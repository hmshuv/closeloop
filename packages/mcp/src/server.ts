import {
  addDays,
  approveBatchCandidate,
  approveSuggestion,
  CONTIGUITY_ASSUMPTION,
  datasetMeta,
  draftJournalEntry,
  escalateException,
  EXCEPTION_TYPES,
  EXPOSURE_BY_TYPE,
  EXPOSURE_CLASSES,
  explainException,
  getAuditTrail,
  getEvidence,
  IsoDateSchema,
  latestRun,
  loadException,
  runReconciliationWithAI,
  showcaseCases,
  suggestionCandidates,
  type CloseLoopConfig,
  type Db,
  type LLMProvider,
  type ReconSummary,
} from "@closeloop/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConfirmationStore } from "./confirm.ts";
import { decodeCursor, DEFAULT_PAGE_SIZE, money, page, withInr } from "./format.ts";
import {
  AuditOutput,
  DecomposeOutput,
  DraftOutput,
  EvidenceOutput,
  ExplainOutput,
  HumanActionOutput,
  ListExceptionsOutput,
  RunOutput,
} from "./schemas.ts";

export interface ServerContext {
  db: Db;
  cfg: CloseLoopConfig;
  provider: LLMProvider | null;
  confirmations: ConfirmationStore;
}

const INSTRUCTIONS = [
  "CloseLoop reconciles Razorpay-style gateway settlements against the bank statement and the accounting ledger.",
  "All money is integer paise; every amount also comes pre-formatted as amount_inr (Indian grouping). Quote amount_inr and the totals the tools return; never do arithmetic on amounts yourself.",
  "Exposure is reported per class (AMOUNT_AT_RISK, AWAITING_SETTLEMENT, STRUCTURAL) and must never be added together.",
  "The deterministic engine decides every match. approve_suggestion and escalate are human actions: call once to get a preview and confirm_token, show the preview to the user, and only call again with confirm_token and the user's name as reviewer after they explicitly agree.",
].join(" ");

const LABELS: Record<string, string> = {
  AMOUNT_MISMATCH: "Amounts differ on linked records",
  FEE_GST_MISMATCH: "Gateway fee/GST deducted incorrectly",
  REFUND_AMOUNT_MISMATCH: "Refund deducted at the wrong amount",
  MISSING_SETTLEMENT: "Captured payment never settled",
  MISSING_BANK_CREDIT: "Settlement never reached the bank",
  MISSING_LEDGER_ENTRY: "Missing ledger entry",
  DUPLICATE_LEDGER_ENTRY: "Duplicate ledger entry",
  TIMING_WINDOW_EXCEEDED: "Settled after the T+n window",
  AMBIGUOUS_BATCH: "Several settlement sets fit this bank credit",
  SUGGESTED_MATCH: "Probable match awaiting approval",
  UNIDENTIFIED_BANK_CREDIT: "Bank credit with no matching settlement",
  MATCH_CONFLICT: "Batch and suggestion claim the same settlement",
  BANK_LEDGER_MISMATCH: "Ledger receipt disagrees with the bank",
};

function respond<T extends { summary: string }>(data: T) {
  return { content: [{ type: "text" as const, text: `${data.summary}\n\n${JSON.stringify(data)}` }], structuredContent: data };
}

async function ensureRun(ctx: ServerContext) {
  const existing = latestRun(ctx.db);
  if (existing) return existing;
  await runReconciliationWithAI(ctx.db, ctx.cfg, {}, ctx.provider);
  const run = latestRun(ctx.db);
  if (!run) throw new Error("Reconciliation did not produce a run");
  return run;
}

