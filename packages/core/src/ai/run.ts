import type { CloseLoopConfig } from "../config.ts";
import type { Db } from "../db/open.ts";
import { datasetMeta, loadSource } from "../matcher/load.ts";
import { runReconciliation, type RunOptions } from "../matcher/run.ts";
import { narrationHints } from "./narration.ts";
import type { LLMProvider } from "./provider.ts";

/**
 * Reconcile with AI narration parsing. The model only contributes grounded candidate tokens for
 * fuzzy matching; every decision is still made by the deterministic engine.
 */
export async function runReconciliationWithAI(db: Db, cfg: CloseLoopConfig, opts: Omit<RunOptions, "source" | "extraTokens" | "aiUsage">, provider: LLMProvider | null) {
  const to = opts.to ?? datasetMeta(db).as_of;
  if (!to) throw new Error("Database has no dataset metadata; generate data first (pnpm gen).");
  const source = loadSource(db, to);
  const { tokens, usage } = await narrationHints(db, source, provider, cfg);
  return runReconciliation(db, cfg, {
    ...opts,
    to,
    source,
    extraTokens: tokens,
    aiUsage: { provider: provider?.name ?? null, model: provider?.model ?? null, narration_parsing: usage },
  });
}
