/** Builds a git-style diff that adds `path` with the given content (one hunk, all lines added). */
export function newFileDiff(path: string, content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

/** Joins lines with "\n" and a trailing newline, for readable inline diffs in tests. */
export function lines(...ls: string[]): string {
  return ls.join("\n") + "\n";
}
