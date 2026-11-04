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

const LINK_KINDS = new Set(["EXACT", "FUZZY", "BATCH", "BATCH_CONTIGUOUS", "BATCH_FROM_GATEWAY_REPORT"]);

/** What the engine linked each bank credit to (confirmed links only; suggestions are not links). */
function predictedLinks(result: ReconResult): Map<string, { kind: string; settlements: string[] }> {
  const predicted = new Map<string, { kind: string; settlements: string[] }>();
  for (const m of result.matches) {
    if (!LINK_KINDS.has(m.kind) || m.left.type !== "settlement" || m.right.type !== "bank_line") continue;
    const p = predicted.get(m.right.id) ?? { kind: m.kind, settlements: [] };
    p.settlements.push(m.left.id);
    predicted.set(m.right.id, p);
  }
  return predicted;
}

/**
 * Score one reconciled split against its ground truth. Definitions are spelled out in EVAL.md.
 * Pure: no database, no clock.
 */
export function scoreSplit(input: { seed: number; split: Split; labels: TruthLabel[]; links: TruthLink[]; result: ReconResult; records: number }): SplitScore {
  const { labels, links, result } = input;

  const predicted = predictedLinks(result);
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
    // A report-mode link counts with the proven subsets here; the mode comparison (scoreMode) reports it separately.
    if (p && (p.kind === "BATCH" || p.kind === "BATCH_CONTIGUOUS" || p.kind === "BATCH_FROM_GATEWAY_REPORT")) outcome = sameSet(p.settlements, truth) ? (p.kind === "BATCH_CONTIGUOUS" ? "correct_contiguous" : "correct_subset") : "wrong_set";
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

/**
 * Outcomes that mean the same thing with or without a gateway recon report, scored from truth links only, so
 * amount-only matching and report matching can be compared on identical data. (The exception labels assume
 * amount-only matching, e.g. that an ambiguity trap should be AMBIGUOUS_BATCH, so they are not used here.)
 */
export interface ModeScore {
  credits: { truth_linked: number; correct: number; wrong_links: number };
  /** Bank credits that truly carry two or more settlements (every consolidated payout, traps included). */
  batch: { n: number; correct: number; wrong: number; ambiguous: number; conflict: number; report_mismatch: number; unresolved: number };
  /** Open human work raised on bank credits. */
  queue: { ambiguous_batch: number; match_conflict: number; suggested_match: number; gateway_report_mismatch: number };
  unresolved_in_batch: number;
  /** Settlements whose bank credit never arrived (MISSING_BANK_LINE, and the twin of an ambiguity trap). */
  never_credited: { n: number; detected: number; deferred: number; missed: number };
  /** Stray credits whose UTR resembles a settlement that was really paid inside a payout. Right answer: unidentified. */
  decoys: { n: number; suggested: number; unidentified: number };
}

export function scoreMode(input: { labels: TruthLabel[]; links: TruthLink[]; result: ReconResult }): ModeScore {
  const { labels, links, result } = input;
  const predicted = predictedLinks(result);
  const typesOn = new Map<string, string[]>();
  for (const e of result.exceptions) typesOn.set(e.primary.id, [...(typesOn.get(e.primary.id) ?? []), e.type]);
  const has = (id: string, type: string) => (typesOn.get(id) ?? []).includes(type);

  const out: ModeScore = {
    credits: { truth_linked: 0, correct: 0, wrong_links: 0 },
    batch: { n: 0, correct: 0, wrong: 0, ambiguous: 0, conflict: 0, report_mismatch: 0, unresolved: 0 },
    queue: { ambiguous_batch: 0, match_conflict: 0, suggested_match: 0, gateway_report_mismatch: 0 },
    unresolved_in_batch: result.deferred.length,
    never_credited: { n: 0, detected: 0, deferred: 0, missed: 0 },
    decoys: { n: 0, suggested: 0, unidentified: 0 },
  };
  for (const link of links.filter((l) => l.kind === "BANK_SETTLEMENT")) {
    const p = predicted.get(link.from_id);
    if (link.to_ids.length === 0) {
      if (p) out.credits.wrong_links++;
      continue;
    }
    out.credits.truth_linked++;
    const right = Boolean(p && sameSet(p.settlements, link.to_ids));
    if (right) out.credits.correct++;
    else if (p) out.credits.wrong_links++;
    if (link.to_ids.length < 2) continue;
    out.batch.n++;
    if (right) out.batch.correct++;
    else if (p) out.batch.wrong++;
    else if (has(link.from_id, "AMBIGUOUS_BATCH")) out.batch.ambiguous++;
    else if (has(link.from_id, "MATCH_CONFLICT")) out.batch.conflict++;
    else if (has(link.from_id, "GATEWAY_REPORT_MISMATCH")) out.batch.report_mismatch++;
    else out.batch.unresolved++;
  }
  for (const e of result.exceptions) {
    if (e.primary.type !== "bank_line") continue;
    if (e.type === "AMBIGUOUS_BATCH") out.queue.ambiguous_batch++;
    if (e.type === "MATCH_CONFLICT") out.queue.match_conflict++;
    if (e.type === "SUGGESTED_MATCH") out.queue.suggested_match++;
    if (e.type === "GATEWAY_REPORT_MISMATCH") out.queue.gateway_report_mismatch++;
  }
  const deferred = new Set(result.deferred.map((d) => d.settlement_id));
  for (const l of labels.filter((x) => x.noise_kind === "MISSING_BANK_LINE" || x.noise_kind === "AMBIGUOUS_TWIN")) {
    out.never_credited.n++;
    if (has(l.entity_id, "MISSING_BANK_CREDIT")) out.never_credited.detected++;
    else if (deferred.has(l.entity_id)) out.never_credited.deferred++;
    else out.never_credited.missed++;
  }
  for (const l of labels.filter((x) => x.noise_kind === "CONFLICT_DECOY")) {
    out.decoys.n++;
    if (has(l.entity_id, "SUGGESTED_MATCH")) out.decoys.suggested++;
    else if (has(l.entity_id, "UNIDENTIFIED_BANK_CREDIT")) out.decoys.unidentified++;
  }
  return out;
}