export function runOutput(summary: ReconSummary, ai: string): z.infer<typeof RunOutput> {
  const byType = EXCEPTION_TYPES.map((type) => ({ type, exposure_class: EXPOSURE_BY_TYPE[type], count: summary.exceptions_by_type[type].count, total: money(summary.exceptions_by_type[type].amount_paise) }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.total.amount_paise - a.total.amount_paise);
  const classes = EXPOSURE_CLASSES.map((c) => ({ exposure_class: c, count: summary.exposure_by_class[c].count, total: money(summary.exposure_by_class[c].amount_paise) }));
  const total = byType.reduce((s, t) => s + t.count, 0);
  const t = summary.tie_out;
  const m = summary.matched;
  return {
    summary:
      `${summary.from} → ${summary.to}: ${total} exceptions. ` +
      classes.map((c) => `${c.exposure_class} ${c.total.amount_inr} (${c.count})`).join(" · ") +
      `. Matched ${m.bank_exact + m.bank_fuzzy + m.bank_batch_contiguous_credits + m.bank_batch_credits} bank credits ` +
      `(${m.bank_exact} exact, ${m.bank_fuzzy} fuzzy, ${m.bank_batch_contiguous_credits + m.bank_batch_credits} batch covering ${m.bank_batch_settlements} settlements). ` +
      `Bank vs books residual ${money(t.residual_paise).amount_inr}.`,
    run_id: summary.run_id,
    period: { from: summary.from, to: summary.to },
    matched: {
      payments_settled: m.payments_settled,
      bank_credits_exact_utr: m.bank_exact,
      bank_credits_fuzzy_utr: m.bank_fuzzy,
      bank_credits_batch_contiguous: m.bank_batch_contiguous_credits,
      bank_credits_batch_subset: m.bank_batch_credits,
      settlements_inside_batch_credits: m.bank_batch_settlements,
      ledger_receipts_by_reference: m.ledger_by_reference,
      ledger_receipts_by_attributes: m.ledger_by_attributes,
      fee_journals: m.journals,
    },
    exceptions: { total_count: total, by_type: byType },
    exposure_by_class: classes,
    exposure_note: "Exposure classes measure different things and are never summed into one figure.",
    pending: {
      payments_in_settlement_window: summary.pending.payments_in_window,
      receipts_in_booking_grace: summary.pending.receipts_in_grace,
      settlements_unresolved_in_batch: summary.pending.unresolved_in_batch,
    },
    tie_out: {
      bank_credits: money(t.bank_credits_paise),
      book_receipts: money(t.book_receipts_paise),
      difference: money(t.difference_paise),
      explained_by_reconciling_items: money(t.explained_paise),
      unexplained_residual: money(t.residual_paise),
    },
    batch_search: summary.batch,
    ai,
  };
}

function aiLabel(provider: LLMProvider | null): string {
  return provider ? `LLM ${provider.model}: narration hints only; the deterministic engine decides matches.` : "No LLM configured: deterministic engine and templates only.";
}

interface SettlementRow {
  id: string;
  utr: string;
  settled_at: string;
  created_at: string;
  amount_paise: number;
}

export function createCloseLoopServer(ctx: ServerContext): McpServer {
  const { db } = ctx;
  const server = new McpServer({ name: "closeloop", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const settlementsById = (ids: string[]) => {
    const get = db.prepare("SELECT id, utr, settled_at, created_at, amount_paise FROM settlements WHERE id = ?");
    return ids.map((id) => get.get(id) as SettlementRow | undefined).filter((s): s is SettlementRow => Boolean(s));
  };
  const settlementLine = (s: SettlementRow) => ({ settlement_id: s.id, utr: s.utr, settled_at: s.settled_at, created_at: s.created_at, amount: money(s.amount_paise) });
  const candidateSets = (exceptionId: string, credit: number) =>
    (db.prepare("SELECT set_index, settlement_ids_json FROM batch_candidate_sets WHERE exception_id = ? ORDER BY set_index").all(exceptionId) as { set_index: number; settlement_ids_json: string }[]).map((r) => {
      const ids = z.array(z.string()).parse(JSON.parse(r.settlement_ids_json));
      const total = settlementsById(ids).reduce((s, x) => s + x.amount_paise, 0);
      return { index: r.set_index, settlement_ids: ids, total: money(total), matches_credit: total === credit, difference_vs_credit: money(credit - total) };
    });
  const creditOf = (lineId: string) => (db.prepare("SELECT credit_paise FROM bank_lines WHERE id = ?").get(lineId) as { credit_paise: number } | undefined)?.credit_paise ?? 0;

  // ---------- run_reconciliation ----------
  server.registerTool(
    "run_reconciliation",
    {
      title: "Run reconciliation",
      description:
        "Reconcile payments, gateway settlements, the bank statement and the ledger for a period, as of its end date. Returns matched counts by kind (exact UTR, fuzzy UTR, batch), exceptions by type with totals, exposure per class (never summed), and the bank-vs-books tie-out. Dates are YYYY-MM-DD; both default to the dataset's full period. Creates a new run that later tools use.",
      inputSchema: { from: IsoDateSchema.optional().describe("First day to report, YYYY-MM-DD"), to: IsoDateSchema.optional().describe("Last day, also the as-of date, YYYY-MM-DD") },
      outputSchema: RunOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to }) => {
      const { summary } = await runReconciliationWithAI(db, ctx.cfg, { from, to }, ctx.provider);
      return respond(RunOutput.parse(runOutput(summary, aiLabel(ctx.provider))));
    },
  );

  // ---------- list_exceptions ----------
  server.registerTool(
    "list_exceptions",
    {
      title: "List exceptions",
      description:
        "List exceptions from the latest reconciliation run, largest amount first, optionally filtered by type, exposure class, minimum amount (paise) or status. Paginated: default 20 per page; pass next_cursor to continue. Each item includes amount_inr and a one-line description; the response includes the count and total for the whole filtered set.",
      inputSchema: {
        type: z.enum(EXCEPTION_TYPES).optional(),
        exposure_class: z.enum(EXPOSURE_CLASSES).optional(),
        min_amount_paise: z.number().int().nonnegative().optional().describe("Integer paise, e.g. 1000000 = ₹10,000.00"),
        status: z.enum(["open", "approved", "escalated"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      outputSchema: ListExceptionsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const run = await ensureRun(ctx);
      const where = ["run_id = ?", "anchor_date BETWEEN ? AND ?"];
      const params: (string | number)[] = [run.id, run.from, run.to];
      const filter = (clause: string, value: string | number | undefined) => {
        if (value === undefined) return;
        where.push(clause);
        params.push(value);
      };
      filter("type = ?", args.type);
      filter("exposure_class = ?", args.exposure_class);
      filter("amount_paise >= ?", args.min_amount_paise);
      filter("status = ?", args.status);
      const rows = db
        .prepare(`SELECT id, type, subtype, exposure_class, status, amount_paise, anchor_date, primary_type, primary_id FROM exceptions WHERE ${where.join(" AND ")} ORDER BY amount_paise DESC, id`)
        .all(...params) as { id: string; type: string; subtype: string | null; exposure_class: string; status: string; amount_paise: number; anchor_date: string; primary_type: string; primary_id: string }[];
      const filters = { type: args.type ?? null, exposure_class: args.exposure_class ?? null, min_amount_paise: args.min_amount_paise ?? null, status: args.status ?? null };
      const scope = `exceptions:${run.id}:${JSON.stringify(filters)}`;
      const p = page(rows, decodeCursor(args.cursor, scope), args.limit ?? DEFAULT_PAGE_SIZE, scope);
      const total = money(rows.reduce((s, r) => s + r.amount_paise, 0));
      return respond(
        ListExceptionsOutput.parse({
          summary: `${rows.length} exception(s) in ${run.from} → ${run.to} match these filters, totalling ${total.amount_inr}. Showing ${p.showing}, largest first.${p.next_cursor ? " Pass next_cursor for more." : ""}`,
          run_id: run.id,
          period: { from: run.from, to: run.to },
          filters,
          total_count: rows.length,
          total,
          showing: p.showing,
          items: p.items.map((r) => ({
            exception_id: r.id,
            type: r.type,
            subtype: r.subtype,
            exposure_class: r.exposure_class,
            status: r.status,
            amount: money(r.amount_paise),
            anchor_date: r.anchor_date,
            primary: { type: r.primary_type, id: r.primary_id },
            description: `${LABELS[r.type] ?? r.type}${r.subtype ? ` (${r.subtype})` : ""}: ${r.primary_type} ${r.primary_id}, ${money(r.amount_paise).amount_inr}`,
          })),
          next_cursor: p.next_cursor,
        }),
      );
    },
  );

  // ---------- get_evidence ----------
  server.registerTool(
    "get_evidence",
    {
      title: "Get evidence",
      description:
        "All records involved in one exception (payments, settlements, bank lines, ledger entries), the deterministic rule that fired with its trace, batch candidate sets with their totals, linked matches, deferred settlements and the exception's audit history. Read-only.",
      inputSchema: { exception_id: z.string().min(1) },
      outputSchema: EvidenceOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ exception_id }) => {
      const b = getEvidence(db, exception_id);
      const credit = b.exception.primary.type === "bank_line" ? creditOf(b.exception.primary.id) : 0;
      const sets = candidateSets(b.exception.id, credit);
      const deferred = db.prepare("SELECT settlement_id, status FROM settlement_reviews WHERE exception_id = ? ORDER BY settlement_id").all(exception_id) as { settlement_id: string; status: string }[];
      return respond(
        EvidenceOutput.parse({
          summary: `${LABELS[b.exception.type] ?? b.exception.type} (${b.exception.status}), ${money(b.exception.amount_paise).amount_inr}. Rule ${String(b.rule_trace.rule)}; ${b.records.length} record(s)${sets.length ? `, ${sets.length} candidate set(s)` : ""}.`,
          exception: { ...b.exception, amount: money(b.exception.amount_paise) },
          rule_trace: withInr(b.rule_trace),
          candidate_sets: sets,
          records: b.records.map((r) => ({ ...r, data: withInr(r.data) })),
          links: b.matches,
          deferred_settlements: deferred,
          audit_history: getAuditTrail(db, exception_id),
          evidence_ids: b.evidence_ids,
        }),
      );
    },
  );

  // ---------- explain_exception ----------
  server.registerTool(
    "explain_exception",
    {
      title: "Explain exception",
      description:
        "Root cause, explanation, confidence, cited evidence ids and a recommended action for one exception, generated from its read-only evidence. Uses the configured LLM when available and falls back to a deterministic template otherwise; `source` says which. Never changes any match or financial record.",
      inputSchema: { exception_id: z.string().min(1) },
      outputSchema: ExplainOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ exception_id }) => {
      const out = await explainException(db, exception_id, ctx.provider, ctx.cfg.ai.explanation.max_tokens);
      const amount = money(loadExceptionAmount(db, exception_id));
      return respond(
        ExplainOutput.parse({
          summary: `${out.root_cause}. Recommended: ${out.recommended_action}${out.requires_human_review ? " Requires human review." : ""} (source: ${out.source}${out.fallback_reason ? `, ${out.fallback_reason}` : ""})`,
          exception_id: out.exception_id,
          root_cause: out.root_cause,
          explanation: out.explanation,
          confidence: out.confidence,
          evidence_ids: out.evidence_ids,
          recommended_action: out.recommended_action,
          requires_human_review: out.requires_human_review,
          source: out.source,
          fallback_reason: out.fallback_reason,
          model: out.model,
          amount,
        }),
      );
    },
  );

  // ---------- decompose_bank_credit ----------
  server.registerTool(
    "decompose_bank_credit",
    {
      title: "Decompose bank credit",
      description:
        "Show how one bank credit breaks down into gateway settlements in the latest run: the matched settlement set with its total and difference, or, if ambiguous or conflicting, every ranked candidate set with totals. Contiguous decompositions state their payout-model assumption. Read-only.",
      inputSchema: { bank_line_id: z.string().min(1) },
      outputSchema: DecomposeOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ bank_line_id }) => {
      const line = db.prepare("SELECT id, txn_date, narration, credit_paise FROM bank_lines WHERE id = ?").get(bank_line_id) as
        | { id: string; txn_date: string; narration: string; credit_paise: number }
        | undefined;
      if (!line) throw new Error(`Unknown bank line ${bank_line_id}`);
      if (line.credit_paise <= 0) throw new Error(`${bank_line_id} is a debit, not a credit`);
      const run = await ensureRun(ctx);
      const credit = money(line.credit_paise);
      const matches = db
        .prepare("SELECT kind, left_id FROM matches WHERE run_id = ? AND right_id = ? AND left_type = 'settlement' AND kind IN ('EXACT','FUZZY','BATCH','BATCH_CONTIGUOUS','HUMAN_APPROVED') ORDER BY left_id")
        .all(run.id, line.id) as { kind: string; left_id: string }[];
      const exc = db
        .prepare("SELECT id, type, status FROM exceptions WHERE run_id = ? AND primary_id = ? AND type IN ('AMBIGUOUS_BATCH','MATCH_CONFLICT','SUGGESTED_MATCH','UNIDENTIFIED_BANK_CREDIT') ORDER BY type LIMIT 1")
        .get(run.id, line.id) as { id: string; type: string; status: string } | undefined;
      const base = { run_id: run.id, bank_line: { id: line.id, txn_date: line.txn_date, narration: line.narration, credit }, candidate_sets: [], exception_id: exc?.id ?? null };

      if (matches.length > 0) {
        const settlements = settlementsById(matches.map((m) => m.left_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
        const sum = settlements.reduce((s, x) => s + x.amount_paise, 0);
        const kind = matches.some((m) => m.kind === "HUMAN_APPROVED") ? "HUMAN_APPROVED" : (matches[0]?.kind ?? "");
        const status = kind === "HUMAN_APPROVED" ? "human_approved" : kind.startsWith("BATCH") ? "decomposed" : "matched_single_settlement";
        const how = kind === "BATCH_CONTIGUOUS" ? "a contiguous run of settlements (unique under the payout-model assumption)" : kind === "BATCH" ? "a proven-unique subset of settlements" : kind === "HUMAN_APPROVED" ? "a human-approved set" : `a ${kind.toLowerCase()} UTR match`;
        return respond(
          DecomposeOutput.parse({
            ...base,
            summary: `${line.id} (${credit.amount_inr} on ${line.txn_date}) = ${settlements.length} settlement(s), matched as ${how}. Settlements total ${money(sum).amount_inr}; difference ${money(line.credit_paise - sum).amount_inr}.`,
            status,
            match_kind: kind,
            assumption: kind === "BATCH_CONTIGUOUS" ? CONTIGUITY_ASSUMPTION : null,
            settlements: settlements.map(settlementLine),
            settlements_total: money(sum),
            difference_vs_credit: money(line.credit_paise - sum),
            note: line.credit_paise === sum ? "The settlements sum exactly to the credit." : "The credit and settlements differ; see the AMOUNT_MISMATCH exception.",
          }),
        );
      }
      if (exc && (exc.type === "AMBIGUOUS_BATCH" || exc.type === "MATCH_CONFLICT")) {
        const sets = candidateSets(exc.id, line.credit_paise).map((s) => ({ ...s, settlements: settlementsById(s.settlement_ids).map(settlementLine) }));
        const conflict = exc.type === "MATCH_CONFLICT";
        return respond(
          DecomposeOutput.parse({
            ...base,
            summary: conflict
              ? `${line.id} (${credit.amount_inr}) has exactly one decomposition, but it needs a settlement already suggested for another bank credit, so nothing was auto-matched. A human must decide (exception ${exc.id}).`
              : `${line.id} (${credit.amount_inr}) fits ${sets.length} ranked candidate set(s) exactly; the engine cannot prove which one is right (exception ${exc.id}). Pick one with approve_suggestion(set_index).`,
            status: conflict ? "conflict" : "ambiguous",
            match_kind: null,
            assumption: null,
            settlements: [],
            settlements_total: null,
            difference_vs_credit: null,
            candidate_sets: sets,
            note: "Candidate sets are ranked by contiguity, then date closeness. A gateway payout report would settle it.",
          }),
        );
      }
      if (exc?.type === "SUGGESTED_MATCH") {
        const settlements = settlementsById(suggestionCandidates(db, exc.id));
        return respond(
          DecomposeOutput.parse({
            ...base,
            summary: `${line.id} (${credit.amount_inr}) has a suggested match awaiting approval (exception ${exc.id}): ${settlements.map((s) => `${s.id} ${money(s.amount_paise).amount_inr}`).join(", ")}.`,
            status: "suggested",
            match_kind: null,
            assumption: null,
            settlements: settlements.map(settlementLine),
            settlements_total: null,
            difference_vs_credit: null,
            note: "Suggestions need human approval via approve_suggestion.",
          }),
        );
      }
      return respond(
        DecomposeOutput.parse({
          ...base,
          summary: `${line.id} (${credit.amount_inr}) has no exact or near UTR, and no set of unmatched settlements in the window sums to it.`,
          status: "unidentified",
          match_kind: null,
          assumption: null,
          settlements: [],
          settlements_total: null,
          difference_vs_credit: null,
          note: "It may be a non-gateway receipt; identify the sender with the bank.",
        }),
      );
    },
  );

  // ---------- draft_journal_entry ----------
  server.registerTool(
    "draft_journal_entry",
    {
      title: "Draft journal entry",
      description:
        "Propose a correcting journal entry for one exception (e.g. booking missing gateway fee + GST, reversing a duplicate receipt). Always a DRAFT with status pending_approval; nothing is posted to the ledger. Debits and credits are pre-totalled and always balance to the engine's amount.",
      inputSchema: { exception_id: z.string().min(1) },
      outputSchema: DraftOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ exception_id }) => {
      const d = await draftJournalEntry(db, exception_id, ctx.provider, ctx.cfg.ai.journal.max_tokens);
      if (!d.applicable) {
        return respond(
          DraftOutput.parse({
            summary: `No journal entry drafted: ${d.reason}.`,
            exception_id,
            applicable: false,
            reason: d.reason,
            draft_id: null,
            status: null,
            narration: null,
            lines: [],
            total_debits: null,
            total_credits: null,
            source: null,
            fallback_reason: null,
          }),
        );
      }
      const debits = d.lines.reduce((s, l) => s + l.debit_paise, 0);
      const credits = d.lines.reduce((s, l) => s + l.credit_paise, 0);
      return respond(
        DraftOutput.parse({
          summary: `Draft ${d.draft_id} (pending_approval, not posted): ${d.narration}. ${d.lines.map((l) => `${l.debit_paise ? "Dr" : "Cr"} ${l.account} ${money(l.debit_paise || l.credit_paise).amount_inr}`).join("; ")}. Balanced at ${money(debits).amount_inr}.`,
          exception_id,
          applicable: true,
          reason: null,
          draft_id: d.draft_id,
          status: d.status,
          narration: d.narration,
          lines: d.lines.map((l) => ({ account: l.account, debit: money(l.debit_paise), credit: money(l.credit_paise), memo: l.memo })),
          total_debits: money(debits),
          total_credits: money(credits),
          source: d.source,
          fallback_reason: d.fallback_reason,
        }),
      );
    },
  );

  // ---------- approve_suggestion (two-step) ----------
  server.registerTool(
    "approve_suggestion",
    {
      title: "Approve suggestion (human action)",
      description:
        "Human approval of a SUGGESTED_MATCH (choose candidate_index, default 0) or of one candidate set of an AMBIGUOUS_BATCH / MATCH_CONFLICT (choose set_index). Two steps: call without confirm_token to get a preview and a confirm_token valid for 5 minutes; show the preview to the user; only after they agree, call again with the same id, confirm_token and reviewer (their name). Records a human-approved link and an audit event; never modifies payments, settlements, bank lines or ledger entries.",
      inputSchema: {
        id: z.string().min(1).describe("Exception id"),
        candidate_index: z.number().int().nonnegative().optional(),
        set_index: z.number().int().nonnegative().optional(),
        confirm_token: z.string().optional(),
        reviewer: z.string().optional().describe("Name of the person approving; required with confirm_token"),
      },
      outputSchema: HumanActionOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ id, candidate_index, set_index, confirm_token, reviewer }) => {
      type Payload = { id: string; kind: "suggestion" | "batch"; index: number };
      if (confirm_token) {
        if (!reviewer?.trim()) throw new Error("reviewer is required to execute an approval. Ask the user for their name and call again with confirm_token and reviewer.");
        const p = ctx.confirmations.consume<Payload>(confirm_token, "approve", (t) => (t.id === id ? null : `This confirm_token is for ${t.id}, not ${id}.`));
        const result =
          p.kind === "suggestion"
            ? approveSuggestion(db, { exceptionId: id, candidateIndex: p.index, reviewer: reviewer.trim() })
            : approveBatchCandidate(db, { exceptionId: id, setIndex: p.index, reviewer: reviewer.trim() });
        return respond(
          HumanActionOutput.parse({
            summary: `Approved ${id} by ${reviewer.trim()}. Recorded as a human-approved match and in the audit trail.`,
            step: "executed",
            preview: null,
            confirm_token: null,
            expires_at: null,
            result: withInr(result),
          }),
        );
      }

      const exc = loadException(db, id);
      if (exc.status !== "open") throw new Error(`${id} is already ${exc.status}.`);
      const line = db.prepare("SELECT id, txn_date, narration, credit_paise FROM bank_lines WHERE id = ?").get(exc.primary_id) as { id: string; txn_date: string; narration: string; credit_paise: number } | undefined;
      if (!line) throw new Error(`${id} is not attached to a bank credit.`);
      let preview: Record<string, unknown>;
      let payload: Payload;
      if (exc.type === "SUGGESTED_MATCH") {
        const index = candidate_index ?? 0;
        const sid = suggestionCandidates(db, id)[index];
        if (!sid) throw new Error(`${id} has no candidate ${index}.`);
        const [s] = settlementsById([sid]);
        preview = { action: `Link bank credit ${line.id} to settlement ${sid}`, bank_line: { ...line, credit: money(line.credit_paise) }, settlement: s ? settlementLine(s) : null };
        payload = { id, kind: "suggestion", index };
      } else if (exc.type === "AMBIGUOUS_BATCH" || exc.type === "MATCH_CONFLICT") {
        const sets = candidateSets(id, line.credit_paise);
        const index = set_index ?? (sets.length === 1 ? 0 : undefined);
        if (index === undefined) throw new Error(`${id} has ${sets.length} candidate sets; pass set_index (0–${sets.length - 1}). Use decompose_bank_credit to compare them.`);
        const chosen = sets.find((s) => s.index === index);
        if (!chosen) throw new Error(`${id} has no candidate set ${index}.`);
        const deferred = db.prepare("SELECT settlement_id FROM settlement_reviews WHERE exception_id = ? AND status = 'unresolved_in_batch'").all(id) as { settlement_id: string }[];
        preview = {
          action: `Link bank credit ${line.id} to the ${chosen.settlement_ids.length} settlements of candidate set ${index}`,
          bank_line: { ...line, credit: money(line.credit_paise) },
          settlements: settlementsById(chosen.settlement_ids).map(settlementLine),
          set_total: chosen.total,
          difference_vs_credit: chosen.difference_vs_credit,
          leftovers_to_re_evaluate: deferred.map((d) => d.settlement_id).filter((s) => !chosen.settlement_ids.includes(s)),
          leftover_rule: "Leftover settlements not claimed by another open batch and past their bank-credit date will be raised as MISSING_BANK_CREDIT.",
        };
        payload = { id, kind: "batch", index };
      } else {
        throw new Error(`${id} is a ${exc.type}; only SUGGESTED_MATCH, AMBIGUOUS_BATCH and MATCH_CONFLICT can be approved.`);
      }
      const { token, expires_at } = ctx.confirmations.issue("approve", payload);
      return respond(
        HumanActionOutput.parse({
          summary: `Preview only, nothing has changed. ${String(preview.action)}. To execute, the user must agree; then call approve_suggestion again with id, confirm_token and reviewer before ${expires_at}.`,
          step: "preview",
          preview: withInr(preview),
          confirm_token: token,
          expires_at,
          result: null,
        }),
      );
    },
  );

  // ---------- escalate (two-step) ----------
  server.registerTool(
    "escalate",
    {
      title: "Escalate exception (human action)",
      description:
        "Escalate an open exception to someone else with a note (e.g. 'raised with Razorpay support, ticket 123'). Two steps: call with id and note to get a preview and a confirm_token valid for 5 minutes; after the user agrees, call again with id, confirm_token and reviewer. Writes an audit event; never modifies financial records.",
      inputSchema: {
        id: z.string().min(1).describe("Exception id"),
        note: z.string().max(1000).optional().describe("Required for the preview step"),
        confirm_token: z.string().optional(),
        reviewer: z.string().optional().describe("Name of the person escalating; required with confirm_token"),
      },
      outputSchema: HumanActionOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ id, note, confirm_token, reviewer }) => {
      if (confirm_token) {
        if (!reviewer?.trim()) throw new Error("reviewer is required to execute an escalation. Ask the user for their name and call again with confirm_token and reviewer.");
        const p = ctx.confirmations.consume<{ id: string; note: string }>(confirm_token, "escalate", (t) => (t.id === id ? null : `This confirm_token is for ${t.id}, not ${id}.`));
        const result = escalateException(db, { exceptionId: id, reviewer: reviewer.trim(), note: p.note });
        return respond(
          HumanActionOutput.parse({ summary: `Escalated ${id} by ${reviewer.trim()}: "${p.note}". Recorded in the audit trail.`, step: "executed", preview: null, confirm_token: null, expires_at: null, result }),
        );
      }
      if (!note?.trim()) throw new Error("note is required: say why and to whom this is escalated.");
      const exc = loadException(db, id);
      if (exc.status !== "open") throw new Error(`${id} is already ${exc.status}.`);
      const amount = money(loadExceptionAmount(db, id));
      const { token, expires_at } = ctx.confirmations.issue("escalate", { id, note: note.trim() });
      return respond(
        HumanActionOutput.parse({
          summary: `Preview only, nothing has changed. Escalate ${exc.type} ${id} (${amount.amount_inr}) with note "${note.trim()}". After the user agrees, call escalate again with id, confirm_token and reviewer before ${expires_at}.`,
          step: "preview",
          preview: { exception_id: id, type: exc.type, amount, note: note.trim() },
          confirm_token: token,
          expires_at,
          result: null,
        }),
      );
    },
  );

  // ---------- get_audit_trail ----------
  server.registerTool(
    "get_audit_trail",
    {
      title: "Get audit trail",
      description:
        "Append-only audit events (runs, investigations, journal drafts, approvals, escalations) with actor system/llm/human, oldest first. Optionally filter by entity id (an exception, run, bank line or draft id). Paginated: default 20 per page with next_cursor. Read-only.",
      inputSchema: { entity_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
      outputSchema: AuditOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ entity_id, limit, cursor }) => {
      const all = getAuditTrail(db, entity_id, 100_000);
      const scope = `audit:${entity_id ?? "*"}`;
      const p = page(all, decodeCursor(cursor, scope), limit ?? DEFAULT_PAGE_SIZE, scope);
      const byActor = all.reduce<Record<string, number>>((acc, e) => ((acc[e.actor] = (acc[e.actor] ?? 0) + 1), acc), {});
      return respond(
        AuditOutput.parse({
          summary: `${all.length} audit event(s)${entity_id ? ` for ${entity_id}` : ""} (${Object.entries(byActor).map(([a, n]) => `${a} ${n}`).join(", ") || "none"}). Showing ${p.showing}.`,
          entity_id: entity_id ?? null,
          total_count: all.length,
          showing: p.showing,
          items: p.items.map((e) => ({ ...e, payload: withInr(e.payload) as Record<string, unknown> })),
          next_cursor: p.next_cursor,
        }),
      );
    },
  );

  // ---------- resource ----------
  server.registerResource(
    "latest_summary",
    "closeloop://summary/latest",
    { title: "Latest reconciliation summary", description: "Summary of the most recent reconciliation run (runs one first if none exists).", mimeType: "application/json" },
    async (uri) => {
      const run = await ensureRun(ctx);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(runOutput(run.summary, aiLabel(ctx.provider))) }] };
    },
  );

  // ---------- prompt ----------
  server.registerPrompt(
    "month_end_review",
    {
      title: "Month-end review",
      description: "Guided month-end close: summary, then the largest amount-at-risk exceptions, then the notable batch credits.",
      argsSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; defaults to the dataset's last month") },
    },
    async ({ month }) => {
      const asOf = datasetMeta(db).as_of ?? "";
      const ym = month ?? asOf.slice(0, 7);
      const from = `${ym}-01`;
      const lastDay = addDays(`${String(Number(ym.slice(0, 4)) + (ym.slice(5) === "12" ? 1 : 0))}-${ym.slice(5) === "12" ? "01" : String(Number(ym.slice(5)) + 1).padStart(2, "0")}-01`, -1);
      const to = asOf && asOf < lastDay ? asOf : lastDay;
      const latest = latestRun(db);
      const run = latest && latest.from === from && latest.to === to ? latest : (await runReconciliationWithAI(db, ctx.cfg, { from, to }, ctx.provider), latestRun(db));
      if (!run) throw new Error("Could not run reconciliation");
      const cases = showcaseCases(db, run.id, from, to);
      const caseLines = [
        cases.largestContiguousBatch
          ? `- Largest batch credit: decompose_bank_credit("${cases.largestContiguousBatch.bank_line_id}") — one bank credit made of ${cases.largestContiguousBatch.settlements} settlements. Explain that it is matched as a contiguous run and what that assumption means.`
          : "- No contiguous batch credit this month.",
        cases.matchConflict
          ? `- Match conflict: decompose_bank_credit("${cases.matchConflict.bank_line_id}") then explain_exception("${cases.matchConflict.exception_id}") — explain why the engine refused to guess and what decision the user must make.`
          : "- No match conflict this month.",
        cases.fuzzyMatch
          ? `- Fuzzy match: decompose_bank_credit("${cases.fuzzyMatch.bank_line_id}") — show the corrupted UTR in the narration versus the settlement UTR, and why exact amount and date made the match safe.`
          : "- No fuzzy match this month.",
      ];
      const text = [
        `Help me close ${ym} for our Razorpay settlements (${from} to ${to}).`,
        "Quote the amount_inr strings and totals the tools return; never add, subtract or convert amounts yourself, and never add exposure classes together.",
        "",
        `1. Summary: call run_reconciliation with from="${from}" and to="${to}". Report matched counts by kind, exceptions by type, exposure per class and the bank-vs-books residual.`,
        `2. Top exceptions: call list_exceptions with exposure_class="AMOUNT_AT_RISK" and limit=5. For each, call explain_exception and give the root cause and recommended action in one line each. Mention how many more remain (total_count).`,
        "3. Batch credits: walk through these cases.",
        ...caseLines,
        "4. Finish with a short list of decisions I need to make. Do not call approve_suggestion or escalate unless I explicitly ask; both show a preview first and need my name as reviewer.",
      ].join("\n");
      return { description: `Month-end review for ${ym}`, messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  return server;
}

function loadExceptionAmount(db: Db, id: string): number {
  const row = db.prepare("SELECT amount_paise FROM exceptions WHERE id = ?").get(id) as { amount_paise: number } | undefined;
  if (!row) throw new Error(`Unknown exception ${id}`);
  return row.amount_paise;
}
