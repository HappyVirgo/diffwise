import { formatComment, formatMarkdown } from "./report.js";
import type { ReviewResult } from "./review/pipeline.js";

/** Identifies a pull request and authenticates against the GitHub REST API. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
  token: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

/** GitHub rejects very large reviews; extra findings are listed in the review body instead. */
export const MAX_INLINE_COMMENTS = 50;

/** Error carrying the HTTP status of a failed GitHub API call. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

async function request(pr: PullRequestRef, path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const fetchFn = pr.fetchFn ?? fetch;
  const url = `${pr.apiUrl ?? "https://api.github.com"}/repos/${pr.owner}/${pr.repo}${path}`;
  const res = await fetchFn(url, {
    ...init,
    headers: {
      Accept: init.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${pr.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "diffwise",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GitHubApiError(`GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${detail.slice(0, 300)}`, res.status);
  }
  return res;
}

/** Downloads the unified diff of a pull request. */
export async function fetchPullRequestDiff(pr: PullRequestRef): Promise<string> {
  const res = await request(pr, `/pulls/${pr.pullNumber}`, { accept: "application/vnd.github.v3.diff" });
  return res.text();
}

/** Payload for `POST /repos/{owner}/{repo}/pulls/{n}/reviews`. */
export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

/** Builds the review payload: one inline comment per finding (capped) plus a markdown summary body. */
export function buildReviewPayload(result: ReviewResult, commitId: string): ReviewPayload {
  const inline = result.findings.slice(0, MAX_INLINE_COMMENTS);
  const overflow = result.findings.length - inline.length;
  let body = formatMarkdown(result);
  if (overflow > 0) body += `\n_${overflow} additional finding(s) are listed in the table but not posted inline._\n`;
  return {
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: inline.map((f) => ({ path: f.file, line: f.line, side: "RIGHT", body: formatComment(f) })),
  };
}

/**
 * Posts the review with inline comments. If GitHub rejects the inline positions (422, e.g. the
 * PR moved on since the diff was fetched), retries once with the summary only.
 * Returns the number of inline comments posted.
 */
export async function postReview(pr: PullRequestRef, result: ReviewResult, commitId: string): Promise<number> {
  const payload = buildReviewPayload(result, commitId);
  const post = (p: ReviewPayload): Promise<Response> =>
    request(pr, `/pulls/${pr.pullNumber}/reviews`, { method: "POST", body: JSON.stringify(p) });
  try {
    await post(payload);
    return payload.comments.length;
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 422 || payload.comments.length === 0) throw err;
    await post({ ...payload, comments: [] });
    return 0;
  }
}
