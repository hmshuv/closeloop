import type { CloseLoopConfig } from "../config.ts";
import type { Settlement } from "../types.ts";
import { normalizeUtrText } from "./similarity.ts";
import { amountSubtype } from "./stage1-items.ts";
import type { BankState } from "./stage2-state.ts";
import type { StageResult } from "./types.ts";

/** Stage 2a: the settlement UTR appears verbatim in the narration once both are uppercased and stripped of spaces/hyphens. */
export function stage2Exact(state: BankState, cfg: CloseLoopConfig): StageResult {
  const result: StageResult = { matches: [], exceptions: [] };
  const byUtr = new Map(state.settlements.map((s) => [normalizeUtrText(s.utr), s]));
  const lengths = [...new Set([...byUtr.keys()].map((u) => u.length))];

  for (const line of state.credits) {
    const text = normalizeUtrText(line.narration);
    const hits = new Map<string, Settlement>();
    for (const len of lengths) {
      for (let i = 0; i + len <= text.length; i++) {
        const s = byUtr.get(text.slice(i, i + len));
        if (s) hits.set(s.id, s);
      }
    }
    if (hits.size !== 1) continue;
    const [s] = hits.values();
    if (!s || state.linked.has(s.id)) continue;

    state.linked.set(s.id, line.id);
    state.resolvedCredits.add(line.id);
    result.matches.push({
      kind: "EXACT",
      left: { type: "settlement", id: s.id },
      right: { type: "bank_line", id: line.id },
      confidence: 1,
      reason: "EXACT_UTR",
      anchor_date: line.txn_date,
      trace: { rule: "stage2.exact_utr", utr: s.utr },
    });
    if (line.credit_paise !== s.amount_paise) {
      // The UTR proves which settlement this is, so link it and flag the amount rather than leaving it unidentified.
      const delta = line.credit_paise - s.amount_paise;
      result.exceptions.push({
        type: "AMOUNT_MISMATCH",
        subtype: amountSubtype(cfg, delta),
        amount_paise: Math.abs(delta),
        primary: { type: "bank_line", id: line.id },
        anchor_date: line.txn_date,
        related: [{ type: "settlement", id: s.id }],
        trace: { rule: "stage2.exact_utr_amount", utr: s.utr, settlement_paise: s.amount_paise, credit_paise: line.credit_paise, delta_paise: delta },
      });
    }
  }
  return result;
}
