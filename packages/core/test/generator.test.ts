import { beforeAll, describe, expect, it } from "vitest";
import { businessDaysBetween } from "../src/calendar.ts";
import { loadConfig } from "../src/config.ts";
import { NOISE_EXPECTATIONS, HELDOUT_ONLY_NOISE } from "../src/generator/catalog.ts";
import { generateDataset, type Dataset } from "../src/generator/generate.ts";
import { datasetHash, partitionDataset } from "../src/generator/split.ts";
import { gatewayFee, gstOnFee } from "../src/money.ts";
import { NOISE_KINDS, type NoiseKind, type TruthLabel } from "../src/types.ts";

const cfg = loadConfig();
let demo: Dataset;
let large: Dataset;

const labelsOf = (ds: Dataset, kind: NoiseKind) => ds.labels.filter((l) => l.noise_kind === kind);
const ids = (labels: TruthLabel[]) => new Set(labels.map((l) => l.entity_id));
const detail = (l: TruthLabel, key: string) => l.details[key];

beforeAll(() => {
  demo = generateDataset({ seed: 42, payments: 5000, config: cfg });
  large = generateDataset({ seed: 7, payments: 25_000, config: cfg });
});

describe("generator reproducibility", () => {
  it("produces an identical dataset for the same seed", () => {
    expect(datasetHash(generateDataset({ seed: 42, payments: 5000, config: cfg }))).toBe(datasetHash(demo));
  });

  it("produces a different dataset for a different seed", () => {
    expect(datasetHash(generateDataset({ seed: 43, payments: 5000, config: cfg }))).not.toBe(datasetHash(demo));
  });
});

describe("generated domain data", () => {
  it("matches the spec's default shape", () => {
    // 5000 requested payments, plus the few extra twin-basket payments that build ambiguity traps.
    expect(demo.payments.length).toBeGreaterThanOrEqual(5000);
    expect(demo.payments.length).toBeLessThan(5100);
    expect(demo.settlements.length).toBeGreaterThan(250);
    expect(demo.settlements.length).toBeLessThan(350);
    expect(demo.meta.period_start).toBe("2026-09-17");
    expect(demo.meta.period_end).toBe("2026-10-31");
    for (const p of demo.payments) expect(p.captured_at.slice(0, 10) <= demo.meta.period_end).toBe(true);
    for (const s of demo.settlements) expect(s.settled_at <= demo.meta.period_end).toBe(true);
  });

  it("keeps every money value an integer number of paise", () => {
    const values = [
      ...demo.payments.map((p) => p.amount_paise),
      ...demo.settlementItems.flatMap((i) => [i.gross_paise, i.fee_paise, i.gst_paise, i.net_paise]),
      ...demo.settlements.map((s) => s.amount_paise),
      ...demo.bankLines.flatMap((b) => [b.credit_paise, b.debit_paise, b.balance_paise]),
      ...demo.ledgerEntries.map((e) => e.amount_paise),
    ];
    expect(values.every(Number.isSafeInteger)).toBe(true);
  });

  it("computes fee, GST on fee and net correctly, except where GST_WRONG_BASE was injected", () => {
    const wrongGst = ids(labelsOf(demo, "GST_WRONG_BASE"));
    const method = new Map(demo.payments.map((p) => [p.id, p.method]));
    for (const item of demo.settlementItems.filter((i) => i.entity_type === "payment")) {
      expect(item.net_paise).toBe(item.gross_paise - item.fee_paise - item.gst_paise);
      expect(item.fee_paise).toBe(gatewayFee(item.gross_paise, cfg.fees.gateway_fee_bps[method.get(item.entity_id)!]));
      if (wrongGst.has(item.entity_id)) expect(item.gst_paise).toBe(gstOnFee(item.gross_paise));
      else expect(item.gst_paise).toBe(gstOnFee(item.fee_paise));
    }
  });

  it("makes every settlement amount the sum of its items' nets", () => {
    const net = new Map<string, number>();
    for (const i of demo.settlementItems) net.set(i.settlement_id, (net.get(i.settlement_id) ?? 0) + i.net_paise);
    for (const s of demo.settlements) {
      expect(s.amount_paise).toBe(net.get(s.id));
      expect(s.amount_paise).toBeGreaterThan(0);
    }
  });

  it("deducts refunds at their real amount unless REFUND_AMOUNT_MISMATCH was injected", () => {
    const mismatched = ids(labelsOf(demo, "REFUND_AMOUNT_MISMATCH"));
    const refunds = new Map(demo.refunds.map((r) => [r.id, r]));
    const payments = new Map(demo.payments.map((p) => [p.id, p]));
    for (const r of demo.refunds) expect(r.amount_paise).toBeLessThanOrEqual(payments.get(r.payment_id)!.amount_paise);
    for (const item of demo.settlementItems.filter((i) => i.entity_type === "refund")) {
      const refund = refunds.get(item.entity_id)!;
      expect(item.fee_paise + item.gst_paise).toBe(0);
      if (mismatched.has(refund.id)) expect(item.net_paise).not.toBe(-refund.amount_paise);
      else expect(item.net_paise).toBe(-refund.amount_paise);
    }
  });

  it("produces a bank statement with a continuous running balance", () => {
    let balance = cfg.generator.opening_balance_paise;
    let lastDate = "";
    for (const line of demo.bankLines) {
      expect((line.credit_paise > 0) !== (line.debit_paise > 0)).toBe(true);
      balance += line.credit_paise - line.debit_paise;
      expect(line.balance_paise).toBe(balance);
      expect(line.balance_paise).toBeGreaterThanOrEqual(0);
      expect(line.txn_date >= lastDate).toBe(true);
      lastDate = line.txn_date;
    }
  });

  it("books a Receipt per bank credit and a Journal per settlement", () => {
    const receipts = demo.links.filter((l) => l.kind === "RECEIPT_BANK" && l.to_ids.length > 0);
    const credits = demo.bankLines.filter((b) => b.credit_paise > 0).length;
    const missingReceipts = labelsOf(demo, "MISSING_LEDGER_RECEIPT").length;
    const duplicates = labelsOf(demo, "DUPLICATE_LEDGER_ENTRY").length;
    expect(receipts.length).toBe(credits - missingReceipts + duplicates);
    const journals = demo.ledgerEntries.filter((e) => e.voucher_type === "Journal").length;
    expect(journals).toBe(demo.settlements.length - labelsOf(demo, "MISSING_LEDGER_JOURNAL").length);
  });
});

