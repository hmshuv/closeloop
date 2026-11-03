import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAudit } from "../audit/audit.ts";
import type { Db } from "../db/open.ts";

const ExceptionRow = z.object({
  id: z.string(),
  run_id: z.string(),
  type: z.string(),
  status: z.string(),
  primary_id: z.string(),
  anchor_date: z.string(),
  related_json: z.string(),
});

export function loadException(db: Db, id: string) {
  const row = db.prepare("SELECT id, run_id, type, status, primary_id, anchor_date, related_json FROM exceptions WHERE id = ?").get(id);
  if (!row) throw new Error(`Unknown exception ${id}`);
  const exc = ExceptionRow.parse(row);
  return { ...exc, related: z.array(z.object({ type: z.string(), id: z.string() })).parse(JSON.parse(exc.related_json)) };
}

/** Settlement candidates of a SUGGESTED_MATCH, in the engine's ranked order. */
export function suggestionCandidates(db: Db, exceptionId: string): string[] {
  return loadException(db, exceptionId).related.filter((r) => r.type === "settlement").map((r) => r.id);
}

/** Open MATCH_CONFLICT exceptions in the same run that involve this settlement. */
export function conflictsInvolving(db: Db, runId: string, settlementId: string): string[] {
  const rows = db.prepare("SELECT id, trace_json FROM exceptions WHERE run_id = ? AND type = 'MATCH_CONFLICT' AND status = 'open'").all(runId) as { id: string; trace_json: string }[];
  return rows.filter((r) => (JSON.parse(r.trace_json) as { conflicting_settlement_ids?: string[] }).conflicting_settlement_ids?.includes(settlementId)).map((r) => r.id);
}

function settlementAlreadyLinked(db: Db, runId: string, settlementId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM matches WHERE run_id = ? AND left_type = 'settlement' AND left_id = ? AND kind IN ('EXACT','FUZZY','BATCH','BATCH_CONTIGUOUS','HUMAN_APPROVED') LIMIT 1")
      .get(runId, settlementId),
  );
}

export interface ApproveSuggestionResult {
  exception_id: string;
  bank_line_id: string;
  settlement_id: string;
  open_conflicts: string[];
}

/** A human confirms a SUGGESTED_MATCH. Records a HUMAN_APPROVED link; financial tables are untouched. */
export function approveSuggestion(db: Db, input: { exceptionId: string; candidateIndex: number; reviewer: string }): ApproveSuggestionResult {
  const exc = loadException(db, input.exceptionId);
  if (exc.type !== "SUGGESTED_MATCH") throw new Error(`${exc.id} is a ${exc.type}, not a SUGGESTED_MATCH`);
  if (exc.status !== "open") throw new Error(`${exc.id} is already ${exc.status}`);
  const settlementId = suggestionCandidates(db, exc.id)[input.candidateIndex];
  if (!settlementId) throw new Error(`${exc.id} has no candidate ${input.candidateIndex}`);
  if (settlementAlreadyLinked(db, exc.run_id, settlementId)) throw new Error(`Settlement ${settlementId} is already linked to another bank credit in this run`);
  const openConflicts = conflictsInvolving(db, exc.run_id, settlementId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO matches (id, run_id, kind, left_type, left_id, right_type, right_id, confidence, reason_code, anchor_date, trace_json)
       VALUES (?, ?, 'HUMAN_APPROVED', 'settlement', ?, 'bank_line', ?, 1, 'HUMAN_APPROVED', ?, ?)`,
    ).run(randomUUID(), exc.run_id, settlementId, exc.primary_id, exc.anchor_date, JSON.stringify({ rule: "review.suggestion_approved", exception_id: exc.id, reviewer: input.reviewer }));
    db.prepare("UPDATE exceptions SET status = 'approved' WHERE id = ?").run(exc.id);
    db.prepare("UPDATE settlement_reviews SET status = 'assigned', updated_at = ? WHERE run_id = ? AND settlement_id = ?").run(new Date().toISOString(), exc.run_id, settlementId);
    appendAudit(db, {
      actor: "human",
      action: "approval",
      entity_type: "exception",
      entity_id: exc.id,
      payload: { reviewer: input.reviewer, settlement_id: settlementId, bank_line_id: exc.primary_id, candidate_index: input.candidateIndex, open_conflicts: openConflicts },
    });
  })();
  return { exception_id: exc.id, bank_line_id: exc.primary_id, settlement_id: settlementId, open_conflicts: openConflicts };
}

/** A human hands an exception to someone else (e.g. the gateway's account manager). */
export function escalateException(db: Db, input: { exceptionId: string; reviewer: string; note: string }): { exception_id: string; previous_status: string } {
  const exc = loadException(db, input.exceptionId);
  if (exc.status !== "open") throw new Error(`${exc.id} is already ${exc.status}`);
  db.transaction(() => {
    db.prepare("UPDATE exceptions SET status = 'escalated' WHERE id = ?").run(exc.id);
    appendAudit(db, { actor: "human", action: "escalation", entity_type: "exception", entity_id: exc.id, payload: { reviewer: input.reviewer, note: input.note, type: exc.type } });
  })();
  return { exception_id: exc.id, previous_status: exc.status };
}
