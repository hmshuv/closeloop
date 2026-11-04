import { addBusinessDays } from "../calendar.ts";
import { settlementWindow, type CloseLoopConfig } from "../config.ts";
import { gatewayFee, gstOnFee, settlementBreakdown } from "../money.ts";
import type { Payment, SettlementItem } from "../types.ts";
import type { ExceptionDraft, MatchDraft, SourceData, StageResult } from "./types.ts";

export function amountSubtype(cfg: CloseLoopConfig, delta: number): "ROUNDING" | "MATERIAL" {
  return Math.abs(delta) <= cfg.matching.amount_mismatch_rounding_threshold_paise ? "ROUNDING" : "MATERIAL";
}

export function dueDate(cfg: CloseLoopConfig, p: Payment): string {
  return addBusinessDays(p.captured_at.slice(0, 10), settlementWindow(cfg, p.method), cfg.calendar);
}

export interface Stage1Result extends StageResult {
  pendingInWindow: number;
}

/**
 * With an imported gateway recon report, each settlement it covers takes its payment and refund links from the
 * report's rows (gross = amount, GST = tax, net = credit − debit); other settlements keep their settlement items.
 * Transfers and adjustments are not linked to payments but still count towards the settlement's total.
 */
export function itemsWithReport(src: SourceData): { items: SettlementItem[]; covered: Set<string>; otherNet: Map<string, number> } {
  const covered = new Set(src.gatewayReport.map((r) => r.settlement_id));
  const otherNet = new Map<string, number>();
  const fromReport: SettlementItem[] = [];
  for (const r of src.gatewayReport) {
    const net = r.credit_paise - r.debit_paise;
    if (r.type === "payment" || r.type === "refund") {
      const sign = r.type === "payment" ? 1 : -1;
      fromReport.push({ id: `report:${r.entity_id}`, settlement_id: r.settlement_id, entity_type: r.type, entity_id: r.entity_id, gross_paise: sign * r.amount_paise, fee_paise: r.fee_paise, gst_paise: r.tax_paise, net_paise: net });
    } else otherNet.set(r.settlement_id, (otherNet.get(r.settlement_id) ?? 0) + net);
  }
  return { items: [...src.items.filter((i) => !covered.has(i.settlement_id)), ...fromReport], covered, otherNet };
}

