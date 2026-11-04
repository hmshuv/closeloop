/** Financial source tables. Insert-only: UPDATE and DELETE are blocked by triggers below. */
export const FINANCIAL_TABLES = [
  "payments",
  "refunds",
  "settlements",
  "settlement_items",
  "bank_lines",
  "ledger_entries",
] as const;

const FINANCIAL_DDL = `
CREATE TABLE IF NOT EXISTS dataset_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method       TEXT NOT NULL CHECK (method IN ('upi','card','netbanking','wallet')),
  status       TEXT NOT NULL CHECK (status IN ('captured','failed')),
  captured_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL REFERENCES payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  utr          TEXT NOT NULL UNIQUE,
  amount_paise INTEGER NOT NULL,
  settled_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settlement_items (
  id            TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('payment','refund')),
  entity_id     TEXT NOT NULL,
  gross_paise   INTEGER NOT NULL,
  fee_paise     INTEGER NOT NULL CHECK (fee_paise >= 0),
  gst_paise     INTEGER NOT NULL CHECK (gst_paise >= 0),
  net_paise     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS bank_lines (
  id            TEXT PRIMARY KEY,
  txn_date      TEXT NOT NULL,
  narration     TEXT NOT NULL,
  credit_paise  INTEGER NOT NULL CHECK (credit_paise >= 0),
  debit_paise   INTEGER NOT NULL CHECK (debit_paise >= 0),
  balance_paise INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           TEXT PRIMARY KEY,
  entry_date   TEXT NOT NULL,
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('Receipt','Journal','Payment')),
  party        TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference    TEXT NOT NULL,
  narration    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_payments_captured ON payments(captured_at);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements(settled_at);
CREATE INDEX IF NOT EXISTS idx_items_settlement ON settlement_items(settlement_id);
CREATE INDEX IF NOT EXISTS idx_items_entity ON settlement_items(entity_id);
CREATE INDEX IF NOT EXISTS idx_bank_date ON bank_lines(txn_date);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_reference ON ledger_entries(reference);
`;

