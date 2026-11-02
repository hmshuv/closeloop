import type { EntityType, ExceptionType, ExpectedMatchKind, NoiseKind } from "../types.ts";

interface NoiseExpectation {
  /** The record the label (and the expected exception) is attached to. */
  entity: EntityType;
  exception: ExceptionType | null;
  match: ExpectedMatchKind | null;
}

/** What a correct matcher should output for each injected noise kind. */
export const NOISE_EXPECTATIONS: Record<NoiseKind, NoiseExpectation> = {
  UTR_TRUNCATED: { entity: "bank_line", exception: null, match: "FUZZY" },
  UTR_CASE_CHANGED: { entity: "bank_line", exception: null, match: "EXACT" },
  UTR_SPACES_HYPHENS: { entity: "bank_line", exception: null, match: "EXACT" },
  UTR_TYPO: { entity: "bank_line", exception: null, match: "FUZZY" },
  CONSOLIDATED_CREDIT: { entity: "bank_line", exception: null, match: "BATCH" },
  LATE_SETTLEMENT: { entity: "settlement", exception: "TIMING_WINDOW_EXCEEDED", match: null },
  MISSING_SETTLEMENT: { entity: "payment", exception: "MISSING_SETTLEMENT", match: null },
  MISSING_BANK_LINE: { entity: "settlement", exception: "MISSING_BANK_CREDIT", match: null },
  MISSING_LEDGER_RECEIPT: { entity: "bank_line", exception: "MISSING_LEDGER_ENTRY", match: null },
  MISSING_LEDGER_JOURNAL: { entity: "settlement", exception: "MISSING_LEDGER_ENTRY", match: null },
  AMOUNT_MISMATCH_ROUNDING: { entity: "bank_line", exception: "AMOUNT_MISMATCH", match: "EXACT" },
  AMOUNT_MISMATCH_MATERIAL: { entity: "bank_line", exception: "AMOUNT_MISMATCH", match: "EXACT" },
  GST_WRONG_BASE: { entity: "payment", exception: "FEE_GST_MISMATCH", match: null },
  DUPLICATE_LEDGER_ENTRY: { entity: "ledger_entry", exception: "DUPLICATE_LEDGER_ENTRY", match: null },
  REFUND_AMOUNT_MISMATCH: { entity: "refund", exception: "REFUND_AMOUNT_MISMATCH", match: null },
  LEDGER_WRONG_REFERENCE: { entity: "ledger_entry", exception: null, match: "LEDGER_ATTR" },
  LEDGER_ABSENT_REFERENCE: { entity: "ledger_entry", exception: null, match: "LEDGER_ATTR" },
  RECEIPT_AMOUNT_MISMATCH: { entity: "bank_line", exception: "BANK_LEDGER_MISMATCH", match: null },
  PHANTOM_RECEIPT: { entity: "ledger_entry", exception: "BANK_LEDGER_MISMATCH", match: null },
  UNIDENTIFIED_CREDIT: { entity: "bank_line", exception: "UNIDENTIFIED_BANK_CREDIT", match: null },
  AMBIGUOUS_BATCH_TRAP: { entity: "bank_line", exception: "AMBIGUOUS_BATCH", match: null },
  // The twin's bank credit is genuinely missing, but no matcher can tell which twin it is:
  // the right output is the AMBIGUOUS_BATCH on the credit, not a guess.
  AMBIGUOUS_TWIN: { entity: "settlement", exception: null, match: null },
  MATCH_CONFLICT_TRAP: { entity: "bank_line", exception: "MATCH_CONFLICT", match: null },
  // A stray credit whose UTR resembles a settlement that actually arrived inside a consolidated payout.
  CONFLICT_DECOY: { entity: "bank_line", exception: "SUGGESTED_MATCH", match: null },
  HELDOUT_NARRATION_FORMAT: { entity: "bank_line", exception: null, match: "ANY" },
  HELDOUT_OCR_CONFUSION: { entity: "bank_line", exception: null, match: "ANY" },
};

/** Variants the matcher's rules were not written around. They are only injected into held-out. */
export const HELDOUT_ONLY_NOISE: ReadonlySet<NoiseKind> = new Set(["HELDOUT_NARRATION_FORMAT", "HELDOUT_OCR_CONFUSION"]);

/**
 * Evaluation targets and the noise kinds that exercise them. Eval requires at least
 * `heldout_min_per_type` held-out labels per target; the generator never inflates rates to get there.
 */
export const COVERAGE_TARGETS: Record<string, readonly NoiseKind[]> = {
  AMOUNT_MISMATCH: ["AMOUNT_MISMATCH_ROUNDING", "AMOUNT_MISMATCH_MATERIAL"],
  FEE_GST_MISMATCH: ["GST_WRONG_BASE"],
  REFUND_AMOUNT_MISMATCH: ["REFUND_AMOUNT_MISMATCH"],
  MISSING_SETTLEMENT: ["MISSING_SETTLEMENT"],
  MISSING_BANK_CREDIT: ["MISSING_BANK_LINE"],
  MISSING_LEDGER_ENTRY: ["MISSING_LEDGER_RECEIPT", "MISSING_LEDGER_JOURNAL"],
  DUPLICATE_LEDGER_ENTRY: ["DUPLICATE_LEDGER_ENTRY"],
  TIMING_WINDOW_EXCEEDED: ["LATE_SETTLEMENT"],
  AMBIGUOUS_BATCH: ["AMBIGUOUS_BATCH_TRAP"],
  SUGGESTED_MATCH: ["CONFLICT_DECOY", "UTR_TYPO", "UTR_TRUNCATED"],
  UNIDENTIFIED_BANK_CREDIT: ["UNIDENTIFIED_CREDIT"],
  MATCH_CONFLICT: ["MATCH_CONFLICT_TRAP"],
  BANK_LEDGER_MISMATCH: ["RECEIPT_AMOUNT_MISMATCH", "PHANTOM_RECEIPT"],
  BATCH_DECOMPOSED: ["CONSOLIDATED_CREDIT"],
  FUZZY_RECOVERY: ["UTR_TYPO", "UTR_TRUNCATED"],
  LEDGER_ATTR_MATCH: ["LEDGER_WRONG_REFERENCE", "LEDGER_ABSENT_REFERENCE"],
};
