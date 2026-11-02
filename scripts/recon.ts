/**
 * pnpm recon [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db path]
 * Runs the deterministic engine against the recon DB and prints the summary.
 */
import { parseArgs } from "node:util";
import { defaultDbPath, formatINR, loadConfig, loadEnvFile, openReconDb, runReconciliation } from "@closeloop/core";

loadEnvFile();
const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, db: { type: "string" } } });
const db = openReconDb(values.db ?? defaultDbPath());
const { summary } = runReconciliation(db, loadConfig(), { from: values.from, to: values.to });
db.close();

console.log(`Run ${summary.run_id}  ${summary.from} → ${summary.to}  (${summary.duration_ms} ms)`);
console.table(summary.matched);
console.log("Exceptions by type:");
console.table(
  Object.fromEntries(Object.entries(summary.exceptions_by_type).filter(([, v]) => v.count > 0).map(([k, v]) => [k, { count: v.count, amount: formatINR(v.amount_paise) }])),
);
console.log("Exposure by class (not summed across classes):");
console.table(Object.fromEntries(Object.entries(summary.exposure_by_class).map(([k, v]) => [k, { count: v.count, amount: formatINR(v.amount_paise) }])));
console.log("Batch:", summary.batch);
const t = summary.tie_out;
console.log(`Tie-out: bank ${formatINR(t.bank_credits_paise)} − books ${formatINR(t.book_receipts_paise)} = ${formatINR(t.difference_paise)}; explained ${formatINR(t.explained_paise)}; residual ${formatINR(t.residual_paise)}`);
