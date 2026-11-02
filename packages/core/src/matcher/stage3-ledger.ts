import { addBusinessDays, windowStart } from "../calendar.ts";
import type { CloseLoopConfig } from "../config.ts";
import type { BankLine, LedgerEntry } from "../types.ts";
import { alnumOnly } from "./similarity.ts";
import { amountSubtype } from "./stage1-items.ts";
import type { TieOutInput } from "./tieout.ts";
import type { SourceData, StageResult } from "./types.ts";

export interface Stage3Result extends StageResult {
  tieOut: Omit<TieOutInput, "from" | "to">;
  pendingReceipts: number;
}

/**
 * Stage 3: bank credit ↔ ledger Receipt (by reference, then amount + date + party),
 * plus settlement ↔ fee/GST Journal (by settlement reference).
 */
export function stage3Ledger(src: SourceData, cfg: CloseLoopConfig): Stage3Result {
  const L = cfg.matching.ledger;
  const cal = cfg.calendar;
  const result: Stage3Result = {
    matches: [],
    exceptions: [],
    pendingReceipts: 0,
    tieOut: { bankCredits: [], receipts: [], pairs: [], duplicateReceipts: [], unmatchedReceipts: [], unreceiptedCredits: [] },
  };
  const credits = src.bankLines.filter((l) => l.credit_paise > 0).sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
  const narration = new Map(credits.map((l) => [l.id, alnumOnly(l.narration)]));
  const receipts = src.ledger.filter((e) => e.voucher_type === "Receipt").sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.id.localeCompare(b.id));
  const receiptOf = new Map<string, string>();

  // A receipt is booked on or after the credit, within the date tolerance.
  const linesNear = (entry: LedgerEntry) => {
    const from = windowStart(entry.entry_date, L.date_tolerance_business_days, cal);
    return credits.filter((l) => l.txn_date >= from && l.txn_date <= entry.entry_date);
  };
  const narrowTo = (lines: BankLine[], keep: (l: BankLine) => boolean) => {
    const narrowed = lines.filter(keep);
    return narrowed.length > 0 ? narrowed : lines;
  };

  const link = (entry: LedgerEntry, line: BankLine, kind: "LEDGER_REF" | "LEDGER_ATTR") => {
    const original = receiptOf.get(line.id);
    if (original) {
      result.tieOut.duplicateReceipts.push(entry.id);
      result.exceptions.push({
        type: "DUPLICATE_LEDGER_ENTRY",
        amount_paise: entry.amount_paise,
        primary: { type: "ledger_entry", id: entry.id },
        anchor_date: entry.entry_date,
        related: [{ type: "ledger_entry", id: original }, { type: "bank_line", id: line.id }],
        trace: { rule: "stage3.one_receipt_per_bank_credit", original_ledger_id: original, bank_line_id: line.id, matched_by: kind },
      });
      return;
    }
    receiptOf.set(line.id, entry.id);
    result.tieOut.pairs.push({ lineId: line.id, receiptId: entry.id });
    result.matches.push({
      kind,
      left: { type: "bank_line", id: line.id },
      right: { type: "ledger_entry", id: entry.id },
      confidence: 1,
      reason: kind === "LEDGER_REF" ? "LEDGER_REFERENCE" : "LEDGER_ATTRIBUTES",
      anchor_date: line.txn_date,
      trace: { rule: kind === "LEDGER_REF" ? "stage3.receipt_reference_in_narration" : "stage3.receipt_amount_date_party", reference: entry.reference },
    });
    if (entry.amount_paise !== line.credit_paise) {
      const delta = line.credit_paise - entry.amount_paise;
      result.exceptions.push({
        type: "BANK_LEDGER_MISMATCH",
        subtype: amountSubtype(cfg, delta),
        amount_paise: Math.abs(delta),
        primary: { type: "bank_line", id: line.id },
        anchor_date: line.txn_date,
        related: [{ type: "ledger_entry", id: entry.id }],
        trace: { rule: "stage3.receipt_amount_equals_credit", credit_paise: line.credit_paise, receipt_paise: entry.amount_paise, delta_paise: delta },
      });
    }
  };

  // Pass 1: the reference (as the accountant typed it) appears in the bank narration.
  const deferred: LedgerEntry[] = [];
  for (const entry of receipts) {
    const ref = alnumOnly(entry.reference);
    let candidates = ref.length >= cfg.matching.fuzzy.min_token_length ? linesNear(entry).filter((l) => narration.get(l.id)?.includes(ref)) : [];
    candidates = narrowTo(candidates, (l) => l.credit_paise === entry.amount_paise);
    candidates = narrowTo(candidates, (l) => !receiptOf.has(l.id));
    const line = candidates[0];
    if (candidates.length === 1 && line) link(entry, line, "LEDGER_REF");
    else deferred.push(entry);
  }

  // Pass 2: wrong or absent reference — fall back to exact amount, date window and the party's bank aliases.
  for (const entry of deferred) {
    const aliases = L.party_aliases[entry.party] ?? [];
    const candidates = linesNear(entry).filter(
      (l) => !receiptOf.has(l.id) && l.credit_paise === entry.amount_paise && aliases.some((a) => narration.get(l.id)?.includes(a)),
    );
    const latest = candidates.at(-1)?.txn_date;
    const closest = candidates.filter((l) => l.txn_date === latest);
    const line = closest[0];
    if (closest.length === 1 && line) {
      link(entry, line, "LEDGER_ATTR");
      continue;
    }
    result.tieOut.unmatchedReceipts.push(entry.id);
    result.exceptions.push({
      type: "BANK_LEDGER_MISMATCH",
      subtype: closest.length > 1 ? "RECEIPT_AMBIGUOUS" : "RECEIPT_WITHOUT_BANK_CREDIT",
      amount_paise: entry.amount_paise,
      primary: { type: "ledger_entry", id: entry.id },
      anchor_date: entry.entry_date,
      related: closest.map((l) => ({ type: "bank_line" as const, id: l.id })),
      trace: { rule: "stage3.receipt_has_bank_credit", reference: entry.reference, party: entry.party, candidates: closest.length },
    });
  }

  for (const line of credits) {
    if (receiptOf.has(line.id)) continue;
    // Accountants may book the receipt up to `grace` business days later; not an exception yet.
    if (addBusinessDays(line.txn_date, L.receipt_grace_business_days, cal) > src.asOf) {
      result.pendingReceipts++;
      continue;
    }
    result.tieOut.unreceiptedCredits.push(line.id);
    result.exceptions.push({
      type: "MISSING_LEDGER_ENTRY",
      subtype: "RECEIPT",
      amount_paise: line.credit_paise,
      primary: { type: "bank_line", id: line.id },
      anchor_date: line.txn_date,
      related: [],
      trace: { rule: "stage3.bank_credit_has_receipt", grace_business_days: L.receipt_grace_business_days },
    });
  }
  result.tieOut.bankCredits = credits.map((l) => ({ id: l.id, date: l.txn_date, amount_paise: l.credit_paise }));
  result.tieOut.receipts = receipts.map((r) => ({ id: r.id, date: r.entry_date, amount_paise: r.amount_paise }));

  // Journals: one per settlement, booking exactly the fee + GST it deducted.
  const charges = new Map<string, number>();
  for (const i of src.items) charges.set(i.settlement_id, (charges.get(i.settlement_id) ?? 0) + i.fee_paise + i.gst_paise);
  const settlements = new Map(src.settlements.map((s) => [s.id, s]));
  const journalOf = new Map<string, string>();
  for (const entry of src.ledger.filter((e) => e.voucher_type === "Journal").sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.id.localeCompare(b.id))) {
    const s = settlements.get(entry.reference.trim());
    if (!s) continue;
    const original = journalOf.get(s.id);
    if (original) {
      result.exceptions.push({
        type: "DUPLICATE_LEDGER_ENTRY",
        amount_paise: entry.amount_paise,
        primary: { type: "ledger_entry", id: entry.id },
        anchor_date: entry.entry_date,
        related: [{ type: "ledger_entry", id: original }, { type: "settlement", id: s.id }],
        trace: { rule: "stage3.one_journal_per_settlement", original_ledger_id: original },
      });
      continue;
    }
    journalOf.set(s.id, entry.id);
    result.matches.push({
      kind: "JOURNAL",
      left: { type: "settlement", id: s.id },
      right: { type: "ledger_entry", id: entry.id },
      confidence: 1,
      reason: "JOURNAL_REFERENCE",
      anchor_date: entry.entry_date,
      trace: { rule: "stage3.journal_reference_is_settlement" },
    });
    const expected = charges.get(s.id) ?? 0;
    if (entry.amount_paise !== expected) {
      const delta = entry.amount_paise - expected;
      result.exceptions.push({
        type: "AMOUNT_MISMATCH",
        subtype: amountSubtype(cfg, delta),
        amount_paise: Math.abs(delta),
        primary: { type: "ledger_entry", id: entry.id },
        anchor_date: entry.entry_date,
        related: [{ type: "settlement", id: s.id }],
        trace: { rule: "stage3.journal_equals_fee_plus_gst", expected_paise: expected, journal_paise: entry.amount_paise },
      });
    }
  }
  for (const s of src.settlements) {
    if (journalOf.has(s.id)) continue;
    result.exceptions.push({
      type: "MISSING_LEDGER_ENTRY",
      subtype: "JOURNAL",
      amount_paise: charges.get(s.id) ?? 0,
      primary: { type: "settlement", id: s.id },
      anchor_date: s.settled_at,
      related: [],
      trace: { rule: "stage3.settlement_has_fee_journal" },
    });
  }
  return result;
}
