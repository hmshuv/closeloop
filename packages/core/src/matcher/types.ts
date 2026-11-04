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
  /** Rows of the gateway's settlement recon report (Razorpay "recon/combined"), if one was imported. Empty otherwise. */
  gatewayReport: GatewayReportRow[];
  bankLines: BankLine[];
  ledger: LedgerEntry[];
  /** Records dated after this are invisible; windows are judged as of this date. */
  asOf: string;
}

/** One recon-report row, normalised. Money in paise; `settled_on` is the IST date of the row's settled_at. */
export interface GatewayReportRow {
  entity_id: string;
  type: "payment" | "refund" | "transfer" | "adjustment";
  settlement_id: string;
  /** UTR of the bank transfer that paid this settlement. Several settlements paid together share one. */
  settlement_utr: string | null;
  amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  credit_paise: number;
  debit_paise: number;
  payment_id: string | null;
  settled_on: string;
}

export const MATCH_KINDS = ["ITEM", "EXACT", "FUZZY", "BATCH_CONTIGUOUS", "BATCH", "BATCH_FROM_GATEWAY_REPORT", "LEDGER_REF", "LEDGER_ATTR", "JOURNAL", "HUMAN_APPROVED"] as const;
export const MatchKindSchema = z.enum(MATCH_KINDS);
export type MatchKind = z.infer<typeof MatchKindSchema>;

export const REASON_CODES = [
  "PAYMENT_IN_SETTLEMENT",
  "EXACT_UTR",
  "FUZZY_UTR",
  "BATCH_CONTIGUOUS_RUN",
  "BATCH_DECOMPOSED",
  "GATEWAY_REPORT_PAYOUT",
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
