import { describe, expect, it, vi } from "vitest";
import { buildReviewPayload, fetchPullRequestDiff, MAX_INLINE_COMMENTS, postReview } from "../src/github.js";
import { formatJson, formatMarkdown, formatTerminal } from "../src/report.js";
import { ClaudeReviewer } from "../src/review/claude.js";
import { HeuristicReviewer } from "../src/review/heuristic.js";
import { reviewDiff, selectReviewer, sortFindings, type ReviewResult } from "../src/review/pipeline.js";
import type { Finding } from "../src/types.js";
import { newFileDiff } from "./helpers.js";

const DIFF =
  newFileDiff("src/b.ts", 'console.log("x");\nconst k = "AKIA' + 'Q3EXFAKEK7Z2WQ4N"; // TODO rotate\n') +
  newFileDiff("package-lock.json", "{}");

async function result(): Promise<ReviewResult> {
  return reviewDiff(DIFF, new HeuristicReviewer());
}

function finding(line: number, overrides: Partial<Finding> = {}): Finding {
  return { file: "src/b.ts", line, severity: "minor", category: "style", message: `m${line}`, suggestion: null, rule: "r", ...overrides };
}

describe("pipeline", () => {
  it("reviews kept files, skips noise and sorts by file, line and severity", async () => {
    const r = await result();
    expect(r.findings.map((f) => `${f.line}:${f.rule}`)).toEqual(["1:debug-output", "2:aws-access-key", "2:todo-comment"]);
    expect(r.skipped).toEqual([{ path: "package-lock.json", reason: "ignored by **/package-lock.json" }]);
    expect(r).toMatchObject({ reviewer: "heuristic", filesReviewed: 1, units: 1 });
  });

  it("de-duplicates identical findings from overlapping units", async () => {
    const dup = finding(1, { rule: "debug-output" });
    const reviewer = { name: "fake", maxUnitTokens: 10, review: async () => [dup, { ...dup }] };
    expect((await reviewDiff(DIFF, reviewer)).findings).toHaveLength(1);
  });

  it("sortFindings puts higher severity first on the same line", () => {
    const sorted = sortFindings([finding(3, { severity: "info" }), finding(3, { severity: "critical" }), finding(1)]);
    expect(sorted.map((f) => `${f.line}:${f.severity}`)).toEqual(["1:minor", "3:critical", "3:info"]);
  });

  it("selects Claude only when requested or when an API key is present", () => {
    expect(selectReviewer("auto", {})).toBeInstanceOf(HeuristicReviewer);
    expect(selectReviewer("heuristic", { ANTHROPIC_API_KEY: "x" })).toBeInstanceOf(HeuristicReviewer);
    expect(selectReviewer("auto", { ANTHROPIC_API_KEY: "test-key" })).toBeInstanceOf(ClaudeReviewer);
  });
});

describe("reports", () => {
  it("terminal output groups by file and summarises", async () => {
    const text = formatTerminal(await result());
    expect(text).toContain("src/b.ts\n      1  minor    Leftover `console` debug output. [debug-output]");
    expect(text).toContain("skipped: package-lock.json");
    expect(text.trimEnd().split("\n").at(-1)).toBe("3 finding(s) (1 critical, 1 minor, 1 info) in 1 file(s) via heuristic");
    expect(text).not.toContain("\x1b[");
    expect(formatTerminal(await result(), true)).toContain("\x1b[1;31m");
  });

  it("JSON output is parseable with a severity summary", async () => {
    const json = JSON.parse(formatJson(await result()));
    expect(json.summary).toEqual({ total: 3, critical: 1, major: 0, minor: 1, info: 1 });
    expect(json.findings[0]).toMatchObject({ file: "src/b.ts", line: 1, rule: "debug-output" });
  });

  it("markdown output is a GFM table with escaped pipes", async () => {
    const r = await result();
    r.findings[0]!.message = "a | b";
    const md = formatMarkdown(r);
    expect(md).toContain("| Severity | Location | Rule | Finding |");
    expect(md).toContain("a \\| b");
    expect(md).toContain("<details><summary>Skipped files</summary>");
  });
});

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

const PR = { owner: "octo", repo: "demo", pullNumber: 7, token: "test-token" };

describe("GitHub integration", () => {
  it("fetches the PR diff with the diff media type", async () => {
    const fetchFn = mockFetch(new Response("diff text"));
    expect(await fetchPullRequestDiff({ ...PR, fetchFn })).toBe("diff text");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/octo/demo/pulls/7");
    expect(init!.headers).toMatchObject({ Accept: "application/vnd.github.v3.diff", Authorization: "Bearer test-token" });
  });

  it("posts one inline RIGHT-side comment per finding", async () => {
    const fetchFn = mockFetch(new Response("{}", { status: 200 }));
    const r = await result();
    expect(await postReview({ ...PR, fetchFn }, r, "abc123")).toBe(3);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/octo/demo/pulls/7/reviews");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ commit_id: "abc123", event: "COMMENT" });
    expect(body.comments[1]).toMatchObject({ path: "src/b.ts", line: 2, side: "RIGHT" });
    expect(body.comments[1].body).toContain("**critical**");
  });

  it("falls back to a summary-only review when GitHub rejects inline positions", async () => {
    const fetchFn = mockFetch(new Response("Unprocessable", { status: 422 }), new Response("{}", { status: 200 }));
    expect(await postReview({ ...PR, fetchFn }, await result(), "abc")).toBe(0);
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body)).comments).toEqual([]);
  });

  it("surfaces other API errors", async () => {
    const fetchFn = mockFetch(new Response("Bad credentials", { status: 401 }));
    await expect(postReview({ ...PR, fetchFn }, await result(), "abc")).rejects.toThrow(/401 Bad credentials/);
  });

  it("caps inline comments and mentions the overflow", async () => {
    const r = await result();
    r.findings = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_, i) => finding(i + 1));
    const payload = buildReviewPayload(r, "sha");
    expect(payload.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(payload.body).toContain("5 additional finding(s)");
  });
});
