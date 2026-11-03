import { z } from "zod";
import type { Db } from "../db/open.ts";
import { ReconSummarySchema, type ReconSummary } from "../matcher/run.ts";

export interface RunInfo {
  id: string;
  from: string;
  to: string;
  summary: ReconSummary;
}

/** The most recent reconciliation run, or null if none has been run yet. */
export function latestRun(db: Db): RunInfo | null {
  const row = db.prepare("SELECT id, from_date, to_date, summary_json FROM recon_runs ORDER BY finished_at DESC, rowid DESC LIMIT 1").get() as
    | { id: string; from_date: string; to_date: string; summary_json: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, from: row.from_date, to: row.to_date, summary: ReconSummarySchema.parse(JSON.parse(row.summary_json)) };
}

const BatchRow = z.object({ right_id: z.string(), n: z.number().int(), credit_paise: z.number().int() });

export interface ShowcaseCases {
  largestContiguousBatch: { bank_line_id: string; settlements: number; credit_paise: number } | null;
  fuzzyMatch: { bank_line_id: string; settlement_id: string; distance: number | null } | null;
  matchConflict: { exception_id: string; bank_line_id: string } | null;
}

/**
 * Picks demo-worthy cases from a run within [from, to]: the largest contiguous batch credit (by settlement
 * count, then amount), a fuzzy match (preferring a genuine edit-distance-1 typo), and a MATCH_CONFLICT.
 */
export function showcaseCases(db: Db, runId: string, from: string, to: string): ShowcaseCases {
  const batch = db
    .prepare(
      `SELECT m.right_id, COUNT(*) AS n, b.credit_paise FROM matches m JOIN bank_lines b ON b.id = m.right_id
       WHERE m.run_id = ? AND m.kind = 'BATCH_CONTIGUOUS' AND m.anchor_date BETWEEN ? AND ?
       GROUP BY m.right_id ORDER BY n DESC, b.credit_paise DESC LIMIT 1`,
    )
    .get(runId, from, to);
  const fuzzyRows = db
    .prepare("SELECT left_id, right_id, trace_json FROM matches WHERE run_id = ? AND kind = 'FUZZY' AND anchor_date BETWEEN ? AND ? ORDER BY anchor_date, right_id")
    .all(runId, from, to) as { left_id: string; right_id: string; trace_json: string }[];
  const fuzzy = fuzzyRows
    .map((r) => ({ ...r, distance: (JSON.parse(r.trace_json) as { best?: { distance?: number | null } }).best?.distance ?? null }))
    .sort((a, b) => Number(b.distance === 1) - Number(a.distance === 1))[0];
  const conflict = db
    .prepare("SELECT id, primary_id FROM exceptions WHERE run_id = ? AND type = 'MATCH_CONFLICT' AND anchor_date BETWEEN ? AND ? ORDER BY amount_paise DESC, id LIMIT 1")
    .get(runId, from, to) as { id: string; primary_id: string } | undefined;
  const b = batch ? BatchRow.parse(batch) : null;
  return {
    largestContiguousBatch: b ? { bank_line_id: b.right_id, settlements: b.n, credit_paise: b.credit_paise } : null,
    fuzzyMatch: fuzzy ? { bank_line_id: fuzzy.right_id, settlement_id: fuzzy.left_id, distance: fuzzy.distance } : null,
    matchConflict: conflict ? { exception_id: conflict.id, bank_line_id: conflict.primary_id } : null,
  };
}
