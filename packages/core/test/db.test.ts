import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { runReconciliation } from "../src/matcher/run.ts";
import { openReconDb, openTruthDb, truthDbPathFor, type Db } from "../src/db/open.ts";
import { FINANCIAL_TABLES } from "../src/db/schema.ts";
import { generateDataset, type Dataset } from "../src/generator/generate.ts";
import { loadDataset } from "../src/generator/load.ts";
import { readTruthLabels, readTruthLinks } from "../src/truth/store.ts";

let ds: Dataset;
let recon: Db;
let truth: Db;

beforeAll(() => {
  ds = generateDataset({ seed: 11, payments: 1500 });
  recon = openReconDb(":memory:");
  truth = openTruthDb(":memory:");
  loadDataset(recon, truth, ds);
});

const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("recon database", () => {
  it("stores every generated record", () => {
    expect(count(recon, "payments")).toBe(ds.payments.length);
    expect(count(recon, "settlement_items")).toBe(ds.settlementItems.length);
    expect(count(recon, "bank_lines")).toBe(ds.bankLines.length);
    expect(count(recon, "ledger_entries")).toBe(ds.ledgerEntries.length);
  });

  it.each(FINANCIAL_TABLES)("blocks UPDATE and DELETE on %s", (table) => {
    expect(() => recon.prepare(`UPDATE ${table} SET id = id`).run()).toThrow(/insert-only/);
    expect(() => recon.prepare(`DELETE FROM ${table}`).run()).toThrow(/insert-only/);
  });

  it("rejects fractional money at the storage layer (STRICT tables)", () => {
    expect(() =>
      recon
        .prepare("INSERT INTO payments (id, order_id, amount_paise, method, status, captured_at) VALUES ('p_x','o_x',100.5,'upi','captured','2026-10-01T10:00:00+05:30')")
        .run(),
    ).toThrow();
  });

  it("contains no ground truth: no truth tables and no split boundary in metadata", () => {
    const tables = (recon.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables.some((t) => t.startsWith("truth"))).toBe(false);
    const keys = (recon.prepare("SELECT key FROM dataset_meta").all() as { key: string }[]).map((r) => r.key);
    expect(keys).not.toContain("heldout_start");
  });
});

describe("truth database", () => {
  it("round-trips labels and links through zod", () => {
    expect(readTruthLabels(truth)).toEqual(ds.labels);
    expect(readTruthLinks(truth)).toEqual(ds.links);
  });

  it("lives in its own file next to the recon DB, which never sees it", () => {
    const dir = mkdtempSync(join(tmpdir(), "closeloop-truth-"));
    const reconPath = join(dir, "closeloop.db");
    const r = openReconDb(reconPath);
    const t = openTruthDb(truthDbPathFor(reconPath));
    loadDataset(r, t, generateDataset({ seed: 3, payments: 300 }));
    r.close();
    t.close();
    expect(existsSync(join(dir, "truth.db"))).toBe(true);
    const reopened = openReconDb(reconPath);
    const tables = (reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((x) => x.name);
    expect(tables).not.toContain("truth_labels");
    expect(() => reopened.prepare("SELECT COUNT(*) FROM truth_labels").get()).toThrow(/no such table/);
    expect(count(openTruthDb(truthDbPathFor(reconPath)), "truth_labels")).toBeGreaterThan(0);
  });
});

describe("read-only source mode", () => {
  it("reconciles against an attached read-only source and keeps all writes in the state DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "closeloop-src-"));
    const sourcePath = join(dir, "source.db");
    const src = openReconDb(sourcePath);
    loadDataset(src, null, generateDataset({ seed: 5, payments: 800 }));
    src.pragma("journal_mode = DELETE");
    src.close();
    chmodSync(sourcePath, 0o444);

    const state = openReconDb(join(dir, "state.db"), { sourcePath });
    const { summary } = runReconciliation(state, loadConfig());
    expect(summary.matched.payments_settled).toBeGreaterThan(0);
    expect(count(state, "main.exceptions")).toBeGreaterThan(0);
    expect(() => state.prepare("DELETE FROM src.dataset_meta").run()).toThrow(/readonly/);
    expect(() => state.prepare("INSERT INTO payments (id, order_id, amount_paise, method, status, captured_at) VALUES ('x','o',1,'upi','captured','2026-10-01T10:00:00+05:30')").run()).toThrow(/readonly/);
    const mainTables = (state.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(mainTables).not.toContain("payments");
  });

  it("refuses a missing source database", () => {
    expect(() => openReconDb(":memory:", { sourcePath: "/nonexistent/source.db" })).toThrow(/not found/);
  });
});
