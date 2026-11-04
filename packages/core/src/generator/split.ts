import { createHash } from "node:crypto";
import { SPLITS, type Split, type TruthLabel } from "../types.ts";
import { COVERAGE_TARGETS } from "./catalog.ts";
import type { Dataset } from "./generate.ts";

/** Split one dataset into independent dev and held-out datasets, each reconciled on its own. */
export function partitionDataset(ds: Dataset): Record<Split, Dataset> {
  const out = {} as Record<Split, Dataset>;
  for (const split of SPLITS) {
    const keep = <T extends { id: string }>(rows: T[]) => rows.filter((r) => ds.splitOf.get(r.id) === split);
    const payments = keep(ds.payments);
    const settlements = keep(ds.settlements);
    out[split] = {
      meta: ds.meta,
      payments,
      refunds: keep(ds.refunds),
      settlements,
      settlementItems: keep(ds.settlementItems),
      bankLines: keep(ds.bankLines),
      ledgerEntries: keep(ds.ledgerEntries),
      labels: ds.labels.filter((l) => l.split === split),
      links: ds.links.filter((l) => l.split === split),
      splitOf: new Map([...ds.splitOf].filter(([, s]) => s === split)),
      payouts: ds.payouts.filter((p) => p.split === split),
    };
  }
  return out;
}

/** Stable content hash used to prove generator reproducibility. */
export function datasetHash(ds: Dataset): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(ds.meta));
  for (const rows of [ds.payments, ds.refunds, ds.settlements, ds.settlementItems, ds.bankLines, ds.ledgerEntries, ds.labels, ds.links]) {
    h.update(JSON.stringify(rows));
  }
  h.update(JSON.stringify([...ds.splitOf]));
  return h.digest("hex");
}

export interface CoverageRow {
  target: string;
  count: number;
  min: number;
  ok: boolean;
}

/** Held-out labels per evaluation target, checked against the configured minimum. */
export function heldoutCoverage(labels: readonly TruthLabel[], minPerType: number): CoverageRow[] {
  const heldout = labels.filter((l) => l.split === "heldout");
  return Object.entries(COVERAGE_TARGETS).map(([target, kinds]) => {
    const count = heldout.filter((l) => kinds.includes(l.noise_kind)).length;
    return { target, count, min: minPerType, ok: count >= minPerType };
  });
}
