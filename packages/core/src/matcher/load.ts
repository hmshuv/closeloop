import type { Db } from "../db/open.ts";
import { loadGatewayReport } from "../gateway/store.ts";
import {
  BankLineSchema,
  LedgerEntrySchema,
  PaymentSchema,
  RefundSchema,
  SettlementItemSchema,
  SettlementSchema,
} from "../types.ts";
import type { SourceData } from "./types.ts";

/**
 * Read the financial source tables as of a date. Only these tables are queried;
 * the matcher has no handle to the ground-truth database.
 */
export function loadSource(db: Db, asOf: string): SourceData {
  const rows = (sql: string) => db.prepare(sql).all(asOf);
  return {
    payments: rows("SELECT * FROM payments WHERE substr(captured_at, 1, 10) <= ? ORDER BY captured_at, id").map((r) => PaymentSchema.parse(r)),
    refunds: rows("SELECT * FROM refunds WHERE substr(created_at, 1, 10) <= ? ORDER BY created_at, id").map((r) => RefundSchema.parse(r)),
    settlements: rows("SELECT * FROM settlements WHERE settled_at <= ? ORDER BY created_at, id").map((r) => SettlementSchema.parse(r)),
    items: rows(
      "SELECT i.* FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id WHERE s.settled_at <= ? ORDER BY i.id",
    ).map((r) => SettlementItemSchema.parse(r)),
    gatewayReport: loadGatewayReport(db, asOf),
    bankLines: rows("SELECT * FROM bank_lines WHERE txn_date <= ? ORDER BY txn_date, id").map((r) => BankLineSchema.parse(r)),
    ledger: rows("SELECT * FROM ledger_entries WHERE entry_date <= ? ORDER BY entry_date, id").map((r) => LedgerEntrySchema.parse(r)),
    asOf,
  };
}

export function datasetMeta(db: Db): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM dataset_meta").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
