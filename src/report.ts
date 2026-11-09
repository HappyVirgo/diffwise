import type { ReviewResult } from "./review/pipeline.js";
import { SEVERITIES, type Finding, type Severity } from "./types.js";

/** Output formats supported by the CLI. */
export type ReportFormat = "terminal" | "json" | "markdown";

const ANSI: Record<Severity, string> = { critical: "\x1b[1;31m", major: "\x1b[31m", minor: "\x1b[33m", info: "\x1b[36m" };
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function counts(findings: Finding[]): Record<Severity, number> {
  const c = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function summaryLine(result: ReviewResult): string {
  const c = counts(result.findings);
  const parts = SEVERITIES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  const tally = parts.length > 0 ? parts.join(", ") : "no findings";
  return `${result.findings.length} finding(s) (${tally}) in ${result.filesReviewed} file(s) via ${result.reviewer}`;
}

/** Plain-text report grouped by file; `color` adds ANSI severity colours. */
export function formatTerminal(result: ReviewResult, color = false): string {
  const paint = (s: Severity, text: string): string => (color ? `${ANSI[s]}${text}${RESET}` : text);
  const dim = (text: string): string => (color ? `${DIM}${text}${RESET}` : text);
  const out: string[] = [];
  let currentFile = "";
  for (const f of result.findings) {
    if (f.file !== currentFile) {
      currentFile = f.file;
      out.push("", f.file);
    }
    out.push(`  ${String(f.line).padStart(5)}  ${paint(f.severity, f.severity.padEnd(8))} ${f.message} ${dim(`[${f.rule}]`)}`);
    if (f.suggestion) out.push(`         ${dim(`-> ${f.suggestion}`)}`);
  }
  if (result.skipped.length > 0) {
    out.push("", dim(`skipped: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`));
  }
  if (result.dropped.length > 0) out.push(dim(`dropped ${result.dropped.length} finding(s) outside changed hunks`));
  out.push("", summaryLine(result));
  return out.join("\n").trimStart() + "\n";
}

/** Machine-readable JSON report. */
export function formatJson(result: ReviewResult): string {
  return JSON.stringify(
    {
      reviewer: result.reviewer,
      summary: { total: result.findings.length, ...counts(result.findings) },
      filesReviewed: result.filesReviewed,
      units: result.units,
      findings: result.findings,
      skipped: result.skipped,
      droppedOutsideDiff: result.dropped.length,
    },
    null,
    2,
  ) + "\n";
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** GitHub-flavoured markdown summary with a findings table. */
export function formatMarkdown(result: ReviewResult): string {
  const out = [`## diffwise review`, "", summaryLine(result) + ".", ""];
  if (result.findings.length > 0) {
    out.push("| Severity | Location | Rule | Finding |", "| --- | --- | --- | --- |");
    for (const f of result.findings) {
      const suggestion = f.suggestion ? `<br>_${escapeCell(f.suggestion)}_` : "";
      out.push(
        `| **${f.severity}** | \`${escapeCell(f.file)}:${f.line}\` | \`${f.rule}\` | ${escapeCell(f.message)}${suggestion} |`,
      );
    }
    out.push("");
  }
  if (result.skipped.length > 0) {
    out.push("<details><summary>Skipped files</summary>", "");
    for (const s of result.skipped) out.push(`- \`${s.path}\` (${s.reason})`);
    out.push("", "</details>", "");
  }
  return out.join("\n");
}

/** Formats a single finding as the body of an inline PR comment. */
export function formatComment(f: Finding): string {
  const suggestion = f.suggestion ? `\n\n**Suggestion:** ${f.suggestion}` : "";
  return `**${f.severity}** (${f.category}, \`${f.rule}\`): ${f.message}${suggestion}`;
}

/** Renders a result in the requested format. */
export function formatReport(result: ReviewResult, format: ReportFormat, color = false): string {
  if (format === "json") return formatJson(result);
  if (format === "markdown") return formatMarkdown(result);
  return formatTerminal(result, color);
}
