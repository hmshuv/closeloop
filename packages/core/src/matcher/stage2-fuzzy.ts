import { windowStart } from "../calendar.ts";
import type { CloseLoopConfig } from "../config.ts";
import type { Settlement } from "../types.ts";
import { boundedLevenshtein, normalizeUtrText, utrCandidateTokens } from "./similarity.ts";
import { amountSubtype } from "./stage1-items.ts";
import { settlementsBetween, type BankState } from "./stage2-state.ts";
import type { StageResult } from "./types.ts";

interface Evidence {
  settlement: Settlement;
  token: string;
  /** Edit distance on the normalized UTR, or null when the evidence is a truncated prefix. */
  distance: number | null;
  /** Display value: 1 − distance/length, or prefix length/length for truncation. */
  confidence: number;
}

function bestEvidence(settlement: Settlement, tokens: string[], cfg: CloseLoopConfig): Evidence | null {
  const f = cfg.matching.fuzzy;
  const utr = normalizeUtrText(settlement.utr);
  let best: Evidence | null = null;
  for (const token of tokens) {
    let ev: Evidence | null = null;
    const d = boundedLevenshtein(token, utr, f.suggest_max_distance);
    if (d <= f.suggest_max_distance) {
      ev = { settlement, token, distance: d, confidence: 1 - d / utr.length };
    } else if (token.length >= f.min_truncated_length && token.length < utr.length && utr.startsWith(token)) {
      ev = { settlement, token, distance: null, confidence: token.length / utr.length };
    }
    if (ev && (!best || ev.confidence > best.confidence)) best = ev;
  }
  return best;
}

/**
 * Stage 2c (runs before batch): recover corrupted UTRs from the narration.
 * Hard requirements for any link: settlement dated within the tolerance before the credit, and
 * (for MATCHED_FUZZY / SUGGESTED_MATCH) the exact amount. Thresholds are edit distances:
 * - distance ≤ 1 and a margin over the runner-up → MATCHED_FUZZY (or, if only the amount differs, link + AMOUNT_MISMATCH)
 * - distance 2, a truncated UTR, or a failed margin → SUGGESTED_MATCH (needs human approval)
 */
export function stage2Fuzzy(state: BankState, cfg: CloseLoopConfig): StageResult {
  const f = cfg.matching.fuzzy;
  const result: StageResult = { matches: [], exceptions: [] };

  for (const line of state.credits) {
    if (state.resolvedCredits.has(line.id)) continue;
    const tokens = utrCandidateTokens(line.narration, f.min_token_length, f.max_token_length);
    if (tokens.length === 0) continue;
    const from = windowStart(line.txn_date, f.date_tolerance_business_days, cfg.calendar);
    const evidence = settlementsBetween(state, from, line.txn_date)
      .filter((s) => !state.linked.has(s.id))
      .map((s) => bestEvidence(s, tokens, cfg))
      .filter((e): e is Evidence => e !== null)
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          Number(b.settlement.amount_paise === line.credit_paise) - Number(a.settlement.amount_paise === line.credit_paise) ||
          a.settlement.id.localeCompare(b.settlement.id),
      );
    const best = evidence[0];
    if (!best) continue;
    const runnerUp = evidence[1];
    const margin = best.confidence - (runnerUp?.confidence ?? 0);
    const describe = (e: Evidence) => ({
      settlement_id: e.settlement.id,
      utr: e.settlement.utr,
      token: e.token,
      distance: e.distance,
      truncated: e.distance === null,
      confidence: Number(e.confidence.toFixed(4)),
      amount_equal: e.settlement.amount_paise === line.credit_paise,
    });
    const trace = { best: describe(best), runner_up: runnerUp ? describe(runnerUp) : null, margin: Number(margin.toFixed(4)) };

    if (best.distance !== null && best.distance <= f.auto_max_distance && margin >= f.margin) {
      const s = best.settlement;
      state.linked.set(s.id, line.id);
      state.resolvedCredits.add(line.id);
      result.matches.push({
        kind: "FUZZY",
        left: { type: "settlement", id: s.id },
        right: { type: "bank_line", id: line.id },
        confidence: best.confidence,
        reason: "FUZZY_UTR",
        anchor_date: line.txn_date,
        trace: { rule: "stage2.fuzzy_auto", ...trace },
      });
      if (s.amount_paise !== line.credit_paise) {
        const delta = line.credit_paise - s.amount_paise;
        result.exceptions.push({
          type: "AMOUNT_MISMATCH",
          subtype: amountSubtype(cfg, delta),
          amount_paise: Math.abs(delta),
          primary: { type: "bank_line", id: line.id },
          anchor_date: line.txn_date,
          related: [{ type: "settlement", id: s.id }],
          trace: { rule: "stage2.fuzzy_utr_amount", ...trace, settlement_paise: s.amount_paise, credit_paise: line.credit_paise, delta_paise: delta },
        });
      }
      continue;
    }

    const plausible = evidence.filter((e) => e.settlement.amount_paise === line.credit_paise).slice(0, f.max_candidates_shown);
    const top = plausible[0];
    if (!top) continue;
    const reason =
      best.distance !== null && best.distance <= f.auto_max_distance ? "margin_below_threshold" : best.distance === null ? "truncated_utr" : "edit_distance_2";
    state.suggestions.set(line.id, plausible.map((e) => e.settlement.id));
    result.exceptions.push({
      type: "SUGGESTED_MATCH",
      amount_paise: line.credit_paise,
      primary: { type: "bank_line", id: line.id },
      anchor_date: line.txn_date,
      related: plausible.map((e) => ({ type: "settlement" as const, id: e.settlement.id })),
      trace: { rule: "stage2.fuzzy_suggest", reason, ...trace, suggested: describe(top), candidates: plausible.map(describe) },
    });
  }
  return result;
}
