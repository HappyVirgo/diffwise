import { describe, expect, it } from "vitest";
import {
  buildLineIndex,
  chunkDiff,
  estimateTokens,
  renderHunk,
  renderUnit,
  sliceHunk,
  trimContext,
} from "../src/diff/chunk.js";
import { DEFAULT_IGNORE_GLOBS, filterFiles, globToRegExp } from "../src/diff/filter.js";
import { parseDiff } from "../src/diff/parse.js";
import type { Hunk } from "../src/types.js";
import { lines, newFileDiff } from "./helpers.js";

function hunkWith(contextBefore: number, changes: string[], contextAfter: number, start = 100): Hunk {
  const body = [
    ...Array.from({ length: contextBefore }, (_, i) => ` before${i}`),
    ...changes,
    ...Array.from({ length: contextAfter }, (_, i) => ` after${i}`),
  ];
  const oldN = body.filter((l) => !l.startsWith("+")).length;
  const newN = body.filter((l) => !l.startsWith("-")).length;
  const diff = lines("diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", `@@ -${start},${oldN} +${start},${newN} @@`, ...body);
  return parseDiff(diff)[0]!.hunks[0]!;
}

/** Re-parses a rendered sub-hunk header + body to prove it is self-consistent. */
function reparse(h: Hunk): Hunk {
  const body = h.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.content);
  return parseDiff(lines("diff --git a/f b/f", "--- a/f", "+++ b/f", h.header, ...body))[0]!.hunks[0]!;
}

describe("globToRegExp", () => {
  it.each([
    ["**/package-lock.json", "package-lock.json", true],
    ["**/package-lock.json", "apps/web/package-lock.json", true],
    ["**/*.min.js", "public/js/app.min.js", true],
    ["**/*.min.js", "public/js/app.js", false],
    ["**/vendor/**", "vendor/lib/x.go", true],
    ["**/vendor/**", "src/vendors.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["docs/?.md", "docs/a.md", true],
    ["**/*.{png,jpg}", "assets/logo.jpg", true],
  ])("%s matches %s -> %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe("filterFiles", () => {
  it("skips binary, deleted, ignored and addition-free files with reasons", () => {
    const diff =
      newFileDiff("src/keep.ts", "x") +
      newFileDiff("yarn.lock", "x") +
      lines("diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ") +
      lines("diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x") +
      lines("diff --git a/a.ts b/b.ts", "similarity index 100%", "rename from a.ts", "rename to b.ts");
    const { kept, skipped } = filterFiles(parseDiff(diff), DEFAULT_IGNORE_GLOBS);
    expect(kept.map((f) => f.newPath)).toEqual(["src/keep.ts"]);
    expect(skipped).toEqual([
      { path: "yarn.lock", reason: "ignored by **/yarn.lock" },
      { path: "img.png", reason: "binary" },
      { path: "gone.ts", reason: "deleted" },
      { path: "b.ts", reason: "no added lines" },
    ]);
  });

  it("respects custom globs", () => {
    const { kept } = filterFiles(parseDiff(newFileDiff("gen/api.ts", "x") + newFileDiff("src/a.ts", "x")), ["gen/**"]);
    expect(kept.map((f) => f.newPath)).toEqual(["src/a.ts"]);
  });
});

describe("trimContext / sliceHunk", () => {
  it("keeps a hunk untouched when its context is within the limit", () => {
    const h = hunkWith(3, ["+x"], 3);
    expect(trimContext(h, 3)).toEqual([h]);
  });

  it("drops distant context and splits at gaps", () => {
    const h = hunkWith(10, ["+a", ...Array.from({ length: 10 }, (_, i) => ` mid${i}`), "-b", "+c"], 10);
    const pieces = trimContext(h, 2);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.lines.map((l) => l.content)).toEqual(["before8", "before9", "a", "mid0", "mid1"]);
    for (const p of pieces) expect(reparse(p).lines).toEqual(p.lines);
  });

  it("computes headers for pure-insertion slices", () => {
    const h = hunkWith(0, ["+a", "+b"], 0, 5);
    const s = sliceHunk(h, 1, 2);
    expect(s.header).toBe("@@ -5,0 +6,1 @@");
    expect(reparse(s).lines[0]!.newLine).toBe(6);
  });
});

describe("chunkDiff", () => {
  const many = Array.from({ length: 30 }, (_, i) => newFileDiff(`src/f${i}.ts`, `export const v${i} = ${i};\n`.repeat(20))).join("");

  it("respects the token budget and keeps hunks whole", () => {
    const files = parseDiff(many);
    const units = chunkDiff(files, { maxTokens: 800 });
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) {
      expect(u.tokens).toBeLessThanOrEqual(800);
      expect(estimateTokens(renderUnit(u))).toBeLessThanOrEqual(u.tokens + u.files.length * 2);
    }
    const hunks = units.flatMap((u) => u.files.flatMap((f) => f.hunks));
    expect(hunks).toHaveLength(30);
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
  });

  it("splits an oversized hunk into consecutive sub-hunks covering every line", () => {
    const big = newFileDiff("src/big.ts", Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"));
    const files = parseDiff(big);
    const units = chunkDiff(files, { maxTokens: 500 });
    expect(units.length).toBeGreaterThan(5);
    const newLines = units.flatMap((u) => u.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.newLine))));
    expect(newLines).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
    for (const u of units) for (const h of u.files[0]!.hunks) expect(reparse(h).lines).toEqual(h.lines);
  });

  it("renders new-file line numbers and markers", () => {
    const [file] = parseDiff(lines("diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", " k", "-o", "+n"));
    expect(renderHunk(file!.hunks[0]!)).toBe("@@ -1,2 +1,2 @@\n     1   k\n       - o\n     2 + n\n");
  });

  it("returns no units for no files", () => {
    expect(chunkDiff([])).toEqual([]);
  });
});

describe("buildLineIndex", () => {
  it("indexes added and context lines but not deleted ones", () => {
    const files = parseDiff(lines("diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -4,3 +4,3 @@", " k", "-o", "+n", " z"));
    expect([...buildLineIndex(files).get("a")!]).toEqual([4, 5, 6]);
  });
});
