import { describe, expect, it } from "vitest";
import { DiffParseError, parseDiff } from "../src/diff/parse.js";
import { lines, newFileDiff } from "./helpers.js";

describe("parseDiff", () => {
  it("tracks old and new line numbers across context, deletions and additions", () => {
    const [file] = parseDiff(
      lines(
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,4 +10,5 @@ function main() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " const d = 5;",
        " return a;",
      ),
    );
    expect(file!.status).toBe("modified");
    expect(file!.newPath).toBe("src/a.ts");
    const hunk = file!.hunks[0]!;
    expect(hunk.section).toBe("function main() {");
    expect(hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
      ["context", 13, 14],
    ]);
  });

  it("handles multiple files and multiple hunks", () => {
    const files = parseDiff(
      lines(
        "diff --git a/x.py b/x.py",
        "--- a/x.py",
        "+++ b/x.py",
        "@@ -1,2 +1,2 @@",
        "-a",
        "+b",
        " c",
        "@@ -20 +20,2 @@",
        " z",
        "+y",
        "diff --git a/y.py b/y.py",
        "--- a/y.py",
        "+++ b/y.py",
        "@@ -5,0 +6 @@",
        "+inserted",
      ),
    );
    expect(files).toHaveLength(2);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.hunks[1]!.lines[1]!.newLine).toBe(21);
    expect(files[1]!.hunks[0]!.lines[0]!.newLine).toBe(6);
  });

  it("recognises added files", () => {
    const [file] = parseDiff(newFileDiff("src/new.ts", "a\nb\n"));
    expect(file).toMatchObject({ status: "added", oldPath: null, newPath: "src/new.ts" });
    expect(file!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("recognises deleted files", () => {
    const [file] = parseDiff(
      lines("diff --git a/old.js b/old.js", "deleted file mode 100644", "--- a/old.js", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x", "-y"),
    );
    expect(file).toMatchObject({ status: "deleted", oldPath: "old.js", newPath: null });
    expect(file!.hunks[0]!.lines.every((l) => l.kind === "del")).toBe(true);
  });

  it("recognises pure renames with no hunks and renames with edits", () => {
    const files = parseDiff(
      lines(
        "diff --git a/a/one.ts b/b/two.ts",
        "similarity index 100%",
        "rename from a/one.ts",
        "rename to b/two.ts",
        "diff --git a/lib/x.ts b/lib/y.ts",
        "similarity index 90%",
        "rename from lib/x.ts",
        "rename to lib/y.ts",
        "--- a/lib/x.ts",
        "+++ b/lib/y.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ),
    );
    expect(files[0]).toMatchObject({ status: "renamed", oldPath: "a/one.ts", newPath: "b/two.ts", similarity: 100 });
    expect(files[0]!.hunks).toHaveLength(0);
    expect(files[1]).toMatchObject({ status: "renamed", oldPath: "lib/x.ts", newPath: "lib/y.ts", similarity: 90 });
    expect(files[1]!.hunks[0]!.lines[1]!.newLine).toBe(1);
  });

  it("flags binary files", () => {
    const files = parseDiff(
      lines(
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/font.woff b/font.woff",
        "new file mode 100644",
        "GIT binary patch",
        "literal 12",
        "zcmZ?wbhEHbRA2ysB",
        "",
        "literal 0",
        "HcmV?d00001",
      ),
    );
    expect(files.map((f) => [f.newPath, f.binary])).toEqual([
      ["logo.png", true],
      ["font.woff", true],
    ]);
  });

  it("attaches '\\ No newline at end of file' to the preceding line", () => {
    const [file] = parseDiff(
      lines(
        "diff --git a/n.txt b/n.txt",
        "--- a/n.txt",
        "+++ b/n.txt",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ),
    );
    const [del, add] = file!.hunks[0]!.lines;
    expect(del).toMatchObject({ kind: "del", noNewlineAtEof: true });
    expect(add).toMatchObject({ kind: "add", newLine: 1, noNewlineAtEof: true });
  });

  it("parses quoted paths with spaces and octal escapes", () => {
    const [file] = parseDiff(
      lines(
        'diff --git "a/docs/my notes.md" "b/docs/caf\\303\\251.md"',
        "similarity index 95%",
        'rename from "docs/my notes.md"',
        'rename to "docs/caf\\303\\251.md"',
      ),
    );
    expect(file).toMatchObject({ oldPath: "docs/my notes.md", newPath: "docs/café.md", status: "renamed" });
  });

  it("parses unquoted paths containing spaces from the git header", () => {
    const [file] = parseDiff(lines("diff --git a/my dir/f.txt b/my dir/f.txt", "old mode 100644", "new mode 100755"));
    expect(file).toMatchObject({ oldPath: "my dir/f.txt", newPath: "my dir/f.txt", status: "modified" });
  });

  it("parses plain `diff -u` output with timestamps", () => {
    const files = parseDiff(
      lines(
        "--- a.txt\t2026-01-01 10:00:00.000000000 +0000",
        "+++ b.txt\t2026-01-02 10:00:00.000000000 +0000",
        "@@ -1 +1,2 @@",
        " keep",
        "+added",
        "--- c.txt\t2026-01-01 10:00:00.000000000 +0000",
        "+++ c.txt\t2026-01-02 10:00:00.000000000 +0000",
        "@@ -3 +3 @@",
        "-x",
        "+y",
      ),
    );
    expect(files.map((f) => f.newPath)).toEqual(["b.txt", "c.txt"]);
    expect(files[0]!.hunks[0]!.lines[1]!.newLine).toBe(2);
  });

  it("tolerates CRLF line endings and empty context lines", () => {
    const text = ["diff --git a/w.ts b/w.ts", "--- a/w.ts", "+++ b/w.ts", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c", ""].join("\r\n");
    const [file] = parseDiff(text);
    expect(file!.hunks[0]!.lines.map((l) => [l.kind, l.content])).toEqual([
      ["context", "a"],
      ["context", ""],
      ["del", "b"],
      ["add", "c"],
    ]);
  });

  it("does not mistake deleted lines starting with '--' for file headers", () => {
    const [file] = parseDiff(
      lines("diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- comment", "+++ plus", "-x"),
    );
    expect(file!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["del", "add", "del"]);
  });

  it("throws on truncated hunks and malformed headers", () => {
    expect(() => parseDiff(lines("diff --git a/t b/t", "--- a/t", "+++ b/t", "@@ -1,3 +1,3 @@", " a"))).toThrow(DiffParseError);
    expect(() => parseDiff(lines("diff --git a/t b/t", "@@ nonsense @@"))).toThrow(/malformed hunk header/);
    expect(() => parseDiff("@@ -1 +1 @@\n-a\n+b\n")).toThrow(/before any file header/);
  });

  it("returns no files for empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
