import { displayPath, type DiffFile } from "../types.js";

/** Default noise globs: lockfiles, build output, minified/generated files and vendored code. */
export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/*.generated.*",
  "**/*_pb2.py",
  "**/*.pb.go",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/third_party/**",
];

/**
 * Compiles a glob into a RegExp. Supports `**` (any number of path segments), `*` (anything
 * except `/`), `?` (one non-`/` character) and `{a,b}` alternation. Matching is case-sensitive.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        re += `(?:${glob.slice(i + 1, close).split(",").map(escapeRegExp).join("|")})`;
        i = close;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Result of splitting files into ones worth reviewing and skipped noise. */
export interface FilterResult {
  kept: DiffFile[];
  skipped: { path: string; reason: string }[];
}

/**
 * Drops binary files, pure deletions and files matching any ignore glob. Files with no
 * added lines (e.g. pure renames) are skipped too since there is nothing new to review.
 */
export function filterFiles(files: DiffFile[], ignoreGlobs: readonly string[] = DEFAULT_IGNORE_GLOBS): FilterResult {
  const patterns = ignoreGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));
  const result: FilterResult = { kept: [], skipped: [] };
  for (const file of files) {
    const path = displayPath(file);
    const hit = patterns.find((p) => p.re.test(path));
    if (file.binary) result.skipped.push({ path, reason: "binary" });
    else if (file.status === "deleted") result.skipped.push({ path, reason: "deleted" });
    else if (hit) result.skipped.push({ path, reason: `ignored by ${hit.glob}` });
    else if (!file.hunks.some((h) => h.lines.some((l) => l.kind === "add")))
      result.skipped.push({ path, reason: "no added lines" });
    else result.kept.push(file);
  }
  return result;
}
