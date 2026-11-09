/** Small deterministic PRNG (mulberry32) so generated diffs are identical across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SNIPPETS = [
  "const total = items.reduce((acc, item) => acc + item.price * item.qty, 0);",
  "if (!user || !user.isActive) return null;",
  "for (const row of rows) result.push(transform(row, options));",
  "export function formatCurrency(value: number, locale = 'en-US'): string {",
  "  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value);",
  "}",
  "await queue.publish({ type: 'order.created', payload: order });",
  "const parsed = schema.safeParse(input);",
  "logger.info('request handled', { status, durationMs });",
  "",
];

/**
 * Generates a synthetic multi-file unified diff with `files` files and `hunksPerFile`
 * modification hunks each (3 context lines on both sides, 1-4 deletions, 1-6 additions).
 */
export function generateLargeDiff(files: number, hunksPerFile: number, seed = 42): string {
  const rand = rng(seed);
  const pick = (): string => SNIPPETS[Math.floor(rand() * SNIPPETS.length)]!;
  const out: string[] = [];
  for (let f = 0; f < files; f++) {
    const path = `src/module${Math.floor(f / 50)}/file${f}.ts`;
    out.push(`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`);
    let oldLine = 1;
    let newLine = 1;
    for (let h = 0; h < hunksPerFile; h++) {
      const gap = 10 + Math.floor(rand() * 40);
      oldLine += gap;
      newLine += gap;
      const dels = 1 + Math.floor(rand() * 4);
      const adds = 1 + Math.floor(rand() * 6);
      out.push(`@@ -${oldLine},${6 + dels} +${newLine},${6 + adds} @@ function block${h}() {`);
      for (let i = 0; i < 3; i++) out.push(` ${pick()}`);
      for (let i = 0; i < dels; i++) out.push(`-${pick()}`);
      for (let i = 0; i < adds; i++) out.push(`+${pick()}`);
      for (let i = 0; i < 3; i++) out.push(` ${pick()}`);
      oldLine += 6 + dels;
      newLine += 6 + adds;
    }
  }
  return out.join("\n") + "\n";
}
