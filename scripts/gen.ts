/**
 * pnpm gen [--seed 42] [--payments 5000] [--days 45] [--db path]
 * Writes a fresh seeded dataset to the recon DB and its ground truth to truth.db alongside it.
 */
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  datasetHash,
  defaultDbPath,
  formatINR,
  generateDataset,
  heldoutCoverage,
  loadConfig,
  loadDataset,
  loadEnvFile,
  openReconDb,
  openTruthDb,
  partitionDataset,
  truthDbPathFor,
  type Dataset,
} from "@closeloop/core";

loadEnvFile();
const cfg = loadConfig();
const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "42" },
    payments: { type: "string", default: String(cfg.generator.default_payments) },
    days: { type: "string" },
    db: { type: "string" },
  },
});

const intArg = (name: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
};

const started = performance.now();
const ds = generateDataset({
  seed: intArg("seed", values.seed) ?? 42,
  payments: intArg("payments", values.payments),
  days: intArg("days", values.days),
  config: cfg,
});
const genMs = performance.now() - started;

const dbPath = values.db ?? defaultDbPath();
const truthPath = truthDbPathFor(dbPath);
for (const p of [dbPath, truthPath]) for (const suffix of ["", "-wal", "-shm"]) rmSync(p + suffix, { force: true });
const recon = openReconDb(dbPath);
const truth = openTruthDb(truthPath);
loadDataset(recon, truth, ds);
recon.close();
truth.close();

const parts = partitionDataset(ds);
const counts = (d: Dataset) => ({
  payments: d.payments.length,
  refunds: d.refunds.length,
  settlements: d.settlements.length,
  settlement_items: d.settlementItems.length,
  bank_lines: d.bankLines.length,
  ledger_entries: d.ledgerEntries.length,
  labels: d.labels.length,
});
console.log(`CloseLoop dataset — seed ${ds.meta.seed}, ${ds.meta.period_start} → ${ds.meta.period_end} (${ds.meta.days} days), held-out from ${ds.meta.heldout_start}`);
console.log(`hash ${datasetHash(ds).slice(0, 16)}  generated in ${genMs.toFixed(0)} ms`);
console.table({ total: counts(ds), dev: counts(parts.dev), heldout: counts(parts.heldout) });

const noise: Record<string, { dev: number; heldout: number }> = {};
for (const l of ds.labels) (noise[l.noise_kind] ??= { dev: 0, heldout: 0 })[l.split]++;
console.log("Injected noise (ground-truth labels):");
console.table(noise);

const credits = ds.bankLines.reduce((s, l) => s + l.credit_paise, 0);
console.log(`Bank credits ${formatINR(credits)} · closing balance ${formatINR(ds.bankLines.at(-1)?.balance_paise ?? 0)}`);

const min = cfg.generator.heldout_min_per_type;
const short = heldoutCoverage(ds.labels, min).filter((c) => !c.ok);
if (short.length > 0) {
  console.log(`Held-out coverage below eval minimum (${min}) for: ${short.map((c) => `${c.target}=${c.count}`).join(", ")}`);
  console.log("(Expected for the demo size. `pnpm eval` uses a larger dataset; rates are never inflated.)");
}
console.log(`\nrecon DB: ${dbPath}\ntruth DB: ${truthPath}`);
