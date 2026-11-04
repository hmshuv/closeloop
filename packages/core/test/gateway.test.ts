import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, loadConfig } from "../src/config.ts";
import { openReconDb } from "../src/db/open.ts";
import { GATEWAY_TABLES } from "../src/db/schema.ts";
import { buildSyntheticReconReport, reconReportJson, SYNTHETIC_NOTE } from "../src/gateway/fixture.ts";
import {
  parseReconCsv,
  parseReconJson,
  razorpayCredentialsFromEnv,
  RazorpayReadOnlyClient,
  RECON_FIELDS,
  reconItemsToCsv,
  toReportRow,
  type RazorpayReconItem,
} from "../src/gateway/razorpay.ts";
import { importRazorpayRecon, loadGatewayReport } from "../src/gateway/store.ts";
import { generateDataset } from "../src/generator/generate.ts";
import { loadDataset } from "../src/generator/load.ts";
import { loadSource } from "../src/matcher/load.ts";
import { reconcile } from "../src/matcher/reconcile.ts";
import { runReconciliation } from "../src/matcher/run.ts";
import { stage1Items } from "../src/matcher/stage1-items.ts";
import { stage2Bank } from "../src/matcher/stage2-bank.ts";
import type { ExceptionDraft, GatewayReportRow, StageResult } from "../src/matcher/types.ts";
import type { Payment, Settlement, SettlementItem } from "../src/types.ts";
import { cfg, credit, itemFor, neft, payment, settlement, source } from "./fixtures.ts";

/** The INR success example from Razorpay's "Fetch Recon" API docs, verbatim. */
const DOCS_EXAMPLE = `{"entity":"collection","count":4,"items":[
{"entity_id":"pay_DEXrnipqTmWVGE","type":"payment","debit":0,"credit":97100,"amount":100000,"currency":"INR","fee":2900,"tax":0,"on_hold":false,"settled":true,"created_at":1567692556,"settled_at":1568176960,"settlement_id":"setl_DGlQ1Rj8os78Ec","posted_at":null,"credit_type":"default","description":"Recurring Payment via Subscription","notes":"Beam me up Scotty.","payment_id":null,"settlement_utr":"1568176960vxp0rj","order_id":"order_DEXrnRiR3SNDHA","order_receipt":null,"method":"card","card_network":"MasterCard","card_issuer":"KARB","card_type":"credit","dispute_id":null},
{"entity_id":"rfnd_DGRcGzZSLyEdg1","type":"refund","debit":242500,"credit":0,"amount":242500,"currency":"INR","fee":0,"tax":0,"on_hold":false,"settled":true,"created_at":1568107224,"settled_at":1568176960,"settlement_id":"setl_DGlQ1Rj8os78Ec","posted_at":null,"credit_type":"default","description":null,"notes":"Beam me up Scotty.","payment_id":"pay_DEXq1pACSqFxtS","settlement_utr":"1568176960vxp0rj","order_id":"order_DEXpmZgffXNvuI","order_receipt":null,"method":"card","card_network":"MasterCard","card_issuer":"KARB","card_type":"credit","dispute_id":null},
{"entity_id":"trf_DEUoCEtdsJgvl7","type":"transfer","debit":100296,"credit":0,"amount":100000,"currency":"INR","fee":296,"tax":46,"on_hold":false,"settled":true,"created_at":1567681786,"settled_at":1568176960,"settlement_id":"setl_DGlQ1Rj8os78Ec","posted_at":null,"credit_type":"default","description":null,"notes":null,"payment_id":"pay_DEApNNTR6xmqJy","settlement_utr":"1568176960vxp0rj","order_id":null,"order_receipt":null,"method":null,"card_network":null,"card_issuer":null,"card_type":null,"dispute_id":null},
{"entity_id":"adj_EhcHONhX4ChgNC","type":"adjustment","debit":0,"credit":1012,"amount":1012,"currency":"INR","fee":0,"tax":0,"on_hold":false,"settled":true,"created_at":1567681786,"settled_at":1568176960,"settlement_id":"setl_DGlQ1Rj8os78Ec","posted_at":null,"description":"test reason","notes":null,"payment_id":null,"settlement_utr":null,"order_id":null,"order_receipt":null,"method":null,"card_network":null,"card_issuer":null,"card_type":null,"dispute_id":null}]}`;

const docsItems = (JSON.parse(DOCS_EXAMPLE) as { items: Record<string, unknown>[] }).items;

