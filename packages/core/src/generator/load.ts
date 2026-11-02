import type { Db } from "../db/open.ts";
import { writeTruth } from "../truth/store.ts";
import {
  BankLineSchema,
  LedgerEntrySchema,
  PaymentSchema,
  RefundSchema,
  SettlementItemSchema,
  SettlementSchema,
} from "../types.ts";
import type { Dataset } from "./generate.ts";

/**
 * Insert a generated dataset. Financial rows go to the recon DB; ground truth goes to the
 * separate truth DB (pass null to skip it, e.g. for a demo-only database).
 */
export function loadDataset(recon: Db, truth: Db | null, ds: Dataset): void {
  const insert = (table: string, columns: string[]) =>
    recon.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((c) => `@${c}`).join(",")})`);

  const meta = insert("dataset_meta", ["key", "value"]);
  const payments = insert("payments", ["id", "order_id", "amount_paise", "method", "status", "captured_at"]);
  const refunds = insert("refunds", ["id", "payment_id", "amount_paise", "created_at"]);
  const settlements = insert("settlements", ["id", "utr", "amount_paise", "settled_at", "created_at"]);
  const items = insert("settlement_items", ["id", "settlement_id", "entity_type", "entity_id", "gross_paise", "fee_paise", "gst_paise", "net_paise"]);
  const bank = insert("bank_lines", ["id", "txn_date", "narration", "credit_paise", "debit_paise", "balance_paise"]);
  const ledger = insert("ledger_entries", ["id", "entry_date", "voucher_type", "party", "amount_paise", "reference", "narration"]);

  recon.transaction(() => {
    // Only non-truth metadata is visible to the matcher (no split boundary, no labels).
    const visible = { seed: ds.meta.seed, period_start: ds.meta.period_start, period_end: ds.meta.period_end, as_of: ds.meta.as_of, merchant_id: ds.meta.merchant_id };
    for (const [key, value] of Object.entries(visible)) meta.run({ key, value: String(value) });
    for (const r of ds.payments) payments.run(PaymentSchema.parse(r));
    for (const r of ds.refunds) refunds.run(RefundSchema.parse(r));
    for (const r of ds.settlements) settlements.run(SettlementSchema.parse(r));
    for (const r of ds.settlementItems) items.run(SettlementItemSchema.parse(r));
    for (const r of ds.bankLines) bank.run(BankLineSchema.parse(r));
    for (const r of ds.ledgerEntries) ledger.run(LedgerEntrySchema.parse(r));
  })();

  if (truth) writeTruth(truth, ds);
}
