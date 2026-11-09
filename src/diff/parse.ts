import type { DiffFile, DiffLine, Hunk } from "../types.js";

/** Raised when the input is not a well-formed unified diff. `lineNumber` is 1-based in the input. */
export class DiffParseError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(`line ${lineNumber}: ${message}`);
    this.name = "DiffParseError";
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Parses unified diff text (as produced by `git diff` or `diff -u`) into files, hunks and lines.
 *
 * New-file line numbers are tracked for added and context lines so findings can be anchored
 * to the right side of a pull request. Renames, copies, mode-only changes, deletions, binary
 * files and "\ No newline at end of file" markers are recognised. Hunk line counts are
 * verified against their headers; a mismatch throws {@link DiffParseError}.
 */
export function parseDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = stripCr(lines[i]!);

    if (line.startsWith("diff --git ")) {
      current = newFile(parseGitHeaderPaths(line.slice("diff --git ".length)));
      files.push(current);
      i++;
      continue;
    }

    if (line.startsWith("--- ") && i + 1 < lines.length && stripCr(lines[i + 1]!).startsWith("+++ ")) {
      const oldPath = parseMarkerPath(line.slice(4));
      const newPath = parseMarkerPath(stripCr(lines[i + 1]!).slice(4));
      // Plain `diff -u` output has no `diff --git` line; each ---/+++ pair starts a file.
      if (current === null || current.hunks.length > 0) {
        current = newFile({ oldPath, newPath });
        files.push(current);
      }
      current.oldPath = oldPath;
      current.newPath = newPath;
      if (oldPath === null) current.status = "added";
      else if (newPath === null) current.status = "deleted";
      i += 2;
      continue;
    }

    if (line.startsWith("@@")) {
      if (current === null) throw new DiffParseError("hunk header before any file header", i + 1);
      const { hunk, next } = parseHunk(lines, i);
      current.hunks.push(hunk);
      i = next;
      continue;
    }

    if (current !== null) applyExtendedHeader(current, line);
    i++;
  }
  return files;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function newFile(paths: { oldPath: string | null; newPath: string | null }): DiffFile {
  return { ...paths, status: "modified", binary: false, similarity: null, hunks: [] };
}

function applyExtendedHeader(file: DiffFile, line: string): void {
  if (line.startsWith("new file mode")) {
    file.status = "added";
    file.oldPath = null;
  } else if (line.startsWith("deleted file mode")) {
    file.status = "deleted";
    file.newPath = null;
  } else if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = unquote(line.slice("rename from ".length));
  } else if (line.startsWith("rename to ")) {
    file.status = "renamed";
    file.newPath = unquote(line.slice("rename to ".length));
  } else if (line.startsWith("copy from ")) {
    file.status = "copied";
    file.oldPath = unquote(line.slice("copy from ".length));
  } else if (line.startsWith("copy to ")) {
    file.status = "copied";
    file.newPath = unquote(line.slice("copy to ".length));
  } else if (line.startsWith("similarity index ")) {
    file.similarity = Number.parseInt(line.slice("similarity index ".length), 10);
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    file.binary = true;
  }
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const header = stripCr(lines[start]!);
  const m = HUNK_RE.exec(header);
  if (!m) throw new DiffParseError(`malformed hunk header: ${header}`, start + 1);
  const oldStart = Number(m[1]);
  const oldLines = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newLines = m[4] === undefined ? 1 : Number(m[4]);
  const hunk: Hunk = { header, oldStart, oldLines, newStart, newLines, section: m[5] ?? "", lines: [] };

  let oldNo = oldStart;
  let newNo = newStart;
  let oldLeft = oldLines;
  let newLeft = newLines;
  let i = start + 1;

  while (i < lines.length && (oldLeft > 0 || newLeft > 0 || stripCr(lines[i]!) === NO_NEWLINE)) {
    const raw = stripCr(lines[i]!);
    if (raw === NO_NEWLINE) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewlineAtEof = true;
      i++;
      continue;
    }
    // Some editors strip the single space of empty context lines; treat "" as context.
    const marker = raw.length === 0 ? " " : raw[0];
    const content = raw.slice(1);
    let dl: DiffLine;
    if (marker === "+" && newLeft > 0) {
      dl = { kind: "add", content, oldLine: null, newLine: newNo++, noNewlineAtEof: false };
      newLeft--;
    } else if (marker === "-" && oldLeft > 0) {
      dl = { kind: "del", content, oldLine: oldNo++, newLine: null, noNewlineAtEof: false };
      oldLeft--;
    } else if (marker === " " && oldLeft > 0 && newLeft > 0) {
      dl = { kind: "context", content, oldLine: oldNo++, newLine: newNo++, noNewlineAtEof: false };
      oldLeft--;
      newLeft--;
    } else {
      break;
    }
    hunk.lines.push(dl);
    i++;
  }

  if (oldLeft !== 0 || newLeft !== 0) {
    throw new DiffParseError(
      `hunk "${header}" is truncated: ${oldLeft} old and ${newLeft} new lines missing`,
      i + 1,
    );
  }
  return { hunk, next: i };
}

/** Parses the `a/x b/y` part of a `diff --git` line. Exact paths are refined later by ---/+++ or rename headers. */
function parseGitHeaderPaths(rest: string): { oldPath: string | null; newPath: string | null } {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest, 0);
    const oldRaw = rest.slice(0, end + 1);
    const newRaw = rest.slice(end + 2);
    return { oldPath: stripPrefix(unquote(oldRaw)), newPath: stripPrefix(unquote(newRaw)) };
  }
  // Without quoting, paths may contain spaces; prefer the split where both sides name the same file.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = stripPrefix(rest.slice(0, half));
    const b = stripPrefix(rest.slice(half + 1));
    if (a === b) return { oldPath: a, newPath: b };
  }
  const idx = rest.lastIndexOf(" b/");
  if (idx === -1) return { oldPath: stripPrefix(rest), newPath: stripPrefix(rest) };
  return { oldPath: stripPrefix(rest.slice(0, idx)), newPath: stripPrefix(rest.slice(idx + 1)) };
}

function parseMarkerPath(raw: string): string | null {
  // `diff -u` appends a tab and a timestamp after the path.
  const path = unquote(raw.split("\t")[0]!);
  if (path === "/dev/null") return null;
  return stripPrefix(path);
}

function stripPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

function findClosingQuote(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };

/** Decodes git's C-style quoted paths (including octal-escaped UTF-8 bytes). */
function unquote(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const nextCh = body[i + 1] ?? "";
    if (/[0-7]/.test(nextCh)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(ESCAPES[nextCh] ?? nextCh, "utf8"));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
