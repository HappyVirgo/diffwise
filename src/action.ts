import { appendFile, readFile } from "node:fs/promises";
import { DEFAULT_IGNORE_GLOBS } from "./diff/filter.js";
import { fetchPullRequestDiff, postReview } from "./github.js";
import { formatMarkdown } from "./report.js";
import { reviewDiff, selectReviewer, type ProviderName } from "./review/pipeline.js";
import { SeveritySchema, severityRank } from "./types.js";

/** Reads an action input the way the runner exposes it (INPUT_<NAME>). */
function input(name: string, fallback = ""): string {
  return process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`]?.trim() || fallback;
}

interface PullRequestEvent {
  pull_request?: { number: number; head: { sha: string } };
}

/** GitHub Action entry point: reviews the PR diff and posts an inline review. */
export async function run(): Promise<number> {
  const token = input("github-token", process.env.GITHUB_TOKEN ?? "");
  const anthropicKey = input("anthropic-api-key");
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  const provider = input("provider", "auto") as ProviderName;
  const failOn = input("fail-on", "none");
  const ignore = input("ignore");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!token || !eventPath || !owner || !repo) throw new Error("Missing GITHUB_TOKEN, GITHUB_EVENT_PATH or GITHUB_REPOSITORY.");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as PullRequestEvent;
  if (!event.pull_request) {
    console.log("diffwise: not a pull_request event; nothing to review.");
    return 0;
  }

  const pr = { owner, repo, pullNumber: event.pull_request.number, token, apiUrl: process.env.GITHUB_API_URL };
  const diff = await fetchPullRequestDiff(pr);
  const extraGlobs = ignore.split(/[\n,]/).map((g) => g.trim()).filter(Boolean);
  const ignoreGlobs = [...DEFAULT_IGNORE_GLOBS, ...extraGlobs];
  const result = await reviewDiff(diff, selectReviewer(provider), { ignoreGlobs });
  const posted = await postReview(pr, result, event.pull_request.head.sha);
  console.log(`diffwise: ${result.findings.length} finding(s), ${posted} inline comment(s) posted via ${result.reviewer}.`);

  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatMarkdown(result));
  if (failOn === "none") return 0;
  const threshold = severityRank(SeveritySchema.parse(failOn));
  return result.findings.some((f) => severityRank(f.severity) >= threshold) ? 1 : 0;
}

if (import.meta.main) run().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.log(`::error::diffwise failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
