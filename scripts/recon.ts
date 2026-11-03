/**
 * pnpm recon [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db path] [--no-ai]
 * Runs the deterministic engine against the recon DB and prints the summary. If an LLM is configured in
 * .env, narration parsing may add grounded candidate tokens for fuzzy matching; it never decides a match.
 */
import { parseArgs } from "node:util";
import { defaultDbPath, formatINR, loadConfig, loadEnvFile, openReconDb, providerFromEnv, runReconciliationWithAI } from "@closeloop/core";

loadEnvFile();
const { values } = parseArgs({
  options: { from: { type: "string" }, to: { type: "string" }, db: { type: "string" }, "no-ai": { type: "boolean", default: false } },
});
const provider = values["no-ai"] ? null : providerFromEnv();
const db = openReconDb(values.db ?? defaultDbPath());
const { summary } = await runReconciliationWithAI(db, loadConfig(), { from: values.from, to: values.to }, provider);
db.close();
console.log(provider ? `LLM: ${provider.model} (narration hints only)` : "LLM: none configured — deterministic only");

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
