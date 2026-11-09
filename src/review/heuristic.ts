import type { ReviewUnit } from "../diff/chunk.js";
import { displayPath, type Category, type DiffFile, type Finding, type Severity } from "../types.js";
import type { Reviewer } from "./reviewer.js";
import {
  commentStyleOf,
  isCodeFile,
  isTestFile,
  languageOf,
  splitLine,
  type Language,
  type SplitLine,
} from "./source.js";

/** A line of the post-change file as visible in a hunk (added or context). */
export interface ViewLine {
  newLine: number;
  content: string;
  added: boolean;
  split: SplitLine;
}

/** Everything a rule needs to inspect one file. `views` holds one array per hunk. */
export interface FileContext {
  path: string;
  lang: Language;
  isTest: boolean;
  views: ViewLine[][];
}

/** A static review rule. `check` returns the new-file lines it fires on plus a message. */
export interface Rule {
  id: string;
  severity: Severity;
  category: Category;
  description: string;
  suggestion: string;
  check(ctx: FileContext): { line: number; message: string }[];
}

/** Thresholds for the size rules. */
export const LONG_LINE_CHARS = 160;
export const LONG_FUNCTION_LINES = 50;

/** Builds a rule that inspects each added line independently. */
function lineRule(
  meta: Omit<Rule, "check">,
  test: (line: ViewLine, ctx: FileContext) => string | null,
): Rule {
  return {
    ...meta,
    check(ctx) {
      const hits: { line: number; message: string }[] = [];
      for (const view of ctx.views)
        for (const l of view) {
          if (!l.added) continue;
          const message = test(l, ctx);
          if (message !== null) hits.push({ line: l.newLine, message });
        }
      return hits;
    },
  };
}

