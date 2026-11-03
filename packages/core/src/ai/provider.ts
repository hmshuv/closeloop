/** Why an AI call fell back to the deterministic path. Recorded on every output and in the audit trail. */
export type FallbackReason =
  | "no_provider"
  | "timeout"
  | "rate_limited"
  | "network"
  | "malformed_json"
  | "schema_invalid"
  | "fabricated_evidence"
  | "unbalanced_entry"
  | `http_${number}`;

export class LLMError extends Error {
  constructor(
    readonly reason: FallbackReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "LLMError";
  }
}

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean;
}

/** Any chat-completion backend. Implementations throw LLMError; callers fall back deterministically. */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LLMRequest): Promise<string>;
}

export type Source = "llm" | "deterministic_fallback";
