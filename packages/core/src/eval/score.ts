import type { ReconResult } from "../matcher/reconcile.ts";
import { summarizeExposure, type ExposureSummary } from "../matcher/exposure.ts";
import { EXCEPTION_TYPES, type ExceptionType, type NoiseKind, type Split, type TruthLabel, type TruthLink } from "../types.ts";

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Miss {
  kind: "FN" | "FP";
  type: string;
  entity_id: string;
  category: string;
}

export const BATCH_OUTCOMES = ["correct_contiguous", "correct_subset", "wrong_set", "ambiguous", "conflict", "suggested", "unidentified", "other"] as const;
export type BatchOutcome = (typeof BATCH_OUTCOMES)[number];

export const FUZZY_KINDS = ["UTR_TYPO", "UTR_TRUNCATED", "HELDOUT_OCR_CONFUSION", "HELDOUT_NARRATION_FORMAT"] as const satisfies readonly NoiseKind[];
/** auto_fuzzy = linked by the fuzzy UTR stage; auto_other = recovered by another stage (e.g. an amount-only single-settlement match). */
export const FUZZY_OUTCOMES = ["auto_fuzzy", "auto_other", "suggested_correct", "auto_wrong", "suggested_wrong", "missed"] as const;
export type FuzzyOutcome = (typeof FUZZY_OUTCOMES)[number];

export interface SplitScore {
  seed: number;
  split: Split;
  records: number;
  reconcile_ms: number;
  /** Bank credits whose true settlement set is non-empty, by what the engine did. */
  credits: { truth_linked: number; correct: number; wrong: number; unmatched: number; false_links_on_unlinked: number; by_kind: Record<string, { matched: number; correct: number }> };
  exceptions: Record<ExceptionType, Counts>;
  batch: { contiguous: Record<BatchOutcome, number>; non_contiguous: Record<BatchOutcome, number> };
  fuzzy: Record<(typeof FUZZY_KINDS)[number], Record<FuzzyOutcome, number>>;
  exact_normalized: { n: number; correct: number };
  missing_credit: { n: number; detected: number; deferred: number; missed: number };
  ledger_attr: { n: number; correct: number };
  exposure: ExposureSummary;
  misses: Miss[];
}

const zeroCounts = (): Counts => ({ tp: 0, fp: 0, fn: 0 });
const zeroBatch = () => Object.fromEntries(BATCH_OUTCOMES.map((o) => [o, 0])) as Record<BatchOutcome, number>;
const zeroFuzzy = () => Object.fromEntries(FUZZY_OUTCOMES.map((o) => [o, 0])) as Record<FuzzyOutcome, number>;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const detail = (l: TruthLabel, key: string) => l.details[key];

const LINK_KINDS = new Set(["EXACT", "FUZZY", "BATCH", "BATCH_CONTIGUOUS"]);

/**
 * Score one reconciled split against its ground truth. Definitions are spelled out in EVAL.md.
 * Pure: no database, no clock.
 */
