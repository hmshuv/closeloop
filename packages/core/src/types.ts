import { z } from "zod";
import { PaiseSchema } from "./money.ts";

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const IstTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/, "expected an IST ISO timestamp");

export const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet"] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

// ---------- Financial records (insert-only) ----------

export const PaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount_paise: PaiseSchema.positive(),
  method: PaymentMethodSchema,
  status: z.enum(["captured", "failed"]),
  captured_at: IstTimestampSchema,
});
export type Payment = z.infer<typeof PaymentSchema>;

export const RefundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount_paise: PaiseSchema.positive(),
  created_at: IstTimestampSchema,
});
export type Refund = z.infer<typeof RefundSchema>;

export const SettlementSchema = z.object({
  id: z.string().min(1),
  utr: z.string().min(1),
  amount_paise: PaiseSchema,
  settled_at: IsoDateSchema,
  /** When the gateway created the settlement; gives same-day settlements a real order. */
  created_at: IstTimestampSchema,
});
export type Settlement = z.infer<typeof SettlementSchema>;

/** A payment line carries positive gross; a refund line carries negative gross and zero fee/GST. */
export const SettlementItemSchema = z.object({
  id: z.string().min(1),
  settlement_id: z.string().min(1),
  entity_type: z.enum(["payment", "refund"]),
  entity_id: z.string().min(1),
  gross_paise: PaiseSchema,
  fee_paise: PaiseSchema.nonnegative(),
  gst_paise: PaiseSchema.nonnegative(),
  net_paise: PaiseSchema,
});
export type SettlementItem = z.infer<typeof SettlementItemSchema>;

export const BankLineSchema = z.object({
  id: z.string().min(1),
  txn_date: IsoDateSchema,
  narration: z.string(),
  credit_paise: PaiseSchema.nonnegative(),
  debit_paise: PaiseSchema.nonnegative(),
  balance_paise: PaiseSchema,
});
export type BankLine = z.infer<typeof BankLineSchema>;

export const VOUCHER_TYPES = ["Receipt", "Journal", "Payment"] as const;
export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  entry_date: IsoDateSchema,
  voucher_type: z.enum(VOUCHER_TYPES),
  party: z.string(),
  amount_paise: PaiseSchema.positive(),
  /** May be empty: accountants sometimes leave the reference blank. */
  reference: z.string(),
  narration: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------- Exceptions ----------

export const EXCEPTION_TYPES = [
  "AMOUNT_MISMATCH",
  "FEE_GST_MISMATCH",
  "REFUND_AMOUNT_MISMATCH",
  "MISSING_SETTLEMENT",
  "MISSING_BANK_CREDIT",
  "MISSING_LEDGER_ENTRY",
  "DUPLICATE_LEDGER_ENTRY",
  "TIMING_WINDOW_EXCEEDED",
  "AMBIGUOUS_BATCH",
  "SUGGESTED_MATCH",
  "UNIDENTIFIED_BANK_CREDIT",
  "MATCH_CONFLICT",
  "BANK_LEDGER_MISMATCH",
] as const;
export const ExceptionTypeSchema = z.enum(EXCEPTION_TYPES);
export type ExceptionType = z.infer<typeof ExceptionTypeSchema>;

// ---------- Ground truth (generator + eval only; never visible to the matcher) ----------

export const SPLITS = ["dev", "heldout"] as const;
export const SplitSchema = z.enum(SPLITS);
export type Split = z.infer<typeof SplitSchema>;

export const NOISE_KINDS = [
  "UTR_TRUNCATED",
  "UTR_CASE_CHANGED",
  "UTR_SPACES_HYPHENS",
  "UTR_TYPO",
  "CONSOLIDATED_CREDIT",
  "LATE_SETTLEMENT",
  "MISSING_SETTLEMENT",
  "MISSING_BANK_LINE",
  "MISSING_LEDGER_RECEIPT",
  "MISSING_LEDGER_JOURNAL",
  "AMOUNT_MISMATCH_ROUNDING",
  "AMOUNT_MISMATCH_MATERIAL",
  "GST_WRONG_BASE",
  "DUPLICATE_LEDGER_ENTRY",
  "REFUND_AMOUNT_MISMATCH",
  "LEDGER_WRONG_REFERENCE",
  "LEDGER_ABSENT_REFERENCE",
  "RECEIPT_AMOUNT_MISMATCH",
  "PHANTOM_RECEIPT",
  "UNIDENTIFIED_CREDIT",
  "AMBIGUOUS_BATCH_TRAP",
  "AMBIGUOUS_TWIN",
  "MATCH_CONFLICT_TRAP",
  "CONFLICT_DECOY",
  "HELDOUT_NARRATION_FORMAT",
  "HELDOUT_OCR_CONFUSION",
] as const;
export const NoiseKindSchema = z.enum(NOISE_KINDS);
export type NoiseKind = z.infer<typeof NoiseKindSchema>;

export const ENTITY_TYPES = ["payment", "refund", "settlement", "settlement_item", "bank_line", "ledger_entry"] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/** ANY = must end up linked to the right record, by whatever match kind. */
export const ExpectedMatchKindSchema = z.enum(["EXACT", "FUZZY", "BATCH", "LEDGER_ATTR", "ANY"]);
export type ExpectedMatchKind = z.infer<typeof ExpectedMatchKindSchema>;

export const TruthLabelSchema = z.object({
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  noise_kind: NoiseKindSchema,
  expected_exception: ExceptionTypeSchema.nullable(),
  expected_match_kind: ExpectedMatchKindSchema.nullable(),
  split: SplitSchema,
  details: z.record(z.string(), z.unknown()),
});
export type TruthLabel = z.infer<typeof TruthLabelSchema>;

/** The true linkage for every bank credit, ledger receipt and journal — lets eval score match precision. */
export const TruthLinkSchema = z.object({
  kind: z.enum(["BANK_SETTLEMENT", "RECEIPT_BANK", "JOURNAL_SETTLEMENT"]),
  from_id: z.string().min(1),
  to_ids: z.array(z.string().min(1)),
  split: SplitSchema,
});
export type TruthLink = z.infer<typeof TruthLinkSchema>;
