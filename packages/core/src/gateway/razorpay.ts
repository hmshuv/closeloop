import { z } from "zod";
import type { GatewayReportRow } from "../matcher/types.ts";

/**
 * Razorpay settlement recon, as documented for `GET /v1/settlements/recon/combined` (API docs → Settlements →
 * Fetch Recon; the same data Razorpay's official MCP server returns from `fetch_settlement_recon_details`).
 * Amounts are integers in currency subunits (paise for INR); timestamps are Unix seconds.
 */

const Subunits = z.number().int().safe();
const UnixSeconds = z.number().int().nonnegative();
const optionalText = z.string().nullable().optional();

export const RECON_ITEM_TYPES = ["payment", "refund", "transfer", "adjustment"] as const;

export const RazorpayReconItemSchema = z
  .object({
    entity_id: z.string().min(1),
    type: z.enum(RECON_ITEM_TYPES),
    debit: Subunits.nonnegative(),
    credit: Subunits.nonnegative(),
    amount: Subunits.nonnegative(),
    currency: z.string().length(3),
    fee: Subunits,
    tax: Subunits,
    on_hold: z.boolean().optional(),
    settled: z.boolean().optional(),
    created_at: UnixSeconds,
    settled_at: UnixSeconds.nullable(),
    settlement_id: z.string().min(1).nullable(),
    posted_at: UnixSeconds.nullable().optional(),
    credit_type: optionalText,
    description: optionalText,
    notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).nullable().optional(),
    payment_id: optionalText,
    settlement_utr: optionalText,
    order_id: optionalText,
    order_receipt: optionalText,
    method: optionalText,
    card_network: optionalText,
    card_issuer: optionalText,
    card_type: optionalText,
    dispute_id: optionalText,
  })
  .passthrough();
export type RazorpayReconItem = z.infer<typeof RazorpayReconItemSchema>;

export const RazorpayCollectionSchema = z.object({ entity: z.literal("collection"), count: z.number().int().nonnegative(), items: z.array(z.unknown()) });

/** Settlement entity, as documented for `GET /v1/settlements`. */
export const RazorpaySettlementSchema = z
  .object({
    id: z.string().min(1),
    entity: z.literal("settlement"),
    amount: Subunits,
    status: z.string(),
    fees: Subunits,
    tax: Subunits,
    utr: z.string().nullable(),
    created_at: UnixSeconds,
  })
  .passthrough();
export type RazorpaySettlement = z.infer<typeof RazorpaySettlementSchema>;

/** Column order for CSV, matching the documented field order of a recon item. */
export const RECON_FIELDS = [
  "entity_id", "type", "debit", "credit", "amount", "currency", "fee", "tax", "on_hold", "settled", "created_at", "settled_at",
  "settlement_id", "posted_at", "credit_type", "description", "notes", "payment_id", "settlement_utr", "order_id", "order_receipt",
  "method", "card_network", "card_issuer", "card_type", "dispute_id",
] as const;
const INTEGER_FIELDS = new Set(["debit", "credit", "amount", "fee", "tax", "created_at", "settled_at", "posted_at"]);
const BOOLEAN_FIELDS = new Set(["on_hold", "settled"]);

const IST_OFFSET_S = 19_800;
/** IST calendar date of a Unix timestamp. */
export const istDate = (unixSeconds: number) => new Date((unixSeconds + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
/** Unix seconds of an IST ISO timestamp (`2026-10-01T09:00:00+05:30`) or of IST midnight for a date. */
export const unixOf = (ist: string) => Math.floor(Date.parse(ist.length === 10 ? `${ist}T00:00:00+05:30` : ist) / 1000);

function validate(raw: unknown[]): RazorpayReconItem[] {
  return raw.map((r, i) => {
    const parsed = RazorpayReconItemSchema.safeParse(r);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`recon row ${i + 1}: ${issue?.path.join(".") || "row"}: ${issue?.message ?? "invalid"}`);
    }
    if (parsed.data.currency !== "INR") throw new Error(`recon row ${i + 1}: currency ${parsed.data.currency} is not supported (INR only)`);
    return parsed.data;
  });
}