export function scoreSplit(input: { seed: number; split: Split; labels: TruthLabel[]; links: TruthLink[]; result: ReconResult; records: number }): SplitScore {
  const { labels, links, result } = input;

  // What the engine linked each bank credit to (confirmed links only; suggestions are not links).
  const predicted = new Map<string, { kind: string; settlements: string[] }>();
  for (const m of result.matches) {
    if (!LINK_KINDS.has(m.kind) || m.left.type !== "settlement" || m.right.type !== "bank_line") continue;
    const p = predicted.get(m.right.id) ?? { kind: m.kind, settlements: [] };
    p.settlements.push(m.left.id);
    predicted.set(m.right.id, p);
  }
  const truthOf = new Map(links.filter((l) => l.kind === "BANK_SETTLEMENT").map((l) => [l.from_id, l.to_ids]));
  const exceptionsOn = new Map<string, typeof result.exceptions>();
  for (const e of result.exceptions) exceptionsOn.set(e.primary.id, [...(exceptionsOn.get(e.primary.id) ?? []), e]);
  const typesOn = (id: string) => (exceptionsOn.get(id) ?? []).map((e) => e.type);
  const suggestedTop = (lineId: string) => {
    const s = exceptionsOn.get(lineId)?.find((e) => e.type === "SUGGESTED_MATCH");
    if (!s) return null;
    const top = (s.trace.suggested as { settlement_id?: string } | undefined)?.settlement_id;
    return top ?? s.related.find((r) => r.type === "settlement")?.id ?? null;
  };
  const deferred = new Set(result.deferred.map((d) => d.settlement_id));
  const labelsOn = new Map<string, TruthLabel[]>();
  for (const l of labels) labelsOn.set(l.entity_id, [...(labelsOn.get(l.entity_id) ?? []), l]);

  // ---- bank credit linkage ----
  const credits: SplitScore["credits"] = { truth_linked: 0, correct: 0, wrong: 0, unmatched: 0, false_links_on_unlinked: 0, by_kind: {} };
  for (const [lineId, truth] of truthOf) {
    const p = predicted.get(lineId);
    if (truth.length === 0) {
      if (p) credits.false_links_on_unlinked++;
      continue;
    }
    credits.truth_linked++;
    if (!p) {
      credits.unmatched++;
      continue;
    }
    const k = (credits.by_kind[p.kind] ??= { matched: 0, correct: 0 });
    k.matched++;
    if (sameSet(p.settlements, truth)) {
      credits.correct++;
      k.correct++;
    } else credits.wrong++;
  }

  // ---- exceptions: precision / recall per type ----
  const exceptions = Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, zeroCounts()])) as Record<ExceptionType, Counts>;
  const misses: Miss[] = [];
  for (const type of EXCEPTION_TYPES) {
    const expected = labels.filter((l) => l.expected_exception === type);
    // A duplicate pair is correctly flagged whichever of the two entries the engine names.
    const accepts = new Map<string, TruthLabel>();
    for (const l of expected) {
      accepts.set(l.entity_id, l);
      const alt = detail(l, "original_ledger_id");
      if (type === "DUPLICATE_LEDGER_ENTRY" && typeof alt === "string") accepts.set(alt, l);
    }
    const flagged = result.exceptions.filter((e) => e.type === type);
    const hit = new Set<TruthLabel>();
    for (const e of flagged) {
      const label = accepts.get(e.primary.id);
      let correct = Boolean(label);
      // A suggestion is also correct when its top candidate is the credit's true settlement.
      if (!correct && type === "SUGGESTED_MATCH") {
        const top = suggestedTop(e.primary.id);
        correct = Boolean(top && truthOf.get(e.primary.id)?.includes(top));
      }
      if (correct) {
        exceptions[type].tp++;
        if (label) hit.add(label);
      } else {
        exceptions[type].fp++;
        const kinds = (labelsOn.get(e.primary.id) ?? []).map((l) => l.noise_kind);
        misses.push({ kind: "FP", type, entity_id: e.primary.id, category: `${type} raised on ${kinds.length ? kinds.join("+") : `a clean ${e.primary.type}`}` });
      }
    }
    for (const l of expected) {
      if (hit.has(l)) continue;
      exceptions[type].fn++;
      const instead = typesOn(l.entity_id).filter((t) => t !== type);
      const why = deferred.has(l.entity_id)
        ? "deferred to human (possible member of an open batch)"
        : instead.length
          ? `raised ${[...new Set(instead)].join("+")} instead`
          : predicted.has(l.entity_id)
            ? `auto-matched as ${predicted.get(l.entity_id)?.kind}`
            : "not flagged";
      misses.push({ kind: "FN", type, entity_id: l.entity_id, category: `${l.noise_kind}: ${why}` });
    }
  }

  // ---- batch decomposition, by true contiguity ----
  const batch = { contiguous: zeroBatch(), non_contiguous: zeroBatch() };
  for (const l of labels.filter((x) => x.noise_kind === "CONSOLIDATED_CREDIT")) {
    const truth = detail(l, "settlement_ids") as string[];
    const p = predicted.get(l.entity_id);
    const types = typesOn(l.entity_id);
    let outcome: BatchOutcome;
    if (p && (p.kind === "BATCH" || p.kind === "BATCH_CONTIGUOUS")) outcome = sameSet(p.settlements, truth) ? (p.kind === "BATCH_CONTIGUOUS" ? "correct_contiguous" : "correct_subset") : "wrong_set";
    else if (p) outcome = "other";
    else if (types.includes("AMBIGUOUS_BATCH")) outcome = "ambiguous";
    else if (types.includes("MATCH_CONFLICT")) outcome = "conflict";
    else if (types.includes("SUGGESTED_MATCH")) outcome = "suggested";
    else if (types.includes("UNIDENTIFIED_BANK_CREDIT")) outcome = "unidentified";
    else outcome = "other";
    batch[detail(l, "contiguous") === true ? "contiguous" : "non_contiguous"][outcome]++;
  }

  // ---- fuzzy UTR recovery ----
  const fuzzy = Object.fromEntries(FUZZY_KINDS.map((k) => [k, zeroFuzzy()])) as SplitScore["fuzzy"];
  for (const kind of FUZZY_KINDS) {
    for (const l of labels.filter((x) => x.noise_kind === kind)) {
      const truth = detail(l, "settlement_id") as string;
      const p = predicted.get(l.entity_id);
      const top = suggestedTop(l.entity_id);
      if (p) fuzzy[kind][!sameSet(p.settlements, [truth]) ? "auto_wrong" : p.kind === "FUZZY" ? "auto_fuzzy" : "auto_other"]++;
      else if (top) fuzzy[kind][top === truth ? "suggested_correct" : "suggested_wrong"]++;
      else fuzzy[kind].missed++;
    }
  }

  const exactLabels = labels.filter((l) => l.noise_kind === "UTR_CASE_CHANGED" || l.noise_kind === "UTR_SPACES_HYPHENS");
  const exact_normalized = {
    n: exactLabels.length,
    correct: exactLabels.filter((l) => predicted.get(l.entity_id)?.kind === "EXACT" && sameSet(predicted.get(l.entity_id)?.settlements ?? [], [detail(l, "settlement_id") as string])).length,
  };

  const missingLabels = labels.filter((l) => l.noise_kind === "MISSING_BANK_LINE");
  const flaggedMissing = new Set(result.exceptions.filter((e) => e.type === "MISSING_BANK_CREDIT").map((e) => e.primary.id));
  const missing_credit = { n: missingLabels.length, detected: 0, deferred: 0, missed: 0 };
  for (const l of missingLabels) {
    if (flaggedMissing.has(l.entity_id)) missing_credit.detected++;
    else if (deferred.has(l.entity_id)) missing_credit.deferred++;
    else missing_credit.missed++;
  }

  const ledgerPairs = new Set(result.matches.filter((m) => m.kind === "LEDGER_ATTR" || m.kind === "LEDGER_REF").map((m) => `${m.left.id}>${m.right.id}`));
  const attrLabels = labels.filter((l) => l.noise_kind === "LEDGER_WRONG_REFERENCE" || l.noise_kind === "LEDGER_ABSENT_REFERENCE");
  const ledger_attr = { n: attrLabels.length, correct: attrLabels.filter((l) => ledgerPairs.has(`${String(detail(l, "bank_line_id"))}>${l.entity_id}`)).length };

  return {
    seed: input.seed,
    split: input.split,
    records: input.records,
    reconcile_ms: result.durationMs,
    credits,
    exceptions,
    batch,
    fuzzy,
    exact_normalized,
    missing_credit,
    ledger_attr,
    exposure: summarizeExposure(result.exceptions),
    misses,
  };
}
