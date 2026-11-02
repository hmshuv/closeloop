import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloseLoopConfig } from "../config.ts";
import type { Db } from "../db/open.ts";
import { EXCEPTION_TYPES, IsoDateSchema, type ExceptionType } from "../types.ts";
import { summarizeExposure } from "./exposure.ts";
import { datasetMeta, loadSource } from "./load.ts";
import { reconcile, type ReconResult } from "./reconcile.ts";
import { EXPOSURE_CLASSES, MATCH_KINDS, type MatchKind } from "./types.ts";

const Counted = z.object({ count: z.number().int().nonnegative(), amount_paise: z.number().int().safe() });

export const ReconSummarySchema = z.object({
  run_id: z.string().uuid(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  as_of: IsoDateSchema,
  matched: z.object({
    payments_settled: z.number().int(),
    bank_exact: z.number().int(),
    bank_fuzzy: z.number().int(),
    bank_batch_contiguous_credits: z.number().int(),
    bank_batch_credits: z.number().int(),
    bank_batch_settlements: z.number().int(),
    ledger_by_reference: z.number().int(),
    ledger_by_attributes: z.number().int(),
    journals: z.number().int(),
  }),
  pending: z.object({
    payments_in_window: z.number().int(),
    receipts_in_grace: z.number().int(),
    /** Settlements whose bank credit depends on an open AMBIGUOUS_BATCH / MATCH_CONFLICT decision. */
    unresolved_in_batch: z.number().int(),
  }),
  exceptions_by_type: z.object(Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, Counted])) as Record<ExceptionType, typeof Counted>),
  /** Never summed across classes. */
  exposure_by_class: z.object(Object.fromEntries(EXPOSURE_CLASSES.map((c) => [c, Counted])) as Record<(typeof EXPOSURE_CLASSES)[number], typeof Counted>),
  tie_out: z.object({
    bank_credits_paise: z.number().int(),
    book_receipts_paise: z.number().int(),
    difference_paise: z.number().int(),
    explained_paise: z.number().int(),
    residual_paise: z.number().int(),
  }),
  /** Run-wide search statistics (all data up to `to`), unlike the period-filtered counts above. */
  batch: z.object({
    attempted: z.number().int(),
    contiguous_decomposed: z.number().int(),
    decomposed: z.number().int(),
    ambiguous: z.number().int(),
    conflicts: z.number().int(),
    single_settlement_suggested: z.number().int(),
    none: z.number().int(),
    budget_exhausted: z.number().int(),
    max_pool: z.number().int(),
  }),
  duration_ms: z.number().nonnegative(),
});
export type ReconSummary = z.infer<typeof ReconSummarySchema>;

/** Summarise a result for the reporting period [from, to]. Matching itself used all data up to `to`. */
export function summarize(runId: string, result: ReconResult, from: string, to: string): ReconSummary {
  const inPeriod = (d: string) => d >= from && d <= to;
  const exceptions = result.exceptions.filter((e) => inPeriod(e.anchor_date));
  const byType = Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, { count: 0, amount_paise: 0 }])) as Record<ExceptionType, { count: number; amount_paise: number }>;
  for (const e of exceptions) {
    byType[e.type].count++;
    byType[e.type].amount_paise += e.amount_paise;
  }
  const kinds = Object.fromEntries(MATCH_KINDS.map((k) => [k, new Set<string>()])) as Record<MatchKind, Set<string>>;
  const matches = result.matches.filter((m) => inPeriod(m.anchor_date));
  for (const m of matches) kinds[m.kind].add(m.kind === "BATCH" || m.kind === "BATCH_CONTIGUOUS" ? m.right.id : `${m.left.id}>${m.right.id}`);
  const batchSettlements = matches.filter((m) => m.kind === "BATCH" || m.kind === "BATCH_CONTIGUOUS").length;
  return {
    run_id: runId,
    from,
    to,
    as_of: to,
    matched: {
      payments_settled: kinds.ITEM.size,
      bank_exact: kinds.EXACT.size,
      bank_fuzzy: kinds.FUZZY.size,
      bank_batch_contiguous_credits: kinds.BATCH_CONTIGUOUS.size,
      bank_batch_credits: kinds.BATCH.size,
      bank_batch_settlements: batchSettlements,
      ledger_by_reference: kinds.LEDGER_REF.size,
      ledger_by_attributes: kinds.LEDGER_ATTR.size,
      journals: kinds.JOURNAL.size,
    },
    pending: { ...result.pending, unresolved_in_batch: result.deferred.filter((d) => inPeriod(d.settled_at)).length },
    exceptions_by_type: byType,
    exposure_by_class: summarizeExposure(exceptions),
    tie_out: {
      bank_credits_paise: result.tieOut.bank_credits_paise,
      book_receipts_paise: result.tieOut.book_receipts_paise,
      difference_paise: result.tieOut.difference_paise,
      explained_paise: result.tieOut.explained_paise,
      residual_paise: result.tieOut.residual_paise,
    },
    batch: {
      attempted: result.batch.attempted,
      contiguous_decomposed: result.batch.contiguous_decomposed,
      decomposed: result.batch.decomposed,
      ambiguous: result.batch.ambiguous,
      conflicts: result.batch.conflicts,
      single_settlement_suggested: result.batch.single_settlement_suggested,
      none: result.batch.none,
      budget_exhausted: result.batch.budget_exhausted,
      max_pool: result.batch.max_pool,
    },
    duration_ms: Math.round(result.durationMs),
  };
}

