/** Indian digit grouping: 12345678 paise → "₹1,23,456.78". Mirrors the engine's formatter. */
export function inr(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const p = (abs % 100).toString().padStart(2, "0");
  const last = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  return `${sign}₹${rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last}` : last}.${p}`;
}

export const pct = ([n, d]: [number, number]) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

export const TYPE_LABEL: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount mismatch",
  FEE_GST_MISMATCH: "Fee / GST mismatch",
  REFUND_AMOUNT_MISMATCH: "Refund mismatch",
  MISSING_SETTLEMENT: "Missing settlement",
  MISSING_BANK_CREDIT: "Missing bank credit",
  MISSING_LEDGER_ENTRY: "Missing ledger entry",
  DUPLICATE_LEDGER_ENTRY: "Duplicate ledger entry",
  TIMING_WINDOW_EXCEEDED: "Settled late",
  AMBIGUOUS_BATCH: "Ambiguous batch",
  SUGGESTED_MATCH: "Suggested match",
  UNIDENTIFIED_BANK_CREDIT: "Unidentified credit",
  MATCH_CONFLICT: "Match conflict",
  BANK_LEDGER_MISMATCH: "Bank ↔ ledger mismatch",
  GATEWAY_REPORT_MISMATCH: "Gateway report ↔ bank mismatch",
};

export const CLASS_LABEL: Record<string, string> = {
  AMOUNT_AT_RISK: "Amount at risk",
  AWAITING_SETTLEMENT: "Awaiting settlement",
  STRUCTURAL: "Structural",
};

export const CLASS_HINT: Record<string, string> = {
  AMOUNT_AT_RISK: "Money that may be lost or misstated until resolved",
  AWAITING_SETTLEMENT: "Money still owed by the gateway or arriving late",
  STRUCTURAL: "Books or links that need a human decision; not money at risk on its own",
};

export const KIND_LABEL: Record<string, string> = {
  EXACT: "Exact UTR",
  FUZZY: "Fuzzy UTR",
  BATCH_CONTIGUOUS: "Contiguous batch",
  BATCH: "Proven-unique subset",
  BATCH_FROM_GATEWAY_REPORT: "From gateway report",
  HUMAN_APPROVED: "Human approved",
};

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…` : id;
}

export function dateLabel(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
