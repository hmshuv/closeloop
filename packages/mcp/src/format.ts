import { formatINR } from "@closeloop/core";
export { withInr } from "@closeloop/core";
import { z } from "zod";

/** Raw paise plus a pre-formatted Indian-grouped rupee string, so the model never formats or adds money. */
export const Money = z.object({ amount_paise: z.number().int(), amount_inr: z.string() });
export type Money = z.infer<typeof Money>;

export const money = (paise: number): Money => ({ amount_paise: paise, amount_inr: formatINR(paise) });

export const DEFAULT_PAGE_SIZE = 20;

interface Cursor {
  offset: number;
  scope: string;
}

/** Opaque cursors bound to the query they came from, so a cursor can't be replayed against different filters. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string | undefined, scope: string): number {
  if (!raw) return 0;
  let parsed: Cursor;
  try {
    parsed = z.object({ offset: z.number().int().nonnegative(), scope: z.string() }).parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid cursor. Start again without a cursor.");
  }
  if (parsed.scope !== scope) throw new Error("This cursor belongs to a different query or run. Start again without a cursor.");
  return parsed.offset;
}

export function page<T>(items: T[], offset: number, limit: number, scope: string): { items: T[]; next_cursor: string | null; showing: string } {
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    items: slice,
    next_cursor: end < items.length ? encodeCursor({ offset: end, scope }) : null,
    showing: items.length === 0 ? "none" : `${offset + 1}–${end} of ${items.length}`,
  };
}
