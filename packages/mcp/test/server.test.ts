import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyntheticReconReport, FINANCIAL_TABLES, formatINR, generateDataset, istDate, loadConfig, RazorpayReadOnlyClient, reconItemsToCsv, type Db } from "@closeloop/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEMO_SEED, openDatabase } from "../src/bootstrap.ts";
import { CONFIRMATION_TTL_MS, ConfirmationStore } from "../src/confirm.ts";
import { AuditOutput, DecomposeOutput, DraftOutput, EvidenceOutput, ExplainOutput, HumanActionOutput, ImportReconOutput, ListExceptionsOutput, RunOutput } from "../src/schemas.ts";
import { createCloseLoopServer } from "../src/server.ts";

const cfg = loadConfig();
let now = Date.now();
let db: Db;
let client: Client;

function financialHash(): string {
  const h = createHash("sha256");
  for (const t of FINANCIAL_TABLES) h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  return h.digest("hex");
}

type CallResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

async function ok<S extends z.ZodTypeAny>(schema: S, name: string, args: Record<string, unknown> = {}): Promise<z.infer<S>> {
  const res = await call(name, args);
  if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}`);
  const data: unknown = schema.parse(res.structuredContent);
  const summary = (res.structuredContent as { summary?: unknown }).summary;
  expect(typeof summary).toBe("string");
  expect(res.content[0]?.text.startsWith(String(summary))).toBe(true); // human summary at the top
  return data;
}

async function firstOfType(type: string): Promise<string> {
  const list = await ok(ListExceptionsOutput, "list_exceptions", { type, status: "open", limit: 1 });
  const id = list.items[0]?.exception_id;
  if (!id) throw new Error(`no open ${type} in demo data`);
  return id;
}

beforeAll(async () => {
  ({ db } = openDatabase(":memory:", cfg));
  const server = createCloseLoopServer({ db, cfg, provider: null, confirmations: new ConfirmationStore(() => now) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  await ok(RunOutput, "run_reconciliation", { from: "2026-10-01", to: "2026-10-31" });
});

describe("tool catalogue", () => {
  it("exposes the ten tools with honest annotations and nothing that deletes or edits records", async () => {
    const { tools } = await client.listTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    expect([...by.keys()].sort()).toEqual(
      ["approve_suggestion", "decompose_bank_credit", "draft_journal_entry", "escalate", "explain_exception", "get_audit_trail", "get_evidence", "import_razorpay_recon", "list_exceptions", "run_reconciliation"].sort(),
    );
    expect(by.get("import_razorpay_recon")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    for (const name of ["list_exceptions", "get_evidence", "decompose_bank_credit", "get_audit_trail"]) expect(by.get(name)?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["approve_suggestion", "escalate"]) expect(by.get(name)?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const t of tools) {
      expect(t.name.split("_")).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(delete|remove|update|edit|insert|modify|set)$/)]));
      expect(t.outputSchema).toBeDefined();
      expect((t.description ?? "").length).toBeGreaterThan(80);
    }
  });

  it("rejects tools that don't exist", async () => {
    await expect(call("delete_payment", { id: "pay_x" })).resolves.toMatchObject({ isError: true });
  });
});

describe("read tools", () => {
  it("run_reconciliation pre-formats every amount and never sums exposure classes", async () => {
    const run = await ok(RunOutput, "run_reconciliation", { from: "2026-10-01", to: "2026-10-31" });
    for (const c of run.exposure_by_class) expect(c.total.amount_inr).toBe(formatINR(c.total.amount_paise));
    for (const t of run.exceptions.by_type) expect(t.total.amount_inr).toBe(formatINR(t.total.amount_paise));
    expect(run.exceptions.total_count).toBe(run.exceptions.by_type.reduce((s, t) => s + t.count, 0));
    expect(run.tie_out.unexplained_residual.amount_inr).toBe("₹0.00");
    expect(JSON.stringify(run)).not.toMatch(/total_exposure|grand_total/);
  });

  it("list_exceptions paginates 20 at a time with a cursor and keeps whole-set totals", async () => {
    const first = await ok(ListExceptionsOutput, "list_exceptions");
    expect(first.items).toHaveLength(20);
    expect(first.next_cursor).not.toBeNull();
    const second = await ok(ListExceptionsOutput, "list_exceptions", { cursor: first.next_cursor });
    expect(second.total).toEqual(first.total);
    expect(second.items.map((i) => i.exception_id)).not.toContain(first.items[0]?.exception_id);
    const amounts = [...first.items, ...second.items].map((i) => i.amount.amount_paise);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    // A cursor can't be replayed against different filters.
    await expect(call("list_exceptions", { type: "FEE_GST_MISMATCH", cursor: first.next_cursor })).resolves.toMatchObject({ isError: true });
  });

  it("get_evidence, explain_exception, draft_journal_entry and get_audit_trail return schema-valid output", async () => {
    const id = await firstOfType("FEE_GST_MISMATCH");
    const evidence = await ok(EvidenceOutput, "get_evidence", { exception_id: id });
    expect(evidence.records.length).toBeGreaterThan(0);
    const explained = await ok(ExplainOutput, "explain_exception", { exception_id: id });
    expect(explained).toMatchObject({ source: "deterministic_fallback", fallback_reason: "no_provider" });
    const draft = await ok(DraftOutput, "draft_journal_entry", { exception_id: id });
    expect(draft).toMatchObject({ applicable: true, status: "pending_approval" });
    expect(draft.total_debits).toEqual(draft.total_credits);
    const audit = await ok(AuditOutput, "get_audit_trail", { entity_id: id });
    expect(audit.items.map((e) => e.action)).toContain("investigation");
    await expect(call("get_evidence", { exception_id: "nope" })).resolves.toMatchObject({ isError: true });
  });

  it("decompose_bank_credit shows the settlement set with totals, or ranked candidate sets when ambiguous", async () => {
    const run = await ok(RunOutput, "run_reconciliation", { from: "2026-10-01", to: "2026-10-31" });
    expect(run.matched.bank_credits_batch_contiguous).toBeGreaterThan(0);
    const batch = await ok(DecomposeOutput, "decompose_bank_credit", { bank_line_id: "bnk_000080" });
    expect(batch).toMatchObject({ status: "decomposed", match_kind: "BATCH_CONTIGUOUS" });
    expect(batch.settlements_total).toEqual(batch.bank_line.credit);
    expect(batch.assumption).toMatch(/payout model/);
    expect(batch.full_search).toBe("unique"); // the exhaustive subset search agrees: no other set sums to it

    const ambiguous = await ok(ListExceptionsOutput, "list_exceptions", { type: "AMBIGUOUS_BATCH", limit: 1 });
    const line = ambiguous.items[0]?.primary.id;
    if (line) {
      const amb = await ok(DecomposeOutput, "decompose_bank_credit", { bank_line_id: line });
      expect(amb.status).toBe("ambiguous");
      for (const set of amb.candidate_sets) expect(set.matches_credit).toBe(true);
    }
  });

  it("serves the latest summary resource and the month_end_review prompt", async () => {
    const res = await client.readResource({ uri: "closeloop://summary/latest" });
    const first = res.contents[0];
    expect(RunOutput.safeParse(JSON.parse(first && "text" in first ? first.text : "")).success).toBe(true);

    const prompt = await client.getPrompt({ name: "month_end_review", arguments: { month: "2026-10" } });
    const msg = prompt.messages[0]?.content;
    const text = msg && msg.type === "text" ? msg.text : "";
    expect(text).toContain('run_reconciliation with from="2026-10-01" and to="2026-10-31"');
    expect(text).toContain("bnk_000080"); // the largest contiguous batch credit from DEMO.md
    expect(text).toContain("bnk_000236"); // the match conflict from DEMO.md
    expect(text).toMatch(/never add, subtract or convert amounts/);
  });
});

describe("two-step human actions", () => {
  it("approve_suggestion previews without changing anything, then executes with token + reviewer", async () => {
    const id = await firstOfType("SUGGESTED_MATCH");
    const before = financialHash();
    const preview = await ok(HumanActionOutput, "approve_suggestion", { id });
    expect(preview).toMatchObject({ step: "preview" });
    expect(preview.confirm_token).toBeTruthy();
    expect((await ok(ListExceptionsOutput, "list_exceptions", { type: "SUGGESTED_MATCH", status: "open" })).items.map((i) => i.exception_id)).toContain(id);

    const executed = await ok(HumanActionOutput, "approve_suggestion", { id, confirm_token: preview.confirm_token, reviewer: "Asha (AP lead)" });
    expect(executed.step).toBe("executed");
    const audit = await ok(AuditOutput, "get_audit_trail", { entity_id: id });
    expect(audit.items.find((e) => e.action === "approval")).toMatchObject({ actor: "human", payload: { reviewer: "Asha (AP lead)" } });
    expect(financialHash()).toBe(before);
  });

  it("refuses a missing reviewer without burning the token", async () => {
    const id = await firstOfType("SUGGESTED_MATCH");
    const { confirm_token } = await ok(HumanActionOutput, "approve_suggestion", { id });
    const missing = await call("approve_suggestion", { id, confirm_token });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toMatch(/reviewer is required/);
    const blank = await call("approve_suggestion", { id, confirm_token, reviewer: "   " });
    expect(blank.isError).toBe(true);
    await expect(ok(HumanActionOutput, "approve_suggestion", { id, confirm_token, reviewer: "Ravi" })).resolves.toMatchObject({ step: "executed" });
  });

  it("refuses a reused token", async () => {
    const id = await firstOfType("SUGGESTED_MATCH");
    const { confirm_token } = await ok(HumanActionOutput, "approve_suggestion", { id });
    await ok(HumanActionOutput, "approve_suggestion", { id, confirm_token, reviewer: "Ravi" });
    const again = await call("approve_suggestion", { id, confirm_token, reviewer: "Ravi" });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/already used/);
  });

  it("refuses an expired token", async () => {
    const id = await firstOfType("UNIDENTIFIED_BANK_CREDIT");
    const { confirm_token } = await ok(HumanActionOutput, "escalate", { id, note: "Asked HDFC for the remitter details" });
    now += CONFIRMATION_TTL_MS + 1_000;
    const late = await call("escalate", { id, confirm_token, reviewer: "Ravi" });
    expect(late.isError).toBe(true);
    expect(late.content[0]?.text).toMatch(/expired/);
    expect((await ok(ListExceptionsOutput, "list_exceptions", { type: "UNIDENTIFIED_BANK_CREDIT", status: "escalated" })).total_count).toBe(0);
  });

  it("escalate needs a note, then executes with token + reviewer", async () => {
    const id = await firstOfType("UNIDENTIFIED_BANK_CREDIT");
    await expect(call("escalate", { id })).resolves.toMatchObject({ isError: true });
    const { confirm_token } = await ok(HumanActionOutput, "escalate", { id, note: "Raised with Razorpay support" });
    await ok(HumanActionOutput, "escalate", { id, confirm_token, reviewer: "Ravi" });
    const escalated = await ok(ListExceptionsOutput, "list_exceptions", { type: "UNIDENTIFIED_BANK_CREDIT", status: "escalated" });
    expect(escalated.items.map((i) => i.exception_id)).toContain(id);
  });

  it("approving an ambiguous batch set re-evaluates leftovers, and a token can't be used for another exception", async () => {
    await ok(RunOutput, "run_reconciliation"); // full period: the demo's ambiguous credit falls in September
    const id = await firstOfType("AMBIGUOUS_BATCH");
    const other = await firstOfType("MATCH_CONFLICT");
    const { confirm_token } = await ok(HumanActionOutput, "approve_suggestion", { id, set_index: 0 });
    await expect(call("approve_suggestion", { id: other, confirm_token, reviewer: "Ravi" })).resolves.toMatchObject({ isError: true });
    const done = await ok(HumanActionOutput, "approve_suggestion", { id, confirm_token, reviewer: "Ravi" });
    expect(done.result).toMatchObject({ exception_id: id });
    expect(Array.isArray((done.result as { leftovers?: unknown }).leftovers)).toBe(true);
  });
});

describe("Razorpay recon report", () => {
  const report = buildSyntheticReconReport(generateDataset({ seed: DEMO_SEED, config: cfg }));
  const requests: { method: string | undefined; url: string }[] = [];
  /** Serves the synthetic report the way the recon and settlements endpoints would, recording every request. */
  const fakeRazorpay = ((url: string, init?: RequestInit) => {
    requests.push({ method: init?.method, url });
    const q = new URL(url).searchParams;
    const day = `${q.get("year")}-${String(q.get("month")).padStart(2, "0")}-${String(q.get("day")).padStart(2, "0")}`;
    const all = new URL(url).pathname.endsWith("/recon/combined") ? report.items.filter((i) => i.settled_at !== null && istDate(i.settled_at) === day) : [];
    const items = all.slice(Number(q.get("skip")), Number(q.get("skip")) + Number(q.get("count")));
    return Promise.resolve(new Response(JSON.stringify({ entity: "collection", count: items.length, items }), { status: 200 }));
  }) as unknown as typeof fetch;

  async function connect(razorpay: RazorpayReadOnlyClient | null) {
    const { db: own } = openDatabase(":memory:", cfg);
    const server = createCloseLoopServer({ db: own, cfg, provider: null, confirmations: new ConfirmationStore(), razorpay });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const cl = new Client({ name: "test", version: "0" });
    await cl.connect(c);
    const run = async <S extends z.ZodTypeAny>(schema: S, name: string, args: Record<string, unknown> = {}) => {
      const res = (await cl.callTool({ name, arguments: args })) as CallResult;
      if (res.isError) throw new Error(res.content[0]?.text);
      return schema.parse(res.structuredContent) as z.infer<S>;
    };
    return { own, run };
  }

  it("imports an export file, then matches batched credits from it without touching financial records", async () => {
    const { own, run } = await connect(null);
    const dir = mkdtempSync(join(tmpdir(), "closeloop-rzp-"));
    writeFileSync(join(dir, "recon.json"), JSON.stringify(report));
    writeFileSync(join(dir, "recon.csv"), reconItemsToCsv(report.items));
    const before = await run(RunOutput, "run_reconciliation", { from: "2026-10-01", to: "2026-10-31" });
    expect(before.gateway_report).toBeNull();
    expect(before.summary).toMatch(/import_razorpay_recon/);
    const financial = () => FINANCIAL_TABLES.map((t) => JSON.stringify(own.prepare(`SELECT * FROM ${t} ORDER BY id`).all())).join();
    const snapshot = financial();

    const imported = await run(ImportReconOutput, "import_razorpay_recon", { file_path: join(dir, "recon.json") });
    expect(imported).toMatchObject({ source: "file", synthetic: true, inserted: report.count, duplicates: 0, conflict_count: 0 });
    expect(imported.summary).toMatch(/^SYNTHETIC demo report/);
    expect((await run(ImportReconOutput, "import_razorpay_recon", { file_path: join(dir, "recon.csv") })).duplicates).toBe(report.count);
    expect(financial()).toBe(snapshot);

    const after = await run(RunOutput, "run_reconciliation", { from: "2026-10-01", to: "2026-10-31" });
    expect(after.matched.bank_credits_batch_gateway_report).toBeGreaterThan(0);
    expect(after.gateway_report).toMatchObject({ mismatches: 0 });
    expect(after.exceptions.by_type.find((t) => t.type === "MATCH_CONFLICT")).toBeUndefined();
    const line = (own.prepare("SELECT right_id FROM matches WHERE kind = 'BATCH_FROM_GATEWAY_REPORT' ORDER BY right_id LIMIT 1").get() as { right_id: string }).right_id;
    const d = await run(DecomposeOutput, "decompose_bank_credit", { bank_line_id: line });
    expect(d).toMatchObject({ status: "decomposed", match_kind: "BATCH_FROM_GATEWAY_REPORT", full_search: null, difference_vs_credit: { amount_paise: 0 } });
    expect(d.summary).toMatch(/recon report lists under UTR/);
  });

  it("fetches from the Razorpay API with GET requests only, when CloseLoop has its own keys", async () => {
    requests.length = 0;
    const { run } = await connect(new RazorpayReadOnlyClient({ keyId: "rzp_test_x", keySecret: "y" }, { fetch: fakeRazorpay }));
    const r = await run(ImportReconOutput, "import_razorpay_recon", { from: "2026-10-01", to: "2026-10-31" });
    expect(r).toMatchObject({ source: "api", synthetic: true });
    expect(r.inserted).toBe(report.items.filter((i) => i.settled_at !== null && istDate(i.settled_at) >= "2026-10-01").length);
    expect(r.origin).not.toMatch(/rzp_test_x/);
    expect(requests.length).toBeGreaterThan(31);
    expect(requests.every((q) => q.method === "GET")).toBe(true);
  });

  it("refuses an API fetch without keys, and ambiguous arguments", async () => {
    const { run } = await connect(null);
    await expect(run(ImportReconOutput, "import_razorpay_recon", { from: "2026-10-01", to: "2026-10-31" })).rejects.toThrow(/CLOSELOOP_RAZORPAY_KEY_ID/);
    await expect(run(ImportReconOutput, "import_razorpay_recon", { file_path: "/x.json", from: "2026-10-01", to: "2026-10-31" })).rejects.toThrow(/either file_path/);
  });
});

describe("stdio transport", () => {
  it("writes only JSON-RPC to stdout; logs go to stderr", async () => {
    const home = mkdtempSync(join(tmpdir(), "closeloop-mcp-"));
    const bin = fileURLToPath(new URL("../bin/dev.js", import.meta.url));
    // NODE_NO_WARNINGS is dropped so node:sqlite's ExperimentalWarning (where Node emits one) is really printed.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LLM_") && k !== "NODE_NO_WARNINGS"));
    const child = spawn(process.execPath, [bin], { cwd: home, env: { ...env, HOME: home, CLOSELOOP_DB: join(home, "closeloop.db") }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    // Only complete (newline-terminated) messages: a large response can arrive split across stdout chunks.
    const complete = () => stdout.split("\n").slice(0, -1).filter((l) => l.trim().length > 0);
    const responded = (id: number) => complete().some((l) => l.includes(`"id":${id}`));
    const waitFor = async (id: number) => {
      for (let i = 0; i < 300 && !responded(id); i++) await new Promise((r) => setTimeout(r, 100));
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "0" } } });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_reconciliation", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_evidence", arguments: { exception_id: "missing" } } });
    await waitFor(4);
    await waitFor(3);
    child.kill();

    const lines = complete();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    expect(stderr).toMatch(/seeding demo data/);
    expect(stderr).toMatch(/ready/);
    expect(stdout).not.toMatch(/seeding|\[closeloop-mcp\]/);
    expect(stdout).not.toMatch(/ExperimentalWarning|experimental feature/);
  }, 60_000);
});
