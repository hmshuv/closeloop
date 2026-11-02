import type { ExceptionDraft } from "./types.ts";

interface Dated {
  id: string;
  date: string;
  amount_paise: number;
}

export interface TieOutInput {
  from: string;
  to: string;
  bankCredits: Dated[];
  receipts: Dated[];
  /** Receipt ↔ bank credit links from stage 3. */
  pairs: { lineId: string; receiptId: string }[];
  duplicateReceipts: string[];
  unmatchedReceipts: string[];
  unreceiptedCredits: string[];
}

export const TIE_OUT_ITEM_KINDS = ["UNRECEIPTED_CREDIT", "DUPLICATE_RECEIPT", "UNMATCHED_RECEIPT", "AMOUNT_DIFFERENCE", "TIMING"] as const;
export type TieOutItemKind = (typeof TIE_OUT_ITEM_KINDS)[number];

export interface TieOut {
  from: string;
  to: string;
  bank_credits_paise: number;
  book_receipts_paise: number;
  /** bank − books */
  difference_paise: number;
  /** Signed contribution of each reconciling-item kind to the difference. */
  items: Record<TieOutItemKind, { count: number; amount_paise: number }>;
  explained_paise: number;
  /** difference − explained. Anything other than 0 is an unexplained book-vs-bank gap. */
  residual_paise: number;
}

/**
 * Period-end tie-out: Σ bank credits − Σ ledger receipts in the period must equal the sum of the
 * reconciling items stage 3 identified. A non-zero residual means some difference has no explanation.
 */
export function computeTieOut(input: TieOutInput): TieOut {
  const inPeriod = (d: string) => d >= input.from && d <= input.to;
  const credits = new Map(input.bankCredits.map((c) => [c.id, c]));
  const receipts = new Map(input.receipts.map((r) => [r.id, r]));
  const items = Object.fromEntries(TIE_OUT_ITEM_KINDS.map((k) => [k, { count: 0, amount_paise: 0 }])) as TieOut["items"];
  const add = (kind: TieOutItemKind, amount: number) => {
    if (amount === 0) return;
    items[kind].count++;
    items[kind].amount_paise += amount;
  };

  for (const { lineId, receiptId } of input.pairs) {
    const line = credits.get(lineId);
    const receipt = receipts.get(receiptId);
    if (!line || !receipt) continue;
    const lineIn = inPeriod(line.date);
    const receiptIn = inPeriod(receipt.date);
    if (lineIn && receiptIn) add("AMOUNT_DIFFERENCE", line.amount_paise - receipt.amount_paise);
    else if (lineIn) add("TIMING", line.amount_paise);
    else if (receiptIn) add("TIMING", -receipt.amount_paise);
  }
  for (const id of input.duplicateReceipts) {
    const r = receipts.get(id);
    if (r && inPeriod(r.date)) add("DUPLICATE_RECEIPT", -r.amount_paise);
  }
  for (const id of input.unmatchedReceipts) {
    const r = receipts.get(id);
    if (r && inPeriod(r.date)) add("UNMATCHED_RECEIPT", -r.amount_paise);
  }
  for (const id of input.unreceiptedCredits) {
    const c = credits.get(id);
    if (c && inPeriod(c.date)) add("UNRECEIPTED_CREDIT", c.amount_paise);
  }

  const bank = input.bankCredits.filter((c) => inPeriod(c.date)).reduce((s, c) => s + c.amount_paise, 0);
  const book = input.receipts.filter((r) => inPeriod(r.date)).reduce((s, r) => s + r.amount_paise, 0);
  const explained = Object.values(items).reduce((s, i) => s + i.amount_paise, 0);
  return {
    from: input.from,
    to: input.to,
    bank_credits_paise: bank,
    book_receipts_paise: book,
    difference_paise: bank - book,
    items,
    explained_paise: explained,
    residual_paise: bank - book - explained,
  };
}

export function tieOutExceptions(tie: TieOut): ExceptionDraft[] {
  if (tie.residual_paise === 0) return [];
  return [
    {
      type: "BANK_LEDGER_MISMATCH",
      subtype: "UNEXPLAINED_TIE_OUT_RESIDUAL",
      amount_paise: Math.abs(tie.residual_paise),
      primary: { type: "period", id: `${tie.from}..${tie.to}` },
      anchor_date: tie.to,
      related: [],
      trace: { rule: "tieout.bank_equals_books_plus_reconciling_items", ...tie },
    },
  ];
}