describe("ground truth", () => {
  it("labels every noise kind with the catalog's expected outcome", () => {
    for (const l of large.labels) {
      const e = NOISE_EXPECTATIONS[l.noise_kind];
      expect([l.entity_type, l.expected_exception, l.expected_match_kind]).toEqual([e.entity, e.exception, e.match]);
    }
  });

  it("injects every dev-eligible noise kind at realistic rates", () => {
    for (const kind of NOISE_KINDS.filter((k) => !HELDOUT_ONLY_NOISE.has(k))) {
      expect(labelsOf(large, kind).filter((l) => l.split === "dev").length, kind).toBeGreaterThan(0);
    }
  });

  it("links each bank credit to the settlements that truly make it up", () => {
    const settlement = new Map(large.settlements.map((s) => [s.id, s]));
    const amountNoise = new Set(
      [...labelsOf(large, "AMOUNT_MISMATCH_ROUNDING"), ...labelsOf(large, "AMOUNT_MISMATCH_MATERIAL")].map((l) => l.entity_id),
    );
    const credits = large.bankLines.filter((b) => b.credit_paise > 0);
    const links = new Map(large.links.filter((l) => l.kind === "BANK_SETTLEMENT").map((l) => [l.from_id, l.to_ids]));
    expect(links.size).toBe(credits.length);
    for (const line of credits) {
      const to = links.get(line.id)!;
      if (to.length === 0 || amountNoise.has(line.id)) continue;
      expect(to.reduce((sum, id) => sum + settlement.get(id)!.amount_paise, 0)).toBe(line.credit_paise);
    }
  });

  it("leaves missing settlements and missing bank credits genuinely absent", () => {
    const settledPayments = new Set(large.settlementItems.map((i) => i.entity_id));
    for (const l of labelsOf(large, "MISSING_SETTLEMENT")) expect(settledPayments.has(l.entity_id)).toBe(false);
    const linked = new Set(large.links.filter((l) => l.kind === "BANK_SETTLEMENT").flatMap((l) => l.to_ids));
    for (const l of labelsOf(large, "MISSING_BANK_LINE")) expect(linked.has(l.entity_id)).toBe(false);
  });

  it("keeps consolidated credits mostly 2–15 settlements, up to 40, all inside the batch window", () => {
    const settlement = new Map(large.settlements.map((s) => [s.id, s]));
    const line = new Map(large.bankLines.map((b) => [b.id, b]));
    const sizes: number[] = [];
    for (const l of labelsOf(large, "CONSOLIDATED_CREDIT")) {
      const members = detail(l, "settlement_ids") as string[];
      sizes.push(members.length);
      const creditDate = line.get(l.entity_id)!.txn_date;
      for (const id of members) {
        const settled = settlement.get(id)!.settled_at;
        expect(settled <= creditDate).toBe(true);
        expect(businessDaysBetween(settled, creditDate, cfg.calendar)).toBeLessThanOrEqual(cfg.matching.batch.window_business_days);
      }
    }
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40);
    expect(sizes.filter((n) => n <= 15).length / sizes.length).toBeGreaterThan(0.8);
  });

  it("builds ambiguity traps from equal-amount twin settlements", () => {
    const settlement = new Map(large.settlements.map((s) => [s.id, s]));
    for (const l of labelsOf(large, "AMBIGUOUS_BATCH_TRAP")) {
      const members = detail(l, "settlement_ids") as string[];
      const twin = settlement.get(detail(l, "twin_settlement_id") as string)!;
      expect(members.some((id) => settlement.get(id)!.amount_paise === twin.amount_paise)).toBe(true);
    }
  });

  it("builds conflict decoys that resemble a consolidated settlement's UTR and amount", () => {
    const settlement = new Map(large.settlements.map((s) => [s.id, s]));
    const line = new Map(large.bankLines.map((b) => [b.id, b]));
    for (const l of labelsOf(large, "CONFLICT_DECOY")) {
      const target = settlement.get(detail(l, "resembles_settlement_id") as string)!;
      const decoy = line.get(l.entity_id)!;
      expect(decoy.credit_paise).toBe(target.amount_paise);
      expect(decoy.narration).not.toContain(target.utr);
    }
  });

  it("injects held-out-only variants exclusively into held-out", () => {
    for (const kind of HELDOUT_ONLY_NOISE) {
      expect(labelsOf(large, kind).filter((l) => l.split === "dev")).toHaveLength(0);
      expect(labelsOf(large, kind).filter((l) => l.split === "heldout").length).toBeGreaterThan(0);
    }
  });
});

