import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { renderUnit, type ReviewUnit } from "../diff/chunk.js";
import { CATEGORIES, CategorySchema, SEVERITIES, SeveritySchema, type Finding } from "../types.js";
import type { Reviewer } from "./reviewer.js";

export const CLAUDE_MODEL = "claude-opus-5-5";

/** Shape the model must return; validated with zod after the API's own schema enforcement. */
export const ModelFindingsSchema = z.object({
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().positive(),
      severity: SeveritySchema,
      category: CategorySchema,
      message: z.string().min(1),
      suggestion: z.string().nullable(),
    }),
  ),
});

/** JSON schema sent as `output_config.format`; mirrors {@link ModelFindingsSchema}. */
export const FINDINGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "severity", "category", "message", "suggestion"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          message: { type: "string" },
          suggestion: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `You are a senior engineer reviewing a pull request diff.
Report only real problems a careful reviewer would raise: bugs, security issues, error-handling gaps,
broken tests, risky performance patterns, and maintainability problems worth fixing before merge.
Do not comment on formatting a linter would fix, and do not praise.

The diff shows each file as "### path [status]" followed by hunks. Every line carries its NEW-file
line number, a marker ("+" added, "-" deleted, " " context) and the code. Deleted lines have no number.
Anchor each finding to the new-file line number of an added or context line shown in the diff; cite the
most specific line. "file" must be the path exactly as written after "###".
Severity: critical (exploitable or data loss), major (likely bug), minor (should fix), info (nit).
Return {"findings": []} when nothing needs attention.`;

/** Raised when the model declines, truncates, or returns output that fails validation. */
export class ClaudeReviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeReviewError";
  }
}

/** Minimal slice of the SDK client this reviewer uses, so tests can inject a fake. */
export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { headers?: Record<string, string> },
    ): Promise<Anthropic.Message>;
  };
}

export interface ClaudeReviewerOptions {
  client?: MessagesClient;
  /** Per-unit token budget for the rendered diff. */
  maxUnitTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Reviewer backed by Claude with JSON-schema structured output, validated with zod. */
export class ClaudeReviewer implements Reviewer {
  readonly name = "claude";
  readonly maxUnitTokens: number;
  private readonly client: MessagesClient;
  private readonly effort: NonNullable<ClaudeReviewerOptions["effort"]>;

  constructor(options: ClaudeReviewerOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.maxUnitTokens = options.maxUnitTokens ?? 6000;
    this.effort = options.effort ?? "medium";
  }

  /** Sends one review unit to Claude and returns schema-validated findings. */
  async review(unit: ReviewUnit): Promise<Finding[]> {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Review this diff:\n\n${renderUnit(unit)}` }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema: FINDINGS_JSON_SCHEMA } },
      // Server-side refusal fallback; not yet in the SDK's request types.
      fallbacks: "default",
    } as Anthropic.MessageCreateParamsNonStreaming;

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(body, {
        headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
      });
    } catch (err) {
      throw new ClaudeReviewError(describeApiError(err), { cause: err });
    }
    return parseResponse(response);
  }
}

/** Maps SDK errors (most specific first) to an actionable message. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit (429); retry later or lower concurrency.";
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request (400): ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Claude API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${String(err.status)}: ${err.message}`;
  return `Unexpected error calling Claude: ${err instanceof Error ? err.message : String(err)}`;
}

/** Checks the stop reason, extracts the JSON text block and validates it. */
export function parseResponse(response: Anthropic.Message): Finding[] {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new ClaudeReviewError(`Claude declined to review this chunk (refusal, category: ${category}).`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeReviewError("Claude's response was truncated at max_tokens; reduce the chunk size.");
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ClaudeReviewError("Claude returned non-JSON output.", { cause: err });
  }
  const parsed = ModelFindingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new ClaudeReviewError(`Claude output failed validation: ${parsed.error.message}`);
  }
  return parsed.data.findings.map((f) => ({ ...f, rule: "llm" }));
}
