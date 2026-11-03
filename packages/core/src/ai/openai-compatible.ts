import { z } from "zod";
import { LLMError, type LLMProvider, type LLMRequest } from "./provider.ts";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Upper bound on the single 429 retry wait. */
  maxRetryAfterMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const CompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After is either delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * POST {baseUrl}/chat/completions with the built-in fetch. Works with Groq, Google AI Studio's
 * OpenAI-compatible endpoint, OpenRouter, Ollama and similar.
 * - one retry on HTTP 429 (honouring Retry-After, capped), then LLMError("rate_limited")
 * - requests JSON mode; if the provider rejects `response_format`, retries without it and remembers
 * - every attempt has an AbortController timeout
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private jsonMode = true;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      return await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new LLMError("timeout");
      throw new LLMError("network", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(request: LLMRequest): Promise<string> {
    const body = (json: boolean) => ({
      model: this.model,
      temperature: 0,
      max_tokens: request.maxTokens ?? 800,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });

    let useJson = Boolean(request.json) && this.jsonMode;
    let retried429 = false;
    for (;;) {
      const res = await this.post(body(useJson));
      if (res.status === 429) {
        if (retried429) throw new LLMError("rate_limited");
        retried429 = true;
        await this.sleep(Math.min(retryAfterMs(res.headers.get("retry-after")) ?? 1_000, this.opts.maxRetryAfterMs ?? 5_000));
        continue;
      }
      if (res.status === 400 && useJson) {
        const text = await res.text().catch(() => "");
        if (/response_format|json_object|json mode/i.test(text)) {
          this.jsonMode = false; // this provider/model doesn't support JSON mode; extract JSON from text instead
          useJson = false;
          continue;
        }
        throw new LLMError("http_400");
      }
      if (!res.ok) throw new LLMError(`http_${res.status}`);
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new LLMError("malformed_json", "completion body was not JSON");
      }
      const parsed = CompletionSchema.safeParse(data);
      const content = parsed.success ? parsed.data.choices[0]?.message.content : null;
      if (!content) throw new LLMError("malformed_json", "no message content in completion");
      return content;
    }
  }
}

/** Returns a provider only when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all set. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleProvider | null {
  const { LLM_BASE_URL: baseUrl, LLM_API_KEY: apiKey, LLM_MODEL: model } = env;
  if (!baseUrl || !apiKey || !model) return null;
  return new OpenAICompatibleProvider({ baseUrl, apiKey, model });
}
