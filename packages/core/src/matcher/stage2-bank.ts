import type { CloseLoopConfig } from "../config.ts";
import { stage2Batch, type BatchStats } from "./stage2-batch.ts";
import { stage2Exact } from "./stage2-exact.ts";
import { stage2Fuzzy } from "./stage2-fuzzy.ts";
import { newBankState, suggestedSettlementIds } from "./stage2-state.ts";
import type { SourceData, StageResult } from "./types.ts";

export interface Stage2Result extends StageResult {
  batch: BatchStats;
}

/** Stage 2: settlement ↔ bank credit. Order: exact UTR → fuzzy UTR → batch decomposition. */
export function stage2Bank(src: SourceData, cfg: CloseLoopConfig, now?: () => number): Stage2Result {
  const state = newBankState(
    src.bankLines.filter((l) => l.credit_paise > 0),
    src.settlements,
  );
  const exact = stage2Exact(state, cfg);
  const fuzzy = stage2Fuzzy(state, cfg);
  const batch = stage2Batch(state, cfg, now);
  const result: Stage2Result = {
    matches: [...exact.matches, ...fuzzy.matches, ...batch.matches],
    exceptions: [...exact.exceptions, ...fuzzy.exceptions, ...batch.exceptions],
    batch: batch.stats,
  };

  const underReview = new Set(batch.exceptions.map((e) => e.primary.id));
  for (const line of state.credits) {
    if (state.resolvedCredits.has(line.id) || state.suggestions.has(line.id) || underReview.has(line.id)) continue;
    const search = batch.unresolved.get(line.id);
    result.exceptions.push({
      type: "UNIDENTIFIED_BANK_CREDIT",
      amount_paise: line.credit_paise,
      primary: { type: "bank_line", id: line.id },
      anchor_date: line.txn_date,
      related: [],
      trace: {
        rule: "stage2.unidentified_credit",
        exact_utr: false,
        fuzzy_candidates: false,
        batch: search ? { status: search.status, pool_size: search.poolSize, method: search.method } : null,
      },
    });
  }

  const pendingReview = suggestedSettlementIds(state);
  for (const s of state.settlements) {
    if (state.linked.has(s.id) || pendingReview.has(s.id) || batch.reserved.has(s.id) || s.settled_at > src.asOf) continue;
    result.exceptions.push({
      type: "MISSING_BANK_CREDIT",
      amount_paise: s.amount_paise,
      primary: { type: "settlement", id: s.id },
      anchor_date: s.settled_at,
      related: [],
      trace: { rule: "stage2.settlement_credited_to_bank", utr: s.utr, settled_at: s.settled_at, as_of: src.asOf },
    });
  }
  return result;
}