/** Stage 1: payment/refund ↔ settlement item by id, with fee + GST arithmetic verified line by line. */
export function stage1Items(src: SourceData, cfg: CloseLoopConfig): Stage1Result {
  const { items, covered, otherNet } = itemsWithReport(src);
  const matches: MatchDraft[] = [];
  const exceptions: ExceptionDraft[] = [];
  const payments = new Map(src.payments.map((p) => [p.id, p]));
  const refunds = new Map(src.refunds.map((r) => [r.id, r]));
  const settlements = new Map(src.settlements.map((s) => [s.id, s]));
  const netBySettlement = new Map<string, number>(otherNet);
  const settled = new Set<string>();

  for (const item of items) {
    netBySettlement.set(item.settlement_id, (netBySettlement.get(item.settlement_id) ?? 0) + item.net_paise);
    const settlement = settlements.get(item.settlement_id);
    if (!settlement) continue;
    const date = settlement.settled_at;

    if (item.entity_type === "payment") {
      const p = payments.get(item.entity_id);
      if (!p) continue;
      settled.add(p.id);
      matches.push({
        kind: "ITEM",
        left: { type: "payment", id: p.id },
        right: { type: "settlement", id: settlement.id },
        confidence: 1,
        reason: "PAYMENT_IN_SETTLEMENT",
        anchor_date: date,
        trace: covered.has(settlement.id) ? { source: "gateway_report", entity_id: item.entity_id } : { settlement_item_id: item.id },
      });
      if (item.gross_paise !== p.amount_paise) {
        const delta = item.gross_paise - p.amount_paise;
        exceptions.push({
          type: "AMOUNT_MISMATCH",
          subtype: amountSubtype(cfg, delta),
          amount_paise: Math.abs(delta),
          primary: { type: "payment", id: p.id },
          anchor_date: date,
          related: [{ type: "settlement_item", id: item.id }, { type: "settlement", id: settlement.id }],
          trace: { rule: "stage1.item_gross_equals_payment", payment_paise: p.amount_paise, item_gross_paise: item.gross_paise, delta_paise: delta },
        });
        continue;
      }
      const expectedFee = gatewayFee(p.amount_paise, cfg.fees.gateway_fee_bps[p.method]);
      const expectedGst = gstOnFee(expectedFee, cfg.fees.gst_bps);
      const arithmeticOk = item.net_paise === item.gross_paise - item.fee_paise - item.gst_paise;
      if (item.fee_paise !== expectedFee || item.gst_paise !== expectedGst || !arithmeticOk) {
        const charged = item.fee_paise + item.gst_paise;
        const expected = expectedFee + expectedGst;
        exceptions.push({
          type: "FEE_GST_MISMATCH",
          amount_paise: Math.abs(charged - expected) || Math.abs(item.gross_paise - item.fee_paise - item.gst_paise - item.net_paise),
          primary: { type: "payment", id: p.id },
          anchor_date: date,
          related: [{ type: "settlement_item", id: item.id }, { type: "settlement", id: settlement.id }],
          trace: {
            rule: "stage1.fee_and_gst_on_fee",
            fee_bps: cfg.fees.gateway_fee_bps[p.method],
            gst_bps: cfg.fees.gst_bps,
            expected: { fee_paise: expectedFee, gst_paise: expectedGst },
            actual: { fee_paise: item.fee_paise, gst_paise: item.gst_paise, net_paise: item.net_paise },
            // GST on the payment amount instead of on the fee is the common error.
            gst_matches_wrong_base: item.gst_paise === gstOnFee(p.amount_paise, cfg.fees.gst_bps),
            arithmetic_ok: arithmeticOk,
          },
        });
      }
    } else {
      const r = refunds.get(item.entity_id);
      if (!r) continue;
      if (-item.net_paise !== r.amount_paise) {
        const delta = -item.net_paise - r.amount_paise;
        exceptions.push({
          type: "REFUND_AMOUNT_MISMATCH",
          amount_paise: Math.abs(delta),
          primary: { type: "refund", id: r.id },
          anchor_date: date,
          related: [{ type: "payment", id: r.payment_id }, { type: "settlement_item", id: item.id }, { type: "settlement", id: settlement.id }],
          trace: { rule: "stage1.refund_deduction_equals_refund", refund_paise: r.amount_paise, deducted_paise: -item.net_paise, delta_paise: delta },
        });
      }
    }
  }

  for (const s of src.settlements) {
    const net = netBySettlement.get(s.id) ?? 0;
    if (net !== s.amount_paise && covered.has(s.id)) {
      exceptions.push({
        type: "GATEWAY_REPORT_MISMATCH",
        subtype: "SETTLEMENT_TOTAL",
        amount_paise: Math.abs(s.amount_paise - net),
        primary: { type: "settlement", id: s.id },
        anchor_date: s.settled_at,
        related: [],
        trace: { rule: "stage1.settlement_equals_gateway_report", settlement_paise: s.amount_paise, report_net_paise: net, delta_paise: s.amount_paise - net },
      });
    } else if (net !== s.amount_paise) {
      const delta = s.amount_paise - net;
      exceptions.push({
        type: "AMOUNT_MISMATCH",
        subtype: amountSubtype(cfg, delta),
        amount_paise: Math.abs(delta),
        primary: { type: "settlement", id: s.id },
        anchor_date: s.settled_at,
        related: [],
        trace: { rule: "stage1.settlement_equals_sum_of_items", settlement_paise: s.amount_paise, items_net_paise: net },
      });
    }
  }

  // A captured payment with no settlement item: an exception only once its window has elapsed.
  let pendingInWindow = 0;
  for (const p of src.payments) {
    if (p.status !== "captured" || settled.has(p.id)) continue;
    const due = dueDate(cfg, p);
    if (due > src.asOf) {
      pendingInWindow++;
      continue;
    }
    exceptions.push({
      type: "MISSING_SETTLEMENT",
      amount_paise: settlementBreakdown(p.amount_paise, cfg.fees.gateway_fee_bps[p.method], cfg.fees.gst_bps).net,
      primary: { type: "payment", id: p.id },
      anchor_date: due,
      related: [],
      trace: { rule: "stage1.captured_payment_settled_within_window", method: p.method, captured_at: p.captured_at, due_date: due, as_of: src.asOf },
    });
  }

  return { matches, exceptions, pendingInWindow };
}
