import { buildLineIndex, chunkDiff } from "../diff/chunk.js";
import { DEFAULT_IGNORE_GLOBS, filterFiles } from "../diff/filter.js";
import { parseDiff } from "../diff/parse.js";
import { severityRank, type Finding } from "../types.js";
import { ClaudeReviewer } from "./claude.js";
import { HeuristicReviewer } from "./heuristic.js";
import type { Reviewer } from "./reviewer.js";

export interface ReviewOptions {
  ignoreGlobs?: readonly string[];
  contextLines?: number;
  /** Overrides the reviewer's preferred per-unit token budget. */
  maxUnitTokens?: number;
  /** Units reviewed in parallel. */
  concurrency?: number;
}

/** Outcome of a full review run. */
export interface ReviewResult {
  reviewer: string;
  findings: Finding[];
  /** Findings discarded because their line is not inside a changed hunk. */
  dropped: Finding[];
  skipped: { path: string; reason: string }[];
  filesReviewed: number;
  units: number;
}

/**
 * Parses, filters and chunks a diff, runs the reviewer on every unit, then keeps only
 * findings anchored to a line that is visible in a hunk of the diff, de-duplicated and sorted.
 */
export async function reviewDiff(diff: string, reviewer: Reviewer, options: ReviewOptions = {}): Promise<ReviewResult> {
  const files = parseDiff(diff);
  const { kept, skipped } = filterFiles(files, options.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS);
  const units = chunkDiff(kept, {
    maxTokens: options.maxUnitTokens ?? reviewer.maxUnitTokens,
    contextLines: options.contextLines ?? 3,
  });
  const raw = (await mapLimit(units, options.concurrency ?? 4, (u) => reviewer.review(u))).flat();
  const { valid, dropped } = validateFindings(raw, buildLineIndex(kept));
  return {
    reviewer: reviewer.name,
    findings: sortFindings(dedupe(valid)),
    dropped,
    skipped,
    filesReviewed: kept.length,
    units: units.length,
  };
}

/** Splits findings into those whose (file, line) exists in the diff's new-side lines and the rest. */
export function validateFindings(
  findings: Finding[],
  index: Map<string, Set<number>>,
): { valid: Finding[]; dropped: Finding[] } {
  const valid: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) (index.get(f.file)?.has(f.line) ? valid : dropped).push(f);
  return { valid, dropped };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}\0${f.line}\0${f.rule}\0${f.rule === "llm" ? f.message : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Orders findings by file, then line, then descending severity. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || severityRank(b.severity) - severityRank(a.severity),
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Provider names accepted by {@link selectReviewer}. */
export type ProviderName = "auto" | "claude" | "heuristic";

/**
 * Picks a reviewer. "auto" uses Claude when ANTHROPIC_API_KEY is set and the offline
 * heuristic reviewer otherwise.
 */
export function selectReviewer(provider: ProviderName, env: NodeJS.ProcessEnv = process.env): Reviewer {
  if (provider === "heuristic") return new HeuristicReviewer();
  if (provider === "claude" || env.ANTHROPIC_API_KEY) return new ClaudeReviewer();
  return new HeuristicReviewer();
}
