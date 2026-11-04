import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAudit } from "../audit/audit.ts";
import type { Db } from "../db/open.ts";
import { formatINR, withInr } from "../money.ts";
import { getEvidence, type EvidenceBundle } from "../review/evidence.ts";
import type { FallbackReason, LLMProvider } from "./provider.ts";
import { callStructured } from "./structured.ts";
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from "./untrusted.ts";

export const ExplanationSchema = z.object({
  root_cause: z.string().min(1).max(600),
  explanation: z.string().min(1).max(3000),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string().min(1)).min(1).max(60),
  recommended_action: z.string().min(1).max(600),
  requires_human_review: z.boolean(),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

export const ExplanationOutputSchema = ExplanationSchema.extend({
  exception_id: z.string(),
  source: z.enum(["llm", "deterministic_fallback"]),
  fallback_reason: z.string().nullable(),
  model: z.string().nullable(),
  /** True when the model said no review was needed but policy requires one. */
  review_policy_applied: z.boolean(),
});
export type ExplanationOutput = z.infer<typeof ExplanationOutputSchema>;

/** Policy floor: the model may raise requires_human_review but can never lower it below this. */
export function reviewRequired(type: string, subtype: string | null): boolean {
  if (type === "TIMING_WINDOW_EXCEEDED") return false;
  if (type === "AMOUNT_MISMATCH" && subtype === "ROUNDING") return false;
  return true;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** Template explanation built only from the rule trace and records. Always valid; always cites real ids. */
export function deterministicExplanation(bundle: EvidenceBundle): Explanation {
  const { exception: e, rule_trace: t } = bundle;
  const amount = formatINR(e.amount_paise);
  const ids = bundle.evidence_ids.slice(1, 12);
  const base = { confidence: 0.6, evidence_ids: ids.length ? ids : [e.id], requires_human_review: reviewRequired(e.type, e.subtype) };
  const by: Record<string, () => Omit<Explanation, "confidence" | "evidence_ids" | "requires_human_review"> & { confidence?: number }> = {
    AMOUNT_MISMATCH: () => ({
      root_cause: e.subtype === "ROUNDING" ? "Paise-level rounding difference between two records of the same money" : "The amounts on two linked records differ materially",
      explanation: `Rule ${String(t.rule)} linked these records by identifier, but their amounts differ by ${amount}.`,
      recommended_action: e.subtype === "ROUNDING" ? "Book the difference to rounding off." : "Ask the gateway for the payout breakdown and recover or book the difference.",
    }),
    FEE_GST_MISMATCH: () => ({
      root_cause: t.gst_matches_wrong_base ? "GST was computed on the payment amount instead of on the gateway fee" : "Gateway fee or GST differs from the configured rate",
      explanation: `Expected fee ${formatINR(num((t.expected as Record<string, unknown> | undefined)?.fee_paise))} + GST ${formatINR(num((t.expected as Record<string, unknown> | undefined)?.gst_paise))}; the settlement deducted fee ${formatINR(num((t.actual as Record<string, unknown> | undefined)?.fee_paise))} + GST ${formatINR(num((t.actual as Record<string, unknown> | undefined)?.gst_paise))}.`,
      recommended_action: "Raise the over-deduction with the gateway and book a receivable for the excess.",
      confidence: t.gst_matches_wrong_base ? 0.9 : 0.6,
    }),
    REFUND_AMOUNT_MISMATCH: () => ({
      root_cause: "The settlement deducted a different amount than the refund issued",
      explanation: `Refund of ${formatINR(num(t.refund_paise))} was deducted as ${formatINR(num(t.deducted_paise))}.`,
      recommended_action: "Reconcile the refund with the gateway's refund report and book the difference.",
    }),
    MISSING_SETTLEMENT: () => ({
      root_cause: "A captured payment has not appeared in any settlement after its settlement window",
      explanation: `Payment was due to settle by ${String(t.due_date)} (as of ${String(t.as_of)}) but no settlement includes it.`,
      recommended_action: "Check the payment's settlement status with the gateway (on hold, disputed or missed).",
    }),
    MISSING_BANK_CREDIT: () => ({
      root_cause: "A settlement was paid out but no bank credit for it was found",
      explanation: `Settlement ${e.primary.id} (UTR ${String(t.utr)}) of ${amount} settled on ${String(t.settled_at)} has no matching bank credit.`,
      recommended_action: "Trace the UTR with the bank; if credited under another reference, link it manually.",
    }),
    MISSING_LEDGER_ENTRY: () => ({
      root_cause: e.subtype === "JOURNAL" ? "The gateway fee and GST for this settlement were never booked" : "Money reached the bank but no receipt was booked",
      explanation: `${e.subtype === "JOURNAL" ? "No fee/GST journal" : "No ledger receipt"} exists for ${e.primary.id} (${amount}).`,
      recommended_action: e.subtype === "JOURNAL" ? "Book the fee and GST journal (see draft)." : "Book the receipt against the gateway clearing account (see draft).",
    }),
    DUPLICATE_LEDGER_ENTRY: () => ({
      root_cause: "The same money was booked twice in the ledger",
      explanation: `${e.primary.id} duplicates ledger entry ${String(t.original_ledger_id)}.`,
      recommended_action: "Reverse the duplicate entry.",
    }),
    TIMING_WINDOW_EXCEEDED: () => ({
      root_cause: "The gateway settled later than the method's T+n business-day window",
      explanation: `${num(t.late_payments)} payment(s) were due by ${String(t.earliest_due_date)} and settled on ${String(t.settled_at)} (${num(t.max_business_days_late)} business day(s) late).`,
      recommended_action: "Track the delay against the gateway's settlement SLA.",
    }),
    AMBIGUOUS_BATCH: () => ({
      root_cause: "Several different sets of settlements sum exactly to this bank credit",
      explanation: `${num(t.solutions_found)} candidate set(s) found in a pool of ${num(t.pool_size)}; uniqueness ${t.uniqueness_proven ? "disproved" : "could not be established within the search budget"}.`,
      recommended_action: "Pick the correct candidate set using the gateway payout report.",
    }),
    SUGGESTED_MATCH: () => ({
      root_cause: "The narration's UTR is close to, but not exactly, a settlement UTR",
      explanation: `Suggested on ${String(t.reason)} evidence; exact amount and date window hold.`,
      recommended_action: "Approve the suggestion if the UTR is a typo, otherwise reject it.",
    }),
    UNIDENTIFIED_BANK_CREDIT: () => ({
      root_cause: "No settlement or combination of settlements explains this credit",
      explanation: `No exact or near UTR and no subset of unmatched settlements in the window sums to ${amount}.`,
      recommended_action: "Identify the sender with the bank; it may be a non-gateway receipt.",
    }),
    MATCH_CONFLICT: () => ({
      root_cause: "A unique batch decomposition needs a settlement that is also suggested for a different bank credit",
      explanation: `Conflicting settlement(s): ${JSON.stringify(t.conflicting_settlement_ids)}; suggested on bank line(s) ${JSON.stringify(t.suggested_on_bank_lines)}.`,
      recommended_action: "Decide whether the batch or the suggestion is right; the other is then unidentified.",
    }),
    BANK_LEDGER_MISMATCH: () => ({
      root_cause: e.primary.type === "period" ? "Bank and books differ by an amount no reconciling item explains" : "The ledger receipt and the bank credit disagree",
      explanation: `${e.subtype ?? "Mismatch"}: ${amount}.`,
      recommended_action: "Correct the ledger receipt so it equals the bank credit.",
    }),
    GATEWAY_REPORT_MISMATCH: () => ({
      root_cause:
        e.subtype === "SETTLEMENT_TOTAL"
          ? "The gateway's recon report does not add up to the settlement amount"
          : e.subtype === "SETTLEMENT_MATCHED_ELSEWHERE"
            ? "The gateway report puts a settlement in this payout, but the bank shows it paid separately"
            : "The bank credit does not equal the payout the gateway's recon report describes",
      explanation: `${e.subtype ?? "Mismatch"} of ${amount}. Gateway report total ${formatINR(num(t.report_net_paise))}; settlements total ${formatINR(num(t.settlements_total_paise ?? t.settlement_paise))}${typeof t.credit_paise === "number" ? `; bank credit ${formatINR(t.credit_paise)}` : ""}${typeof t.settlement_utr === "string" ? ` (payout UTR ${t.settlement_utr})` : ""}.`,
      recommended_action: "Ask the gateway for the payout breakdown of this UTR and compare it with the bank statement before matching.",
    }),
  };
  const pick = by[e.type]?.() ?? { root_cause: `${e.type} raised by ${String(t.rule)}`, explanation: JSON.stringify(t).slice(0, 2000), recommended_action: "Review the evidence." };
  return ExplanationSchema.parse({ ...base, ...pick });
}

const SYSTEM = [
  "You explain reconciliation exceptions for an Indian finance team. The matching engine has already decided what is matched; you never change that.",
  UNTRUSTED_PREAMBLE,
  'Respond with one JSON object: {"root_cause": string, "explanation": string, "confidence": number 0-1, "evidence_ids": string[], "recommended_action": string, "requires_human_review": boolean}.',
  "Cite only ids from the allowed evidence list. Every amount comes with a pre-formatted *_inr string: quote those strings exactly and never add, subtract or convert amounts yourself; the engine has already done all arithmetic.",
  "engine_finding is the deterministic engine's own statement of what happened: your explanation must be consistent with it and must not contradict it; add clarity and context for a finance reader, not new facts.",
  "root_cause is one plain-English sentence describing the cause (never just the exception type code); explanation is 2-4 sentences; recommended_action is one concrete next step.",
].join(" ");

/**
 * Explain one exception from a read-only evidence bundle. The output is zod-validated and rejected if it
 * cites any id that isn't in the bundle; on any failure the deterministic template is used and the reason
 * is recorded. Writes only ai_outputs and audit_log.
 */
export async function explainException(db: Db, exceptionId: string, provider: LLMProvider | null, maxTokens = 1500): Promise<ExplanationOutput> {
  const bundle = getEvidence(db, exceptionId);
  const allowed = new Set(bundle.evidence_ids);
  // The deterministic finding grounds the model: it may rephrase and contextualise, never contradict.
  const finding = deterministicExplanation(bundle);
  const trusted = withInr({
    exception: bundle.exception,
    engine_finding: { root_cause: finding.root_cause, explanation: finding.explanation, recommended_action: finding.recommended_action },
    rule_trace: bundle.rule_trace,
    candidate_sets: bundle.candidate_sets,
    links: bundle.matches,
  });
  const user = [
    "Exception and rule trace (generated by the deterministic engine):",
    JSON.stringify(trusted),
    "Records involved (source data, untrusted):",
    wrapUntrusted("records", JSON.stringify(withInr(bundle.records))),
    `Allowed evidence_ids: ${JSON.stringify(bundle.evidence_ids)}`,
  ].join("\n");

  const res = await callStructured(provider, { system: SYSTEM, user, maxTokens }, ExplanationSchema, (v): FallbackReason | null =>
    v.evidence_ids.every((id) => allowed.has(id)) ? null : "fabricated_evidence",
  );
  const explanation = res.ok ? res.value : deterministicExplanation(bundle);
  const floor = reviewRequired(bundle.exception.type, bundle.exception.subtype);
  const output = ExplanationOutputSchema.parse({
    ...explanation,
    requires_human_review: explanation.requires_human_review || floor,
    exception_id: exceptionId,
    source: res.ok ? "llm" : "deterministic_fallback",
    fallback_reason: res.ok ? null : res.reason,
    model: res.ok ? res.model : null,
    review_policy_applied: floor && !explanation.requires_human_review,
  });

  db.transaction(() => {
    db.prepare("INSERT INTO ai_outputs (id, kind, key, source, fallback_reason, model, payload_json, created_at) VALUES (?, 'explanation', ?, ?, ?, ?, ?, ?)").run(
      randomUUID(),
      exceptionId,
      output.source,
      output.fallback_reason,
      output.model,
      JSON.stringify(output),
      new Date().toISOString(),
    );
    appendAudit(db, {
      actor: output.source === "llm" ? "llm" : "system",
      action: "investigation",
      entity_type: "exception",
      entity_id: exceptionId,
      payload: { source: output.source, fallback_reason: output.fallback_reason, detail: res.ok ? null : (res.detail ?? null), model: output.model, review_policy_applied: output.review_policy_applied },
    });
  })();
  return output;
}
