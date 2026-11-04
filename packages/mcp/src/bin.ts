import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSyntheticReconReport,
  defaultDbPath,
  reconReportJson,
  generateDataset,
  loadConfig,
  loadDataset,
  loadEnvFile,
  openReconDb,
  openTruthDb,
  providerFromEnv,
  razorpayCredentialsFromEnv,
  RazorpayReadOnlyClient,
  reconItemsToCsv,
  runReconciliationWithAI,
  truthDbPathFor,
  type CloseLoopConfig,
} from "@closeloop/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEMO_SEED, openDatabase } from "./bootstrap.ts";
import { ConfirmationStore } from "./confirm.ts";
import { log } from "./log.ts";
import { createCloseLoopServer, runOutput } from "./server.ts";

const USAGE = `closeloop-mcp            start the MCP server on stdio
closeloop-mcp check      seed if empty, run one reconciliation, print the summary to stderr, exit
closeloop-mcp seed PATH  write the demo dataset as a standalone source DB (for CLOSELOOP_SOURCE_DB)
closeloop-mcp demo-report PATH  write a SYNTHETIC Razorpay settlement recon report (.json or .csv) for the
                         demo dataset, in the documented recon/combined format, for import_razorpay_recon

Environment: CLOSELOOP_DB (state DB, default ~/.closeloop/closeloop.db), CLOSELOOP_SOURCE_DB (read-only
financial data), LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_REASONING_EFFORT (optional),
CLOSELOOP_RAZORPAY_KEY_ID / CLOSELOOP_RAZORPAY_KEY_SECRET (optional; read-only recon fetching, GET only).`;

// Installed from npm, the default config ships next to the bundle (dist/../config). In the repo, core's
// own default (the repo's config/) applies. CLOSELOOP_CONFIG_DIR always wins.
const packagedConfig = fileURLToPath(new URL("../config/", import.meta.url));
if (!process.env.CLOSELOOP_CONFIG_DIR && existsSync(join(packagedConfig, "matching.json"))) process.env.CLOSELOOP_CONFIG_DIR = packagedConfig;

function openState(cfg: CloseLoopConfig) {
  const path = defaultDbPath();
  const source = process.env.CLOSELOOP_SOURCE_DB;
  if (source) {
    log(`state ${path} · source ${source} (attached read-only)`);
    return { db: openReconDb(path, { sourcePath: source }), path };
  }
  return { db: openDatabase(path, cfg).db, path };
}

/** Write the demo dataset as a standalone source DB, as a customer's data export would be. */
function seed(path: string, cfg: CloseLoopConfig): void {
  if (existsSync(path)) {
    log(`${path} already exists; leaving it untouched`);
    return;
  }
  const truthPath = truthDbPathFor(path);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(truthPath + suffix, { force: true });
  const db = openReconDb(path);
  const truth = openTruthDb(truthPath);
  const ds = generateDataset({ seed: DEMO_SEED, config: cfg });
  loadDataset(db, truth, ds);
  // Rollback-journal mode so the file stays readable from a read-only mount.
  db.pragma("journal_mode = DELETE");
  db.close();
  truth.close();
  log(`wrote demo source DB ${path} (${ds.payments.length} payments, ${ds.settlements.length} settlements)`);
}

/** The demo dataset's settlements as Razorpay would report them. Synthetic, and labelled so in every row. */
function demoReport(path: string, cfg: CloseLoopConfig): void {
  const report = buildSyntheticReconReport(generateDataset({ seed: DEMO_SEED, config: cfg }));
  const body = /\.csv$/i.test(path) ? reconItemsToCsv(report.items) : reconReportJson(report);
  writeFileSync(path, body);
  log(`wrote SYNTHETIC Razorpay recon report ${path} (${report.count} rows, demo seed ${DEMO_SEED}); import it with import_razorpay_recon`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  // Claude Desktop starts servers from an arbitrary working directory, so also read ~/.closeloop/.env.
  loadEnvFile(join(homedir(), ".closeloop", ".env"));
  loadEnvFile(".env");
  const cfg = loadConfig();

  if (command === "--help" || command === "-h") return log(`\n${USAGE}`);
  if (command === "seed") {
    if (!arg) throw new Error("usage: closeloop-mcp seed PATH");
    return seed(arg, cfg);
  }
  if (command === "demo-report") {
    if (!arg) throw new Error("usage: closeloop-mcp demo-report PATH(.json|.csv)");
    return demoReport(arg, cfg);
  }
  if (command && command !== "check") throw new Error(`unknown command "${command}"\n${USAGE}`);

  const provider = providerFromEnv(process.env, cfg.ai.timeout_ms);
  const { db, path } = openState(cfg);

  if (command === "check") {
    const { summary } = await runReconciliationWithAI(db, cfg, {}, provider);
    log(runOutput(summary, provider ? `LLM ${provider.model}` : "no LLM").summary);
    db.close();
    return;
  }

  const creds = razorpayCredentialsFromEnv(process.env);
  const razorpay = creds ? new RazorpayReadOnlyClient(creds, { reconPageSize: cfg.gateway.razorpay.recon_page_size }) : null;
  const server = createCloseLoopServer({ db, cfg, provider, confirmations: new ConfirmationStore(), razorpay });
  await server.connect(new StdioServerTransport());
  const network = [provider ? `LLM ${provider.model}` : null, razorpay ? "Razorpay API read-only (GET recon/settlements)" : null].filter(Boolean);
  log(`ready · db ${path} · ${network.length ? network.join(" · ") : "no LLM, no gateway API (deterministic only, no outbound network calls)"}`);
  const shutdown = () => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log("fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
