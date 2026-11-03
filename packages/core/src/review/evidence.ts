import { z } from "zod";
import type { Db } from "../db/open.ts";
import {
  BankLineSchema,
  LedgerEntrySchema,
  PaymentSchema,
  RefundSchema,
  SettlementItemSchema,
  SettlementSchema,
} from "../types.ts";

const RefSchema = z.object({ type: z.string(), id: z.string() });

export const EvidenceBundleSchema = z.object({
  exception: z.object({
    id: z.string(),
    run_id: z.string(),
    type: z.string(),
    subtype: z.string().nullable(),
    exposure_class: z.string(),
    amount_paise: z.number().int(),
    status: z.string(),
    anchor_date: z.string(),
    primary: RefSchema,
  }),
  /** The deterministic rule that fired and the values it saw. */
  rule_trace: z.record(z.string(), z.unknown()),
  candidate_sets: z.array(z.array(z.string())),
  records: z.array(z.object({ evidence_id: z.string(), type: z.string(), data: z.record(z.string(), z.unknown()) })),
  matches: z.array(z.object({ kind: z.string(), left_id: z.string(), right_id: z.string(), reason_code: z.string() })),
  /** Every id an explanation may cite. */
  evidence_ids: z.array(z.string()),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

const MAX_RECORDS = 80;

function fetchRecord(db: Db, type: string, id: string): Record<string, unknown> | null {
  const one = (sql: string) => db.prepare(sql).get(id) as Record<string, unknown> | undefined;
  switch (type) {
    case "payment": {
      const r = one("SELECT * FROM payments WHERE id = ?");
      return r ? PaymentSchema.parse(r) : null;
    }
    case "refund": {
      const r = one("SELECT * FROM refunds WHERE id = ?");
      return r ? RefundSchema.parse(r) : null;
    }
    case "settlement": {
      const r = one("SELECT * FROM settlements WHERE id = ?");
      if (!r) return null;
      const totals = db
        .prepare("SELECT COUNT(*) AS item_count, COALESCE(SUM(fee_paise),0) AS fee_paise_total, COALESCE(SUM(gst_paise),0) AS gst_paise_total FROM settlement_items WHERE settlement_id = ?")
        .get(id) as Record<string, number>;
      return { ...SettlementSchema.parse(r), ...totals };
    }
    case "settlement_item": {
      const r = one("SELECT * FROM settlement_items WHERE id = ?");
      return r ? SettlementItemSchema.parse(r) : null;
    }
    case "bank_line": {
      const r = one("SELECT * FROM bank_lines WHERE id = ?");
      return r ? BankLineSchema.parse(r) : null;
    }
    case "ledger_entry": {
      const r = one("SELECT * FROM ledger_entries WHERE id = ?");
      return r ? LedgerEntrySchema.parse(r) : null;
    }
    default:
      return null;
  }
}

/** Read-only evidence for one exception: the records involved, the rule trace and the links around them. */
export function getEvidence(db: Db, exceptionId: string): EvidenceBundle {
  const row = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(exceptionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Unknown exception ${exceptionId}`);
  const exc = z
    .object({
      id: z.string(),
      run_id: z.string(),
      type: z.string(),
      subtype: z.string().nullable(),
      exposure_class: z.string(),
      amount_paise: z.number().int(),
      status: z.string(),
      anchor_date: z.string(),
      primary_type: z.string(),
      primary_id: z.string(),
      related_json: z.string(),
      trace_json: z.string(),
    })
    .parse(row);
  const related = z.array(RefSchema).parse(JSON.parse(exc.related_json));
  const sets = (db.prepare("SELECT settlement_ids_json FROM batch_candidate_sets WHERE exception_id = ? ORDER BY set_index").all(exc.id) as { settlement_ids_json: string }[]).map(
    (r) => z.array(z.string()).parse(JSON.parse(r.settlement_ids_json)),
  );

  const refs = new Map<string, string>();
  for (const ref of [{ type: exc.primary_type, id: exc.primary_id }, ...related, ...sets.flat().map((id) => ({ type: "settlement", id }))]) {
    if (refs.size >= MAX_RECORDS) break;
    if (!refs.has(ref.id)) refs.set(ref.id, ref.type);
  }
  const records: EvidenceBundle["records"] = [];
  for (const [id, type] of refs) {
    const data = type === "period" ? { period: id } : fetchRecord(db, type, id);
    if (data) records.push({ evidence_id: id, type, data });
  }
  const ids = records.map((r) => r.evidence_id);
  const placeholders = ids.map(() => "?").join(",");
  const matches = ids.length
    ? (db
        .prepare(`SELECT kind, left_id, right_id, reason_code FROM matches WHERE run_id = ? AND (left_id IN (${placeholders}) OR right_id IN (${placeholders})) LIMIT 100`)
        .all(exc.run_id, ...ids, ...ids) as EvidenceBundle["matches"])
    : [];

  return EvidenceBundleSchema.parse({
    exception: {
      id: exc.id,
      run_id: exc.run_id,
      type: exc.type,
      subtype: exc.subtype,
      exposure_class: exc.exposure_class,
      amount_paise: exc.amount_paise,
      status: exc.status,
      anchor_date: exc.anchor_date,
      primary: { type: exc.primary_type, id: exc.primary_id },
    },
    rule_trace: JSON.parse(exc.trace_json) as unknown,
    candidate_sets: sets,
    records,
    matches,
    evidence_ids: [exc.id, ...ids],
  });
}
