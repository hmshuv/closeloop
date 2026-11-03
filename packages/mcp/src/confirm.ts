import { randomBytes } from "node:crypto";

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

interface Pending<T> {
  action: string;
  payload: T;
  expiresAt: number;
  used: boolean;
}

/**
 * Two-step human actions: the first call returns a preview and a single-use token; the second call must
 * present that token (within 5 minutes) together with the reviewer's name to execute.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, Pending<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  issue<T>(action: string, payload: T): { token: string; expires_at: string } {
    const token = randomBytes(18).toString("base64url");
    const expiresAt = this.now() + CONFIRMATION_TTL_MS;
    this.pending.set(token, { action, payload, expiresAt, used: false });
    return { token, expires_at: new Date(expiresAt).toISOString() };
  }

  /** `check` validates the request against the token's payload first; a mismatch is rejected without using the token up. */
  consume<T>(token: string, action: string, check?: (payload: T) => string | null): T {
    const p = this.pending.get(token);
    if (!p || p.action !== action) throw new Error("Unknown confirmation token. Call again without confirm_token to get a new preview.");
    if (p.used) throw new Error("This confirmation token was already used. Call again without confirm_token to get a new preview.");
    if (this.now() > p.expiresAt) {
      this.pending.delete(token);
      throw new Error("This confirmation token has expired (tokens last 5 minutes). Call again without confirm_token to get a new preview.");
    }
    const problem = check?.(p.payload as T);
    if (problem) throw new Error(problem);
    p.used = true;
    return p.payload as T;
  }
}