function insertOnlyTriggers(table: string): string {
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is insert-only'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is insert-only'); END;`;
}

/** Engine output. Written by runs (and, in later phases, by human review actions) — never by the AI layer. */
const RECON_OUTPUT_DDL = `
CREATE TABLE IF NOT EXISTS recon_runs (
  id           TEXT PRIMARY KEY,
  from_date    TEXT NOT NULL,
  to_date      TEXT NOT NULL,
  as_of        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  config_hash  TEXT NOT NULL,
  summary_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES recon_runs(id),
  kind        TEXT NOT NULL,
  left_type   TEXT NOT NULL,
  left_id     TEXT NOT NULL,
  right_type  TEXT NOT NULL,
  right_id    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  reason_code TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  trace_json  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS exceptions (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES recon_runs(id),
  type           TEXT NOT NULL,
  exposure_class TEXT NOT NULL,
  amount_paise   INTEGER NOT NULL CHECK (amount_paise >= 0),
  subtype        TEXT,
  primary_type   TEXT NOT NULL,
  primary_id     TEXT NOT NULL,
  anchor_date    TEXT NOT NULL,
  related_json   TEXT NOT NULL,
  trace_json     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open','approved','escalated'))
) STRICT;

CREATE TABLE IF NOT EXISTS batch_candidate_sets (
  exception_id        TEXT NOT NULL REFERENCES exceptions(id),
  set_index           INTEGER NOT NULL,
  settlement_ids_json TEXT NOT NULL,
  PRIMARY KEY (exception_id, set_index)
) STRICT;

/* Settlements deferred to a human batch decision, and what became of them. */
CREATE TABLE IF NOT EXISTS settlement_reviews (
  run_id                   TEXT NOT NULL REFERENCES recon_runs(id),
  settlement_id            TEXT NOT NULL,
  exception_id             TEXT NOT NULL REFERENCES exceptions(id),
  status                   TEXT NOT NULL CHECK (status IN ('unresolved_in_batch','assigned','missing_raised','released')),
  resolved_by_exception_id TEXT,
  updated_at               TEXT NOT NULL,
  PRIMARY KEY (run_id, settlement_id, exception_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_matches_run ON matches(run_id);
CREATE INDEX IF NOT EXISTS idx_matches_left ON matches(left_id);
CREATE INDEX IF NOT EXISTS idx_matches_right ON matches(right_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_run ON exceptions(run_id, type);
CREATE INDEX IF NOT EXISTS idx_exceptions_primary ON exceptions(primary_id);
`;

/** AI-layer outputs and the audit trail. The AI layer writes only here, never to financial or match tables. */
const AI_AND_AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS ai_outputs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('narration_parse','explanation','journal_draft')),
  key             TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('llm','deterministic_fallback')),
  fallback_reason TEXT,
  model           TEXT,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_ai_outputs_key ON ai_outputs(kind, key);

CREATE TABLE IF NOT EXISTS journal_drafts (
  id              TEXT PRIMARY KEY,
  exception_id    TEXT NOT NULL REFERENCES exceptions(id),
  status          TEXT NOT NULL CHECK (status = 'pending_approval'),
  lines_json      TEXT NOT NULL,
  narration       TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('llm','deterministic_fallback')),
  fallback_reason TEXT,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('system','llm','human')),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_id, ts);
`;

/**
 * Imported gateway reports (Razorpay settlement recon "recon/combined", fetched read-only or from an export).
 * They live with engine state, not with the financial source, so they work with a read-only source mount.
 * Insert-only; re-importing the same rows is a no-op (natural key below).
 */
const GATEWAY_DDL = `
CREATE TABLE IF NOT EXISTS gateway_reports (
  id          TEXT PRIMARY KEY,
  gateway     TEXT NOT NULL CHECK (gateway = 'razorpay'),
  source      TEXT NOT NULL CHECK (source IN ('api','file')),
  origin      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  rows_read   INTEGER NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS gateway_recon_items (
  entity_id      TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('payment','refund','transfer','adjustment')),
  settlement_id  TEXT NOT NULL,
  settlement_utr TEXT,
  amount_paise   INTEGER NOT NULL,
  fee_paise      INTEGER NOT NULL,
  tax_paise      INTEGER NOT NULL,
  credit_paise   INTEGER NOT NULL CHECK (credit_paise >= 0),
  debit_paise    INTEGER NOT NULL CHECK (debit_paise >= 0),
  payment_id     TEXT,
  settled_at     INTEGER NOT NULL,
  settled_on     TEXT NOT NULL,
  report_id      TEXT NOT NULL REFERENCES gateway_reports(id),
  raw_json       TEXT NOT NULL,
  PRIMARY KEY (entity_id, type, settlement_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_gateway_items_settlement ON gateway_recon_items(settlement_id);

CREATE TABLE IF NOT EXISTS gateway_settlements (
  id           TEXT PRIMARY KEY,
  utr          TEXT,
  amount_paise INTEGER NOT NULL,
  fees_paise   INTEGER NOT NULL,
  tax_paise    INTEGER NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  report_id    TEXT NOT NULL REFERENCES gateway_reports(id)
) STRICT;
`;

export const GATEWAY_TABLES = ["gateway_reports", "gateway_recon_items", "gateway_settlements"] as const;

/** Source data: dataset metadata + the insert-only financial tables. */
export const FINANCIAL_SCHEMA = FINANCIAL_DDL + FINANCIAL_TABLES.map(insertOnlyTriggers).join("\n");

/** Engine state: runs, matches, exceptions, reviews, AI outputs, drafts and the append-only audit log. */
export const STATE_SCHEMA = RECON_OUTPUT_DDL + AI_AND_AUDIT_DDL + GATEWAY_DDL + ["audit_log", ...GATEWAY_TABLES].map(insertOnlyTriggers).join("\n");

export const RECON_SCHEMA = FINANCIAL_SCHEMA + STATE_SCHEMA;

/** Ground truth lives in its own database file. The matcher is never handed this connection. */
export const TRUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS truth_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS truth_labels (
  id                  INTEGER PRIMARY KEY,
  entity_type         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  noise_kind          TEXT NOT NULL,
  expected_exception  TEXT,
  expected_match_kind TEXT,
  split               TEXT NOT NULL CHECK (split IN ('dev','heldout')),
  details_json        TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS truth_links (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  from_id      TEXT NOT NULL,
  to_ids_json  TEXT NOT NULL,
  split        TEXT NOT NULL CHECK (split IN ('dev','heldout'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_truth_entity ON truth_labels(entity_id);
CREATE INDEX IF NOT EXISTS idx_truth_links_from ON truth_links(from_id);
`;
