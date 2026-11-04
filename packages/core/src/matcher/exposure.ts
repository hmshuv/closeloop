import type { ExceptionType } from "../types.ts";
import { EXPOSURE_CLASSES, type ExceptionDraft, type ExposureClass } from "./types.ts";

/** Exposure is reported per class and never summed into one number: the classes mean different things. */
export const EXPOSURE_BY_TYPE: Record<ExceptionType, ExposureClass> = {
  AMOUNT_MISMATCH: "AMOUNT_AT_RISK",
  FEE_GST_MISMATCH: "AMOUNT_AT_RISK",
  REFUND_AMOUNT_MISMATCH: "AMOUNT_AT_RISK",
  MISSING_BANK_CREDIT: "AMOUNT_AT_RISK",
  UNIDENTIFIED_BANK_CREDIT: "AMOUNT_AT_RISK",
  BANK_LEDGER_MISMATCH: "AMOUNT_AT_RISK",
  GATEWAY_REPORT_MISMATCH: "AMOUNT_AT_RISK",
  MISSING_SETTLEMENT: "AWAITING_SETTLEMENT",
  TIMING_WINDOW_EXCEEDED: "AWAITING_SETTLEMENT",
  MISSING_LEDGER_ENTRY: "STRUCTURAL",
  DUPLICATE_LEDGER_ENTRY: "STRUCTURAL",
  AMBIGUOUS_BATCH: "STRUCTURAL",
  SUGGESTED_MATCH: "STRUCTURAL",
  MATCH_CONFLICT: "STRUCTURAL",
};

/** Unknown types default to AMOUNT_AT_RISK: when in doubt, treat money as at risk. */
export function exposureClassOf(type: string): ExposureClass {
  return (EXPOSURE_BY_TYPE as Record<string, ExposureClass | undefined>)[type] ?? "AMOUNT_AT_RISK";
}

export type ExposureSummary = Record<ExposureClass, { count: number; amount_paise: number }>;

export function summarizeExposure(exceptions: readonly Pick<ExceptionDraft, "type" | "amount_paise">[]): ExposureSummary {
  const out = Object.fromEntries(EXPOSURE_CLASSES.map((c) => [c, { count: 0, amount_paise: 0 }])) as ExposureSummary;
  for (const e of exceptions) {
    const bucket = out[exposureClassOf(e.type)];
    bucket.count++;
    bucket.amount_paise += e.amount_paise;
  }
  return out;
}
