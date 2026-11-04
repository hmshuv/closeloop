import type { CloseLoopConfig } from "../config.ts";
import { stage2Batch, type BatchStats } from "./stage2-batch.ts";
import { stage2Exact } from "./stage2-exact.ts";
import { stage2Fuzzy } from "./stage2-fuzzy.ts";
import { stage2Report, type GatewayReportStats } from "./stage2-report.ts";
import { newBankState, suggestedSettlementIds } from "./stage2-state.ts";
import type { SourceData, StageResult } from "./types.ts";

/** A settlement that could belong to an open AMBIGUOUS_BATCH / MATCH_CONFLICT: its fate waits on a human. */
export interface DeferredSettlement {
  settlement_id: string;
  settled_at: string;
  amount_paise: number;
  /** Primary bank lines of the open batch exceptions it could belong to. */
  bank_line_ids: string[];
}

export interface Stage2Result extends StageResult {
  batch: BatchStats;
  deferred: DeferredSettlement[];
  /** Null when no gateway recon report was imported (amount-only batch matching). */
  gateway: GatewayReportStats | null;
}

/** Stage 2: settlement ↔ bank credit. Order: exact UTR → gateway report payouts (if imported) → fuzzy UTR → batch decomposition. */
export interface Stage2Options {
  now?: () => number;
  /** Bank line id → extra candidate UTR tokens (e.g. from AI narration parsing). Only grounded ones are used. */
  extraTokens?: ReadonlyMap<string, readonly string[]>;
}

export function stage2Bank(src: SourceData, cfg: CloseLoopConfig, opts: Stage2Options = {}): Stage2Result {
  const state = newBankState(
    src.bankLines.filter((l) => l.credit_paise > 0),
    src.settlements,
  );
  const exact = stage2Exact(state, cfg);
  const report = src.gatewayReport.length > 0 ? stage2Report(state, src.gatewayReport, cfg) : null;
  const fuzzy = stage2Fuzzy(state, cfg, opts.extraTokens);
  const batch = stage2Batch(state, cfg, opts.now);
  const result: Stage2Result = {
    matches: [...exact.matches, ...(report?.matches ?? []), ...fuzzy.matches, ...batch.matches],
    exceptions: [...exact.exceptions, ...(report?.exceptions ?? []), ...fuzzy.exceptions, ...batch.exceptions],
    batch: batch.stats,
    deferred: [],
    gateway: report?.stats ?? null,
  };

  const underReview = new Set(batch.exceptions.map((e) => e.primary.id));
  for (const line of state.credits) {
    if (state.resolvedCredits.has(line.id) || state.heldCredits.has(line.id) || state.suggestions.has(line.id) || underReview.has(line.id)) continue;
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
    if (state.linked.has(s.id) || state.heldSettlements.has(s.id) || pendingReview.has(s.id)) continue;
    const holders = batch.reserved.get(s.id);
    if (holders) {
      // Status unresolved_in_batch: re-evaluated when a candidate set is approved (see review/batch.ts).
      result.deferred.push({ settlement_id: s.id, settled_at: s.settled_at, amount_paise: s.amount_paise, bank_line_ids: [...new Set(holders)] });
      continue;
    }
    if (s.settled_at > src.asOf) continue;
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
