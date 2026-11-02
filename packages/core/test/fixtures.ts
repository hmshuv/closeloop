import { loadConfig } from "../src/config.ts";
import type { SourceData } from "../src/matcher/types.ts";
import { settlementBreakdown } from "../src/money.ts";
import type { BankLine, LedgerEntry, Payment, PaymentMethod, Refund, Settlement, SettlementItem } from "../src/types.ts";

export const cfg = loadConfig();
export const PARTY = "Razorpay Software Pvt Ltd";

export const ts = (date: string, time = "10:00:00") => `${date}T${time}+05:30`;

export function payment(id: string, amount: number, method: PaymentMethod, date: string, status: Payment["status"] = "captured"): Payment {
  return { id, order_id: `order_${id}`, amount_paise: amount, method, status, captured_at: ts(date) };
}

/** A correct settlement item for a payment (fee and 18% GST on the fee). */
export function itemFor(p: Payment, settlementId: string, id = `item_${p.id}`): SettlementItem {
  const b = settlementBreakdown(p.amount_paise, cfg.fees.gateway_fee_bps[p.method], cfg.fees.gst_bps);
  return { id, settlement_id: settlementId, entity_type: "payment", entity_id: p.id, gross_paise: p.amount_paise, fee_paise: b.fee, gst_paise: b.gst, net_paise: b.net };
}

export function refundItem(r: Refund, settlementId: string, deducted = r.amount_paise): SettlementItem {
  return { id: `item_${r.id}`, settlement_id: settlementId, entity_type: "refund", entity_id: r.id, gross_paise: -deducted, fee_paise: 0, gst_paise: 0, net_paise: -deducted };
}

let minute = 0;
export function settlement(id: string, utr: string, date: string, amount: number): Settlement {
  minute = (minute + 1) % 600;
  const t = 9 * 60 + minute;
  return { id, utr, amount_paise: amount, settled_at: date, created_at: ts(date, `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`) };
}

export function credit(id: string, date: string, amount: number, narration: string): BankLine {
  return { id, txn_date: date, narration, credit_paise: amount, debit_paise: 0, balance_paise: 0 };
}

export function receipt(id: string, date: string, amount: number, reference: string, party = PARTY): LedgerEntry {
  return { id, entry_date: date, voucher_type: "Receipt", party, amount_paise: amount, reference, narration: `Receipt ${reference}` };
}

export function journal(id: string, date: string, amount: number, settlementId: string): LedgerEntry {
  return { id, entry_date: date, voucher_type: "Journal", party: PARTY, amount_paise: amount, reference: settlementId, narration: "fees" };
}

export function source(partial: Partial<SourceData>): SourceData {
  return { payments: [], refunds: [], settlements: [], items: [], bankLines: [], ledger: [], asOf: "2026-10-31", ...partial };
}

export const neft = (utr: string) => `NEFT CR-${utr}-RAZORPAY SOFTWARE PVT LTD-SETTL MIDABCDEFGHJK`;
