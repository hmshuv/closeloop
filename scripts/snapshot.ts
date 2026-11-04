/**
 * pnpm snapshot [--no-llm] [--pace-ms 20000] [--top 20] [--repo-url https://github.com/you/closeloop]
 * pnpm snapshot --refresh-batches   (re-record only the deterministic batch decompositions; no LLM calls)
 *
 * Seeds the demo dataset, runs the October reconciliation and records the real MCP tool outputs into
 * apps/dashboard/data/snapshot.json for the read-only dashboard. LLM explanations (from .env) are generated
 * only for the DEMO.md cases and the top exceptions by amount; everything else gets the deterministic
 * explanation, and every explanation is labelled with its source. No secrets are written.
 * It also records the same demo month with a SYNTHETIC gateway recon report imported (gateway_report), for the
 * "Gateway report vs amount-only" comparison and the report-mode batch decompositions.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildSyntheticReconReport, generateDataset, loadConfig, loadEnvFile, providerFromEnv, showcaseCases, type Db } from "@closeloop/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEMO_SEED, openDatabase } from "closeloop-mcp/src/bootstrap.ts";
import { ConfirmationStore } from "closeloop-mcp/src/confirm.ts";
import { createCloseLoopServer } from "closeloop-mcp/src/server.ts";

const FROM = "2026-10-01";
const TO = "2026-10-31";
const OUT = "apps/dashboard/data/snapshot.json";
const RETRYABLE = new Set(["rate_limited", "timeout", "network", "http_429", "http_503"]);

loadEnvFile();
const { values } = parseArgs({
  options: { "refresh-batches": { type: "boolean", default: false }, "no-llm": { type: "boolean", default: false }, "pace-ms": { type: "string", default: "20000" }, top: { type: "string", default: "20" }, "repo-url": { type: "string" } },
});
const cfg = loadConfig();
const provider = values["no-llm"] ? null : providerFromEnv(process.env, cfg.ai.timeout_ms);
const paceMs = Number(values["pace-ms"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.error("[snapshot]", ...a);

/**
 * The public dashboard must not show any real company's name. The synthetic data imitates a real gateway's
 * narrations and ledger party, so gateway names are replaced with a neutral "Gateway" for display. Ids,
 * amounts and match results are untouched; the engine itself ran on the original synthetic text.
 */
const REDACTIONS: [RegExp, string][] = [
  [/RAZORPAY SOFTWARE PVT LTD/g, "GATEWAY SETTLEMENTS PVT LTD"],
  [/RAZORPAY SOFTWARE/g, "GATEWAY SETTLEMENTS"],
  [/RAZORPAY SOFTW/g, "GATEWAY SETTL"],
  [/Razorpay Software Pvt Ltd/g, "Gateway Settlements Pvt Ltd"],
  [/Razorpay-style/g, "gateway"],
  [/RZP PAYOUTS/g, "PGW PAYOUTS"],
  [/\bRZPY\b/g, "PGW"],
  [/\bRZP\b/g, "PGW"],
  [/RAZORPAY/g, "GATEWAY"],
  [/Razorpay/g, "Gateway"],
  [/razorpay/g, "gateway"],
];
const redact = (text: string) => REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);

async function connect(db: Db, withLlm: boolean): Promise<Client> {
  const server = createCloseLoopServer({ db, cfg, provider: withLlm ? provider : null, confirmations: new ConfirmationStore() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "snapshot", version: "0" });
  await client.connect(a);
  return client;
}

type Structured = Record<string, unknown>;
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: Structured; isError?: boolean; content: { text: string }[] };
  if (res.isError || !res.structuredContent) throw new Error(`${name} failed: ${res.content[0]?.text}`);
  return res.structuredContent;
}

