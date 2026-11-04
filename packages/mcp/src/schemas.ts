import { EXCEPTION_TYPES, EXPOSURE_CLASSES, IsoDateSchema } from "@closeloop/core";
import { z } from "zod";
import { Money } from "./format.ts";

/** Every tool response starts with a one-paragraph human summary. */
const base = { summary: z.string() };
const Json = z.record(z.string(), z.unknown());

export const Period = z.object({ from: IsoDateSchema, to: IsoDateSchema });

export const RunOutput = z.object({
  ...base,
  run_id: z.string(),
  period: Period,
  matched: z.object({
    payments_settled: z.number().int(),
    bank_credits_exact_utr: z.number().int(),
    bank_credits_fuzzy_utr: z.number().int(),
    bank_credits_batch_contiguous: z.number().int(),
    bank_credits_batch_subset: z.number().int(),
    bank_credits_batch_gateway_report: z.number().int(),
    settlements_inside_batch_credits: z.number().int(),
    ledger_receipts_by_reference: z.number().int(),
    ledger_receipts_by_attributes: z.number().int(),
    fee_journals: z.number().int(),
  }),
  exceptions: z.object({
    total_count: z.number().int(),
    by_type: z.array(z.object({ type: z.enum(EXCEPTION_TYPES), exposure_class: z.enum(EXPOSURE_CLASSES), count: z.number().int(), total: Money })),
  }),
  exposure_by_class: z.array(z.object({ exposure_class: z.enum(EXPOSURE_CLASSES), count: z.number().int(), total: Money })),
  exposure_note: z.string(),
  pending: z.object({ payments_in_settlement_window: z.number().int(), receipts_in_booking_grace: z.number().int(), settlements_unresolved_in_batch: z.number().int() }),
  tie_out: z.object({ bank_credits: Money, book_receipts: Money, difference: Money, explained_by_reconciling_items: Money, unexplained_residual: Money }),
  batch_search: z.record(z.string(), z.number()),
  /** Null when no gateway recon report was imported: batches were matched on amounts alone. */
  gateway_report: z.record(z.string(), z.number()).nullable(),
  ai: z.string(),
});

export const ExceptionItem = z.object({
  exception_id: z.string(),
  type: z.string(),
  subtype: z.string().nullable(),
  exposure_class: z.string(),
  status: z.string(),
  amount: Money,
  anchor_date: z.string(),
  primary: z.object({ type: z.string(), id: z.string() }),
  description: z.string(),
});

export const ListExceptionsOutput = z.object({
  ...base,
  run_id: z.string(),
  period: Period,
  filters: Json,
  total_count: z.number().int(),
  total: Money,
  showing: z.string(),
  items: z.array(ExceptionItem),
  next_cursor: z.string().nullable(),
});

const CandidateSet = z.object({
  index: z.number().int(),
  settlement_ids: z.array(z.string()),
  total: Money,
  matches_credit: z.boolean(),
  difference_vs_credit: Money,
});

export const EvidenceOutput = z.object({
  ...base,
  exception: z.object({
    id: z.string(),
    run_id: z.string(),
    type: z.string(),
    subtype: z.string().nullable(),
    exposure_class: z.string(),
    status: z.string(),
    amount: Money,
    anchor_date: z.string(),
    primary: z.object({ type: z.string(), id: z.string() }),
  }),
  rule_trace: Json,
  candidate_sets: z.array(CandidateSet),
  records: z.array(z.object({ evidence_id: z.string(), type: z.string(), data: Json })),
  links: z.array(z.object({ kind: z.string(), left_id: z.string(), right_id: z.string(), reason_code: z.string() })),
  deferred_settlements: z.array(z.object({ settlement_id: z.string(), status: z.string() })),
  audit_history: z.array(Json),
  evidence_ids: z.array(z.string()),
});

export const ExplainOutput = z.object({
  ...base,
  exception_id: z.string(),
  root_cause: z.string(),
  explanation: z.string(),
  confidence: z.number(),
  evidence_ids: z.array(z.string()),
  recommended_action: z.string(),
  requires_human_review: z.boolean(),
  source: z.enum(["llm", "deterministic_fallback"]),
  fallback_reason: z.string().nullable(),
  model: z.string().nullable(),
  amount: Money,
});

const SettlementLine = z.object({ settlement_id: z.string(), utr: z.string(), settled_at: z.string(), created_at: z.string(), amount: Money });

export const DecomposeOutput = z.object({
  ...base,
  run_id: z.string(),
  bank_line: z.object({ id: z.string(), txn_date: z.string(), narration: z.string(), credit: Money }),
  status: z.enum(["decomposed", "matched_single_settlement", "human_approved", "ambiguous", "conflict", "report_mismatch", "suggested", "unidentified"]),
  match_kind: z.string().nullable(),
  assumption: z.string().nullable(),
  /**
   * Verdict of the exhaustive arbitrary-subset search for this credit: "unique" means no other set of
   * unmatched settlements sums to it, so the decomposition is proven without the payout-model assumption.
   */
  full_search: z.enum(["unique", "ambiguous", "none", "budget_exhausted", "not_checked"]).nullable(),
  settlements: z.array(SettlementLine),
  settlements_total: Money.nullable(),
  difference_vs_credit: Money.nullable(),
  candidate_sets: z.array(CandidateSet.extend({ settlements: z.array(SettlementLine) })),
  exception_id: z.string().nullable(),
  note: z.string(),
});

export const ImportReconOutput = z.object({
  ...base,
  report_id: z.string(),
  source: z.enum(["api", "file"]),
  origin: z.string(),
  synthetic: z.boolean(),
  rows_read: z.number().int(),
  inserted: z.number().int(),
  duplicates: z.number().int(),
  conflict_count: z.number().int(),
  conflicts: z.array(z.string()),
  unsettled: z.number().int(),
  settlements_covered: z.number().int(),
  payout_utrs: z.number().int(),
  settled_from: z.string().nullable(),
  settled_to: z.string().nullable(),
  settlements_fetched: z.number().int(),
});

const JournalLineOut = z.object({ account: z.string(), debit: Money, credit: Money, memo: z.string() });

export const DraftOutput = z.object({
  ...base,
  exception_id: z.string(),
  applicable: z.boolean(),
  reason: z.string().nullable(),
  draft_id: z.string().nullable(),
  status: z.literal("pending_approval").nullable(),
  narration: z.string().nullable(),
  lines: z.array(JournalLineOut),
  total_debits: Money.nullable(),
  total_credits: Money.nullable(),
  source: z.enum(["llm", "deterministic_fallback"]).nullable(),
  fallback_reason: z.string().nullable(),
});

export const HumanActionOutput = z.object({
  ...base,
  step: z.enum(["preview", "executed"]),
  preview: Json.nullable(),
  confirm_token: z.string().nullable(),
  expires_at: z.string().nullable(),
  result: Json.nullable(),
});

export const AuditOutput = z.object({
  ...base,
  entity_id: z.string().nullable(),
  total_count: z.number().int(),
  showing: z.string(),
  items: z.array(z.object({ id: z.string(), ts: z.string(), actor: z.string(), action: z.string(), entity_type: z.string(), entity_id: z.string(), payload: Json })),
  next_cursor: z.string().nullable(),
});
