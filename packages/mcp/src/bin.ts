import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, loadConfig, loadEnvFile, providerFromEnv } from "@closeloop/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./bootstrap.ts";
import { ConfirmationStore } from "./confirm.ts";
import { log } from "./log.ts";
import { createCloseLoopServer } from "./server.ts";

async function main(): Promise<void> {
  // Claude Desktop starts servers from an arbitrary working directory, so also read ~/.closeloop/.env.
  loadEnvFile(join(homedir(), ".closeloop", ".env"));
  loadEnvFile(".env");
  const cfg = loadConfig();
  const path = defaultDbPath();
  const { db } = openDatabase(path, cfg);
  const provider = providerFromEnv(process.env, cfg.ai.timeout_ms);
  const server = createCloseLoopServer({ db, cfg, provider, confirmations: new ConfirmationStore() });
  await server.connect(new StdioServerTransport());
  log(`ready · db ${path} · ${provider ? `LLM ${provider.model}` : "no LLM (deterministic only)"}`);
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