function repoUrl(): string | null {
  if (values["repo-url"]) return values["repo-url"];
  if (process.env.CLOSELOOP_REPO_URL) return process.env.CLOSELOOP_REPO_URL;
  try {
    const raw = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return raw.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

const started = Date.now();
const readEval = (): unknown => (existsSync("EVAL.json") ? JSON.parse(readFileSync("EVAL.json", "utf8")) : null);

/**
 * The same demo data reconciled twice in a fresh DB, through the real MCP tools: amount-only, then after
 * import_razorpay_recon with a SYNTHETIC recon report built from the demo dataset. Counts cover every open item
 * as of the end date (not just October), so a still-open September ambiguity counts too.
 */
async function gatewaySection(lines: readonly string[]): Promise<Structured> {
  const { db: gdb } = openDatabase(":memory:", cfg);
  const client = await connect(gdb, false);
  const tally = (runId: string) => {
    const count = (type: string) => (gdb.prepare("SELECT COUNT(*) AS n FROM exceptions WHERE run_id = ? AND type = ?").get(runId, type) as { n: number }).n;
    const credits = (kind: string) => (gdb.prepare("SELECT COUNT(DISTINCT right_id) AS n FROM matches WHERE run_id = ? AND kind = ?").get(runId, kind) as { n: number }).n;
    return {
      batch_credits: { contiguous: credits("BATCH_CONTIGUOUS"), subset: credits("BATCH"), gateway_report: credits("BATCH_FROM_GATEWAY_REPORT") },
      ambiguous_batch: count("AMBIGUOUS_BATCH"),
      match_conflict: count("MATCH_CONFLICT"),
      suggested_match: count("SUGGESTED_MATCH"),
      gateway_report_mismatch: count("GATEWAY_REPORT_MISMATCH"),
      unidentified_bank_credit: count("UNIDENTIFIED_BANK_CREDIT"),
      missing_bank_credit: count("MISSING_BANK_CREDIT"),
      unresolved_in_batch: (gdb.prepare("SELECT COUNT(DISTINCT settlement_id) AS n FROM settlement_reviews WHERE run_id = ?").get(runId) as { n: number }).n,
    };
  };
  const amountOnly = await call(client, "run_reconciliation", { from: FROM, to: TO });
  const file = join(mkdtempSync(join(tmpdir(), "closeloop-snapshot-")), "recon.synthetic.json");
  writeFileSync(file, JSON.stringify(buildSyntheticReconReport(generateDataset({ seed: DEMO_SEED, config: cfg }))));
  const imported = await call(client, "import_razorpay_recon", { file_path: file });
  if (imported.synthetic !== true) throw new Error("demo recon report is not labelled synthetic");
  const withReport = await call(client, "run_reconciliation", { from: FROM, to: TO });
  const reportLines = (gdb.prepare("SELECT DISTINCT right_id FROM matches WHERE run_id = ? AND kind = 'BATCH_FROM_GATEWAY_REPORT' AND anchor_date BETWEEN ? AND ? ORDER BY right_id").all(withReport.run_id, FROM, TO) as { right_id: string }[]).map((r) => r.right_id);
  const batches: Structured[] = [];
  for (const line of [...new Set([...lines, ...reportLines])]) batches.push(await call(client, "decompose_bank_credit", { bank_line_id: line }));
  return {
    synthetic: true,
    note: "SYNTHETIC recon report generated from the demo dataset in the gateway's documented settlement recon format; it agrees with the bank by construction.",
    as_of: TO,
    import: { rows: imported.rows_read, settlements_covered: imported.settlements_covered, payout_utrs: imported.payout_utrs },
    amount_only: tally(String(amountOnly.run_id)),
    with_report: tally(String(withReport.run_id)),
    batches,
  };
}

/**
 * --refresh-batches: re-run the deterministic engine and re-record only the batch decompositions, keeping the
 * existing explanations (and their audit history) untouched. Same seed + same engine must reproduce the same
 * decompositions; anything other than new fields is treated as drift and aborts.
 */
if (values["refresh-batches"]) {
  const existing = JSON.parse(readFileSync(OUT, "utf8")) as { batches: Structured[]; [k: string]: unknown };
  const { db } = openDatabase(":memory:", cfg);
  const client = await connect(db, false);
  await call(client, "run_reconciliation", { from: FROM, to: TO });
  const shape = (b: Structured) =>
    JSON.stringify({
      line: (b.bank_line as Structured).id,
      status: b.status,
      kind: b.match_kind,
      settlements: (b.settlements as Structured[]).map((x) => x.settlement_id).sort(),
      sets: (b.candidate_sets as Structured[]).map((c) => (c.settlement_ids as string[]).slice().sort()),
    });
  const refreshed: Structured[] = [];
  for (const old of existing.batches) {
    const line = String((old.bank_line as Structured).id);
    const fresh = await call(client, "decompose_bank_credit", { bank_line_id: line });
    if (shape(fresh) !== shape(old)) throw new Error(`Batch ${line} differs from the committed snapshot; run a full \`pnpm snapshot\` instead.\n  committed: ${shape(old)}\n  fresh:     ${shape(fresh)}`);
    // Keep the committed run and exception ids so links to the existing explanations stay valid.
    let text = JSON.stringify(fresh);
    if (typeof fresh.exception_id === "string" && typeof old.exception_id === "string") text = text.replaceAll(fresh.exception_id, old.exception_id);
    text = text.replaceAll(String(fresh.run_id), String(old.run_id));
    refreshed.push(JSON.parse(text) as Structured);
  }
  let sha: string | null = null;
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  const gateway_report = await gatewaySection(refreshed.map((b) => String((b.bank_line as Structured).id)));
  const out = redact(JSON.stringify({ ...existing, batches: refreshed, gateway_report, eval: readEval() ?? existing.eval, batches_refreshed_at: new Date().toISOString(), batches_refreshed_from_commit: sha }));
  if (/razorpay|\brzpy?\b/i.test(out) || /gsk_|sk-[A-Za-z0-9]{10}|LLM_API_KEY|Bearer /.test(out)) throw new Error("Refusing to write: real gateway name or secret-like text");
  writeFileSync(OUT, out + "\n");
  log(`refreshed ${refreshed.length} batch decompositions, the gateway-report comparison and the eval headline in ${OUT}; explanations untouched`);
  process.exit(0);
}
const { db } = openDatabase(":memory:", cfg);
const llmClient = await connect(db, true);
const plainClient = await connect(db, false);

log(`LLM: ${provider ? provider.model : "none (deterministic only)"}`);
const summary = await call(llmClient, "run_reconciliation", { from: FROM, to: TO });
const runId = String(summary.run_id);

// Every October exception, largest first (paginated tool output).
const exceptions: Structured[] = [];
for (let cursor: string | null = null; ; ) {
  const page = await call(plainClient, "list_exceptions", { limit: 100, ...(cursor ? { cursor } : {}) });
  exceptions.push(...(page.items as Structured[]));
  cursor = (page.next_cursor as string | null) ?? null;
  if (!cursor) break;
}
const showcase = showcaseCases(db, runId, FROM, TO);

// Open batch exceptions from earlier dates are still unresolved as of 31 Oct; the batch page shows them too.
const ambiguous = db.prepare("SELECT id, primary_id FROM exceptions WHERE run_id = ? AND type = 'AMBIGUOUS_BATCH' ORDER BY amount_paise DESC").all(runId) as { id: string; primary_id: string }[];
const conflictTrace = showcase.matchConflict
  ? (JSON.parse((db.prepare("SELECT trace_json FROM exceptions WHERE id = ?").get(showcase.matchConflict.exception_id) as { trace_json: string }).trace_json) as { suggested_on_bank_lines?: string[] })
  : {};
const decoyIds = (conflictTrace.suggested_on_bank_lines ?? []).flatMap((line) =>
  (db.prepare("SELECT id FROM exceptions WHERE run_id = ? AND primary_id = ? AND type = 'SUGGESTED_MATCH'").all(runId, line) as { id: string }[]).map((r) => r.id),
);

const llmTargets = [
  ...(showcase.matchConflict ? [showcase.matchConflict.exception_id] : []),
  ...decoyIds,
  ...ambiguous.map((a) => a.id),
  ...exceptions.slice(0, Number(values.top)).map((e) => String(e.exception_id)),
].filter((id, i, all) => all.indexOf(id) === i);
const detailIds = [...exceptions.map((e) => String(e.exception_id)), ...ambiguous.map((a) => a.id)].filter((id, i, all) => all.indexOf(id) === i);

const details: Record<string, Structured> = {};
let llmOk = 0;
let llmFallback = 0;
for (const id of detailIds) {
  const wantLlm = Boolean(provider) && llmTargets.includes(id);
  const reasonOf = (e: Structured) => (typeof e.fallback_reason === "string" ? e.fallback_reason : null);
  let explanation = await call(wantLlm ? llmClient : plainClient, "explain_exception", { exception_id: id });
  if (wantLlm && explanation.source !== "llm" && RETRYABLE.has(reasonOf(explanation) ?? "")) {
    log(`${id}: ${reasonOf(explanation)}, waiting 60 s and retrying once`);
    await sleep(60_000);
    explanation = await call(llmClient, "explain_exception", { exception_id: id });
  }
  if (wantLlm) {
    if (explanation.source === "llm") llmOk++;
    else llmFallback++;
    log(`${id}: ${explanation.source === "llm" ? "llm" : `fallback (${reasonOf(explanation)})`}`);
    await sleep(paceMs); // free tiers allow only a few thousand tokens per minute
  }
  const draft = await call(plainClient, "draft_journal_entry", { exception_id: id });
  // Evidence last, so its audit history includes the investigation and the draft above.
  const evidence = await call(plainClient, "get_evidence", { exception_id: id });
  details[id] = { evidence, explanation: { ...explanation, llm_requested: wantLlm }, draft: draft.applicable ? draft : null };
}

// Batch decompositions: every batch-matched credit in October, plus the ambiguous and conflict credits.
const batchLines = new Set<string>([
  ...(showcase.largestContiguousBatch ? [showcase.largestContiguousBatch.bank_line_id] : []),
  ...(db
    .prepare("SELECT DISTINCT right_id FROM matches WHERE run_id = ? AND kind IN ('BATCH','BATCH_CONTIGUOUS') AND anchor_date BETWEEN ? AND ? ORDER BY right_id")
    .all(runId, FROM, TO) as { right_id: string }[]).map((r) => r.right_id),
  ...ambiguous.map((a) => a.primary_id),
  ...(showcase.matchConflict ? [showcase.matchConflict.bank_line_id] : []),
]);
const batches: Structured[] = [];
for (const line of batchLines) batches.push(await call(plainClient, "decompose_bank_credit", { bank_line_id: line }));

const evalJson = readEval();
const gateway_report = await gatewaySection([...batchLines]);
let commit: string | null = null;
try {
  const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const dirty = execSync("git status --porcelain --untracked-files=no -- packages scripts config", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
  commit = dirty ? `${sha}-dirty` : sha;
} catch {
  /* not a git checkout */
}

const snapshot = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  commit,
  repo_url: repoUrl(),
  dataset: { seed: 42, payments: cfg.generator.default_payments, period_start: cfg.generator.period_start, synthetic: true },
  period: { from: FROM, to: TO },
  llm: {
    model: provider?.model ?? null,
    requested: provider ? llmTargets.length : 0,
    llm: llmOk,
    fallback_after_request: llmFallback,
    note: provider
      ? `LLM explanations were requested for the DEMO.md cases and the top ${values.top} exceptions by amount; all other explanations are deterministic templates.`
      : "No LLM was configured when this snapshot was generated; every explanation is a deterministic template.",
  },
  summary,
  exceptions,
  details,
  showcase,
  batches,
  default_batch_line: showcase.largestContiguousBatch?.bank_line_id ?? null,
  gateway_report,
  eval: evalJson,
};


mkdirSync("apps/dashboard/data", { recursive: true });
const text = redact(JSON.stringify(snapshot));
if (/razorpay|\brzpy?\b/i.test(text)) throw new Error("Snapshot still contains a real gateway name after redaction");
if (/gsk_|sk-[A-Za-z0-9]{10}|LLM_API_KEY|Bearer /.test(text)) throw new Error("Refusing to write a snapshot that looks like it contains a secret");
writeFileSync(OUT, text + "\n");
log(`wrote ${OUT} (${(text.length / 1024).toFixed(0)} KB): ${exceptions.length} exceptions, ${batches.length} batch credits, LLM ${llmOk}/${provider ? llmTargets.length : 0} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(0);
