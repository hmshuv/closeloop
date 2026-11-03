import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloseLoopConfig } from "../config.ts";
import type { Db } from "../db/open.ts";
import { groundedTokens, normalizeUtrText, utrCandidateTokens } from "../matcher/similarity.ts";
import type { SourceData } from "../matcher/types.ts";
import type { FallbackReason, LLMProvider, Source } from "./provider.ts";
import { callStructured } from "./structured.ts";
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from "./untrusted.ts";

export const NarrationFieldsSchema = z.object({
  utr: z.string().max(40).nullish(),
  counterparty: z.string().max(120).nullish(),
  channel: z.enum(["NEFT", "RTGS", "IMPS", "UPI", "OTHER"]).nullish(),
  reference: z.string().max(60).nullish(),
});
export type NarrationFields = z.infer<typeof NarrationFieldsSchema>;

export type NarrationParse = NarrationFields & { source: Source; fallback_reason: FallbackReason | null; model: string | null };

/** Regex-only parse, used whenever the model is unavailable or its output is rejected. */
export function deterministicNarrationParse(narration: string): NarrationFields {
  const upper = narration.toUpperCase();
  const channel = /\b(NEFT|RTGS|IMPS|UPI)\b/.exec(upper)?.[1] as NarrationFields["channel"] | undefined;
  const counterparty = /(RAZORPAY[A-Z ]*|RZPY|RZP PAYOUTS)/.exec(upper)?.[1]?.trim() ?? null;
  const tokens = utrCandidateTokens(narration, 10, 22);
  const utr = tokens.find((t) => /^[A-Z]{4}[NR]\d{8,}$/.test(t)) ?? tokens.sort((a, b) => b.length - a.length)[0] ?? null;
  return { utr, counterparty, channel: channel ?? null, reference: null };
}

const SYSTEM = [
  "You extract fields from Indian bank statement narrations.",
  UNTRUSTED_PREAMBLE,
  'Respond with one JSON object with keys "utr", "counterparty", "channel", "reference" (null when absent).',
  "channel is one of NEFT, RTGS, IMPS, UPI, OTHER. Copy values exactly as they appear in the narration; never invent or correct them.",
].join(" ");

export async function parseNarration(narration: string, provider: LLMProvider | null, maxTokens = 600): Promise<NarrationParse> {
  const res = await callStructured(provider, { system: SYSTEM, user: `Parse this bank narration:\n${wrapUntrusted("bank_narration", narration)}`, maxTokens }, NarrationFieldsSchema);
  if (res.ok) return { ...res.value, source: "llm", fallback_reason: null, model: res.model };
  return { ...deterministicNarrationParse(narration), source: "deterministic_fallback", fallback_reason: res.reason, model: null };
}

export interface NarrationUsage {
  candidates: number;
  llm: number;
  cached: number;
  fallback: Record<string, number>;
  hints_offered: number;
  hints_grounded: number;
  /** Candidates not sent to the model because the per-run call budget was spent. */
  skipped_over_budget: number;
}

/**
 * For bank credits with no exact UTR in their narration, ask the AI layer for UTR/reference tokens.
 * Returns only grounded tokens (present in the narration text). They become extra *candidates* for the
 * deterministic fuzzy scorer; they cannot create a match on their own. Results are cached by narration hash.
 */
export async function narrationHints(
  db: Db | null,
  src: SourceData,
  provider: LLMProvider | null,
  cfg: CloseLoopConfig,
): Promise<{ tokens: Map<string, string[]>; usage: NarrationUsage }> {
  const { concurrency, max_calls_per_run: budget, max_tokens: maxTokens } = cfg.ai.narration;
  const f = cfg.matching.fuzzy;
  const utrs = new Set(src.settlements.map((s) => normalizeUtrText(s.utr)));
  const lengths = [...new Set([...utrs].map((u) => u.length))];
  const hasExact = (narration: string) => {
    const text = normalizeUtrText(narration);
    return lengths.some((len) => Array.from({ length: Math.max(0, text.length - len + 1) }, (_, i) => text.slice(i, i + len)).some((t) => utrs.has(t)));
  };
  const candidates = src.bankLines.filter((l) => l.credit_paise > 0 && !hasExact(l.narration));
  const usage: NarrationUsage = { candidates: candidates.length, llm: 0, cached: 0, fallback: {}, hints_offered: 0, hints_grounded: 0, skipped_over_budget: 0 };
  let calls = 0;
  const tokens = new Map<string, string[]>();
  if (!provider) {
    // Nothing to ask: record the reason once instead of once per narration.
    if (candidates.length > 0) usage.fallback.no_provider = candidates.length;
    return { tokens, usage };
  }

  const cacheGet = db?.prepare("SELECT payload_json FROM ai_outputs WHERE kind = 'narration_parse' AND key = ? AND source = 'llm' LIMIT 1");
  const cachePut = db?.prepare(
    "INSERT INTO ai_outputs (id, kind, key, source, fallback_reason, model, payload_json, created_at) VALUES (?, 'narration_parse', ?, ?, ?, ?, ?, ?)",
  );
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const line = candidates[next++];
      if (!line) break;
      const key = createHash("sha256").update(line.narration).digest("hex");
      const hit = cacheGet?.get(key) as { payload_json: string } | undefined;
      let parsed: NarrationParse;
      if (hit) {
        usage.cached++;
        parsed = { ...NarrationFieldsSchema.parse(JSON.parse(hit.payload_json)), source: "llm", fallback_reason: null, model: null };
      } else {
        if (calls >= budget) {
          usage.skipped_over_budget++;
          continue;
        }
        calls++;
        parsed = await parseNarration(line.narration, provider, maxTokens);
        cachePut?.run(randomUUID(), key, parsed.source, parsed.fallback_reason, parsed.model, JSON.stringify(NarrationFieldsSchema.parse(parsed)), new Date().toISOString());
      }
      if (parsed.source === "llm") {
        if (!hit) usage.llm++;
        const offered = [parsed.utr, parsed.reference].filter((t): t is string => typeof t === "string" && t.length > 0);
        const grounded = groundedTokens(line.narration, offered, f.min_token_length, f.max_token_length);
        usage.hints_offered += offered.length;
        usage.hints_grounded += grounded.length;
        if (grounded.length > 0) tokens.set(line.id, grounded);
      } else {
        const reason = parsed.fallback_reason ?? "unknown";
        usage.fallback[reason] = (usage.fallback[reason] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { tokens, usage };
}
