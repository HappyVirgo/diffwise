/** A labelled or predicted finding reduced to what the benchmark compares. */
export interface LabelledFinding {
  file: string;
  line: number;
  rule: string;
}

/** True/false positive and false negative counts. */
export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

const key = (f: LabelledFinding): string => `${f.file}\0${f.line}\0${f.rule}`;

/**
 * Matches predictions to expectations exactly on (file, line, rule), as multisets,
 * and accumulates counts per rule into `perRule`.
 */
export function scoreFixture(
  expected: LabelledFinding[],
  predicted: LabelledFinding[],
  perRule: Map<string, Counts>,
): Counts {
  const remaining = new Map<string, number>();
  for (const e of expected) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);
  const total: Counts = { tp: 0, fp: 0, fn: 0 };
  const bump = (rule: string, field: keyof Counts): void => {
    const c = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    c[field]++;
    perRule.set(rule, c);
    total[field]++;
  };
  for (const p of predicted) {
    const n = remaining.get(key(p)) ?? 0;
    if (n > 0) {
      remaining.set(key(p), n - 1);
      bump(p.rule, "tp");
    } else {
      bump(p.rule, "fp");
    }
  }
  for (const e of expected) {
    const n = remaining.get(key(e)) ?? 0;
    if (n > 0) {
      remaining.set(key(e), n - 1);
      bump(e.rule, "fn");
    }
  }
  return total;
}

/** Precision, recall and F1; a metric with an empty denominator is reported as null. */
export function metrics(c: Counts): { precision: number | null; recall: number | null; f1: number | null } {
  const precision = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? null : c.tp / (c.tp + c.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** Sums counts over all rules. */
export function sumCounts(perRule: Map<string, Counts>): Counts {
  const t: Counts = { tp: 0, fp: 0, fn: 0 };
  for (const c of perRule.values()) {
    t.tp += c.tp;
    t.fp += c.fp;
    t.fn += c.fn;
  }
  return t;
}
