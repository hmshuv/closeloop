import { windowStart } from "../calendar.ts";
import type { CloseLoopConfig } from "../config.ts";
import type { BankLine, Settlement } from "../types.ts";
import { normalizeUtrText } from "./similarity.ts";
import type { BankState } from "./stage2-state.ts";
import type { GatewayReportRow, StageResult } from "./types.ts";

export interface GatewayReportStats {
  rows: number;
  settlements_covered: number;
  /** Bank transfers (distinct settlement_utr) that paid out more than one settlement, or a settlement under another UTR. */
  payouts: number;
  matched: number;
  settlements_matched: number;
  located_by_utr: number;
  located_by_amount_and_date: number;
  mismatches: number;
  /** No bank credit names the payout UTR, and no single credit fits its amount and dates. */
  not_found: number;
  /** Report rows for settlements the source data does not have. */
  unknown_settlements: number;
}

interface Payout {
  utr: string;
  settlementIds: string[];
  reportNet: number;
  rows: number;
}

/**
 * Stage 2r (only when a gateway recon report was imported; after exact UTR, before fuzzy and batch).
 * The report says which settlements each bank transfer paid (rows sharing a `settlement_utr`), so a batched
 * credit is linked by those item-level facts instead of an amount-only subset search. The amounts must still
 * agree to the paisa: Σ settlement amounts = Σ report (credit − debit) = the bank credit. If the report and the
 * bank disagree, nothing is matched and a GATEWAY_REPORT_MISMATCH goes to a human.
 */
export function stage2Report(state: BankState, report: readonly GatewayReportRow[], cfg: CloseLoopConfig): StageResult & { stats: GatewayReportStats } {
  const result: StageResult & { stats: GatewayReportStats } = {
    matches: [],
    exceptions: [],
    stats: { rows: report.length, settlements_covered: 0, payouts: 0, matched: 0, settlements_matched: 0, located_by_utr: 0, located_by_amount_and_date: 0, mismatches: 0, not_found: 0, unknown_settlements: 0 },
  };
  const settlements = new Map(state.settlements.map((s) => [s.id, s]));
  const payouts = new Map<string, Payout>();
  const covered = new Set<string>();
  for (const row of report) {
    covered.add(row.settlement_id);
    if (!row.settlement_utr) continue;
    const p = payouts.get(row.settlement_utr) ?? { utr: row.settlement_utr, settlementIds: [], reportNet: 0, rows: 0 };
    if (!p.settlementIds.includes(row.settlement_id)) p.settlementIds.push(row.settlement_id);
    p.reportNet += row.credit_paise - row.debit_paise;
    p.rows++;
    payouts.set(row.settlement_utr, p);
  }
  result.stats.settlements_covered = covered.size;
  result.stats.unknown_settlements = [...covered].filter((id) => !settlements.has(id)).length;

  const W = cfg.matching.batch.window_business_days;
  const open = () => state.credits.filter((c) => !state.resolvedCredits.has(c.id) && !state.heldCredits.has(c.id));
  const narrations = new Map(state.credits.map((c) => [c.id, normalizeUtrText(c.narration)]));

  for (const p of [...payouts.values()].sort((a, b) => a.utr.localeCompare(b.utr))) {
    const members = p.settlementIds.map((id) => settlements.get(id));
    if (members.some((m) => !m)) continue;
    const set = (members as Settlement[]).slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const utr = normalizeUtrText(p.utr);
    // One settlement paid under its own UTR is an ordinary credit: the exact and fuzzy stages handle it.
    if (set.length === 1 && normalizeUtrText((set[0] as Settlement).utr) === utr) continue;
    result.stats.payouts++;
    if (set.every((s) => state.linked.has(s.id))) continue;

    const total = set.reduce((sum, s) => sum + s.amount_paise, 0);
    const first = set.reduce((d, s) => (s.settled_at < d ? s.settled_at : d), (set[0] as Settlement).settled_at);
    const last = set.reduce((d, s) => (s.settled_at > d ? s.settled_at : d), first);
    const byUtr = open().filter((c) => narrations.get(c.id)?.includes(utr));
    let line: BankLine | undefined;
    let locatedBy: "utr_in_narration" | "amount_and_date";
    if (byUtr.length === 1) {
      line = byUtr[0];
      locatedBy = "utr_in_narration";
    } else {
      // The narration may have lost the UTR. Locate by amount only for a multi-settlement payout, and only when
      // exactly one open credit has that exact total on a date the payout could have arrived.
      const fits = set.length > 1 && byUtr.length === 0 ? open().filter((c) => c.credit_paise === total && c.txn_date >= last && windowStart(c.txn_date, W, cfg.calendar) <= first) : [];
      line = fits.length === 1 ? fits[0] : undefined;
      locatedBy = "amount_and_date";
    }
    if (!line) {
      result.stats.not_found++;
      continue;
    }

    const elsewhere = set.filter((s) => state.linked.has(s.id) && state.linked.get(s.id) !== line.id);
    const trace = {
      settlement_utr: p.utr,
      located_by: locatedBy,
      report_rows: p.rows,
      report_net_paise: p.reportNet,
      settlements_total_paise: total,
      credit_paise: line.credit_paise,
      settlement_ids: set.map((s) => s.id),
    };
    if (line.credit_paise !== total || p.reportNet !== total || elsewhere.length > 0) {
      state.heldCredits.add(line.id);
      for (const s of set) if (!state.linked.has(s.id)) state.heldSettlements.add(s.id);
      result.stats.mismatches++;
      const subtype = elsewhere.length > 0 ? "SETTLEMENT_MATCHED_ELSEWHERE" : line.credit_paise !== total ? "BANK_CREDIT_AMOUNT" : "REPORT_TOTAL";
      result.exceptions.push({
        type: "GATEWAY_REPORT_MISMATCH",
        subtype,
        amount_paise: Math.abs(line.credit_paise - total) || Math.abs(p.reportNet - total) || total,
        primary: { type: "bank_line", id: line.id },
        anchor_date: line.txn_date,
        related: set.map((s) => ({ type: "settlement" as const, id: s.id })),
        trace: { rule: "stage2.gateway_report_vs_bank", ...trace, delta_paise: line.credit_paise - total, matched_elsewhere: elsewhere.map((s) => ({ settlement_id: s.id, bank_line_id: state.linked.get(s.id) })) },
      });
      continue;
    }

    for (const s of set) {
      state.linked.set(s.id, line.id);
      result.matches.push({
        kind: "BATCH_FROM_GATEWAY_REPORT",
        left: { type: "settlement", id: s.id },
        right: { type: "bank_line", id: line.id },
        confidence: 1,
        reason: "GATEWAY_REPORT_PAYOUT",
        anchor_date: line.txn_date,
        trace: { rule: "stage2.gateway_report_payout", ...trace, set_size: set.length },
      });
    }
    state.resolvedCredits.add(line.id);
    result.stats.matched++;
    result.stats.settlements_matched += set.length;
    if (locatedBy === "utr_in_narration") result.stats.located_by_utr++;
    else result.stats.located_by_amount_and_date++;
  }
  return result;
}
