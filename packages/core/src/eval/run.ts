import type { CloseLoopConfig } from "../config.ts";
import { openReconDb, openTruthDb } from "../db/open.ts";
import { generateDataset, type Dataset } from "../generator/generate.ts";
import { loadDataset } from "../generator/load.ts";
import { heldoutCoverage, partitionDataset, type CoverageRow } from "../generator/split.ts";
import { runReconciliation } from "../matcher/run.ts";
import { readTruthLabels, readTruthLinks } from "../truth/store.ts";
import type { Split, TruthLabel } from "../types.ts";
import { BATCH_OUTCOMES, scoreSplit, type BatchOutcome, type SplitScore } from "./score.ts";

const zeroBatch = () => Object.fromEntries(BATCH_OUTCOMES.map((o) => [o, 0])) as Record<BatchOutcome, number>;

export interface EvalOptions {
  cfg: CloseLoopConfig;
  payments: number;
  days: number;
  /** Fixed up front. Consumed in order; the run may stop early only on truth-label coverage. */
  seeds: number[];
  minPerType: number;
  sweep: { payments: number[]; seeds: number[] };
}

export interface SeedRun {
  seed: number;
  dev: SplitScore;
  heldout: SplitScore;
}

export interface SweepRow {
  payments: number;
  payments_per_day: number;
  seeds: number[];
  score: Pick<SplitScore, "batch">;
  max_pool: number;
  credits: number;
}

export interface EvalResult {
  options: Omit<EvalOptions, "cfg">;
  runs: SeedRun[];
  seedsUsed: number[];
  coverage: CoverageRow[];
  shortfall: CoverageRow[];
  stoppedEarly: boolean;
  sweep: SweepRow[];
  totalMs: number;
}

const recordsOf = (d: Dataset) => d.payments.length + d.settlements.length + d.bankLines.length + d.ledgerEntries.length;

/** Load one split into its own in-memory recon DB and truth DB, reconcile, and score. */
function evaluateSplit(cfg: CloseLoopConfig, seed: number, split: Split, data: Dataset): { score: SplitScore; maxPool: number } {
  const recon = openReconDb(":memory:");
  const truth = openTruthDb(":memory:");
  try {
    loadDataset(recon, truth, data);
    // The matcher only ever sees `recon`. Truth is read back separately, after the run.
    const { result } = runReconciliation(recon, cfg);
    const score = scoreSplit({ seed, split, labels: readTruthLabels(truth), links: readTruthLinks(truth), result, records: recordsOf(data) });
    return { score, maxPool: result.batch.max_pool };
  } finally {
    recon.close();
    truth.close();
  }
}

export function runEval(opts: EvalOptions): EvalResult {
  const started = performance.now();
  const { cfg, ...options } = opts;
  const runs: SeedRun[] = [];
  const heldoutLabels: TruthLabel[] = [];
  let coverage: CoverageRow[] = [];

  for (const seed of opts.seeds) {
    const ds = generateDataset({ seed, payments: opts.payments, days: opts.days, config: cfg });
    const parts = partitionDataset(ds);
    runs.push({ seed, dev: evaluateSplit(cfg, seed, "dev", parts.dev).score, heldout: evaluateSplit(cfg, seed, "heldout", parts.heldout).score });
    heldoutLabels.push(...parts.heldout.labels);
    // Stopping rule: truth-label counts only, never matcher results.
    coverage = heldoutCoverage(heldoutLabels, opts.minPerType);
    if (coverage.every((c) => c.ok)) break;
  }

  // Batch behaviour as daily volume grows (full datasets, both splits together).
  const sweep: SweepRow[] = opts.sweep.payments.map((payments) => {
    const merged: SplitScore["batch"] = { contiguous: zeroBatch(), non_contiguous: zeroBatch() };
    let maxPool = 0;
    let credits = 0;
    for (const seed of opts.sweep.seeds) {
      const ds = generateDataset({ seed, payments, days: opts.days, config: cfg });
      const { score, maxPool: pool } = evaluateSplit(cfg, seed, "dev", ds);
      maxPool = Math.max(maxPool, pool);
      credits += ds.bankLines.filter((l) => l.credit_paise > 0).length;
      for (const side of ["contiguous", "non_contiguous"] as const) for (const o of BATCH_OUTCOMES) merged[side][o] += score.batch[side][o];
    }
    return { payments, payments_per_day: Math.round(payments / opts.days), seeds: opts.sweep.seeds, score: { batch: merged }, max_pool: maxPool, credits };
  });

  return {
    options,
    runs,
    seedsUsed: runs.map((r) => r.seed),
    coverage,
    shortfall: coverage.filter((c) => !c.ok),
    stoppedEarly: runs.length < opts.seeds.length,
    sweep,
    totalMs: performance.now() - started,
  };
}
