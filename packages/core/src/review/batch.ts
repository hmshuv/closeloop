import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { exposureClassOf } from "../matcher/exposure.ts";

export type LeftoverOutcome = "missing_raised" | "still_deferred" | "released";

export interface ApproveBatchResult {
  exception_id: string;
  bank_line_id: string;
  approved_settlement_ids: string[];
  leftovers: { settlement_id: string; outcome: LeftoverOutcome; exception_id?: string }[];
}

const ExceptionRow = z.object({
  id: z.string(),
  run_id: z.string(),
  type: z.string(),
  status: z.string(),
  primary_type: z.string(),
  primary_id: z.string(),
  anchor_date: z.string(),
});

/**
 * A human picks one candidate set for an AMBIGUOUS_BATCH (or confirms a MATCH_CONFLICT's batch).
 * Records HUMAN_APPROVED links, closes the exception, then re-evaluates the settlements that were deferred
 * to it (status unresolved_in_batch):
 * - still a possible member of another open batch exception → stays deferred there
 * - otherwise, past its bank-credit date as of the run → MISSING_BANK_CREDIT is raised now
 * - otherwise → released (not yet due)
 * Writes only recon output tables; financial tables are untouched.
 */
export function approveBatchCandidate(db: Db, input: { exceptionId: string; setIndex: number; reviewer: string }): ApproveBatchResult {
  const exc = ExceptionRow.parse(db.prepare("SELECT id, run_id, type, status, primary_type, primary_id, anchor_date FROM exceptions WHERE id = ?").get(input.exceptionId));
  if (exc.type !== "AMBIGUOUS_BATCH" && exc.type !== "MATCH_CONFLICT") throw new Error(`${exc.id} is a ${exc.type}, not a batch exception`);
  if (exc.status !== "open") throw new Error(`${exc.id} is already ${exc.status}`);
  const setRow = db.prepare("SELECT settlement_ids_json FROM batch_candidate_sets WHERE exception_id = ? AND set_index = ?").get(exc.id, input.setIndex) as
    | { settlement_ids_json: string }
    | undefined;
  if (!setRow) throw new Error(`${exc.id} has no candidate set ${input.setIndex}`);
  const chosen = z.array(z.string()).parse(JSON.parse(setRow.settlement_ids_json));
  const { as_of: asOf } = z.object({ as_of: z.string() }).parse(db.prepare("SELECT as_of FROM recon_runs WHERE id = ?").get(exc.run_id));
  const at = new Date().toISOString();
  const result: ApproveBatchResult = { exception_id: exc.id, bank_line_id: exc.primary_id, approved_settlement_ids: chosen, leftovers: [] };

  db.transaction(() => {
    const insertMatch = db.prepare(
      `INSERT INTO matches (id, run_id, kind, left_type, left_id, right_type, right_id, confidence, reason_code, anchor_date, trace_json)
       VALUES (?, ?, 'HUMAN_APPROVED', 'settlement', ?, 'bank_line', ?, 1, 'HUMAN_APPROVED', ?, ?)`,
    );
    for (const id of chosen) {
      insertMatch.run(randomUUID(), exc.run_id, id, exc.primary_id, exc.anchor_date, JSON.stringify({ rule: "review.batch_candidate_approved", exception_id: exc.id, set_index: input.setIndex, reviewer: input.reviewer }));
    }
    db.prepare("UPDATE exceptions SET status = 'approved' WHERE id = ?").run(exc.id);
    const assign = db.prepare("UPDATE settlement_reviews SET status = 'assigned', updated_at = ? WHERE run_id = ? AND settlement_id = ?");
    for (const id of chosen) assign.run(at, exc.run_id, id);

    const leftovers = db
      .prepare("SELECT settlement_id FROM settlement_reviews WHERE run_id = ? AND exception_id = ? AND status = 'unresolved_in_batch' ORDER BY settlement_id")
      .all(exc.run_id, exc.id) as { settlement_id: string }[];
    const otherOpen = db.prepare(
      `SELECT 1 FROM settlement_reviews r JOIN exceptions e ON e.id = r.exception_id
       WHERE r.run_id = ? AND r.settlement_id = ? AND r.exception_id <> ? AND r.status = 'unresolved_in_batch' AND e.status = 'open' LIMIT 1`,
    );
    const mark = db.prepare("UPDATE settlement_reviews SET status = ?, resolved_by_exception_id = ?, updated_at = ? WHERE run_id = ? AND settlement_id = ? AND exception_id = ?");
    const insertException = db.prepare(
      `INSERT INTO exceptions (id, run_id, type, exposure_class, amount_paise, subtype, primary_type, primary_id, anchor_date, related_json, trace_json, status)
       VALUES (?, ?, 'MISSING_BANK_CREDIT', ?, ?, NULL, 'settlement', ?, ?, ?, ?, 'open')`,
    );

    for (const { settlement_id } of leftovers) {
      if (otherOpen.get(exc.run_id, settlement_id, exc.id)) {
        mark.run("released", null, at, exc.run_id, settlement_id, exc.id);
        result.leftovers.push({ settlement_id, outcome: "still_deferred" });
        continue;
      }
      const s = z
        .object({ settled_at: z.string(), amount_paise: z.number().int(), utr: z.string() })
        .parse(db.prepare("SELECT settled_at, amount_paise, utr FROM settlements WHERE id = ?").get(settlement_id));
      if (s.settled_at > asOf) {
        mark.run("released", null, at, exc.run_id, settlement_id, exc.id);
        result.leftovers.push({ settlement_id, outcome: "released" });
        continue;
      }
      const id = randomUUID();
      insertException.run(
        id,
        exc.run_id,
        exposureClassOf("MISSING_BANK_CREDIT"),
        s.amount_paise,
        settlement_id,
        s.settled_at,
        JSON.stringify([{ type: "bank_line", id: exc.primary_id }]),
        JSON.stringify({ rule: "review.leftover_after_batch_approval", approved_exception_id: exc.id, utr: s.utr, settled_at: s.settled_at, as_of: asOf, reviewer: input.reviewer }),
      );
      mark.run("missing_raised", id, at, exc.run_id, settlement_id, exc.id);
      result.leftovers.push({ settlement_id, outcome: "missing_raised", exception_id: id });
    }
  })();
  return result;
}