function configHash(cfg: CloseLoopConfig): string {
  const plain = { windows: cfg.windows, fees: cfg.fees, matching: cfg.matching };
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex").slice(0, 16);
}

export interface RunOptions {
  from?: string;
  to?: string;
}

/**
 * Run the engine against the recon DB and persist the run, its matches and exceptions.
 * Writes only to recon_runs / matches / exceptions / batch_candidate_sets — never to financial tables.
 */
export function runReconciliation(db: Db, cfg: CloseLoopConfig, opts: RunOptions = {}): { summary: ReconSummary; result: ReconResult } {
  const meta = datasetMeta(db);
  const to = opts.to ?? meta.as_of;
  const from = opts.from ?? meta.period_start;
  if (!to || !from) throw new Error("Database has no dataset metadata; generate data first (pnpm gen).");
  IsoDateSchema.parse(from);
  IsoDateSchema.parse(to);
  if (from > to) throw new Error(`from (${from}) must not be after to (${to})`);

  const startedAt = new Date().toISOString();
  const result = reconcile(loadSource(db, to), cfg, { from, to });
  const runId = randomUUID();
  const summary = ReconSummarySchema.parse(summarize(runId, result, from, to));

  const insertRun = db.prepare(
    "INSERT INTO recon_runs (id, from_date, to_date, as_of, started_at, finished_at, config_hash, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMatch = db.prepare(
    "INSERT INTO matches (id, run_id, kind, left_type, left_id, right_type, right_id, confidence, reason_code, anchor_date, trace_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertException = db.prepare(
    `INSERT INTO exceptions (id, run_id, type, exposure_class, amount_paise, subtype, primary_type, primary_id, anchor_date, related_json, trace_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  );
  const insertSet = db.prepare("INSERT INTO batch_candidate_sets (exception_id, set_index, settlement_ids_json) VALUES (?, ?, ?)");
  const insertReview = db.prepare(
    "INSERT INTO settlement_reviews (run_id, settlement_id, exception_id, status, updated_at) VALUES (?, ?, ?, 'unresolved_in_batch', ?)",
  );

  db.transaction(() => {
    insertRun.run(runId, from, to, to, startedAt, new Date().toISOString(), configHash(cfg), JSON.stringify(summary));
    for (const m of result.matches) {
      insertMatch.run(randomUUID(), runId, m.kind, m.left.type, m.left.id, m.right.type, m.right.id, m.confidence, m.reason, m.anchor_date, JSON.stringify(m.trace));
    }
    const batchExceptionOf = new Map<string, string>();
    for (const e of result.exceptions) {
      const id = randomUUID();
      if (e.type === "AMBIGUOUS_BATCH" || e.type === "MATCH_CONFLICT") batchExceptionOf.set(e.primary.id, id);
      insertException.run(id, runId, e.type, e.exposure_class, e.amount_paise, e.subtype ?? null, e.primary.type, e.primary.id, e.anchor_date, JSON.stringify(e.related), JSON.stringify(e.trace));
      e.candidate_sets?.forEach((set, i) => insertSet.run(id, i, JSON.stringify(set)));
    }
    const at = new Date().toISOString();
    for (const d of result.deferred) {
      for (const line of d.bank_line_ids) {
        const exceptionId = batchExceptionOf.get(line);
        if (exceptionId) insertReview.run(runId, d.settlement_id, exceptionId, at);
      }
    }
  })();
  return { summary, result };
}
