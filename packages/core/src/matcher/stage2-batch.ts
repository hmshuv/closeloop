import { businessDaysBetween, windowStart } from "../calendar.ts";
import type { CloseLoopConfig } from "../config.ts";
import type { BankLine, Settlement } from "../types.ts";
import { settlementsBetween, suggestedSettlementIds, type BankState } from "./stage2-state.ts";
import { findSubsetsWithSum, type SubsetSumResult } from "./subsetsum.ts";
import type { StageResult } from "./types.ts";

export const CONTIGUITY_ASSUMPTION =
  "Unique among runs of consecutive settlements (by created_at) only. Assumes the payout model that a consolidated payout covers every settlement created over a stretch of time; it does not prove that no non-contiguous subset sums to the credit.";

export interface BatchStats {
  attempted: number;
  contiguous_decomposed: number;
  decomposed: number;
  settlements_decomposed: number;
  ambiguous: number;
  conflicts: number;
  none: number;
  budget_exhausted: number;
  max_pool: number;
  mitm_runs: number;
  dfs_runs: number;
  total_ms: number;
}

export interface BatchOutcome {
  status: SubsetSumResult["status"];
  poolSize: number;
  method: SubsetSumResult["method"];
}

export interface Stage2BatchResult extends StageResult {
  stats: BatchStats;
  /** Settlements that could belong to an open AMBIGUOUS_BATCH / MATCH_CONFLICT; never also reported missing. */
  reserved: Set<string>;
  /** Credits searched and proven to have no decomposition. */
  unresolved: Map<string, BatchOutcome>;
}

/** All [start, end] (inclusive) runs of consecutive positive values summing to target. O(n) sliding window. */
export function contiguousRuns(values: readonly number[], target: number): [number, number][] {
  const runs: [number, number][] = [];
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < values.length; hi++) {
    sum += values[hi] as number;
    while (sum > target && lo <= hi) sum -= values[lo++] as number;
    if (sum === target && lo <= hi) runs.push([lo, hi]);
  }
  return runs;
}

/** Number of maximal consecutive blocks a set forms within the ordered pool (1 = fully contiguous). */
function blocks(positions: number[]): number {
  const sorted = positions.slice().sort((a, b) => a - b);
  return sorted.filter((p, i) => i === 0 || p !== (sorted[i - 1] as number) + 1).length;
}

/**
 * Stage 2b, after exact and fuzzy: one bank credit may net many settlements.
 *  i.  Contiguous runs: settlements consecutive in created_at order whose sum equals the credit.
 *      Exactly one run → BATCH_CONTIGUOUS (unique under the payout-model assumption only).
 *  ii. Arbitrary subsets (proof-only): a proven-unique subset → BATCH_DECOMPOSED; several → AMBIGUOUS_BATCH
 *      with the top-K candidate sets ranked by contiguity, then date closeness.
 * The pool is the unmatched settlements paid in the W business days up to the credit date. Only
 * MATCHED_FUZZY settlements left the pool; SUGGESTED_MATCH settlements stay in it, and a batch that needs
 * one becomes a MATCH_CONFLICT instead of an auto-match.
 */