const JS_DEBUG = /\bconsole\.(log|debug|trace|dir)\s*\(/;
const PY_PRINT = /(^|[^\w.])print\s*\(/;
const SCRIPT_PATH = /(^|\/)(scripts?|bin|cli|examples?)\/|(^|\/)cli\.[a-z]+$|(^|\/)__main__\.py$/;

const JS_DEBUGGER = /(^|[^\w.$])debugger\s*(;|$)/;
const PY_DEBUGGER = /(^|[^\w.])breakpoint\s*\(\s*\)|\b(i?pdb)\.set_trace\s*\(/;

const TODO = /\b(TODO|FIXME|XXX|HACK)\b/;

const AWS_KEY = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/;
const PRIVATE_KEY = /-----BEGIN ((RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY( BLOCK)?-----/;
const KNOWN_TOKENS: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "GitHub fine-grained token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b[sr]k_live_[A-Za-z0-9]{16,}\b/, "Stripe live key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
];
const ASSIGNED_LITERAL = /([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(?:[rbu]?)(["'`])([^"'`]*)\2/g;
const SECRET_NAME =
  /(password|passwd|pwd|secret|secret_?key|signing_?key|api_?key|token|credentials?|private_?key|access_?key)$/;
const PLACEHOLDER = /^[<{$%]|<|\$\{|\{\{|your|example|changeme|change_me|placeholder|dummy|redacted|xxxx|\*\*\*|^(none|null|undefined|true|false)$/i;

const JS_EVAL = /(^|[^\w.$])eval\s*\(|\bnew\s+Function\s*\(/;
const PY_EVAL = /(^|[^\w.])(eval|exec)\s*\(/;

const FOCUSED = /\b(describe|it|test|context|suite)\.only\s*\(|(^|[^\w.$])(fit|fdescribe)\s*\(/;
const SKIPPED =
  /\b(describe|it|test|context|suite)\.skip\s*\(|(^|[^\w.$])(xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip\b|@unittest\.skip\b|@(Disabled|Ignore)\b/;

const SQL_STRONG = /^\s*(select\b[\s\S]*\bfrom\b|insert\s+into\b|update\s+\w+\s+set\b|delete\s+from\b)/i;
const SQL_UPPER = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|VALUES|FROM|JOIN|ORDER BY|GROUP BY|LIMIT)\b/;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1).)*)\1/g;
const CONCAT = /["'`]\s*\+\s*[\w(]|[\w)\]]\s*\+\s*["'`]/;
const PY_FORMAT = /["']\s*%\s*[\w(]|["']\.format\s*\(|\b[rR]?f(["'])(?:(?!\1).)*\{[^}]+\}/;

function isSecretValue(value: string): boolean {
  if (value.length < 8 || /\s/.test(value) || PLACEHOLDER.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  // Values that look like env-var names, paths or URLs without credentials are configuration, not secrets.
  if (/^[A-Z][A-Z0-9_]+$/.test(value) || /^[./~]/.test(value) || /^https?:\/\/[^@]*$/.test(value)) return false;
  return true;
}

function hasSql(content: string): boolean {
  for (const m of content.matchAll(STRING_LITERAL)) {
    const body = m[2] ?? "";
    if (SQL_STRONG.test(body) || SQL_UPPER.test(body)) return true;
  }
  // Continuation lines of multi-line template literals carry SQL without opening quotes.
  return SQL_STRONG.test(content) || (SQL_UPPER.test(content) && content.includes("${"));
}

const emptyCatchRule: Rule = {
  id: "empty-catch",
  severity: "major",
  category: "correctness",
  description: "Catch/except block that silently swallows errors.",
  suggestion: "Handle the error, log it, or rethrow; if ignoring is intentional, add a comment explaining why.",
  check(ctx) {
    const hits: { line: number; message: string }[] = [];
    for (const view of ctx.views)
      for (let i = 0; i < view.length; i++) {
        const l = view[i]!;
        if (!l.added) continue;
        if (ctx.lang === "py") {
          const m = /^(\s*)except\b[^:]*:\s*(.*)$/.exec(l.split.code);
          if (!m) continue;
          const inline = m[2]!.trim();
          const next = view[i + 1];
          const nextIsPass = next !== undefined && next.split.code.trim() === "pass" && next.split.comment === "";
          const after = view[i + 2];
          const bodyEnds =
            after === undefined || after.content.trim() === "" || indent(after.content) <= m[1]!.length;
          if (inline === "pass" || (inline === "" && nextIsPass && bodyEnds))
            hits.push({ line: l.newLine, message: "`except` block only contains `pass`, silently swallowing errors." });
        } else {
          if (!/\bcatch\b/.test(l.split.code)) continue;
          const sameLine = /\bcatch\b\s*(\([^)]*\))?\s*\{\s*\}/.test(l.split.code) && l.split.comment === "";
          const next = view[i + 1];
          const opensBlock = /\bcatch\b\s*(\([^)]*\))?\s*\{\s*$/.test(l.split.code) && l.split.comment === "";
          const nextCloses = next !== undefined && /^\s*\}/.test(next.content);
          if (sameLine || (opensBlock && nextCloses))
            hits.push({ line: l.newLine, message: "Empty `catch` block silently swallows errors." });
        }
      }
    return hits;
  },
};

function indent(s: string): number {
  return s.length - s.trimStart().length;
}

const JS_FUNC_DECL =
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?(function\b|(\([^)]*\)|\w+)\s*(:\s*[^=]+)?=>)|^\s*(public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(?!(if|for|while|switch|catch|return|else)\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[^{;]+)?\{\s*$/;
const GO_FUNC_DECL = /^func\b/;
const JAVA_FUNC_DECL =
  /^\s*(public|private|protected|static|final|synchronized|abstract|\s)+[\w<>\[\], ]+\s+\w+\s*\([^)]*\)\s*(throws\s+[\w., ]+)?\s*\{?\s*$/;
const PY_FUNC_DECL = /^(\s*)(async\s+)?def\s+\w+/;

/** Returns the index of the last line of a brace-delimited body starting at `start`, or -1 if it is not closed in view. */
function braceBodyEnd(view: ViewLine[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < view.length; i++) {
    for (const c of view[i]!.split.code) {
      if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
    // A declaration with no body (e.g. an interface method) never opens a brace.
    if (!opened && i - start > 3) return -1;
  }
  return -1;
}

/** Returns the index of the last non-blank line of an indentation-delimited Python body. */
function pyBodyEnd(view: ViewLine[], start: number, defIndent: number): number {
  let last = start;
  for (let i = start + 1; i < view.length; i++) {
    const content = view[i]!.content;
    if (content.trim() === "") continue;
    if (indent(content) <= defIndent) break;
    last = i;
  }
  return last;
}

const longFunctionRule: Rule = {
  id: "long-function",
  severity: "minor",
  category: "maintainability",
  description: `Newly added function with a body longer than ${LONG_FUNCTION_LINES} lines.`,
  suggestion: "Split the function into smaller, well-named helpers.",
  check(ctx) {
    const hits: { line: number; message: string }[] = [];
    for (const view of ctx.views)
      for (let i = 0; i < view.length; i++) {
        const l = view[i]!;
        if (!l.added) continue;
        let end = -1;
        if (ctx.lang === "py") {
          const m = PY_FUNC_DECL.exec(l.split.code);
          if (m) end = pyBodyEnd(view, i, m[1]!.length);
        } else {
          const decl =
            ctx.lang === "go" ? GO_FUNC_DECL : ctx.lang === "java" ? JAVA_FUNC_DECL : JS_FUNC_DECL;
          if (decl.test(l.split.code)) end = braceBodyEnd(view, i);
        }
        if (end === -1) continue;
        const body = ctx.lang === "py" ? end - i : end - i - 1;
        const allAdded = view.slice(i, end + 1).every((v) => v.added);
        if (allAdded && body > LONG_FUNCTION_LINES) {
          hits.push({ line: l.newLine, message: `New function body is ${body} lines long (limit ${LONG_FUNCTION_LINES}).` });
          i = end;
        }
      }
    return hits;
  },
};

/** All built-in heuristic rules, in report order. */
export const RULES: readonly Rule[] = [
  lineRule(
    {
      id: "aws-access-key",
      severity: "critical",
      category: "security",
      description: "AWS access key id committed in source.",
      suggestion: "Revoke the key, load credentials from the environment or a secret manager, and purge it from history.",
    },
    (l) => (AWS_KEY.test(l.content) && !l.content.includes("EXAMPLE") ? "Hard-coded AWS access key id." : null),
  ),
  lineRule(
    {
      id: "private-key",
      severity: "critical",
      category: "security",
      description: "PEM private key committed in source.",
      suggestion: "Remove the key, rotate it, and load it from a secret store at runtime.",
    },
    (l) => (PRIVATE_KEY.test(l.content) ? "Private key material added to the repository." : null),
  ),
  lineRule(
    {
      id: "hardcoded-secret",
      severity: "critical",
      category: "security",
      description: "Credential literal (password, token, API key) or known token format hard-coded in source.",
      suggestion: "Read the value from an environment variable or secret manager instead.",
    },
    (l, ctx) => {
      for (const [re, label] of KNOWN_TOKENS) if (re.test(l.content)) return `Hard-coded ${label}.`;
      if (ctx.isTest || /\.(md|example|sample|template)$/i.test(ctx.path) || AWS_KEY.test(l.content)) return null;
      for (const m of l.content.matchAll(ASSIGNED_LITERAL)) {
        const name = (m[1] ?? "").replace(/-/g, "_").toLowerCase().split(".").pop() ?? "";
        if (SECRET_NAME.test(name)) {
          if (isSecretValue(m[3] ?? "")) return `Hard-coded credential assigned to \`${m[1]}\`.`;
        }
      }
      return null;
    },
  ),
  lineRule(
    {
      id: "sql-concat",
      severity: "major",
      category: "security",
      description: "SQL statement built by string concatenation or interpolation.",
      suggestion: "Use parameterized queries / bound parameters instead of building SQL strings.",
    },
    (l, ctx) => {
      if (!hasSql(l.content)) return null;
      const interpolated =
        CONCAT.test(l.content) ||
        /`[^`]*\$\{|^[^`]*\$\{[^}]+\}/.test(l.content) ||
        (ctx.lang === "py" && PY_FORMAT.test(l.content));
      return interpolated ? "SQL query built from interpolated values; risk of SQL injection." : null;
    },
  ),
  lineRule(
    {
      id: "eval-usage",
      severity: "major",
      category: "security",
      description: "Dynamic code execution via eval/new Function/exec.",
      suggestion: "Avoid evaluating strings as code; use a parser (e.g. JSON.parse, ast.literal_eval) or a dispatch table.",
    },
    (l, ctx) => {
      const re = ctx.lang === "py" ? PY_EVAL : ctx.lang === "js" ? JS_EVAL : null;
      return re && re.test(l.split.code) ? "Dynamic code execution of a string." : null;
    },
  ),
  lineRule(
    {
      id: "debugger-statement",
      severity: "major",
      category: "correctness",
      description: "Leftover debugger breakpoint.",
      suggestion: "Remove the breakpoint before merging.",
    },
    (l, ctx) => {
      const re = ctx.lang === "py" ? PY_DEBUGGER : ctx.lang === "js" ? JS_DEBUGGER : null;
      return re && re.test(l.split.code) ? "Debugger breakpoint left in code." : null;
    },
  ),
  lineRule(
    {
      id: "focused-test",
      severity: "major",
      category: "testing",
      description: "Focused test (.only / fit / fdescribe) that silently disables the rest of the suite.",
      suggestion: "Remove `.only` so the whole suite runs in CI.",
    },
    (l) => (FOCUSED.test(l.split.code) ? "Focused test will skip every other test in the file." : null),
  ),
  emptyCatchRule,
  lineRule(
    {
      id: "skipped-test",
      severity: "minor",
      category: "testing",
      description: "Test disabled via skip / xit / xdescribe / skip decorators.",
      suggestion: "Fix or delete the test instead of skipping it, or link a tracking issue.",
    },
    (l) => (SKIPPED.test(l.split.code) ? "Test is disabled." : null),
  ),
  lineRule(
    {
      id: "debug-output",
      severity: "minor",
      category: "style",
      description: "Leftover debug output (console.log / print).",
      suggestion: "Remove the statement or use the project's logger.",
    },
    (l, ctx) => {
      if (SCRIPT_PATH.test(ctx.path)) return null;
      if (ctx.lang === "js" && JS_DEBUG.test(l.split.code)) return "Leftover `console` debug output.";
      if (ctx.lang === "py" && PY_PRINT.test(l.split.code)) return "Leftover `print` debug output.";
      return null;
    },
  ),
  lineRule(
    {
      id: "todo-comment",
      severity: "info",
      category: "maintainability",
      description: "New TODO/FIXME/XXX/HACK comment.",
      suggestion: "Resolve it in this change or track it in an issue.",
    },
    (l) => {
      const m = TODO.exec(l.split.comment);
      return m ? `New ${m[1]} comment.` : null;
    },
  ),
  longFunctionRule,
  lineRule(
    {
      id: "long-line",
      severity: "info",
      category: "style",
      description: `Added source line longer than ${LONG_LINE_CHARS} characters.`,
      suggestion: "Wrap the line or extract parts into named variables.",
    },
    (l, ctx) =>
      isCodeFile(ctx.path) && l.content.length > LONG_LINE_CHARS
        ? `Line is ${l.content.length} characters long (limit ${LONG_LINE_CHARS}).`
        : null,
  ),
];

/** Builds the per-file context the rules operate on. */
export function fileContext(file: DiffFile): FileContext {
  const path = displayPath(file);
  const style = commentStyleOf(path);
  const views = file.hunks.map((h) =>
    h.lines
      .filter((l) => l.kind !== "del")
      .map((l) => ({ newLine: l.newLine!, content: l.content, added: l.kind === "add", split: splitLine(l.content, style) })),
  );
  return { path, lang: languageOf(path), isTest: isTestFile(path), views };
}

/** Offline, deterministic reviewer that runs the static {@link RULES} over added lines. */
export class HeuristicReviewer implements Reviewer {
  readonly name = "heuristic";
  readonly maxUnitTokens = Number.POSITIVE_INFINITY;

  constructor(private readonly rules: readonly Rule[] = RULES) {}

  /** Runs every rule on every file in the unit. */
  async review(unit: ReviewUnit): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of unit.files) {
      const ctx = fileContext(file);
      for (const rule of this.rules)
        for (const hit of rule.check(ctx))
          findings.push({
            file: ctx.path,
            line: hit.line,
            severity: rule.severity,
            category: rule.category,
            message: hit.message,
            suggestion: rule.suggestion,
            rule: rule.id,
          });
    }
    return findings;
  }
}
