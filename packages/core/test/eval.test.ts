import { describe, expect, it } from "vitest";
import { runEval } from "../src/eval/run.ts";
import { renderEvalMarkdown, renderReadmeResults } from "../src/eval/report.ts";
import { FUZZY_KINDS } from "../src/eval/score.ts";
import { cfg } from "./fixtures.ts";

describe("evaluation harness", () => {
  const result = runEval({ cfg, payments: 3000, days: 45, seeds: [11, 12, 13], minPerType: 1_000_000, sweep: { payments: [2000], seeds: [11] } });

  it("consumes the fixed seeds in order and stops only on truth-label coverage", () => {
    // An unreachable minimum means coverage is never met: every seed is used, none skipped or reordered.
    expect(result.seedsUsed).toEqual([11, 12, 13]);
    expect(result.stoppedEarly).toBe(false);
    expect(result.shortfall.length).toBeGreaterThan(0);
    const early = runEval({ cfg, payments: 3000, days: 45, seeds: [11, 12, 13], minPerType: 0, sweep: { payments: [], seeds: [] } });
    expect(early.seedsUsed).toEqual([11]);
  });

  it("scores consistently: every truth-linked credit and missing credit lands in exactly one outcome", () => {
    for (const run of result.runs) {
      for (const s of [run.dev, run.heldout]) {
        expect(s.credits.correct + s.credits.wrong + s.credits.unmatched).toBe(s.credits.truth_linked);
        expect(s.missing_credit.detected + s.missing_credit.deferred + s.missing_credit.missed).toBe(s.missing_credit.n);
        for (const k of FUZZY_KINDS) for (const v of Object.values(s.fuzzy[k])) expect(v).toBeGreaterThanOrEqual(0);
        if (s.split === "dev") expect(s.fuzzy.HELDOUT_OCR_CONFUSION.missed + s.fuzzy.HELDOUT_NARRATION_FORMAT.missed).toBe(0);
      }
    }
  });

  it("renders a report and README block from the run, with no placeholder numbers", () => {
    const md = renderEvalMarkdown(result, { generatedAt: "2026-11-03T00:00:00Z", commit: null, command: "test" });
    expect(md).toContain("## Exceptions: precision and recall per type");
    expect(md).toContain("Coverage shortfall");
    const block = renderReadmeResults(result);
    expect(block.split("\n")).toHaveLength(3);
    expect(block).toContain("EVAL.md");
  });
});
