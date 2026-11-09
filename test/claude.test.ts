import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { parseDiff } from "../src/diff/parse.js";
import {
  CLAUDE_MODEL,
  ClaudeReviewer,
  ClaudeReviewError,
  describeApiError,
  type MessagesClient,
} from "../src/review/claude.js";
import { reviewDiff } from "../src/review/pipeline.js";
import { newFileDiff } from "./helpers.js";

function message(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLAUDE_MODEL,
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Message;
}

function fakeClient(impl: () => Promise<Anthropic.Message>): MessagesClient & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(impl);
  return { messages: { create }, create };
}

const DIFF = newFileDiff("src/a.ts", "const a = 1;\nconst b = eval(a);\n");
const unit = { index: 0, files: parseDiff(DIFF), tokens: 0 };

describe("ClaudeReviewer", () => {
  it("sends the model, effort, JSON schema format and fallback options", async () => {
    const client = fakeClient(async () => message('{"findings": []}'));
    await new ClaudeReviewer({ client }).review(unit);
    const [body, options] = client.create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    for (const banned of ["temperature", "top_p", "top_k", "thinking"]) expect(body).not.toHaveProperty(banned);
    expect(body.messages[0].content).toContain("     2 + const b = eval(a);");
    expect(options).toEqual({ headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } });
  });

  it("returns zod-validated findings tagged with the llm rule", async () => {
    const payload = {
      findings: [{ file: "src/a.ts", line: 2, severity: "major", category: "security", message: "eval", suggestion: null }],
    };
    const client = fakeClient(async () => message(JSON.stringify(payload)));
    expect(await new ClaudeReviewer({ client }).review(unit)).toEqual([{ ...payload.findings[0], rule: "llm" }]);
  });

  it("drops model findings whose line is outside the changed hunks", async () => {
    const payload = {
      findings: [
        { file: "src/a.ts", line: 2, severity: "major", category: "security", message: "eval", suggestion: "remove" },
        { file: "src/a.ts", line: 99, severity: "minor", category: "style", message: "hallucinated", suggestion: null },
        { file: "src/other.ts", line: 1, severity: "minor", category: "style", message: "wrong file", suggestion: null },
      ],
    };
    const client = fakeClient(async () => message(JSON.stringify(payload)));
    const result = await reviewDiff(DIFF, new ClaudeReviewer({ client }));
    expect(result.findings.map((f) => f.line)).toEqual([2]);
    expect(result.dropped.map((f) => f.message)).toEqual(["hallucinated", "wrong file"]);
  });

  it("treats a refusal as an error", async () => {
    const refusal = { ...message(""), stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } };
    const client = fakeClient(async () => refusal as unknown as Anthropic.Message);
    await expect(new ClaudeReviewer({ client }).review(unit)).rejects.toThrow(/declined.*cyber/);
  });

  it("rejects truncated, non-JSON and schema-invalid output", async () => {
    const cases: [Anthropic.Message, RegExp][] = [
      [message('{"findings": [', "max_tokens"), /truncated/],
      [message("not json"), /non-JSON/],
      [message('{"findings": [{"file": "a", "line": 0, "severity": "huge"}]}'), /failed validation/],
    ];
    for (const [response, error] of cases) {
      const client = fakeClient(async () => response);
      await expect(new ClaudeReviewer({ client }).review(unit)).rejects.toThrow(error);
    }
  });

  it("wraps SDK errors with specific messages", async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const client = fakeClient(async () => {
      throw rate;
    });
    const err = await new ClaudeReviewer({ client }).review(unit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeReviewError);
    expect((err as Error).message).toMatch(/rate limit/);
    expect((err as Error).cause).toBe(rate);
  });

  it("maps each SDK error class most-specific-first", () => {
    expect(describeApiError(new Anthropic.AuthenticationError(401, undefined, "bad", new Headers()))).toMatch(/API key/);
    expect(describeApiError(new Anthropic.BadRequestError(400, undefined, "nope", new Headers()))).toMatch(/400/);
    expect(describeApiError(new Anthropic.InternalServerError(500, undefined, "boom", new Headers()))).toMatch(/error 500/);
    expect(describeApiError(new Anthropic.APIConnectionError({ message: "offline" }))).toMatch(/Could not reach/);
    expect(describeApiError(new Error("other"))).toMatch(/Unexpected error/);
  });
});
