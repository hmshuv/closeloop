import type { z } from "zod";
import { extractJsonObject } from "./json.ts";
import { LLMError, type FallbackReason, type LLMProvider, type LLMRequest } from "./provider.ts";

export type StructuredResult<T> = { ok: true; value: T; model: string } | { ok: false; reason: FallbackReason; detail?: string };

/**
 * One model call whose output must be a JSON object passing `schema` and then `check`.
 * Any failure is returned as a fallback reason, never thrown, so callers always have a deterministic path.
 */
export async function callStructured<T>(
  provider: LLMProvider | null,
  request: LLMRequest,
  schema: z.ZodType<T>,
  check?: (value: T) => FallbackReason | null,
): Promise<StructuredResult<T>> {
  if (!provider) return { ok: false, reason: "no_provider" };
  let text: string;
  try {
    text = await provider.complete({ ...request, json: true });
  } catch (err) {
    if (err instanceof LLMError) return { ok: false, reason: err.reason, detail: err.message };
    return { ok: false, reason: "network", detail: err instanceof Error ? err.message : String(err) };
  }
  const raw = extractJsonObject(text);
  if (!raw) return { ok: false, reason: "malformed_json", detail: "no JSON object in response" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed_json", detail: "response JSON did not parse" };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: "schema_invalid", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const problem = check?.(parsed.data);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, value: parsed.data, model: provider.model };
}