/** A JSON export: one collection (as the API returns it), a list of collections (pages), or a bare list of items. */
export function parseReconJson(text: string): RazorpayReconItem[] {
  const data: unknown = JSON.parse(text);
  const pages = Array.isArray(data) && data.every((d) => RazorpayCollectionSchema.safeParse(d).success) && data.length > 0 ? data : [data];
  const raw = pages.flatMap((page) => {
    if (Array.isArray(page)) return page as unknown[];
    const c = RazorpayCollectionSchema.safeParse(page);
    if (!c.success) throw new Error('expected a recon collection ({"entity": "collection", "items": [...]}) or a list of recon items');
    return c.data.items;
  });
  return validate(raw);
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF line endings. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/**
 * A CSV export with the API's field names as the header row. Amounts must be integers in paise, exactly as the API
 * returns them: a rupee-denominated column ("12.50") is rejected rather than silently read 100× too small.
 */
export function parseReconCsv(text: string): RazorpayReconItem[] {
  const [header, ...body] = csvRows(text.replace(/^\uFEFF/, ""));
  if (!header) throw new Error("empty CSV");
  const columns = header.map((h) => h.trim());
  for (const required of ["entity_id", "type", "debit", "credit", "amount", "currency", "fee", "tax", "settlement_id", "settled_at"]) {
    if (!columns.includes(required)) throw new Error(`CSV is missing the "${required}" column`);
  }
  const raw = body.map((cells, r) =>
    Object.fromEntries(
      columns.map((col, c) => {
        const v = (cells[c] ?? "").trim();
        if (v === "" || v === "null") return [col, null];
        if (INTEGER_FIELDS.has(col)) {
          if (!/^-?\d+$/.test(v)) throw new Error(`CSV row ${r + 2}, ${col}: "${v}" is not an integer amount in paise (currency subunits), as the API reports it`);
          return [col, Number(v)];
        }
        if (BOOLEAN_FIELDS.has(col)) return [col, v === "true" || v === "1"];
        if (col === "notes" && /^[[{]/.test(v)) return [col, JSON.parse(v) as unknown];
        return [col, v];
      }),
    ),
  );
  return validate(raw);
}

export function parseReconFile(path: string, text: string): RazorpayReconItem[] {
  return /\.csv$/i.test(path) ? parseReconCsv(text) : parseReconJson(text);
}

export function reconItemsToCsv(items: readonly RazorpayReconItem[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : `${v as string | number | boolean}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [RECON_FIELDS.join(","), ...items.map((it) => RECON_FIELDS.map((f) => cell((it as Record<string, unknown>)[f])).join(","))].join("\n") + "\n";
}

/** Rows that belong to a settlement become report rows; unsettled rows (no settlement yet) are left out. */
export function toReportRow(item: RazorpayReconItem): GatewayReportRow | null {
  if (item.settled === false || !item.settlement_id || item.settled_at === null) return null;
  return {
    entity_id: item.entity_id,
    type: item.type,
    settlement_id: item.settlement_id,
    settlement_utr: item.settlement_utr ?? null,
    amount_paise: item.amount,
    fee_paise: item.fee,
    tax_paise: item.tax,
    credit_paise: item.credit,
    debit_paise: item.debit,
    payment_id: item.payment_id ?? null,
    settled_on: istDate(item.settled_at),
  };
}

// ---------- read-only API client ----------

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

/** CLOSELOOP_RAZORPAY_KEY_ID / CLOSELOOP_RAZORPAY_KEY_SECRET, or null when either is missing. */
export function razorpayCredentialsFromEnv(env: NodeJS.ProcessEnv): RazorpayCredentials | null {
  const keyId = env.CLOSELOOP_RAZORPAY_KEY_ID?.trim();
  const keySecret = env.CLOSELOOP_RAZORPAY_KEY_SECRET?.trim();
  return keyId && keySecret ? { keyId, keySecret } : null;
}

export interface RazorpayClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const RECON_PAGE = 1000; // documented maximum `count` for recon/combined
const SETTLEMENT_PAGE = 100; // documented maximum `count` for settlements

/**
 * Read-only by construction: the only request this client can make is a GET to the two documented settlement
 * endpoints. There is no method that sends a body or uses another HTTP verb.
 */
export class RazorpayReadOnlyClient {
  readonly #auth: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(creds: RazorpayCredentials, opts: RazorpayClientOptions = {}) {
    this.#auth = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`;
    this.#fetch = opts.fetch ?? fetch;
    this.#base = (opts.baseUrl ?? "https://api.razorpay.com/v1").replace(/\/$/, "");
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async #get(path: "/settlements/recon/combined" | "/settlements", query: Record<string, number>): Promise<unknown> {
    const url = `${this.#base}${path}?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
    const res = await this.#fetch(url, { method: "GET", headers: { Authorization: this.#auth, Accept: "application/json" }, signal: AbortSignal.timeout(this.#timeoutMs) });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const description = (body as { error?: { description?: string } } | null)?.error?.description;
      throw new Error(`Razorpay GET ${path} failed: HTTP ${res.status}${description ? ` (${description})` : ""}`);
    }
    return body;
  }

  async #pages(path: "/settlements/recon/combined" | "/settlements", query: Record<string, number>, size: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let skip = 0; ; skip += size) {
      const page = RazorpayCollectionSchema.parse(await this.#get(path, { ...query, count: size, skip }));
      out.push(...page.items);
      if (page.items.length < size) return out;
    }
  }

  /** Recon rows for every settlement received on each IST day in [from, to] (YYYY-MM-DD). */
  async fetchRecon(from: string, to: string): Promise<RazorpayReconItem[]> {
    const raw: unknown[] = [];
    for (let day = from; day <= to; day = nextDay(day)) {
      const [year, month, date] = day.split("-").map(Number) as [number, number, number];
      raw.push(...(await this.#pages("/settlements/recon/combined", { year, month, day: date }, RECON_PAGE)));
    }
    return validate(raw);
  }

  /** Settlements created between IST midnight of `from` and the end of `to`. */
  async fetchSettlements(from: string, to: string): Promise<RazorpaySettlement[]> {
    const raw = await this.#pages("/settlements", { from: unixOf(from), to: unixOf(nextDay(to)) - 1 }, SETTLEMENT_PAGE);
    return raw.map((r) => RazorpaySettlementSchema.parse(r));
  }
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
