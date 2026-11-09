import { displayPath, type DiffFile, type DiffLine, type Hunk } from "../types.js";

/** Options for {@link chunkDiff}. */
export interface ChunkOptions {
  /** Maximum estimated tokens per review unit (rendered text, excluding the prompt). */
  maxTokens: number;
  /** Context lines kept around each change; hunks are trimmed (never padded) to this. */
  contextLines: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 6000, contextLines: 3 };

/** A batch of hunks that is reviewed in one provider call. */
export interface ReviewUnit {
  index: number;
  files: DiffFile[];
  tokens: number;
}

/**
 * Estimates the token count of text. Source code averages roughly 3-4 characters per token
 * for Claude-family tokenizers; dividing by 3.5 errs towards over-estimating.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Renders a file header line as it appears in review units. */
export function renderFileHeader(file: DiffFile): string {
  const rename = file.status === "renamed" && file.oldPath ? ` (renamed from ${file.oldPath})` : "";
  return `### ${displayPath(file)} [${file.status}]${rename}\n`;
}

/**
 * Renders a hunk with explicit new-file line numbers so a reviewer (human or model) can cite
 * exact lines: `  42 + added`, `  43   context`, `     - deleted`.
 */
export function renderHunk(hunk: Hunk): string {
  let out = `${hunk.header}\n`;
  for (const l of hunk.lines) {
    const no = l.newLine === null ? "" : String(l.newLine);
    const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    out += `${no.padStart(6)} ${mark} ${l.content}\n`;
  }
  return out;
}

/** Renders a whole review unit as the text sent to a reviewer. */
export function renderUnit(unit: ReviewUnit): string {
  return unit.files.map((f) => renderFileHeader(f) + f.hunks.map(renderHunk).join("")).join("\n");
}

/**
 * Packs files into review units that fit `maxTokens`. Hunks are trimmed to `contextLines`
 * of context, kept whole whenever they fit, and packed greedily in diff order. A hunk that
 * alone exceeds the budget is split at line boundaries into consecutive sub-hunks.
 */
export function chunkDiff(files: DiffFile[], options: Partial<ChunkOptions> = {}): ReviewUnit[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const units: ReviewUnit[] = [];
  let currentFiles: DiffFile[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (currentFiles.length === 0) return;
    units.push({ index: units.length, files: currentFiles, tokens: currentTokens });
    currentFiles = [];
    currentTokens = 0;
  };

  for (const file of files) {
    const headerTokens = estimateTokens(renderFileHeader(file));
    const pieces = file.hunks
      .flatMap((h) => trimContext(h, opts.contextLines))
      .flatMap((h) => splitOversized(h, opts.maxTokens - headerTokens));
    for (const piece of pieces) {
      const tokens = estimateTokens(renderHunk(piece));
      const last = currentFiles[currentFiles.length - 1];
      const sameFile = last !== undefined && displayPath(last) === displayPath(file);
      const cost = tokens + (sameFile ? 0 : headerTokens);
      if (currentTokens + cost > opts.maxTokens && currentFiles.length > 0) flush();
      const tail = currentFiles[currentFiles.length - 1];
      if (tail !== undefined && displayPath(tail) === displayPath(file)) {
        tail.hunks.push(piece);
        currentTokens += tokens;
      } else {
        currentFiles.push({ ...file, hunks: [piece] });
        currentTokens += tokens + headerTokens;
      }
    }
  }
  flush();
  return units;
}

/** Drops context lines farther than `n` lines from any change, splitting the hunk where gaps appear. */
export function trimContext(hunk: Hunk, n: number): Hunk[] {
  const { lines } = hunk;
  const keep = new Array<boolean>(lines.length).fill(false);
  let lastChange = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "context") lastChange = i;
    if (i - lastChange <= n) keep[i] = true;
  }
  lastChange = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.kind !== "context") lastChange = i;
    if (lastChange - i <= n) keep[i] = true;
  }
  const runs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const start = i;
    while (i + 1 < lines.length && keep[i + 1]) i++;
    runs.push([start, i + 1]);
  }
  if (runs.length === 1 && runs[0]![0] === 0 && runs[0]![1] === lines.length) return [hunk];
  return runs.map(([s, e]) => sliceHunk(hunk, s, e));
}

function splitOversized(hunk: Hunk, budget: number): Hunk[] {
  if (estimateTokens(renderHunk(hunk)) <= budget) return [hunk];
  const out: Hunk[] = [];
  let start = 0;
  // Reserve room for the (re-generated) header of each piece.
  let used = estimateTokens(hunk.header) + 2;
  for (let i = 0; i < hunk.lines.length; i++) {
    const lineTokens = estimateTokens(renderHunk({ ...hunk, header: "", lines: [hunk.lines[i]!] }));
    if (used + lineTokens > budget && i > start) {
      out.push(sliceHunk(hunk, start, i));
      start = i;
      used = estimateTokens(hunk.header) + 2;
    }
    used += lineTokens;
  }
  out.push(sliceHunk(hunk, start, hunk.lines.length));
  return out;
}

/** Builds a self-consistent sub-hunk from `hunk.lines[start, end)` with a recomputed header. */
export function sliceHunk(hunk: Hunk, start: number, end: number): Hunk {
  // A zero-length side's start names the preceding line, so the first real line is start + 1.
  let oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newNo = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (let i = 0; i < start; i++) {
    const l = hunk.lines[i]!;
    if (l.kind !== "add") oldNo++;
    if (l.kind !== "del") newNo++;
  }
  const lines: DiffLine[] = hunk.lines.slice(start, end);
  const oldLines = lines.filter((l) => l.kind !== "add").length;
  const newLines = lines.filter((l) => l.kind !== "del").length;
  // Unified diff convention: a side with zero lines names the line *before* the change.
  const oldStart = oldLines === 0 ? oldNo - 1 : oldNo;
  const newStart = newLines === 0 ? newNo - 1 : newNo;
  const section = hunk.section ? ` ${hunk.section}` : "";
  return {
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${section}`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    section: hunk.section,
    lines,
  };
}

/** Maps each file path to the set of new-file line numbers visible in its hunks (added + context). */
export function buildLineIndex(files: DiffFile[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const f of files) {
    const set = index.get(displayPath(f)) ?? new Set<number>();
    for (const h of f.hunks) for (const l of h.lines) if (l.newLine !== null) set.add(l.newLine);
    index.set(displayPath(f), set);
  }
  return index;
}