describe("Razorpay recon report: parsing the documented format", () => {
  it("accepts the documented recon/combined response and normalises its rows", () => {
    const items = parseReconJson(DOCS_EXAMPLE);
    expect(items.map((i) => i.type)).toEqual(["payment", "refund", "transfer", "adjustment"]);
    expect(toReportRow(items[0] as RazorpayReconItem)).toEqual({
      entity_id: "pay_DEXrnipqTmWVGE",
      type: "payment",
      settlement_id: "setl_DGlQ1Rj8os78Ec",
      settlement_utr: "1568176960vxp0rj",
      amount_paise: 100000,
      fee_paise: 2900,
      tax_paise: 0,
      credit_paise: 97100,
      debit_paise: 0,
      payment_id: null,
      settled_on: "2019-09-11",
    });
    // A list of pages or a bare list of items works too.
    expect(parseReconJson(`[${DOCS_EXAMPLE},${DOCS_EXAMPLE}]`)).toHaveLength(8);
    expect(parseReconJson(JSON.stringify(docsItems))).toHaveLength(4);
  });

  it("round-trips through CSV with the API's field names as headers", () => {
    const items = parseReconJson(DOCS_EXAMPLE);
    const csv = reconItemsToCsv(items);
    expect(csv.split("\n")[0]).toBe(RECON_FIELDS.join(","));
    expect(parseReconCsv(csv).map(toReportRow)).toEqual(items.map(toReportRow));
  });

  it("maps differently named export headers through configured aliases, case-insensitively", () => {
    const csv = reconItemsToCsv(parseReconJson(DOCS_EXAMPLE)).replace("entity_id,", "Entity ID,").replace(",settlement_utr,", ",Settlement UTR,");
    expect(() => parseReconCsv(csv)).toThrow(/missing the "entity_id" column.*csv_header_aliases/);
    const rows = parseReconCsv(csv, { "entity id": "entity_id", "SETTLEMENT UTR": "settlement_utr" });
    expect(rows.map(toReportRow)).toEqual(parseReconJson(DOCS_EXAMPLE).map(toReportRow));
    // Aliases may only target documented field names.
    expect(GatewayConfigSchema.safeParse({ razorpay: { recon_page_size: 100, csv_header_aliases: { "UTR No": "utr_number" } } }).success).toBe(false);
  });

  it("rejects rupee-denominated amounts and non-INR currencies instead of misreading them", () => {
    const csv = reconItemsToCsv(parseReconJson(DOCS_EXAMPLE)).replace(",97100,100000,", ",971.00,1000.00,");
    expect(() => parseReconCsv(csv)).toThrow(/not an integer amount in paise/);
    expect(() => parseReconJson(DOCS_EXAMPLE.replace(/"INR"/g, '"USD"'))).toThrow(/currency USD is not supported/);
    expect(() => parseReconJson('{"entity":"collection","count":1,"items":[{"entity_id":"pay_x"}]}')).toThrow(/recon row 1/);
  });
});

