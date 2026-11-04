import { createHash, randomUUID } from "node:crypto";
import { appendAudit } from "../audit/audit.ts";
import type { Db } from "../db/open.ts";
import type { GatewayReportRow } from "../matcher/types.ts";
import { toReportRow, type RazorpayReconItem, type RazorpaySettlement } from "./razorpay.ts";

export interface GatewayImportResult {
  report_id: string;
  source: "api" | "file";
  origin: string;
  rows_read: number;
  inserted: number;
  /** Identical to a row already imported: ignored. */
  duplicates: number;
  /** Same entity and settlement as an imported row but different figures: kept as first imported, listed here. */
  conflicts: string[];
  /** Rows with no settlement yet (settled = false): not usable for matching. */
  unsettled: number;
  settlements_covered: number;
  payout_utrs: number;
  settled_from: string | null;
  settled_to: string | null;
  settlements_fetched: number;
}

const FIGURES = ["settlement_utr", "amount_paise", "fee_paise", "tax_paise", "credit_paise", "debit_paise", "payment_id", "settled_on"] as const;

/**
 * Store a Razorpay recon report in the state DB. Insert-only and idempotent: rows already present (same entity,
 * type and settlement) are not touched. Nothing here writes to the financial source tables.
 */
export function importRazorpayRecon(
  db: Db,
  items: readonly RazorpayReconItem[],
  opts: { source: "api" | "file"; origin: string; settlements?: readonly RazorpaySettlement[] },
): GatewayImportResult {
  const sha256 = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  const reportId = randomUUID();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gateway_recon_items (entity_id, type, settlement_id, settlement_utr, amount_paise, fee_paise, tax_paise, credit_paise, debit_paise, payment_id, settled_at, settled_on, report_id, raw_json)
     VALUES (@entity_id, @type, @settlement_id, @settlement_utr, @amount_paise, @fee_paise, @tax_paise, @credit_paise, @debit_paise, @payment_id, @settled_at, @settled_on, @report_id, @raw_json)`,
  );
  const existing = db.prepare(`SELECT ${FIGURES.join(", ")} FROM gateway_recon_items WHERE entity_id = ? AND type = ? AND settlement_id = ?`);
  const insertSettlement = db.prepare(
    "INSERT OR IGNORE INTO gateway_settlements (id, utr, amount_paise, fees_paise, tax_paise, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const result: GatewayImportResult = {
    report_id: reportId,
    source: opts.source,
    origin: opts.origin,
    rows_read: items.length,
    inserted: 0,
    duplicates: 0,
    conflicts: [],
    unsettled: 0,
    settlements_covered: 0,
    payout_utrs: 0,
    settled_from: null,
    settled_to: null,
    settlements_fetched: opts.settlements?.length ?? 0,
  };
  const settlements = new Set<string>();
  const utrs = new Set<string>();

  db.transaction(() => {
    db.prepare("INSERT INTO gateway_reports (id, gateway, source, origin, sha256, rows_read, imported_at) VALUES (?, 'razorpay', ?, ?, ?, ?, ?)").run(
      reportId,
      opts.source,
      opts.origin,
      sha256,
      items.length,
      new Date().toISOString(),
    );
    for (const item of items) {
      const row = toReportRow(item);
      if (!row || item.settled_at === null) {
        result.unsettled++;
        continue;
      }
      settlements.add(row.settlement_id);
      if (row.settlement_utr) utrs.add(row.settlement_utr);
      if (!result.settled_from || row.settled_on < result.settled_from) result.settled_from = row.settled_on;
      if (!result.settled_to || row.settled_on > result.settled_to) result.settled_to = row.settled_on;
      const { changes } = insert.run({ ...row, settled_at: item.settled_at, report_id: reportId, raw_json: JSON.stringify(item) });
      if (Number(changes) > 0) {
        result.inserted++;
        continue;
      }
      const prior = existing.get(row.entity_id, row.type, row.settlement_id) as Record<string, unknown>;
      if (FIGURES.every((f) => prior[f] === row[f])) result.duplicates++;
      else result.conflicts.push(`${row.type} ${row.entity_id} in ${row.settlement_id}`);
    }
    for (const s of opts.settlements ?? []) insertSettlement.run(s.id, s.utr, s.amount, s.fees, s.tax, s.status, s.created_at, reportId);
    appendAudit(db, {
      actor: "system",
      action: "gateway_report_import",
      entity_type: "gateway_report",
      entity_id: reportId,
      payload: { gateway: "razorpay", source: opts.source, origin: opts.origin, sha256, rows_read: items.length, inserted: result.inserted, duplicates: result.duplicates, conflicts: result.conflicts.length },
    });
  })();
  result.settlements_covered = settlements.size;
  result.payout_utrs = utrs.size;
  return result;
}

/** Imported report rows settled on or before `asOf`, for the matcher. Empty when nothing was imported. */
export function loadGatewayReport(db: Db, asOf: string): GatewayReportRow[] {
  return db
    .prepare(
      `SELECT entity_id, type, settlement_id, settlement_utr, amount_paise, fee_paise, tax_paise, credit_paise, debit_paise, payment_id, settled_on
       FROM gateway_recon_items WHERE settled_on <= ? ORDER BY settlement_id, type, entity_id`,
    )
    .all(asOf)
    .map((r) => ({ ...(r as GatewayReportRow) }));
}
