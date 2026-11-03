import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BankCalendar } from "./calendar.ts";
import { PaiseSchema } from "./money.ts";
import { IsoDateSchema, NoiseKindSchema, type PaymentMethod } from "./types.ts";

const perMethod = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ upi: schema, card: schema, netbanking: schema, wallet: schema });

const Rate = z.number().min(0).max(1);
const IntRange = z.tuple([z.number().int().positive(), z.number().int().positive()]);

export const WindowsConfigSchema = z.object({
  settlement_windows_business_days: perMethod(z.number().int().nonnegative()),
  calendar: z.object({
    note: z.string().optional(),
    second_and_fourth_saturday_off: z.boolean(),
    holidays: z.array(z.object({ date: IsoDateSchema, name: z.string() })),
  }),
});

export const FeesConfigSchema = z.object({
  note: z.string().optional(),
  gateway_fee_bps: perMethod(z.number().int().nonnegative()),
  gst_bps: z.number().int().nonnegative(),
});

export const MatchingConfigSchema = z.object({
  batch: z.object({
    window_business_days: z.number().int().positive(),
    time_budget_ms: z.number().int().positive(),
    node_budget: z.number().int().positive(),
    mitm_max_n: z.number().int().positive().max(40),
    max_candidate_sets: z.number().int().positive(),
    max_passes: z.number().int().positive(),
    /** A one-settlement "batch" auto-matches only if the narration names the gateway (case-insensitive substring). */
    single_settlement_gateway_patterns: z.array(z.string().min(2)),
  }),
  amount_mismatch_rounding_threshold_paise: PaiseSchema.nonnegative(),
  fuzzy: z.object({
    date_tolerance_business_days: z.number().int().nonnegative(),
    min_token_length: z.number().int().positive(),
    max_token_length: z.number().int().positive(),
    min_truncated_length: z.number().int().positive(),
    auto_max_distance: z.number().int().nonnegative(),
    suggest_max_distance: z.number().int().nonnegative(),
    margin: z.number().min(0).max(1),
    max_candidates_shown: z.number().int().positive(),
  }),
  ledger: z.object({
    date_tolerance_business_days: z.number().int().nonnegative(),
    receipt_grace_business_days: z.number().int().nonnegative(),
    party_aliases: z.record(z.string(), z.array(z.string().min(2))),
  }),
});

export const GeneratorConfigSchema = z.object({
  period_start: IsoDateSchema,
  days: z.number().int().positive(),
  heldout_share: z.number().gt(0).lt(1),
  default_payments: z.number().int().positive(),
  eval_payments: z.number().int().positive(),
  /** Fixed up front; eval consumes them in order and may stop early only on truth-label coverage. */
  eval_seeds: z.array(z.number().int().nonnegative()).min(1),
  heldout_min_per_type: z.number().int().nonnegative(),
  settlement_chunk_target: z.number().int().positive(),
  method_mix: perMethod(z.number().nonnegative()),
  failed_payment_rate: Rate,
  refund_rate: Rate,
  partial_refund_share: Rate,
  opening_balance_paise: PaiseSchema.positive(),
  consolidation: z.object({
    settlement_share: Rate,
    small_size: IntRange,
    large_size: IntRange,
    large_share: Rate,
    /** Share of consolidations whose members are not consecutive in time. */
    non_contiguous_share: Rate,
  }),
  noise_rates: z.record(NoiseKindSchema, Rate),
});

export const AiConfigSchema = z.object({
  note: z.string().optional(),
  timeout_ms: z.number().int().positive(),
  narration: z.object({ max_calls_per_run: z.number().int().nonnegative(), concurrency: z.number().int().positive(), max_tokens: z.number().int().positive() }),
  explanation: z.object({ max_tokens: z.number().int().positive() }),
  journal: z.object({ max_tokens: z.number().int().positive() }),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type WindowsConfig = z.infer<typeof WindowsConfigSchema>;
export type FeesConfig = z.infer<typeof FeesConfigSchema>;
export type MatchingConfig = z.infer<typeof MatchingConfigSchema>;
export type GeneratorConfig = z.infer<typeof GeneratorConfigSchema>;

export interface CloseLoopConfig {
  windows: WindowsConfig;
  fees: FeesConfig;
  matching: MatchingConfig;
  generator: GeneratorConfig;
  ai: AiConfig;
  calendar: BankCalendar;
}

/** Repo-level `config/` directory; override with CLOSELOOP_CONFIG_DIR. */
export function defaultConfigDir(): string {
  return process.env.CLOSELOOP_CONFIG_DIR ?? fileURLToPath(new URL("../../../config/", import.meta.url));
}

function readJson<T extends z.ZodTypeAny>(dir: string, file: string, schema: T): z.infer<T> {
  const path = join(dir, file);
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid config ${path}: ${parsed.error.message}`);
  return parsed.data as z.infer<T>;
}

export function loadConfig(dir: string = defaultConfigDir()): CloseLoopConfig {
  const windows = readJson(dir, "windows.json", WindowsConfigSchema);
  return {
    windows,
    fees: readJson(dir, "fees.json", FeesConfigSchema),
    matching: readJson(dir, "matching.json", MatchingConfigSchema),
    generator: readJson(dir, "generator.json", GeneratorConfigSchema),
    ai: readJson(dir, "ai.json", AiConfigSchema),
    calendar: {
      secondAndFourthSaturdayOff: windows.calendar.second_and_fourth_saturday_off,
      holidays: new Set(windows.calendar.holidays.map((h) => h.date)),
    },
  };
}

export function settlementWindow(cfg: CloseLoopConfig, method: PaymentMethod): number {
  return cfg.windows.settlement_windows_business_days[method];
}

/** Loads `.env` from the working directory if present (Node built-in; no dotenv dependency). */
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
