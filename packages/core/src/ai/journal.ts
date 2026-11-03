import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAudit } from "../audit/audit.ts";
import type { Db } from "../db/open.ts";
import { PaiseSchema } from "../money.ts";
import { getEvidence, type EvidenceBundle } from "../review/evidence.ts";
import type { FallbackReason, LLMProvider } from "./provider.ts";
import { callStructured } from "./structured.ts";
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from "./untrusted.ts";

export const CHART_OF_ACCOUNTS = [
  "Bank Account",
  "Razorpay Settlement Clearing",
  "Payment Gateway Charges",
  "GST Input Credit",
  "Receivable from Razorpay",
  "Rounding Off",
  "Suspense",
] as const;

export const JournalLineSchema = z
  .object({
    account: z.enum(CHART_OF_ACCOUNTS),
    debit_paise: PaiseSchema.nonnegative(),
    credit_paise: PaiseSchema.nonnegative(),
    memo: z.string().max(200).default(""),
  })
  .refine((l) => (l.debit_paise > 0) !== (l.credit_paise > 0), "each line is either a debit or a credit");
export type JournalLine = z.infer<typeof JournalLineSchema>;

export const JournalProposalSchema = z.object({
  narration: z.string().min(1).max(300),
  lines: z.array(JournalLineSchema).min(2).max(6),
});
export type JournalProposal = z.infer<typeof JournalProposalSchema>;

const DraftedSchema = z.object({
  applicable: z.literal(true),
  exception_id: z.string(),
  draft_id: z.string(),
  status: z.literal("pending_approval"),
  narration: z.string(),
  lines: z.array(JournalLineSchema),
  total_paise: PaiseSchema.positive(),
  source: z.enum(["llm", "deterministic_fallback"]),
  fallback_reason: z.string().nullable(),
});

export const JournalDraftOutputSchema = z.discriminatedUnion("applicable", [
  z.object({ applicable: z.literal(false), exception_id: z.string(), reason: z.string() }),
  DraftedSchema,
]);
export type JournalDraftOutput = z.infer<typeof JournalDraftOutputSchema>;

type Template = { applicable: false; reason: string } | { applicable: true; total: number; proposal: JournalProposal };

const dr = (account: JournalLine["account"], amount: number, memo = ""): JournalLine => ({ account, debit_paise: amount, credit_paise: 0, memo });
const cr = (account: JournalLine["account"], amount: number, memo = ""): JournalLine => ({ account, debit_paise: 0, credit_paise: amount, memo });
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** The deterministic correcting entry for an exception, or why none applies. Amounts come only from the engine. */
export function journalTemplate(bundle: EvidenceBundle): Template {
  const { exception: e, rule_trace: t } = bundle;
  const ref = e.primary.id;
  const entry = (narration: string, lines: JournalLine[]): Template => {
    const kept = lines.filter((l) => l.debit_paise + l.credit_paise > 0);
    const total = kept.reduce((s, l) => s + l.debit_paise, 0);
    return total > 0 ? { applicable: true, total, proposal: { narration, lines: kept } } : { applicable: false, reason: "nothing to book" };
  };
  switch (e.type) {
    case "FEE_GST_MISMATCH": {
      const exp = (t.expected ?? {}) as Record<string, unknown>;
      const act = (t.actual ?? {}) as Record<string, unknown>;
      const feeDiff = num(act.fee_paise) - num(exp.fee_paise);
      const gstDiff = num(act.gst_paise) - num(exp.gst_paise);
      const excess = feeDiff + gstDiff;
      if (excess <= 0) return { applicable: false, reason: "under-deduction: confirm with the gateway before booking" };
      return entry(`Excess gateway fee/GST deducted for ${ref}, recoverable from Razorpay`, [
        dr("Receivable from Razorpay", excess, "excess deducted"),
        cr("GST Input Credit", Math.max(0, gstDiff), "GST charged on wrong base"),
        cr("Payment Gateway Charges", Math.max(0, feeDiff), "fee over-charged"),
      ].concat(gstDiff < 0 ? [dr("GST Input Credit", -gstDiff)] : [], feeDiff < 0 ? [dr("Payment Gateway Charges", -feeDiff)] : []));
    }
    case "MISSING_LEDGER_ENTRY": {
      if (e.subtype === "JOURNAL") {
        const s = bundle.records.find((r) => r.evidence_id === ref)?.data ?? {};
        return entry(`Gateway fee and GST on fees for settlement ${ref}`, [
          dr("Payment Gateway Charges", num(s.fee_paise_total)),
          dr("GST Input Credit", num(s.gst_paise_total)),
          cr("Razorpay Settlement Clearing", num(s.fee_paise_total) + num(s.gst_paise_total)),
        ]);
      }
      return entry(`Razorpay settlement received, bank line ${ref}`, [dr("Bank Account", e.amount_paise), cr("Razorpay Settlement Clearing", e.amount_paise)]);
    }
    case "DUPLICATE_LEDGER_ENTRY":
      return entry(`Reversal of duplicate entry ${ref} (original ${String(t.original_ledger_id)})`, [dr("Razorpay Settlement Clearing", e.amount_paise), cr("Bank Account", e.amount_paise)]);
    case "BANK_LEDGER_MISMATCH": {
      if (e.primary.type === "period") return { applicable: false, reason: "unexplained tie-out residual: investigate before booking" };
      if (e.primary.type === "ledger_entry") {
        return entry(`Reversal of receipt ${ref} with no bank credit`, [dr("Razorpay Settlement Clearing", e.amount_paise), cr("Bank Account", e.amount_paise)]);
      }
      const delta = num(t.delta_paise); // credit − receipt
      return delta > 0
        ? entry(`Receipt for ${ref} booked short by the difference`, [dr("Bank Account", delta), cr("Razorpay Settlement Clearing", delta)])
        : entry(`Receipt for ${ref} booked in excess of the bank credit`, [dr("Razorpay Settlement Clearing", -delta), cr("Bank Account", -delta)]);
    }
    case "REFUND_AMOUNT_MISMATCH": {
      const delta = num(t.delta_paise); // deducted − refund
      return delta > 0
        ? entry(`Refund over-deducted for ${ref}, recoverable`, [dr("Receivable from Razorpay", delta), cr("Razorpay Settlement Clearing", delta)])
        : entry(`Refund under-deducted for ${ref}`, [dr("Razorpay Settlement Clearing", -delta), cr("Receivable from Razorpay", -delta)]);
    }
    case "AMOUNT_MISMATCH": {
      if (e.primary.type !== "bank_line") return { applicable: false, reason: "source-record arithmetic issue: correct at source" };
      const delta = num(t.delta_paise); // credit − settlement
      const other = e.subtype === "ROUNDING" ? "Rounding Off" : delta < 0 ? "Receivable from Razorpay" : "Suspense";
      return delta < 0
        ? entry(`Bank credit ${ref} short of the settlement`, [dr(other, -delta), cr("Razorpay Settlement Clearing", -delta)])
        : entry(`Bank credit ${ref} exceeds the settlement`, [dr("Razorpay Settlement Clearing", delta), cr(other, delta)]);
    }
    default:
      return { applicable: false, reason: `${e.type} needs a matching decision, not a journal entry` };
  }
}

