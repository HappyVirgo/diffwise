import { z } from "zod";

/** Kind of a line inside a hunk. */
export type LineKind = "add" | "del" | "context";

/** One line of a hunk. `newLine` is set for added and context lines, `oldLine` for deleted and context lines. */
export interface DiffLine {
  kind: LineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  /** True when the line is followed by "\ No newline at end of file". */
  noNewlineAtEof: boolean;
}

/** A contiguous hunk introduced by an `@@ -a,b +c,d @@` header. */
export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@`, usually the enclosing function signature. */
  section: string;
  lines: DiffLine[];
}

/** How a file changed. */
export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

/** One file section of a unified diff. Paths are null for /dev/null sides. */
export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** Rename/copy similarity index (0-100) when git reports one. */
  similarity: number | null;
  hunks: Hunk[];
}

/** Returns the path to report findings against: the new path, or the old one for deletions. */
export function displayPath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "<unknown>";
}

export const SEVERITIES = ["critical", "major", "minor", "info"] as const;
export const CATEGORIES = [
  "security",
  "correctness",
  "maintainability",
  "testing",
  "style",
  "performance",
] as const;

export const SeveritySchema = z.enum(SEVERITIES);
export const CategorySchema = z.enum(CATEGORIES);
export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;

/** A single review finding anchored to a line of the new file. */
export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: SeveritySchema,
  category: CategorySchema,
  message: z.string().min(1),
  suggestion: z.string().nullable(),
  /** Rule id for heuristic findings, or "llm" for model findings. */
  rule: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Numeric rank used to sort and filter severities (higher is worse). */
export function severityRank(s: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(s);
}
