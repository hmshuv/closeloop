import type { BankLine, Settlement } from "../types.ts";

/** Mutable bookkeeping shared by the settlement ↔ bank sub-stages (exact → fuzzy → batch). */
export interface BankState {
  credits: BankLine[];
  /** Sorted by created_at (hence by settled_at), so a date window is a contiguous slice in time order. */
  settlements: Settlement[];
  /** Settlement id → bank line id, for confirmed links (exact, fuzzy, batch). */
  linked: Map<string, string>;
  /** Bank line ids already resolved by a confirmed link. */
  resolvedCredits: Set<string>;
  /** Bank line id → settlement ids suggested for it (pending human approval). */
  suggestions: Map<string, string[]>;
}

export function newBankState(credits: BankLine[], settlements: Settlement[]): BankState {
  return {
    credits: credits.slice().sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id)),
    settlements: settlements.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    linked: new Map(),
    resolvedCredits: new Set(),
    suggestions: new Map(),
  };
}

/** Settlements with from ≤ settled_at ≤ to. */
export function settlementsBetween(state: BankState, from: string, to: string): Settlement[] {
  const lower = (date: string) => {
    let lo = 0;
    let hi = state.settlements.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((state.settlements[mid] as Settlement).settled_at < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const end = lower(`${to}~`); // "~" sorts after any date suffix, so this includes `to` itself
  return state.settlements.slice(lower(from), end);
}

export function suggestedSettlementIds(state: BankState): Set<string> {
  return new Set([...state.suggestions.values()].flat());
}