const SYSTEM = [
  "You draft correcting journal entries for an Indian finance team. Drafts are never posted automatically.",
  UNTRUSTED_PREAMBLE,
  'Respond with one JSON object: {"narration": string, "lines": [{"account": string, "debit_paise": integer, "credit_paise": integer, "memo": string}]}.',
  `Use only these accounts: ${CHART_OF_ACCOUNTS.join(", ")}. Amounts are integer paise. Debits must equal credits and must total exactly the stated amount.`,
].join(" ");

/**
 * Propose a correcting entry as a DRAFT (status pending_approval) — never posted to the ledger.
 * The model may choose wording and accounts, but the entry must balance and total exactly the
 * engine-computed amount, or the deterministic template is used.
 */
export async function draftJournalEntry(db: Db, exceptionId: string, provider: LLMProvider | null): Promise<JournalDraftOutput> {
  const bundle = getEvidence(db, exceptionId);
  const template = journalTemplate(bundle);
  if (!template.applicable) {
    appendAudit(db, { actor: "system", action: "journal_draft", entity_type: "exception", entity_id: exceptionId, payload: { applicable: false, reason: template.reason } });
    return JournalDraftOutputSchema.parse({ applicable: false, exception_id: exceptionId, reason: template.reason });
  }

  const user = [
    `Exception ${bundle.exception.type}${bundle.exception.subtype ? ` (${bundle.exception.subtype})` : ""}; rule trace: ${JSON.stringify(bundle.rule_trace)}`,
    `The correcting entry must total exactly ${template.total} paise. Reference template: ${JSON.stringify(template.proposal)}`,
    "Records (source data, untrusted):",
    wrapUntrusted("records", JSON.stringify(bundle.records)),
  ].join("\n");
  const res = await callStructured(provider, { system: SYSTEM, user, maxTokens: 600 }, JournalProposalSchema, (p): FallbackReason | null => {
    const debit = p.lines.reduce((s, l) => s + l.debit_paise, 0);
    const credit = p.lines.reduce((s, l) => s + l.credit_paise, 0);
    return debit === credit && debit === template.total ? null : "unbalanced_entry";
  });
  const proposal = res.ok ? res.value : template.proposal;
  const draftId = randomUUID();
  const output = DraftedSchema.parse({
    applicable: true,
    exception_id: exceptionId,
    draft_id: draftId,
    status: "pending_approval",
    narration: proposal.narration,
    lines: proposal.lines,
    total_paise: template.total,
    source: res.ok ? "llm" : "deterministic_fallback",
    fallback_reason: res.ok ? null : res.reason,
  });

  db.transaction(() => {
    db.prepare(
      "INSERT INTO journal_drafts (id, exception_id, status, lines_json, narration, source, fallback_reason, created_at) VALUES (?, ?, 'pending_approval', ?, ?, ?, ?, ?)",
    ).run(draftId, exceptionId, JSON.stringify(output.lines), output.narration, output.source, output.fallback_reason, new Date().toISOString());
    appendAudit(db, {
      actor: output.source === "llm" ? "llm" : "system",
      action: "journal_draft",
      entity_type: "journal_draft",
      entity_id: draftId,
      payload: { exception_id: exceptionId, source: output.source, fallback_reason: output.fallback_reason, total_paise: template.total },
    });
  })();
  return output;
}
