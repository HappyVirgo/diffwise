import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff/parse.js";
import { HeuristicReviewer, RULES } from "../src/review/heuristic.js";
import { splitLine } from "../src/review/source.js";
import { lines, newFileDiff } from "./helpers.js";

async function hits(path: string, content: string): Promise<string[]> {
  const files = parseDiff(newFileDiff(path, content));
  const findings = await new HeuristicReviewer().review({ index: 0, files, tokens: 0 });
  return findings.map((f) => `${f.line}:${f.rule}`);
}

describe("splitLine", () => {
  it("blanks string contents and separates comments", () => {
    expect(splitLine(`const s = "a // b"; // note`, "slash")).toEqual({ code: `const s = "      "; `, comment: "// note" });
    expect(splitLine(`x = '#' # real`, "hash")).toEqual({ code: `x = ' ' `, comment: "# real" });
    expect(splitLine(` * TODO in block`, "slash").comment).toContain("TODO");
  });
});

describe("HeuristicReviewer rules", () => {
  it.each<[string, string, string, string[]]>([
    ["debug-output js", "src/a.ts", "console.log(x);\nconsole.error(err);\n// console.log(old)", ["1:debug-output"]],
    ["debug-output py", "app/a.py", "print('x')\nlog.info('y')\nself.print_report()", ["1:debug-output"]],
    ["debug-output ignored in scripts", "scripts/seed.ts", "console.log('seeded');", []],
    ["debugger js", "src/a.js", "debugger;\nconst debuggerEnabled = true;", ["1:debugger-statement"]],
    ["debugger py", "app/a.py", "import pdb; pdb.set_trace()\nbreakpoint()", ["1:debugger-statement", "2:debugger-statement"]],
    ["todo in comment only", "src/a.ts", 'const t = "TODO";\n// FIXME later\nx(); # not a comment in ts', ["2:todo-comment"]],
    ["todo python", "a.py", "x = 1  # HACK: works for now", ["1:todo-comment"]],
    ["aws key", "src/c.ts", 'const id = "AKIA' + 'Q3EXFAKEK7Z2WQ4N";\nconst doc = "AKIA' + 'IOSFODNN7EXAMPLE";', ["1:aws-access-key"]],
    ["private key", "k.pem", "-----BEGIN OPENSSH PRIVATE" + " KEY-----\nabc\n-----END OPENSSH PRIVATE" + " KEY-----", ["1:private-key"]],
    [
      "generic secrets",
      "src/s.ts",
      [
        'const apiKey = "q8Zr4LmN2vX7pT1s";',
        'const password = process.env.PASSWORD ?? "";',
        'const token = "<your-token>";',
        'const tokenUrl = "https://auth.example.com/token";',
        'const SLACK = "xox' + 'b-1234567890-abcdefghij";',
        "if (secret == \"abcdefgh12\") {}",
      ].join("\n"),
      ["1:hardcoded-secret", "5:hardcoded-secret"],
    ],
    ["generic secret skipped in tests", "test/s.test.ts", 'const password = "hunter2hunter2";', []],
    ["eval js", "src/e.ts", 'eval(code);\nnew Function("a", body);\nregex.exec(s);\nconst s = "eval(x)";', ["1:eval-usage", "2:eval-usage"]],
    ["eval py", "x.py", "exec(src)\nast.literal_eval(s)\ncursor.execute(q)", ["1:eval-usage"]],
    ["empty catch inline", "src/c.ts", "try { a(); } catch (e) {}", ["1:empty-catch"]],
    ["empty catch multiline", "src/c.ts", "try {\n  a();\n} catch (e) {\n}\n", ["3:empty-catch"]],
    ["catch with comment is intentional", "src/c.ts", "try {\n  a();\n} catch {\n  // ignore: best effort\n}", []],
    ["except pass", "c.py", "try:\n    a()\nexcept ValueError:\n    pass\nb()", ["3:empty-catch"]],
    ["except inline pass", "c.py", "try:\n    a()\nexcept: pass", ["3:empty-catch"]],
    ["except that handles", "c.py", "try:\n    a()\nexcept ValueError:\n    pass_count += 1", []],
    ["focused tests", "t.test.ts", "describe.only('x', () => {});\nfit('y', () => {});\nit('only works', () => {});", ["1:focused-test", "2:focused-test"]],
    ["skipped tests", "t.test.js", "it.skip('a', f);\nxdescribe('b', f);\n@pytest.mark.skipif(x)", ["1:skipped-test", "2:skipped-test"]],
    ["skipped pytest", "tests/test_a.py", "@pytest.mark.skip(reason='x')\ndef test_a():\n    pass", ["1:skipped-test"]],
    [
      "sql concat js",
      "src/q.ts",
      [
        'db.query("SELECT * FROM t WHERE id = " + id);',
        'db.query("SELECT * FROM t WHERE id = $1", [id]);',
        "db.query(`DELETE FROM t WHERE id = ${id}`);",
        'const msg = "Select an option " + name;',
      ].join("\n"),
      ["1:sql-concat", "3:sql-concat"],
    ],
    [
      "sql python",
      "q.py",
      'cur.execute(f"SELECT * FROM t WHERE a = \'{a}\'")\ncur.execute("UPDATE t SET a = %s", (a,))\nq = "INSERT INTO t VALUES ({})".format(v)',
      ["1:sql-concat", "3:sql-concat"],
    ],
    ["long line", "src/l.ts", `const x = "${"a".repeat(170)}";`, ["1:long-line"]],
    ["long line ignored in docs", "README.md", "a".repeat(200), []],
  ])("%s", async (_name, path, content, expected) => {
    expect(await hits(path, content)).toEqual(expected);
  });

  it("flags only newly added long functions, at the declaration line", async () => {
    const body = Array.from({ length: 55 }, (_, i) => `  x += ${i};`).join("\n");
    expect(await hits("src/f.ts", `const y = 1;\nexport async function big(x: number) {\n${body}\n  return x;\n}\n`)).toEqual([
      "2:long-function",
    ]);
    expect(await hits("src/f.ts", `function small() {\n  return 1;\n}\n`)).toEqual([]);
    const pyBody = Array.from({ length: 52 }, (_, i) => `    x += ${i}`).join("\n");
    expect(await hits("f.py", `def big(x):\n${pyBody}\n    return x\n\n\ndef other():\n    pass\n`)).toEqual(["1:long-function"]);
  });

  it("does not flag a long function that was only partially changed", async () => {
    const ctx = Array.from({ length: 60 }, (_, i) => `   x += ${i};`);
    const diff = lines(
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,63 +1,63 @@",
      "+function big(x) {",
      "-function big(y) {",
      ...ctx,
      " }",
      " ",
    );
    const findings = await new HeuristicReviewer().review({ index: 0, files: parseDiff(diff), tokens: 0 });
    expect(findings).toEqual([]);
  });

  it("never fires on deleted lines", async () => {
    const diff = lines("diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,1 @@", "-console.log(x); debugger;", " ok();");
    expect(await new HeuristicReviewer().review({ index: 0, files: parseDiff(diff), tokens: 0 })).toEqual([]);
  });

  it("fills every Finding field from rule metadata", async () => {
    const [f] = await new HeuristicReviewer().review({ index: 0, files: parseDiff(newFileDiff("a.ts", "eval(x)")), tokens: 0 });
    const rule = RULES.find((r) => r.id === "eval-usage")!;
    expect(f).toEqual({
      file: "a.ts",
      line: 1,
      rule: "eval-usage",
      severity: rule.severity,
      category: rule.category,
      message: expect.any(String),
      suggestion: rule.suggestion,
    });
  });

  it("has unique rule ids", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
});
