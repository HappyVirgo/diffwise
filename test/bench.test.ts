import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandFakes } from "../bench/fakes.js";
import { generateLargeDiff } from "../bench/generate.js";
import { metrics, scoreFixture, sumCounts, type Counts } from "../bench/score.js";
import { parseDiff } from "../src/diff/parse.js";

describe("bench scoring", () => {
  it("matches exactly on file, line and rule as a multiset", () => {
    const perRule = new Map<string, Counts>();
    const e = [
      { file: "a", line: 1, rule: "x" },
      { file: "a", line: 1, rule: "x" },
      { file: "a", line: 2, rule: "y" },
    ];
    const p = [
      { file: "a", line: 1, rule: "x" },
      { file: "a", line: 3, rule: "y" },
    ];
    expect(scoreFixture(e, p, perRule)).toEqual({ tp: 1, fp: 1, fn: 2 });
    expect(perRule.get("x")).toEqual({ tp: 1, fp: 0, fn: 1 });
    expect(sumCounts(perRule)).toEqual({ tp: 1, fp: 1, fn: 2 });
  });

  it("reports null for undefined ratios", () => {
    expect(metrics({ tp: 0, fp: 0, fn: 0 })).toEqual({ precision: null, recall: null, f1: null });
    expect(metrics({ tp: 3, fp: 1, fn: 0 })).toEqual({ precision: 0.75, recall: 1, f1: 3 / 3.5 });
  });

  it("generates a deterministic, parseable large diff", () => {
    const d = generateLargeDiff(20, 5);
    expect(generateLargeDiff(20, 5)).toBe(d);
    expect(parseDiff(d)).toHaveLength(20);
  });

  it("every fixture is a well-formed diff with a matching label file", () => {
    for (const split of ["dev", "holdout"]) {
      const dir = join(import.meta.dirname, "..", "bench", "fixtures", split);
      const patches = readdirSync(dir).filter((f) => f.endsWith(".patch"));
      expect(patches.length).toBeGreaterThan(0);
      for (const p of patches) {
        expect(() => parseDiff(expandFakes(readFileSync(join(dir, p), "utf8")))).not.toThrow();
        const labels = JSON.parse(readFileSync(join(dir, p.replace(/\.patch$/, ".expected.json")), "utf8"));
        expect(Array.isArray(labels.findings)).toBe(true);
      }
    }
  });
});