describe("dev / held-out split", () => {
  it("assigns every record to exactly one split and keeps linked records together", () => {
    const { dev, heldout } = partitionDataset(large);
    const tables = (d: Dataset) => [d.payments, d.refunds, d.settlements, d.settlementItems, d.bankLines, d.ledgerEntries];
    tables(large).forEach((rows, i) => expect(tables(dev)[i]!.length + tables(heldout)[i]!.length).toBe(rows.length));

    for (const part of [dev, heldout]) {
      const settlementIds = new Set(part.settlements.map((s) => s.id));
      const paymentIds = new Set(part.payments.map((p) => p.id));
      const lineIds = new Set(part.bankLines.map((b) => b.id));
      for (const i of part.settlementItems) expect(settlementIds.has(i.settlement_id)).toBe(true);
      for (const r of part.refunds) expect(paymentIds.has(r.payment_id)).toBe(true);
      for (const link of part.links) {
        const targets = link.kind === "RECEIPT_BANK" ? lineIds : settlementIds;
        for (const id of link.to_ids) expect(targets.has(id)).toBe(true);
      }
    }
  });

  it("holds out roughly the last 20% of the period", () => {
    const { dev, heldout } = partitionDataset(demo);
    const share = heldout.payments.length / (dev.payments.length + heldout.payments.length);
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.25);
  });
});
