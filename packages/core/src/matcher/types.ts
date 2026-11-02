import { z } from "zod";
import type {
  BankLine,
  EntityType,
  ExceptionType,
  LedgerEntry,
  Payment,
  Refund,
  Settlement,
  SettlementItem,
} from "../types.ts";

/** Everything the matcher may see. Built from the recon DB's financial tables only. */
export interface SourceData {
  payments: Payment[];
  refunds: Refund[];
  settlements: Settlement[];
  items: SettlementItem[];
  bankLines: BankLine[];
  ledger: LedgerEntry[];
  /** Records dated after this are invisible; windows are judged as of this date. */
  asOf: string;
}

export const MATCH_KINDS = ["ITEM", "EXACT", "FUZZY", "BATCH_CONTIGUOUS", "BATCH", "LEDGER_REF", "LEDGER_ATTR", "JOURNAL", "HUMAN_APPROVED"] as const;
export const MatchKindSchema = z.enum(MATCH_KINDS);
export type MatchKind = z.infer<typeof MatchKindSchema>;

export const REASON_CODES = [
  "PAYMENT_IN_SETTLEMENT",
  "EXACT_UTR",
  "FUZZY_UTR",
  "BATCH_CONTIGUOUS_RUN",
  "BATCH_DECOMPOSED",
  "LEDGER_REFERENCE",
  "LEDGER_ATTRIBUTES",
  "JOURNAL_REFERENCE",
  "HUMAN_APPROVED",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EXPOSURE_CLASSES = ["AMOUNT_AT_RISK", "AWAITING_SETTLEMENT", "STRUCTURAL"] as const;
export const ExposureClassSchema = z.enum(EXPOSURE_CLASSES);
export type ExposureClass = z.infer<typeof ExposureClassSchema>;

export type EntityKind = EntityType | "period";

export interface EntityRef {
  type: EntityKind;
  id: string;
}

export interface MatchDraft {
  kind: MatchKind;
  left: EntityRef;
  right: EntityRef;
  /** Display only. Never used as a decision threshold. */
  confidence: number;
  reason: ReasonCode;
  /** The date this match belongs to, used for period reporting. */
  anchor_date: string;
  trace: Record<string, unknown>;
}

export interface ExceptionDraft {
  type: ExceptionType;
  subtype?: string;
  /** Exposure amount in paise (always ≥ 0). */
  amount_paise: number;
  primary: EntityRef;
  /** The date this exception belongs to, used for period reporting. */
  anchor_date: string;
  related: EntityRef[];
  /** Machine-readable rule trace: which rule fired and on what evidence. */
  trace: { rule: string } & Record<string, unknown>;
  /** AMBIGUOUS_BATCH / MATCH_CONFLICT: the settlement-id sets that sum to the credit. */
  candidate_sets?: string[][];
}

export interface StageResult {
  matches: MatchDraft[];
  exceptions: ExceptionDraft[];
}