describe("Razorpay read-only client", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const page = (n: number) => ({ entity: "collection", count: n, items: Array.from({ length: n }, (_, i) => ({ ...docsItems[0], entity_id: `pay_${i}` })) });
  const fakeFetch = (pages: Record<string, unknown>) =>
    ((url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ url: u.toString(), init: init ?? {} });
      const body = pages[`${u.pathname}?day=${u.searchParams.get("day")}&skip=${u.searchParams.get("skip")}`] ?? { entity: "collection", count: 0, items: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;

  it("only ever sends authenticated GETs to the documented settlement endpoints, and pages 100 rows at a time", async () => {
    calls.length = 0;
    const client = new RazorpayReadOnlyClient({ keyId: "rzp_test_id", keySecret: "s3cret" }, { fetch: fakeFetch({ "/v1/settlements/recon/combined?day=1&skip=0": page(100), "/v1/settlements/recon/combined?day=1&skip=100": page(3) }) });
    const items = await client.fetchRecon("2026-10-01", "2026-10-02");
    expect(items).toHaveLength(103);
    await client.fetchSettlements("2026-10-01", "2026-10-02");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.init.method).toBe("GET");
      expect(c.init.body).toBeUndefined();
      expect(new URL(c.url).origin).toBe("https://api.razorpay.com");
      expect(new URL(c.url).pathname).toMatch(/^\/v1\/settlements(\/recon\/combined)?$/);
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("rzp_test_id:s3cret").toString("base64")}`);
    }
    const recon = calls.filter((c) => c.url.includes("recon")).map((c) => Object.fromEntries(new URL(c.url).searchParams));
    expect(recon).toEqual([
      { year: "2026", month: "10", day: "1", count: "100", skip: "0" },
      { year: "2026", month: "10", day: "1", count: "100", skip: "100" },
      { year: "2026", month: "10", day: "2", count: "100", skip: "0" },
    ]);
    const settlementsQuery = Object.fromEntries(new URL(calls.at(-1)?.url ?? "").searchParams);
    expect(settlementsQuery).toMatchObject({ from: String(Date.parse("2026-10-01T00:00:00+05:30") / 1000), to: String(Date.parse("2026-10-03T00:00:00+05:30") / 1000 - 1), count: "100" });
  });

  it("takes a larger page size from config, up to the API's 1000", async () => {
    calls.length = 0;
    const client = new RazorpayReadOnlyClient({ keyId: "a", keySecret: "b" }, { reconPageSize: 1000, fetch: fakeFetch({ "/v1/settlements/recon/combined?day=1&skip=0": page(1000), "/v1/settlements/recon/combined?day=1&skip=1000": page(2) }) });
    expect(await client.fetchRecon("2026-10-01", "2026-10-01")).toHaveLength(1002);
    expect(calls.map((c) => new URL(c.url).searchParams.get("count"))).toEqual(["1000", "1000"]);
    expect(() => new RazorpayReadOnlyClient({ keyId: "a", keySecret: "b" }, { reconPageSize: 1001 })).toThrow(/1 to 1000/);
    expect(loadConfig().gateway.razorpay.recon_page_size).toBe(100);
  });

  it("reports API errors without echoing credentials", async () => {
    const failing = (() => Promise.resolve(new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "The api key provided is invalid" } }), { status: 401 }))) as unknown as typeof fetch;
    const err = await new RazorpayReadOnlyClient({ keyId: "rzp_test_id", keySecret: "s3cret" }, { fetch: failing }).fetchRecon("2026-10-01", "2026-10-01").then(() => new Error("expected a failure"), (e: unknown) => e as Error);
    expect(err.message).toMatch(/HTTP 401 \(The api key provided is invalid\)/);
    expect(err.message).not.toMatch(/s3cret|rzp_test_id/);
  });

  it("reads credentials only from CLOSELOOP_RAZORPAY_KEY_ID / _SECRET", () => {
    expect(razorpayCredentialsFromEnv({ RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b" })).toBeNull();
    expect(razorpayCredentialsFromEnv({ CLOSELOOP_RAZORPAY_KEY_ID: "a" })).toBeNull();
    expect(razorpayCredentialsFromEnv({ CLOSELOOP_RAZORPAY_KEY_ID: " a ", CLOSELOOP_RAZORPAY_KEY_SECRET: "b" })).toEqual({ keyId: "a", keySecret: "b" });
  });
});

describe("importing a report into the state DB", () => {
  it("is idempotent, keeps the first copy of a conflicting row, and is insert-only", () => {
    const db = openReconDb(":memory:");
    const items = parseReconJson(DOCS_EXAMPLE);
    const first = importRazorpayRecon(db, items, { source: "file", origin: "docs.json" });
    expect(first).toMatchObject({ inserted: 4, duplicates: 0, conflicts: [], settlements_covered: 1, payout_utrs: 1, settled_from: "2019-09-11" });
    const again = importRazorpayRecon(db, items, { source: "file", origin: "docs.json" });
    expect(again).toMatchObject({ inserted: 0, duplicates: 4, conflicts: [] });
    const settlementEntity = { id: "setl_DGlQ1Rj8os78Ec", entity: "settlement" as const, amount: 9973635, status: "processed", fees: 0, tax: 0, utr: "1568176960vxp0rj", created_at: 1568176960 };
    const changed = importRazorpayRecon(db, [{ ...(items[0] as RazorpayReconItem), credit: 97000 }], { source: "api", origin: "edited", settlements: [settlementEntity] });
    expect(changed.conflicts).toEqual(["payment pay_DEXrnipqTmWVGE in setl_DGlQ1Rj8os78Ec"]);
    expect(loadGatewayReport(db, "2019-09-11").find((r) => r.entity_id === "pay_DEXrnipqTmWVGE")?.credit_paise).toBe(97100);
    for (const t of GATEWAY_TABLES) {
      expect(() => db.prepare(`DELETE FROM ${t}`).run()).toThrow(/insert-only/);
      const col = t === "gateway_reports" ? "origin" : "report_id";
      expect(() => db.prepare(`UPDATE ${t} SET ${col} = ${col}`).run()).toThrow(/insert-only/);
    }
    expect(loadGatewayReport(db, "2019-09-10")).toHaveLength(0);
  });

  it("works when the financial source is attached read-only (the report lives in the state DB)", () => {
    const dir = mkdtempSync(join(tmpdir(), "closeloop-gw-"));
    const sourcePath = join(dir, "source.db");
    const ds = generateDataset({ seed: 5, payments: 600 });
    const src = openReconDb(sourcePath);
    loadDataset(src, null, ds);
    src.pragma("journal_mode = DELETE");
    src.close();
    chmodSync(sourcePath, 0o444);
    const state = openReconDb(join(dir, "state.db"), { sourcePath });
    const imported = importRazorpayRecon(state, buildSyntheticReconReport(ds).items, { source: "file", origin: "synthetic" });
    expect(imported.inserted).toBeGreaterThan(0);
    const { summary } = runReconciliation(state, cfg);
    expect(summary.gateway_report?.rows).toBe(imported.inserted);
  });
});

// ---------- matching with the report ----------

/** Report rows for a settlement, derived from its items exactly as the gateway would report them. */
function rowsFor(s: Settlement, items: SettlementItem[], utr: string): GatewayReportRow[] {
  return items.map((it) => ({
    entity_id: it.entity_id,
    type: it.entity_type,
    settlement_id: s.id,
    settlement_utr: utr,
    amount_paise: Math.abs(it.gross_paise),
    fee_paise: it.fee_paise,
    tax_paise: it.gst_paise,
    credit_paise: Math.max(it.net_paise, 0),
    debit_paise: Math.max(-it.net_paise, 0),
    payment_id: null,
    settled_on: s.settled_at,
  }));
}

/** A settlement holding one payment, with its item, so stage 1 balances. */
function settled(id: string, utr: string, date: string, gross: number): { p: Payment; s: Settlement; item: SettlementItem } {
  const p = payment(`pay_${id}`, gross, "upi", date);
  const item = itemFor(p, id);
  return { p, s: settlement(id, utr, date, item.net_paise), item };
}

const ofType = (r: { exceptions: ExceptionDraft[] }, type: ExceptionDraft["type"]) => r.exceptions.filter((e) => e.type === type);
const ids = (r: { exceptions: ExceptionDraft[] }, type: ExceptionDraft["type"]) => ofType(r, type).map((e) => e.primary.id);
const kind = (r: StageResult, k: string) => r.matches.filter((m) => m.kind === k);
const PAYOUT_UTR = "ICICN26279999999";

describe("stage 2r: batched credits from the gateway report", () => {
  // Created in the order twinA, other, twinB: two contiguous runs and two subsets sum to the credit.
  const twinA = settled("twin_a", "AXISN26278000011", "2026-10-05", 1_00_000);
  const other = settled("other", "AXISN26278000012", "2026-10-05", 1_50_000);
  const twinB = settled("twin_b", "AXISN26278000013", "2026-10-05", 1_00_000);
  const all = [twinA, other, twinB];
  const amount = other.s.amount_paise + twinB.s.amount_paise;
  const base = (bankAmount: number, narration = neft(PAYOUT_UTR), report = [...rowsFor(other.s, [other.item], PAYOUT_UTR), ...rowsFor(twinB.s, [twinB.item], PAYOUT_UTR)]) =>
    source({ payments: all.map((x) => x.p), settlements: all.map((x) => x.s), items: all.map((x) => x.item), bankLines: [credit("p1", "2026-10-06", bankAmount, narration)], gatewayReport: report });

  it("without a report the credit is ambiguous; with it, the report's settlements are matched as BATCH_FROM_GATEWAY_REPORT", () => {
    const amountOnly = stage2Bank({ ...base(amount), gatewayReport: [] }, cfg);
    expect(ofType(amountOnly, "AMBIGUOUS_BATCH")).toHaveLength(1);
    expect(amountOnly.gateway).toBeNull();

    const r = stage2Bank(base(amount), cfg);
    const m = kind(r, "BATCH_FROM_GATEWAY_REPORT");
    expect(m.map((x) => x.left.id).sort()).toEqual(["other", "twin_b"]);
    expect(m[0]).toMatchObject({ reason: "GATEWAY_REPORT_PAYOUT", right: { id: "p1" }, trace: { located_by: "utr_in_narration", settlement_utr: PAYOUT_UTR, report_net_paise: amount, credit_paise: amount } });
    expect(ofType(r, "AMBIGUOUS_BATCH")).toHaveLength(0);
    // The twin the report did not put in this payout is now plainly missing from the bank.
    expect(ids(r, "MISSING_BANK_CREDIT")).toEqual(["twin_a"]);
    expect(r.gateway).toMatchObject({ payouts: 1, matched: 1, settlements_matched: 2, mismatches: 0 });
  });

  it("raises GATEWAY_REPORT_MISMATCH and matches nothing when the bank credit is off by even one paisa", () => {
    const r = stage2Bank(base(amount + 1), cfg);
    expect(r.matches.filter((m) => m.right.id === "p1")).toHaveLength(0);
    const [mismatch] = ofType(r, "GATEWAY_REPORT_MISMATCH");
    expect(mismatch).toMatchObject({ subtype: "BANK_CREDIT_AMOUNT", amount_paise: 1, trace: { delta_paise: 1 } });
    // Held for the human: not also unidentified, not batch-searched, the settlements not called missing.
    expect(ofType(r, "UNIDENTIFIED_BANK_CREDIT")).toHaveLength(0);
    expect(ofType(r, "AMBIGUOUS_BATCH")).toHaveLength(0);
    expect(ids(r, "MISSING_BANK_CREDIT")).toEqual(["twin_a"]);
  });

  it("flags a report whose rows don't add up to the settlement, in stage 1 and against the bank", () => {
    const tampered = [...rowsFor(other.s, [other.item], PAYOUT_UTR), ...rowsFor(twinB.s, [{ ...twinB.item, net_paise: twinB.item.net_paise - 500 }], PAYOUT_UTR)];
    const src = base(amount, neft(PAYOUT_UTR), tampered);
    const s1 = stage1Items(src, cfg);
    expect(ofType(s1, "GATEWAY_REPORT_MISMATCH")).toMatchObject([{ subtype: "SETTLEMENT_TOTAL", amount_paise: 500, primary: { id: "twin_b" } }]);
    expect(ofType(s1, "AMOUNT_MISMATCH")).toHaveLength(0);
    expect(ofType(stage2Bank(src, cfg), "GATEWAY_REPORT_MISMATCH")).toMatchObject([{ subtype: "REPORT_TOTAL" }]);
  });

  it("locates a multi-settlement payout by exact total and dates when the narration lost the UTR", () => {
    const r = stage2Bank(base(amount, "NEFT CR-RAZORPAY SOFTWARE PVT LTD-SETTL"), cfg);
    expect(kind(r, "BATCH_FROM_GATEWAY_REPORT")[0]?.trace).toMatchObject({ located_by: "amount_and_date" });
  });

  it("resolves a match conflict: the suggested settlement is accounted for by its real payout", () => {
    const S = settled("S", "AXISN26278555555", "2026-10-05", 1_23_456);
    const o = settled("o", "AXISN26278666666", "2026-10-05", 2_00_000);
    const total = S.s.amount_paise + o.s.amount_paise;
    const decoy = credit("decoy", "2026-10-05", S.s.amount_paise, neft("AXISN26278555588")); // distance 2 from S
    const src = source({ settlements: [S.s, o.s], bankLines: [decoy, credit("p1", "2026-10-06", total, neft(PAYOUT_UTR))] });
    expect(ofType(stage2Bank(src, cfg), "MATCH_CONFLICT")).toHaveLength(1);
    const r = stage2Bank({ ...src, gatewayReport: [...rowsFor(S.s, [S.item], PAYOUT_UTR), ...rowsFor(o.s, [o.item], PAYOUT_UTR)] }, cfg);
    expect(ofType(r, "MATCH_CONFLICT")).toHaveLength(0);
    expect(kind(r, "BATCH_FROM_GATEWAY_REPORT")).toHaveLength(2);
    expect(ids(r, "UNIDENTIFIED_BANK_CREDIT")).toEqual(["decoy"]);
  });

  it("links payments to settlements from the report's rows", () => {
    const r = stage1Items(base(amount), cfg);
    const fromReport = r.matches.filter((m) => m.trace.source === "gateway_report").map((m) => m.left.id).sort();
    expect(fromReport).toEqual(["pay_other", "pay_twin_b"]);
    expect(r.matches.find((m) => m.left.id === "pay_twin_a")?.trace).toEqual({ settlement_item_id: twinA.item.id });
  });
});

describe("the synthetic demo report", () => {
  const ds = generateDataset({ seed: 42, payments: 5000 });
  const report = buildSyntheticReconReport(ds);

  it("is in the documented format, labelled synthetic, and covers every settlement", () => {
    expect(report.entity).toBe("collection");
    expect(report.count).toBe(report.items.length);
    expect(Object.keys(report.items[0] as object)).toEqual([...RECON_FIELDS]);
    expect(report.items.every((i) => (i.notes as { source?: string }).source === SYNTHETIC_NOTE)).toBe(true);
    expect(parseReconJson(JSON.stringify(report))).toHaveLength(report.items.length);
    expect(new Set(report.items.map((i) => i.settlement_id)).size).toBe(ds.settlements.length);
  });

  it("matches the committed fixtures byte for byte (regenerate with `pnpm fixtures`)", () => {
    const dir = new URL("../../../fixtures/razorpay/", import.meta.url);
    expect(readFileSync(new URL("recon-combined.synthetic.json", dir), "utf8")).toBe(reconReportJson(report));
    expect(readFileSync(new URL("recon-combined.synthetic.csv", dir), "utf8")).toBe(reconItemsToCsv(report.items));
  });

  it("links every gateway-report batch to exactly its true settlements, with no mismatch or conflict", () => {
    const db = openReconDb(":memory:");
    loadDataset(db, null, ds);
    importRazorpayRecon(db, report.items, { source: "file", origin: "synthetic" });
    const { result } = runReconciliation(db, cfg);
    const truth = new Map(ds.links.filter((l) => l.kind === "BANK_SETTLEMENT").map((l) => [l.from_id, l.to_ids.slice().sort()]));
    const linked = new Map<string, string[]>();
    for (const m of result.matches.filter((x) => x.kind === "BATCH_FROM_GATEWAY_REPORT")) linked.set(m.right.id, [...(linked.get(m.right.id) ?? []), m.left.id]);
    expect(linked.size).toBe(ds.payouts.length);
    for (const [line, ids] of linked) expect(ids.sort()).toEqual(truth.get(line));
    expect(result.exceptions.filter((e) => e.type === "GATEWAY_REPORT_MISMATCH" || e.type === "MATCH_CONFLICT" || e.type === "AMBIGUOUS_BATCH")).toHaveLength(0);
    // Same data with the report left out: the amount-only path runs.
    const amountOnly = reconcile({ ...loadSource(db, ds.meta.as_of), gatewayReport: [] }, cfg, { from: ds.meta.period_start, to: ds.meta.as_of });
    expect(amountOnly.gateway).toBeNull();
    expect(amountOnly.matches.some((m) => m.kind === "BATCH_FROM_GATEWAY_REPORT")).toBe(false);
  });
});

describe("upgrading from 0.1.x", () => {
  it("reads runs stored before gateway reports existed, and config directories without gateway.json", async () => {
    const { latestRun } = await import("../src/review/runs.ts");
    const db = openReconDb(":memory:");
    loadDataset(db, null, generateDataset({ seed: 7, payments: 400 }));
    const { summary } = runReconciliation(db, cfg);
    const old: Record<string, unknown> = { ...summary };
    delete old.gateway_report;
    const legacy = { ...old, matched: Object.fromEntries(Object.entries(summary.matched).filter(([k]) => k !== "bank_gateway_report_credits")) };
    db.prepare("INSERT INTO recon_runs (id, from_date, to_date, as_of, started_at, finished_at, config_hash, summary_json) VALUES ('legacy', ?, ?, ?, '9999', '9999', 'x', ?)").run(summary.from, summary.to, summary.to, JSON.stringify(legacy));
    const run = latestRun(db);
    expect(run?.id).toBe("legacy");
    expect(run?.summary.gateway_report).toBeNull();
    expect(run?.summary.matched.bank_gateway_report_credits).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), "closeloop-cfg-"));
    for (const f of ["windows", "fees", "matching", "generator", "ai"]) writeFileSync(join(dir, `${f}.json`), readFileSync(new URL(`../../../config/${f}.json`, import.meta.url)));
    expect(loadConfig(dir).gateway.razorpay).toEqual({ recon_page_size: 100, csv_header_aliases: {} });
  });
});
