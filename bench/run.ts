/**
 * Benchmark: heuristic reviewer precision/recall on the labelled fixture corpus (dev and
 * held-out splits reported separately) plus parser/chunker throughput on a generated diff.
 * Usage: npm run bench   (writes bench/RESULTS.md)
 *        npm run bench -- --dev-only   (dev split only, prints, writes nothing; used while tuning rules)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkDiff } from "../src/diff/chunk.js";
import { filterFiles } from "../src/diff/filter.js";
import { expandFakes } from "./fakes.js";
import { parseDiff } from "../src/diff/parse.js";
import { HeuristicReviewer, RULES } from "../src/review/heuristic.js";
import { reviewDiff } from "../src/review/pipeline.js";
import { generateLargeDiff } from "./generate.js";
import { metrics, scoreFixture, sumCounts, type Counts, type LabelledFinding } from "./score.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEV_ONLY = process.argv.includes("--dev-only");
const SPLITS = DEV_ONLY ? (["dev"] as const) : (["dev", "holdout"] as const);
type Split = "dev" | "holdout";

interface SplitResult {
  fixtures: number;
  clean: number;
  perRule: Map<string, Counts>;
  misses: string[];
}

async function evaluate(split: Split): Promise<SplitResult> {
  const dir = join(here, "fixtures", split);
  const names = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort();
  const result: SplitResult = { fixtures: names.length, clean: 0, perRule: new Map(), misses: [] };
  const reviewer = new HeuristicReviewer();
  for (const name of names) {
    const base = name.replace(/\.patch$/, "");
    const diff = expandFakes(readFileSync(join(dir, name), "utf8"));
    const expected = (JSON.parse(readFileSync(join(dir, `${base}.expected.json`), "utf8")) as { findings: LabelledFinding[] })
      .findings;
    if (expected.length === 0) result.clean++;
    const { findings } = await reviewDiff(diff, reviewer);
    const before = new Map([...result.perRule].map(([k, v]) => [k, { ...v }]));
    scoreFixture(expected, findings, result.perRule);
    for (const [rule, c] of result.perRule) {
      const prev = before.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
      if (c.fp > prev.fp) result.misses.push(`${base}: ${c.fp - prev.fp} false positive(s) for \`${rule}\``);
      if (c.fn > prev.fn) result.misses.push(`${base}: ${c.fn - prev.fn} missed \`${rule}\``);
    }
  }
  return result;
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

function ruleTable(perRule: Map<string, Counts>): string[] {
  const rows = ["| Rule | TP | FP | FN | Precision | Recall |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const rule of RULES.map((r) => r.id)) {
    const c = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    const m = metrics(c);
    rows.push(`| \`${rule}\` | ${c.tp} | ${c.fp} | ${c.fn} | ${pct(m.precision)} | ${pct(m.recall)} |`);
  }
  const t = sumCounts(perRule);
  const m = metrics(t);
  rows.push(`| **overall (micro)** | **${t.tp}** | **${t.fp}** | **${t.fn}** | **${pct(m.precision)}** | **${pct(m.recall)}** |`);
  return rows;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time(fn: () => void, runs: number): number {
  fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples) / 1000;
}

async function throughput(): Promise<string[]> {
  const diff = generateLargeDiff(2000, 20);
  const lines = diff.split("\n").length - 1;
  const mb = Buffer.byteLength(diff) / 1024 / 1024;
  const files = parseDiff(diff);
  const kept = filterFiles(files).kept;
  const runs = 7;
  const tParse = time(() => parseDiff(diff), runs);
  const tChunk = time(() => chunkDiff(filterFiles(parseDiff(diff)).kept, { maxTokens: 6000 }), runs);
  const units = chunkDiff(kept, { maxTokens: 6000 }).length;
  const reviewer = new HeuristicReviewer();
  const t0 = performance.now();
  await reviewDiff(diff, reviewer);
  const tReview = (performance.now() - t0) / 1000;
  const row = (label: string, s: number): string =>
    `| ${label} | ${(s * 1000).toFixed(0)} ms | ${Math.round(lines / s).toLocaleString("en-US")} | ${(mb / s).toFixed(1)} |`;
  return [
    `Input: generated diff, ${files.length.toLocaleString("en-US")} files, ${lines.toLocaleString("en-US")} lines, ${mb.toFixed(2)} MB; ${units} review units at a 6,000-token budget.`,
    "",
    "| Stage | Time | Lines/sec | MB/s |",
    "| --- | ---: | ---: | ---: |",
    row(`parse (median of ${runs})`, tParse),
    row(`parse + filter + chunk (median of ${runs})`, tChunk),
    row("full heuristic review (single run)", tReview),
  ];
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const machine = `${os.cpus()[0]?.model.trim() ?? "unknown CPU"} (${os.cpus().length} logical cores), ${os.type()} ${os.release()}, Node ${process.version}`;
  const out: string[] = [
    "# diffwise benchmark results",
    "",
    `Measured ${date} on ${machine}.`,
    "Command: `npm run bench`. Reviewer: offline `HeuristicReviewer` (no LLM calls). All fixtures are synthetic.",
    "",
    "Matching is exact on (file, new-file line, rule id). Precision is n/a when a rule made no predictions.",
    "",
  ];
  const all = new Map<string, Counts>();
  for (const split of SPLITS) {
    const r = await evaluate(split);
    for (const [rule, c] of r.perRule) {
      const a = all.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
      all.set(rule, { tp: a.tp + c.tp, fp: a.fp + c.fp, fn: a.fn + c.fn });
    }
    const title =
      split === "dev"
        ? "Dev split (fixtures used while writing the rules)"
        : "Held-out split (written separately; never used to tune rules)";
    out.push(`## ${title}`, "", `${r.fixtures} fixtures (${r.clean} clean).`, "", ...ruleTable(r.perRule), "");
    if (r.misses.length > 0) out.push("Errors:", "", ...r.misses.map((m) => `- ${m}`), "");
  }
  if (DEV_ONLY) {
    process.stdout.write(out.join("\n"));
    return;
  }
  out.push("## Combined", "", ...ruleTable(all), "", "## Parser / chunker throughput", "", ...(await throughput()), "");
  const text = out.join("\n");
  writeFileSync(join(here, "RESULTS.md"), text);
  process.stdout.write(text);
}

await main();
