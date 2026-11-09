/** Comment syntax family used to split code from comments. */
export type CommentStyle = "slash" | "hash";

/** Coarse language family derived from a file extension. */
export type Language = "js" | "py" | "go" | "java" | "other";

const EXT_LANG: Record<string, Language> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", pyi: "py",
  go: "go",
  java: "java", kt: "java", scala: "java", cs: "java",
};

const HASH_EXTS = new Set(["py", "pyi", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "r", "pl", "ps1"]);

const CODE_EXTS = new Set([
  ...Object.keys(EXT_LANG),
  "rb", "rs", "c", "h", "cc", "cpp", "hpp", "php", "swift", "sh", "bash", "sql", "css", "scss", "less", "html", "lua", "dart",
]);

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Returns the language family of a path. */
export function languageOf(path: string): Language {
  return EXT_LANG[extension(path)] ?? "other";
}

/** Returns the comment style used by a path's language. */
export function commentStyleOf(path: string): CommentStyle {
  return HASH_EXTS.has(extension(path)) ? "hash" : "slash";
}

/** True for source-code files (as opposed to docs, data or config). */
export function isCodeFile(path: string): boolean {
  return CODE_EXTS.has(extension(path));
}

/** True for paths that look like test files. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /([._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$)/.test(path);
}

/** A source line split into code (string contents blanked out) and trailing comment text. */
export interface SplitLine {
  code: string;
  comment: string;
}

/**
 * Splits one line into code and comment with a small quote-aware scanner. String literal
 * contents are replaced by spaces in `code` (quotes are kept) so that patterns inside
 * strings do not match code rules. Lines starting a block-comment continuation (`*`, `/*`)
 * are treated as entirely comment. Multi-line strings are not tracked.
 */
export function splitLine(line: string, style: CommentStyle): SplitLine {
  const trimmed = line.trimStart();
  if (style === "slash" && (trimmed.startsWith("/*") || trimmed.startsWith("*"))) return { code: "", comment: trimmed };
  let code = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\") {
        code += "  ";
        i++;
      } else if (c === quote) {
        code += c;
        quote = null;
      } else {
        code += " ";
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      code += c;
    } else if (style === "slash" && c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) {
      return { code, comment: line.slice(i) };
    } else if (style === "hash" && c === "#") {
      return { code, comment: line.slice(i) };
    } else {
      code += c;
    }
  }
  return { code, comment: "" };
}
