import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { openReconDb, openTruthDb, type Db } from "../src/db/open.ts";
import { FINANCIAL_TABLES } from "../src/db/schema.ts";
import { generateDataset, type Dataset } from "../src/generator/generate.ts";
import { loadDataset } from "../src/generator/load.ts";
import { partitionDataset } from "../src/generator/split.ts";
import { ReconSummarySchema, runReconciliation, type ReconSummary } from "../src/matcher/run.ts";
import type { ReconResult } from "../src/matcher/reconcile.ts";
import type { NoiseKind } from "../src/types.ts";
import { cfg } from "./fixtures.ts";

const matcherDir = fileURLToPath(new URL("../src/matcher/", import.meta.url));

describe("ground-truth isolation", () => {
  it("no matcher module imports the generator or the truth store", () => {
    for (const file of readdirSync(matcherDir)) {
      const imports = [...readFileSync(join(matcherDir, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${file} imports ${spec}`).not.toMatch(/generator|truth/);
    }
  });

  it("the matcher's database handle has no ground-truth tables to read", () => {
    const recon = openReconDb(":memory:");
    const truth = openTruthDb(":memory:");
    loadDataset(recon, truth, generateDataset({ seed: 3, payments: 800, config: cfg }));
    expect(() => recon.prepare("SELECT * FROM truth_labels").all()).toThrow(/no such table/);
    expect(() => runReconciliation(recon, cfg)).not.toThrow();
  });
});

describe("end-to-end on generated data (seed 42, 5k payments, dev split)", () => {
  let ds: Dataset;
  let db: Db;
  let summary: ReconSummary;
  let result: ReconResult;
  const counts = new Map<string, number>();

  beforeAll(() => {
    ds = partitionDataset(generateDataset({ seed: 42, payments: 5000, config: cfg })).dev;
    db = openReconDb(":memory:");
    loadDataset(db, null, ds);
    for (const t of FINANCIAL_TABLES) counts.set(t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    ({ summary, result } = runReconciliation(db, cfg));
  });

  const labelled = (...kinds: NoiseKind[]) => new Set(ds.labels.filter((l) => kinds.includes(l.noise_kind)).map((l) => l.entity_id));
  const flagged = (type: string) => new Set(result.exceptions.filter((e) => e.type === type).map((e) => e.primary.id));

  it("produces a summary that validates against its schema and ties out", () => {
    expect(ReconSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.tie_out.residual_paise).toBe(0);
  });

  it("finds the deterministic stage-1/4 issues exactly (no false positives or negatives)", () => {
    expect(flagged("FEE_GST_MISMATCH")).toEqual(labelled("GST_WRONG_BASE"));
    expect(flagged("REFUND_AMOUNT_MISMATCH")).toEqual(labelled("REFUND_AMOUNT_MISMATCH"));
    expect(flagged("MISSING_SETTLEMENT")).toEqual(labelled("MISSING_SETTLEMENT"));
    expect(flagged("TIMING_WINDOW_EXCEEDED")).toEqual(labelled("LATE_SETTLEMENT"));
  });

  it("flags every injected match-conflict trap", () => {
    for (const id of labelled("MATCH_CONFLICT_TRAP")) expect(flagged("MATCH_CONFLICT").has(id)).toBe(true);
  });

  it("persists the run without touching financial tables", () => {
    for (const t of FINANCIAL_TABLES) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(counts.get(t));
    const run = db.prepare("SELECT COUNT(*) AS n FROM recon_runs WHERE id = ?").get(summary.run_id) as { n: number };
    expect(run.n).toBe(1);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM exceptions WHERE run_id = ?").get(summary.run_id) as { n: number };
    expect(stored.n).toBe(result.exceptions.length);
  });
});