export function stage2Batch(state: BankState, cfg: CloseLoopConfig, now?: () => number): Stage2BatchResult {
  const b = cfg.matching.batch;
  const cal = cfg.calendar;
  const result: Stage2BatchResult = {
    matches: [],
    exceptions: [],
    reserved: new Set(),
    unresolved: new Map(),
    stats: { attempted: 0, contiguous_decomposed: 0, decomposed: 0, settlements_decomposed: 0, ambiguous: 0, conflicts: 0, none: 0, budget_exhausted: 0, max_pool: 0, mitm_runs: 0, dfs_runs: 0, total_ms: 0 },
  };
  const suggested = suggestedSettlementIds(state);
  const suggestingLines = (settlementId: string) => [...state.suggestions].filter(([, ids]) => ids.includes(settlementId)).map(([line]) => line);
  const opts = { timeBudgetMs: b.time_budget_ms, nodeBudget: b.node_budget, mitmMaxN: b.mitm_max_n, maxSets: b.max_candidate_sets * 10, now };
  const poolFor = (line: BankLine) =>
    settlementsBetween(state, windowStart(line.txn_date, b.window_business_days, cal), line.txn_date).filter((s) => !state.linked.has(s.id) && s.amount_paise > 0);
  const conflicts = new Map<string, { line: BankLine; members: Settlement[]; conflicting: Settlement[]; method: string }>();

  /** Returns true if the credit was consumed (matched). Conflicts are recorded and not retried. */
  const accept = (line: BankLine, members: Settlement[], kind: "BATCH_CONTIGUOUS" | "BATCH", trace: Record<string, unknown>): boolean => {
    const conflicting = members.filter((s) => suggested.has(s.id));
    if (conflicting.length > 0) {
      conflicts.set(line.id, { line, members, conflicting, method: kind });
      return false;
    }
    for (const s of members) {
      state.linked.set(s.id, line.id);
      result.matches.push({
        kind,
        left: { type: "settlement", id: s.id },
        right: { type: "bank_line", id: line.id },
        confidence: 1,
        reason: kind === "BATCH_CONTIGUOUS" ? "BATCH_CONTIGUOUS_RUN" : "BATCH_DECOMPOSED",
        anchor_date: line.txn_date,
        trace: { ...trace, set_size: members.length, settlement_ids: members.map((m) => m.id) },
      });
    }
    state.resolvedCredits.add(line.id);
    result.stats.settlements_decomposed += members.length;
    if (kind === "BATCH_CONTIGUOUS") result.stats.contiguous_decomposed++;
    else result.stats.decomposed++;
    return true;
  };

  const byAmountDesc = (lines: BankLine[]) => lines.slice().sort((x, y) => y.credit_paise - x.credit_paise || x.id.localeCompare(y.id));
  const open = () => byAmountDesc(state.credits.filter((c) => !state.resolvedCredits.has(c.id) && !state.suggestions.has(c.id) && !conflicts.has(c.id)));

  // 2b-i: contiguous runs, repeated while consuming runs shrinks other credits' pools.
  for (let pass = 0; pass < b.max_passes; pass++) {
    let progress = false;
    for (const line of open()) {
      const pool = poolFor(line);
      const runs = contiguousRuns(pool.map((s) => s.amount_paise), line.credit_paise);
      const run = runs[0];
      if (runs.length !== 1 || !run) continue;
      const members = pool.slice(run[0], run[1] + 1);
      // For the trace only: does an arbitrary-subset search (when cheap) also find this unique?
      const affordable = pool.filter((s) => s.amount_paise <= line.credit_paise);
      const general = affordable.length <= b.mitm_max_n ? findSubsetsWithSum(affordable.map((s) => s.amount_paise), line.credit_paise, opts).status : "not_checked";
      progress =
        accept(line, members, "BATCH_CONTIGUOUS", {
          rule: "stage2.batch_contiguous_run",
          assumption: CONTIGUITY_ASSUMPTION,
          pool_size: pool.length,
          arbitrary_subset_search: general,
        }) || progress;
    }
    if (!progress) break;
  }

  // 2b-ii: arbitrary subsets, proof-only.
  let pending = open();
  const last = new Map<string, { line: BankLine; res: SubsetSumResult; pool: Settlement[]; ordered: Settlement[] }>();
  for (let pass = 0; pass < b.max_passes && pending.length > 0; pass++) {
    let progress = false;
    const retry: BankLine[] = [];
    for (const line of pending) {
      const ordered = poolFor(line);
      const pool = ordered.filter((s) => s.amount_paise <= line.credit_paise);
      const res = findSubsetsWithSum(pool.map((s) => s.amount_paise), line.credit_paise, opts);
      result.stats.attempted++;
      result.stats.max_pool = Math.max(result.stats.max_pool, pool.length);
      result.stats.total_ms += res.elapsedMs;
      if (res.method === "mitm") result.stats.mitm_runs++;
      else result.stats.dfs_runs++;

      if (res.status === "unique") {
        last.delete(line.id);
        const members = (res.solutions[0] ?? []).map((i) => pool[i] as Settlement);
        const trace = { rule: "stage2.batch_unique_subset", method: res.method, complement: res.complement, pool_size: pool.length };
        progress = accept(line, members, "BATCH", trace) || progress;
      } else {
        last.set(line.id, { line, res, pool, ordered });
        if (res.status === "ambiguous" || res.status === "budget_exhausted") retry.push(line);
      }
    }
    if (!progress) break;
    pending = retry.filter((l) => !state.resolvedCredits.has(l.id));
  }

  for (const { line, members, conflicting, method } of conflicts.values()) {
    result.stats.conflicts++;
    for (const s of members) result.reserved.add(s.id);
    const lines = [...new Set(conflicting.flatMap((s) => suggestingLines(s.id)))];
    result.exceptions.push({
      type: "MATCH_CONFLICT",
      amount_paise: line.credit_paise,
      primary: { type: "bank_line", id: line.id },
      anchor_date: line.txn_date,
      related: [...members.map((s) => ({ type: "settlement" as const, id: s.id })), ...lines.map((id) => ({ type: "bank_line" as const, id }))],
      trace: {
        rule: "stage2.batch_conflicts_with_suggestion",
        decomposition: method,
        batch_settlement_ids: members.map((s) => s.id),
        conflicting_settlement_ids: conflicting.map((s) => s.id),
        suggested_on_bank_lines: lines,
      },
      candidate_sets: [members.map((s) => s.id)],
    });
  }

  for (const { line, res, pool, ordered } of last.values()) {
    if (res.status === "none") {
      result.stats.none++;
      result.unresolved.set(line.id, { status: res.status, poolSize: pool.length, method: res.method });
      continue;
    }
    result.stats.ambiguous++;
    if (res.status === "budget_exhausted") result.stats.budget_exhausted++;
    const position = new Map(ordered.map((s, i) => [s.id, i]));
    const ranked = res.solutions
      .map((sol) => sol.map((i) => pool[i] as Settlement))
      .map((set) => ({
        set,
        blocks: blocks(set.map((s) => position.get(s.id) as number)),
        distance: set.reduce((sum, s) => sum + businessDaysBetween(s.settled_at, line.txn_date, cal), 0) / set.length,
      }))
      .sort((x, y) => x.blocks - y.blocks || x.distance - y.distance || x.set.length - y.set.length)
      .slice(0, b.max_candidate_sets);
    // Any settlement in the pool could belong to this credit until a human resolves it.
    for (const s of pool) result.reserved.add(s.id);
    result.exceptions.push({
      type: "AMBIGUOUS_BATCH",
      amount_paise: line.credit_paise,
      primary: { type: "bank_line", id: line.id },
      anchor_date: line.txn_date,
      related: pool.map((s) => ({ type: "settlement" as const, id: s.id })),
      trace: {
        rule: "stage2.batch_ambiguous",
        method: res.method,
        pool_size: pool.length,
        solutions_found: res.solutionCount,
        uniqueness_proven: res.uniquenessProven,
        budget_exhausted: res.status === "budget_exhausted",
        ranking: "fewest contiguous blocks, then closest settlement dates",
        candidate_ranking: ranked.map((r) => ({ blocks: r.blocks, mean_business_days_before_credit: Number(r.distance.toFixed(2)), size: r.set.length })),
      },
      candidate_sets: ranked.map((r) => r.set.map((s) => s.id)),
    });
  }
  return result;
}
