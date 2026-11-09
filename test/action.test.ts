import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/action.js";
import { newFileDiff } from "./helpers.js";

describe("GitHub Action entry point", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fetches the PR diff, posts a review and honours fail-on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffwise-"));
    const eventPath = join(dir, "event.json");
    const summaryPath = join(dir, "summary.md");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 12, head: { sha: "deadbeef" } } }));
    writeFileSync(summaryPath, "");
    vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
    vi.stubEnv("GITHUB_REPOSITORY", "octo/demo");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summaryPath);
    vi.stubEnv("GITHUB_API_URL", "https://api.example.test");
    vi.stubEnv("INPUT_GITHUB-TOKEN", "test-token");
    vi.stubEnv("INPUT_PROVIDER", "heuristic");
    vi.stubEnv("INPUT_FAIL-ON", "major");
    vi.stubEnv("INPUT_IGNORE", "docs/**");

    const fetchFn = vi.fn<typeof fetch>();
    fetchFn
      .mockResolvedValueOnce(new Response(newFileDiff("src/a.ts", "debugger;\n") + newFileDiff("docs/x.ts", "debugger;\n")))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchFn);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await run()).toBe(1);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://api.example.test/repos/octo/demo/pulls/12");
    const review = JSON.parse(String(fetchFn.mock.calls[1]![1]!.body));
    expect(review.commit_id).toBe("deadbeef");
    expect(review.comments).toEqual([expect.objectContaining({ path: "src/a.ts", line: 1, side: "RIGHT" })]);
    expect(readFileSync(summaryPath, "utf8")).toContain("## diffwise review");
  });
});
