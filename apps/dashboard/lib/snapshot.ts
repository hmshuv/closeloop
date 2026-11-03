import { readFileSync } from "node:fs";
import { join } from "node:path";

// Shapes recorded by `pnpm snapshot` from the real MCP tool outputs. Read once at build time; there is no
// runtime data access, database, API route or LLM call.

export interface Money {
  amount_paise: number;
  amount_inr: string;
}

export interface ExceptionItem {
  exception_id: string;
  type: string;
  subtype: string | null;
  exposure_class: string;
  status: string;
  amount: Money;
  anchor_date: string;
  primary: { type: string; id: string };
  description: string;
}

export interface CandidateSet {
  index: number;
  settlement_ids: string[];
  total: Money;
  matches_credit: boolean;
  difference_vs_credit: Money;
}

export interface SettlementLine {
  settlement_id: string;
  utr: string;
  settled_at: string;
  created_at: string;
  amount: Money;
}

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
}

export interface Evidence {
  summary: string;
  exception: { id: string; type: string; subtype: string | null; exposure_class: string; status: string; amount: Money; anchor_date: string; primary: { type: string; id: string } };
  rule_trace: Record<string, unknown>;
  candidate_sets: CandidateSet[];
  records: { evidence_id: string; type: string; data: Record<string, unknown> }[];
  links: { kind: string; left_id: string; right_id: string; reason_code: string }[];
  deferred_settlements: { settlement_id: string; status: string }[];
  audit_history: AuditEvent[];
  evidence_ids: string[];
}

export interface Explanation {
  summary: string;
  root_cause: string;
  explanation: string;
  confidence: number;
  evidence_ids: string[];
  recommended_action: string;
  requires_human_review: boolean;
  source: "llm" | "deterministic_fallback";
  fallback_reason: string | null;
  model: string | null;
  llm_requested: boolean;
}

export interface Draft {
  draft_id: string;
  status: "pending_approval";
  narration: string;
  lines: { account: string; debit: Money; credit: Money; memo: string }[];
  total_debits: Money;
  total_credits: Money;
  source: string | null;
}

export interface Decomposition {
  summary: string;
  bank_line: { id: string; txn_date: string; narration: string; credit: Money };
  status: "decomposed" | "matched_single_settlement" | "human_approved" | "ambiguous" | "conflict" | "suggested" | "unidentified";
  match_kind: string | null;
  assumption: string | null;
  /** Verdict of the exhaustive subset search; "unique" = proven without the payout-model assumption. */
  full_search: "unique" | "ambiguous" | "none" | "budget_exhausted" | "not_checked" | null;
  settlements: SettlementLine[];
  settlements_total: Money | null;
  difference_vs_credit: Money | null;
  candidate_sets: (CandidateSet & { settlements: SettlementLine[] })[];
  exception_id: string | null;
  note: string;
}

type Pair = [number, number];
export interface EvalHeadline {
  credits: Pair;
  fuzzy: Pair;
  batch: Pair;
  batchContiguous: Pair;
  batchNonContiguous: Pair;
  batchAmbiguous: Pair;
  wrongLinks: number;
  missing: { n: number; detected: number; deferred: number; missed: number };
  macroRecall: number;
  macroPrecision: number;
  recordsPerSecond: number;
}

export interface Snapshot {
  schema_version: number;
  generated_at: string;
  commit: string | null;
  repo_url: string | null;
  dataset: { seed: number; payments: number; period_start: string; synthetic: boolean };
  period: { from: string; to: string };
  llm: { model: string | null; requested: number; llm: number; fallback_after_request: number; note: string };
  summary: {
    summary: string;
    run_id: string;
    matched: {
      payments_settled: number;
      bank_credits_exact_utr: number;
      bank_credits_fuzzy_utr: number;
      bank_credits_batch_contiguous: number;
      bank_credits_batch_subset: number;
      settlements_inside_batch_credits: number;
      ledger_receipts_by_reference: number;
      ledger_receipts_by_attributes: number;
      fee_journals: number;
    };
    exceptions: { total_count: number; by_type: { type: string; exposure_class: string; count: number; total: Money }[] };
    exposure_by_class: { exposure_class: string; count: number; total: Money }[];
    exposure_note: string;
    pending: { payments_in_settlement_window: number; receipts_in_booking_grace: number; settlements_unresolved_in_batch: number };
    tie_out: { bank_credits: Money; book_receipts: Money; difference: Money; explained_by_reconciling_items: Money; unexplained_residual: Money };
  };
  exceptions: ExceptionItem[];
  details: Record<string, { evidence: Evidence; explanation: Explanation; draft: Draft | null }>;
  showcase: {
    largestContiguousBatch: { bank_line_id: string; settlements: number } | null;
    fuzzyMatch: { bank_line_id: string; settlement_id: string; distance: number | null } | null;
    matchConflict: { exception_id: string; bank_line_id: string } | null;
  };
  batches: Decomposition[];
  default_batch_line: string | null;
  eval: {
    generated_at: string;
    commit: string | null;
    seeds_used: number[];
    payments_per_dataset: number;
    runtime_s: number;
    heldout: EvalHeadline;
    dev: EvalHeadline;
  } | null;
}

let cached: Snapshot | null = null;

export function snapshot(): Snapshot {
  cached ??= JSON.parse(readFileSync(join(process.cwd(), "data", "snapshot.json"), "utf8")) as Snapshot;
  return cached;
}

export function batchFor(lineId: string): Decomposition | undefined {
  return snapshot().batches.find((b) => b.bank_line.id === lineId);
}
