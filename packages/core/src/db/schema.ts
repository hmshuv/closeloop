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
  settled_at   TEXT NOT NULL
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

export const RECON_SCHEMA = FINANCIAL_DDL + FINANCIAL_TABLES.map(insertOnlyTriggers).join("\n");

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
