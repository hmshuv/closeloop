import { rmSync } from "node:fs";
import { generateDataset, loadDataset, openReconDb, openTruthDb, truthDbPathFor, type CloseLoopConfig, type Db } from "@closeloop/core";
import { log } from "./log.ts";

export const DEMO_SEED = 42;

/** Open the recon DB; on first run (no payments yet) seed the reproducible demo dataset so the server works instantly. */
export function openDatabase(path: string, cfg: CloseLoopConfig): { db: Db; seeded: boolean } {
  const db = openReconDb(path);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number };
  if (n > 0) return { db, seeded: false };

  const started = Date.now();
  log(`empty database at ${path}; seeding demo data (seed ${DEMO_SEED}, ${cfg.generator.default_payments} payments)…`);
  const ds = generateDataset({ seed: DEMO_SEED, config: cfg });
  let truth: Db | null = null;
  if (path !== ":memory:") {
    const truthPath = truthDbPathFor(path);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(truthPath + suffix, { force: true });
    truth = openTruthDb(truthPath);
  }
  loadDataset(db, truth, ds);
  truth?.close();
  log(`seeded ${ds.payments.length} payments, ${ds.settlements.length} settlements, ${ds.bankLines.length} bank lines in ${Date.now() - started} ms`);
  return { db, seeded: true };
}
