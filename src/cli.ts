#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { DEFAULT_IGNORE_GLOBS } from "./diff/filter.js";
import { formatReport, type ReportFormat } from "./report.js";
import { reviewDiff, selectReviewer, type ProviderName } from "./review/pipeline.js";
import { SeveritySchema, severityRank } from "./types.js";

const USAGE = `Usage: diffwise review [options]

Diff source (one of):
  --base <ref>         Review \`git diff <ref>...HEAD\` in the current repository
  --diff <file>        Review a patch file ("-" reads stdin)

Options:
  --format <f>         terminal | json | markdown        (default: terminal)
  --provider <p>       auto | claude | heuristic          (default: auto: claude if ANTHROPIC_API_KEY is set)
  --ignore <glob>      Extra ignore glob (repeatable); defaults skip lockfiles, minified, vendored files
  --no-default-ignore  Do not apply the default ignore globs
  --max-tokens <n>     Token budget per review unit (Claude provider; default 6000)
  --context <n>        Context lines kept around changes (default 3)
  --fail-on <sev>      Exit 1 if a finding is at least this severity: critical | major | minor | info
  -h, --help           Show this help
`;

/** Runs `git diff <base>...HEAD` and returns its output. */
export async function gitDiff(base: string, cwd = process.cwd()): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["diff", "--no-color", "--no-ext-diff", "-M", `${base}...HEAD`],
    { cwd, maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** CLI entry point; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      diff: { type: "string" },
      format: { type: "string", default: "terminal" },
      provider: { type: "string", default: "auto" },
      ignore: { type: "string", multiple: true, default: [] },
      "no-default-ignore": { type: "boolean", default: false },
      "max-tokens": { type: "string" },
      context: { type: "string", default: "3" },
      "fail-on": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals[0] !== "review") {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (!["terminal", "json", "markdown"].includes(values.format)) throw new Error(`Unknown format: ${values.format}`);
  if (!["auto", "claude", "heuristic"].includes(values.provider)) throw new Error(`Unknown provider: ${values.provider}`);

  const diff =
    values.diff === "-"
      ? await readStdin()
      : values.diff
        ? await readFile(values.diff, "utf8")
        : await gitDiff(values.base ?? "main");

  const ignoreGlobs = [...(values["no-default-ignore"] ? [] : DEFAULT_IGNORE_GLOBS), ...values.ignore];
  const result = await reviewDiff(diff, selectReviewer(values.provider as ProviderName), {
    ignoreGlobs,
    contextLines: Number(values.context),
    ...(values["max-tokens"] ? { maxUnitTokens: Number(values["max-tokens"]) } : {}),
  });
  process.stdout.write(formatReport(result, values.format as ReportFormat, process.stdout.isTTY === true));

  if (!values["fail-on"]) return 0;
  const threshold = severityRank(SeveritySchema.parse(values["fail-on"]));
  return result.findings.some((f) => severityRank(f.severity) >= threshold) ? 1 : 0;
}

if (import.meta.main) main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`diffwise: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);
