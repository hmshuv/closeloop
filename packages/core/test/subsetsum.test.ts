import { describe, expect, it } from "vitest";
import { contiguousRuns } from "../src/matcher/stage2-batch.ts";
import { boundedLevenshtein, utrCandidateTokens } from "../src/matcher/similarity.ts";
import { findSubsetsWithSum } from "../src/matcher/subsetsum.ts";

const opts = { timeBudgetMs: 250, nodeBudget: 5_000_000, mitmMaxN: 36, maxSets: 10 };
const sumOf = (values: number[], idx: number[]) => idx.reduce((s, i) => s + (values[i] as number), 0);

describe("bounded subset-sum", () => {
  it("finds a unique decomposition (meet-in-the-middle)", () => {
    const values = [1_234_567, 2_345_678, 3_456_789, 987_654, 5_555_501];
    const res = findSubsetsWithSum(values, 1_234_567 + 3_456_789 + 5_555_501, opts);
    expect(res.status).toBe("unique");
    expect(res.method).toBe("mitm");
    expect(res.uniquenessProven).toBe(true);
    expect(res.solutions[0]?.sort()).toEqual([0, 2, 4]);
  });

  it("reports ambiguity with every candidate set when equal amounts make it undecidable", () => {
    const values = [97_000, 150_000, 97_000, 33_333];
    const res = findSubsetsWithSum(values, 247_000, opts);
    expect(res.status).toBe("ambiguous");
    expect(res.solutionCount).toBe(2);
    for (const sol of res.solutions) expect(sumOf(values, sol)).toBe(247_000);
  });

  it("reports none when no subset sums to the credit", () => {
    expect(findSubsetsWithSum([100, 200, 400], 350, opts).status).toBe("none");
    expect(findSubsetsWithSum([100, 200], 1_000, opts).status).toBe("none");
  });

  it("uses branch-and-bound with the complement trick above the MITM limit and still proves uniqueness", () => {
    // A superincreasing sequence (each amount exceeds the sum of all smaller ones): every subset sum is unique.
    const values = Array.from({ length: 40 }, (_, i) => 2 ** i * 1_000 + 1);
    const excluded = new Set([3, 17, 29]);
    const target = values.reduce((s, v, i) => (excluded.has(i) ? s : s + v), 0);
    const res = findSubsetsWithSum(values, target, opts);
    expect(res.method).toBe("dfs");
    expect(res.complement).toBe(true);
    expect(res.status).toBe("unique");
    expect(sumOf(values, res.solutions[0] ?? [])).toBe(target);
  });

  it("respects the time budget on a pathological input", () => {
    // 60 near-equal even amounts and an odd target: no solution exists, but pruning can't prove it quickly.
    const values = Array.from({ length: 60 }, (_, i) => 1_000_000 + 2 * i);
    const budget = 50;
    const started = performance.now();
    const res = findSubsetsWithSum(values, 15_000_001, { ...opts, timeBudgetMs: budget, nodeBudget: Number.MAX_SAFE_INTEGER });
    const elapsed = performance.now() - started;
    expect(res.status).toBe("budget_exhausted");
    expect(res.uniquenessProven).toBe(false);
    expect(elapsed).toBeLessThan(budget + 100);
  });

  it("rejects non-integer money", () => {
    expect(() => findSubsetsWithSum([1.5, 2], 3, opts)).toThrow();
    expect(() => findSubsetsWithSum([1, 2], 2.5, opts)).toThrow();
  });
});

describe("contiguous runs", () => {
  it("finds every run of consecutive amounts that sums to the target", () => {
    expect(contiguousRuns([5, 10, 15, 10, 5], 25)).toEqual([[1, 2], [2, 3]]);
    expect(contiguousRuns([5, 10, 15], 20)).toEqual([]);
    expect(contiguousRuns([7], 7)).toEqual([[0, 0]]);
  });
});

describe("UTR similarity", () => {
  it("computes bounded Levenshtein distance", () => {
    expect(boundedLevenshtein("AXISN26278123456", "AXISN26278123456", 2)).toBe(0);
    expect(boundedLevenshtein("AXJSN26278123456", "AXISN26278123456", 2)).toBe(1);
    expect(boundedLevenshtein("AXJSN26278123446", "AXISN26278123456", 2)).toBe(2);
    expect(boundedLevenshtein("HDFCN11111111111", "AXISN26278123456", 2)).toBe(3); // capped at max + 1
  });

  it("rebuilds UTRs split by separators from adjacent tokens", () => {
    const tokens = utrCandidateTokens("IMPS-INF/RZP PAYOUTS/MID123/REF AXISN.26296.123456/SETTLEMENT CR", 8, 22);
    expect(tokens).toContain("AXISN26296123456");
  });
});
