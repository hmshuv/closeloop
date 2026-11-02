import {
  addBusinessDays,
  addDays,
  datesInRange,
  isBusinessDay,
  nextBusinessDay,
  windowStart,
  type BankCalendar,
} from "../calendar.ts";
import { loadConfig, settlementWindow, type CloseLoopConfig } from "../config.ts";
import { gstOnFee, settlementBreakdown, sumPaise } from "../money.ts";
import {
  PAYMENT_METHODS,
  SPLITS,
  type BankLine,
  type LedgerEntry,
  type NoiseKind,
  type Payment,
  type PaymentMethod,
  type Refund,
  type Settlement,
  type SettlementItem,
  type Split,
  type TruthLabel,
  type TruthLink,
} from "../types.ts";
import { HELDOUT_ONLY_NOISE, NOISE_EXPECTATIONS } from "./catalog.ts";
import {
  devNarration,
  heldoutNarration,
  makeDebit,
  makeMerchantId,
  makeUtr,
  ocrConfuse,
  spaceOrHyphenate,
  truncateUtr,
  typoUtr,
  type DebitSpec,
} from "./narration.ts";
import { Rng } from "./rng.ts";

export const GATEWAY_PARTY = "Razorpay Software Pvt Ltd";

export interface GenerateOptions {
  seed: number;
  payments?: number;
  /** Period length. Defaults to config (45 days). Larger eval datasets extend the period instead of the daily volume. */
  days?: number;
  config?: CloseLoopConfig;
}

export interface DatasetMeta {
  seed: number;
  payments_requested: number;
  days: number;
  period_start: string;
  period_end: string;
  as_of: string;
  heldout_start: string;
  merchant_id: string;
}

export interface Dataset {
  meta: DatasetMeta;
  payments: Payment[];
  refunds: Refund[];
  settlements: Settlement[];
  settlementItems: SettlementItem[];
  bankLines: BankLine[];
  ledgerEntries: LedgerEntry[];
  /** Ground truth. Written only to truth.db. */
  labels: TruthLabel[];
  links: TruthLink[];
  /** Entity id → split. Ground truth as well. */
  splitOf: Map<string, Split>;
}

/** Subscription-style price points: identical amounts make subset-sum ambiguity realistic. */
const PLAN_PRICES = [19_900, 49_900, 99_900, 1_49_900, 2_99_900] as const;

interface Ctx {
  cfg: CloseLoopConfig;
  cal: BankCalendar;
  start: string;
  end: string;
  heldoutStart: string;
  mid: string;
  usedIds: Set<string>;
  usedUtrs: Set<string>;
  splitOf: Map<string, Split>;
  labels: TruthLabel[];
  links: TruthLink[];
}

interface PaymentRec {
  payment: Payment;
  split: Split;
  date: string;
  /** Forces the payment into a dedicated settlement (used to build ambiguity traps). */
  group?: string;
  trap: boolean;
}

interface SettlementDraft {
  key: string;
  split: Split;
  method: PaymentMethod;
  due: string;
  settledAt: string;
  items: SettlementItem[];
  trap: boolean;
  settlement?: Settlement;
}

interface PendingLabel {
  kind: NoiseKind;
  details: Record<string, unknown>;
}

interface CreditSpec {
  date: string;
  amount: number;
  narration: string;
  /** The UTR text exactly as printed in the narration; accountants copy this into the ledger. */
  printedRef: string;
  split: Split;
  settlementIds: string[];
  labels: PendingLabel[];
  ledgerNoiseEligible: boolean;
  order: number;
  line?: BankLine;
}

interface DebitLine {
  date: string;
  spec: DebitSpec;
  split: Split;
  order: number;
  line?: BankLine;
}

interface EntryDraft {
  entry: Omit<LedgerEntry, "id">;
  split: Split;
  order: number;
  link?: Omit<TruthLink, "from_id" | "split">;
  labels: (PendingLabel & { duplicateOf?: EntryDraft })[];
  id?: string;
}

// ---------- helpers ----------

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`generator invariant: missing ${what}`);
  return value;
}

function uniqueId(ctx: Ctx, rng: Rng, prefix: string): string {
  for (;;) {
    const id = `${prefix}_${rng.alnum(14)}`;
    if (!ctx.usedIds.has(id)) {
      ctx.usedIds.add(id);
      return id;
    }
  }
}

function freshUtr(ctx: Ctx, rng: Rng, date: string): string {
  for (;;) {
    const utr = makeUtr(rng, date);
    if (!ctx.usedUtrs.has(utr)) {
      ctx.usedUtrs.add(utr);
      return utr;
    }
  }
}

function timestamp(rng: Rng, date: string): string {
  const hh = String(rng.int(7, 23)).padStart(2, "0");
  const mm = String(rng.int(0, 59)).padStart(2, "0");
  const ss = String(rng.int(0, 59)).padStart(2, "0");
  return `${date}T${hh}:${mm}:${ss}+05:30`;
}

function splitForDate(ctx: Ctx, date: string): Split {
  return date < ctx.heldoutStart ? "dev" : "heldout";
}

function businessDaysOfSplit(ctx: Ctx, split: Split): string[] {
  const [from, to] = split === "dev" ? [ctx.start, addDays(ctx.heldoutStart, -1)] : [ctx.heldoutStart, ctx.end];
  return datesInRange(from, to).filter((d) => isBusinessDay(d, ctx.cal));
}

/** Noise counts come from configured rates only — never inflated to hit eval minimums. */
function noiseCount(ctx: Ctx, kind: NoiseKind, split: Split, base: number): number {
  if (split === "dev" && HELDOUT_ONLY_NOISE.has(kind)) return 0;
  return Math.round((ctx.cfg.generator.noise_rates[kind] ?? 0) * base);
}

function label(ctx: Ctx, kind: NoiseKind, entityId: string, split: Split, details: Record<string, unknown> = {}): void {
  const e = NOISE_EXPECTATIONS[kind];
  ctx.labels.push({
    entity_type: e.entity,
    entity_id: entityId,
    noise_kind: kind,
    expected_exception: e.exception,
    expected_match_kind: e.match,
    split,
    details,
  });
}

function sampleAmount(rng: Rng): number {
  if (rng.chance(0.25)) return rng.pick(PLAN_PRICES);
  const rupees = Math.round(Math.exp(rng.uniform(Math.log(49), Math.log(40_000))));
  return rupees * 100 + (rng.chance(0.3) ? rng.int(1, 99) : 0);
}

function draftNet(d: SettlementDraft): number {
  return sumPaise(d.items.map((i) => i.net_paise));
}

// ---------- stage 1: payments & refunds ----------

function buildPayments(ctx: Ctx, rng: Rng, n: number, days: number): { recs: PaymentRec[]; trapKeys: { split: Split; key: string }[] } {
  const g = ctx.cfg.generator;
  const recs: PaymentRec[] = [];
  const make = (date: string, method: PaymentMethod, amount: number, status: Payment["status"]): Payment => ({
    id: uniqueId(ctx, rng, "pay"),
    order_id: uniqueId(ctx, rng, "order"),
    amount_paise: amount,
    method,
    status,
    captured_at: timestamp(rng, date),
  });

  for (let i = 0; i < n; i++) {
    const date = addDays(ctx.start, rng.int(0, days - 1));
    const method = rng.weighted(g.method_mix);
    const status = rng.chance(g.failed_payment_rate) ? "failed" : "captured";
    recs.push({ payment: make(date, method, sampleAmount(rng), status), split: splitForDate(ctx, date), date, trap: false });
  }

  // Ambiguity traps: two settlements with identical baskets (same plan prices, same day, same method),
  // so their nets are equal. One arrives inside a consolidated credit, the other never arrives.
  const trapKeys: { split: Split; key: string }[] = [];
  for (const split of SPLITS) {
    const captured = recs.filter((r) => r.split === split && r.payment.status === "captured").length;
    const count = noiseCount(ctx, "AMBIGUOUS_BATCH_TRAP", split, Math.round(captured / g.settlement_chunk_target));
    for (let t = 0; t < count; t++) {
      const method = rng.pick(PAYMENT_METHODS);
      const dates = businessDaysOfSplit(ctx, split).filter(
        (d) => addBusinessDays(d, settlementWindow(ctx.cfg, method), ctx.cal) <= ctx.end,
      );
      if (dates.length === 0) continue;
      const date = rng.pick(dates);
      const basket = Array.from({ length: rng.int(1, 3) }, () => rng.pick(PLAN_PRICES));
      const key = `amb:${split}:${t}`;
      for (const side of ["a", "b"]) {
        for (const amount of basket) {
          recs.push({ payment: make(date, method, amount, "captured"), split, date, group: `${key}:${side}`, trap: true });
        }
      }
      trapKeys.push({ split, key });
    }
  }

  recs.sort((a, b) => a.payment.captured_at.localeCompare(b.payment.captured_at) || a.payment.id.localeCompare(b.payment.id));
  for (const r of recs) ctx.splitOf.set(r.payment.id, r.split);
  return { recs, trapKeys };
}

function buildRefunds(ctx: Ctx, rng: Rng, recs: PaymentRec[]): Refund[] {
  const g = ctx.cfg.generator;
  const refunds: Refund[] = [];
  for (const r of recs) {
    if (r.trap || r.payment.status !== "captured" || !rng.chance(g.refund_rate)) continue;
    const date = addDays(r.date, rng.int(1, 7));
    if (date > ctx.end) continue;
    const full = r.payment.amount_paise;
    const amount = rng.chance(g.partial_refund_share) ? Math.max(100, Math.floor(full * rng.uniform(0.1, 0.9))) : full;
    const refund = { id: uniqueId(ctx, rng, "rfnd"), payment_id: r.payment.id, amount_paise: amount, created_at: timestamp(rng, date) };
    refunds.push(refund);
    ctx.splitOf.set(refund.id, r.split);
  }
  return refunds.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ---------- stage 2: settlements ----------

function buildSettlements(ctx: Ctx, rng: Rng, recs: PaymentRec[], refunds: Refund[]): SettlementDraft[] {
  const { cfg, cal } = ctx;
  const g = cfg.generator;
  const due = (r: PaymentRec) => addBusinessDays(r.date, settlementWindow(cfg, r.payment.method), cal);
  const refunded = new Set(refunds.map((r) => r.payment_id));
  const settleable = recs.filter((r) => r.payment.status === "captured" && due(r) <= ctx.end);

  // A captured payment whose window elapsed before period end but never appears in any settlement.
  const missing = new Set<PaymentRec>();
  for (const split of SPLITS) {
    const inSplit = settleable.filter((r) => r.split === split);
    const eligible = inSplit.filter((r) => !r.trap && !refunded.has(r.payment.id));
    for (const r of rng.sample(eligible, noiseCount(ctx, "MISSING_SETTLEMENT", split, inSplit.length))) {
      missing.add(r);
      label(ctx, "MISSING_SETTLEMENT", r.payment.id, split, { due_date: due(r) });
    }
  }

  const groups = new Map<string, PaymentRec[]>();
  for (const r of settleable) {
    if (missing.has(r)) continue;
    const key = r.group ?? `${r.split}|${due(r)}|${r.payment.method}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const drafts: SettlementDraft[] = [];
  for (const [key, list] of groups) {
    const first = must(list[0], "group member");
    const chunks = first.group ? 1 : Math.max(1, Math.round(list.length / g.settlement_chunk_target));
    const size = Math.ceil(list.length / chunks);
    for (let c = 0; c < chunks; c++) {
      const members = list.slice(c * size, (c + 1) * size);
      if (members.length === 0) continue;
      const items = members.map((r): SettlementItem => {
        const b = settlementBreakdown(r.payment.amount_paise, cfg.fees.gateway_fee_bps[r.payment.method], cfg.fees.gst_bps);
        return {
          id: "",
          settlement_id: "",
          entity_type: "payment",
          entity_id: r.payment.id,
          gross_paise: r.payment.amount_paise,
          fee_paise: b.fee,
          gst_paise: b.gst,
          net_paise: b.net,
        };
      });
      const d = due(first);
      drafts.push({ key: `${key}#${c}`, split: first.split, method: first.payment.method, due: d, settledAt: d, items, trap: first.trap });
    }
  }

  // GST computed on the payment amount instead of on the fee.
  for (const split of SPLITS) {
    const items = drafts.filter((d) => d.split === split && !d.trap).flatMap((d) => d.items);
    for (const item of rng.sample(items, noiseCount(ctx, "GST_WRONG_BASE", split, items.length))) {
      const applied = gstOnFee(item.gross_paise, cfg.fees.gst_bps);
      label(ctx, "GST_WRONG_BASE", item.entity_id, split, { expected_gst_paise: item.gst_paise, applied_gst_paise: applied });
      item.gst_paise = applied;
      item.net_paise = item.gross_paise - item.fee_paise - applied;
    }
  }

  // Settlements paid out 1–3 business days after the method's window.
  const late: { draft: SettlementDraft; shift: number }[] = [];
  for (const split of SPLITS) {
    const inSplit = drafts.filter((d) => d.split === split);
    const eligible = inSplit.filter((d) => !d.trap && addBusinessDays(d.settledAt, 3, cal) <= ctx.end);
    for (const draft of rng.sample(eligible, noiseCount(ctx, "LATE_SETTLEMENT", split, inSplit.length))) {
      const shift = rng.int(1, 3);
      draft.settledAt = addBusinessDays(draft.settledAt, shift, cal);
      late.push({ draft, shift });
    }
  }

  // Refunds are deducted from the merchant's settlement one business day after they're created.
  const byDay = new Map<string, SettlementDraft[]>();
  for (const d of drafts) {
    if (d.trap) continue;
    const k = `${d.split}|${d.settledAt}`;
    byDay.set(k, [...(byDay.get(k) ?? []), d]);
  }
  const settledPayments = new Map<string, SettlementDraft>();
  for (const d of drafts) for (const it of d.items) settledPayments.set(it.entity_id, d);
  const methodOf = new Map(recs.map((r) => [r.payment.id, r.payment.method]));

  const refundItems: { item: SettlementItem; draft: SettlementDraft; refund: Refund }[] = [];
  for (const refund of refunds) {
    if (!settledPayments.has(refund.payment_id)) continue; // parent payment not yet settled: refund still pending
    const split = must(ctx.splitOf.get(refund.id), "refund split");
    const method = methodOf.get(refund.payment_id);
    for (let day = addBusinessDays(refund.created_at.slice(0, 10), 1, cal); day <= ctx.end; day = nextBusinessDay(day, cal)) {
      const candidates = (byDay.get(`${split}|${day}`) ?? [])
        .slice()
        .sort((a, b) => Number(b.method === method) - Number(a.method === method) || draftNet(b) - draftNet(a));
      const target = candidates.find((c) => draftNet(c) > refund.amount_paise + 100);
      if (!target) continue;
      const item: SettlementItem = {
        id: "",
        settlement_id: "",
        entity_type: "refund",
        entity_id: refund.id,
        gross_paise: -refund.amount_paise,
        fee_paise: 0,
        gst_paise: 0,
        net_paise: -refund.amount_paise,
      };
      target.items.push(item);
      refundItems.push({ item, draft: target, refund });
      break;
    }
  }

  // The settlement deducts a different amount than the refund actually issued.
  for (const split of SPLITS) {
    const inSplit = refundItems.filter((r) => r.draft.split === split);
    for (const { item, draft, refund } of rng.sample(inSplit, noiseCount(ctx, "REFUND_AMOUNT_MISMATCH", split, inSplit.length))) {
      const up = refund.amount_paise <= 200 || rng.chance(0.5);
      const delta = up ? rng.int(100, 50_000) : -rng.int(100, Math.min(50_000, refund.amount_paise - 100));
      if (draftNet(draft) - delta <= 0) continue;
      item.gross_paise = item.net_paise = -(refund.amount_paise + delta);
      label(ctx, "REFUND_AMOUNT_MISMATCH", refund.id, split, { refund_paise: refund.amount_paise, deducted_paise: refund.amount_paise + delta });
    }
  }

  drafts.sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.key.localeCompare(b.key));
  let itemSeq = 0;
  for (const d of drafts) {
    const id = uniqueId(ctx, rng, "setl");
    const amount = draftNet(d);
    if (amount <= 0) throw new Error(`generator invariant: settlement ${d.key} has non-positive amount`);
    d.settlement = { id, utr: freshUtr(ctx, rng, d.settledAt), amount_paise: amount, settled_at: d.settledAt };
    ctx.splitOf.set(id, d.split);
    for (const it of d.items) {
      it.id = `sitm_${String(++itemSeq).padStart(7, "0")}`;
      it.settlement_id = id;
      ctx.splitOf.set(it.id, d.split);
    }
  }
  for (const { draft, shift } of late) {
    const s = must(draft.settlement, "settlement");
    label(ctx, "LATE_SETTLEMENT", s.id, draft.split, { due_date: draft.due, settled_at: s.settled_at, business_days_late: shift });
  }
  return drafts;
}

// ---------- stage 3: bank statement ----------

const SINGLE_SETTLEMENT_NOISE = [
  "MISSING_BANK_LINE",
  "AMOUNT_MISMATCH_ROUNDING",
  "AMOUNT_MISMATCH_MATERIAL",
  "UTR_TYPO",
  "UTR_TRUNCATED",
  "UTR_CASE_CHANGED",
  "UTR_SPACES_HYPHENS",
  "HELDOUT_NARRATION_FORMAT",
  "HELDOUT_OCR_CONFUSION",
] as const satisfies readonly NoiseKind[];

function buildCredits(ctx: Ctx, rng: Rng, drafts: SettlementDraft[], trapKeys: { split: Split; key: string }[]): CreditSpec[] {
  const { cfg, cal } = ctx;
  const W = cfg.matching.batch.window_business_days;
  const cons = cfg.generator.consolidation;
  const credits: CreditSpec[] = [];
  const stl = (d: SettlementDraft) => must(d.settlement, "settlement");
  // A consolidated credit may only contain settlements paid within W business days before it.
  // `list` is sorted by settledAt, so the window is a contiguous slice found by binary search.
  const lowerBound = (list: SettlementDraft[], date: string) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (must(list[mid], "draft").settledAt < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inWindow = (list: SettlementDraft[], creditDate: string) =>
    list.slice(lowerBound(list, windowStart(creditDate, W, cal)), lowerBound(list, addDays(creditDate, 1)));

  const credit = (split: Split, date: string, amount: number, narration: string, printedRef: string, settlementIds: string[], labels: PendingLabel[], ledgerNoiseEligible: boolean) =>
    credits.push({ date, amount, narration, printedRef, split, settlementIds, labels, ledgerNoiseEligible, order: rng.next() });

  const payout = (split: Split, date: string, members: SettlementDraft[], kind: NoiseKind, details: Record<string, unknown>) => {
    const utr = freshUtr(ctx, rng, date);
    const ids = members.map((m) => stl(m).id);
    credit(split, date, sumPaise(members.map((m) => stl(m).amount_paise)), devNarration(rng, utr, ctx.mid), utr, ids, [{ kind, details: { settlement_ids: ids, ...details } }], kind === "CONSOLIDATED_CREDIT");
  };

  for (const split of SPLITS) {
    const all = drafts.filter((d) => d.split === split);
    const claimed = new Set<SettlementDraft>();
    const isFree = (d: SettlementDraft) => !d.trap && !claimed.has(d);

    for (const { key } of trapKeys.filter((t) => t.split === split)) {
      const a = all.find((d) => d.key === `${key}:a#0`);
      const b = all.find((d) => d.key === `${key}:b#0`);
      if (!a || !b) continue;
      const date = a.settledAt;
      const others = rng.sample(inWindow(all, date).filter(isFree), rng.int(1, 2));
      for (const d of [a, b, ...others]) claimed.add(d);
      payout(split, date, [a, ...others], "AMBIGUOUS_BATCH_TRAP", { twin_settlement_id: stl(b).id });
      label(ctx, "AMBIGUOUS_TWIN", stl(b).id, split, { twin_of: stl(a).id });
    }

    const conflicts = noiseCount(ctx, "MATCH_CONFLICT_TRAP", split, all.length);
    for (let t = 0; t < conflicts; t++) {
      for (const s of rng.sample(all.filter(isFree), 25)) {
        const others = rng.sample(inWindow(all, s.settledAt).filter((d) => d !== s && isFree(d)), rng.int(1, 2));
        if (others.length === 0) continue;
        for (const d of [s, ...others]) claimed.add(d);
        payout(split, s.settledAt, [s, ...others], "MATCH_CONFLICT_TRAP", { conflicting_settlement_id: stl(s).id });
        const decoyRef = typoUtr(rng, stl(s).utr, rng.int(2, 3));
        credit(split, s.settledAt, stl(s).amount_paise, devNarration(rng, decoyRef, ctx.mid), decoyRef, [], [{ kind: "CONFLICT_DECOY", details: { resembles_settlement_id: stl(s).id } }], false);
        break;
      }
    }

    const target = Math.round(cons.settlement_share * all.length);
    let absorbed = 0;
    for (const anchor of rng.shuffle(all)) {
      if (absorbed >= target) break;
      if (!isFree(anchor)) continue;
      const next = nextBusinessDay(anchor.settledAt, cal);
      const date = rng.chance(0.5) && next <= ctx.end ? next : anchor.settledAt;
      const [lo, hi] = rng.chance(cons.large_share) ? cons.large_size : cons.small_size;
      const pool = inWindow(all, date).filter((d) => d !== anchor && isFree(d));
      const members = [anchor, ...rng.sample(pool, rng.int(lo, hi) - 1)];
      if (members.length < 2) continue;
      for (const d of members) claimed.add(d);
      absorbed += members.length;
      payout(split, date, members, "CONSOLIDATED_CREDIT", { size: members.length });
    }

    const remaining = rng.shuffle(all.filter(isFree));
    for (const kind of SINGLE_SETTLEMENT_NOISE) {
      for (const d of remaining.splice(0, Math.min(noiseCount(ctx, kind, split, all.length), remaining.length))) {
        const s = stl(d);
        const details = { settlement_id: s.id };
        if (kind === "MISSING_BANK_LINE") {
          label(ctx, kind, s.id, split, { settled_at: s.settled_at });
          continue;
        }
        if (kind === "AMOUNT_MISMATCH_ROUNDING" || kind === "AMOUNT_MISMATCH_MATERIAL") {
          const magnitude = kind === "AMOUNT_MISMATCH_ROUNDING" ? rng.int(1, 99) : rng.int(500_00, 50_000_00);
          const delta = rng.chance(0.5) && s.amount_paise - magnitude > 0 ? -magnitude : magnitude;
          const subtype = kind === "AMOUNT_MISMATCH_ROUNDING" ? "ROUNDING" : "MATERIAL";
          credit(split, s.settled_at, s.amount_paise + delta, devNarration(rng, s.utr, ctx.mid), s.utr, [s.id], [{ kind, details: { ...details, delta_paise: delta, subtype } }], true);
          continue;
        }
        let printed = s.utr;
        let narration: string;
        if (kind === "HELDOUT_NARRATION_FORMAT") {
          ({ narration, printed } = heldoutNarration(s.utr, ctx.mid));
        } else {
          if (kind === "UTR_TYPO") printed = typoUtr(rng, s.utr, rng.int(1, 2));
          if (kind === "UTR_TRUNCATED") printed = truncateUtr(rng, s.utr);
          if (kind === "UTR_CASE_CHANGED") printed = s.utr.toLowerCase();
          if (kind === "UTR_SPACES_HYPHENS") printed = spaceOrHyphenate(rng, s.utr);
          if (kind === "HELDOUT_OCR_CONFUSION") printed = ocrConfuse(rng, s.utr);
          narration = devNarration(rng, printed, ctx.mid);
          if (kind === "UTR_CASE_CHANGED" && rng.chance(0.5)) narration = narration.toLowerCase();
        }
        credit(split, s.settled_at, s.amount_paise, narration, printed, [s.id], [{ kind, details: { ...details, printed } }], true);
      }
    }

    for (const d of remaining) {
      const s = stl(d);
      credit(split, s.settled_at, s.amount_paise, devNarration(rng, s.utr, ctx.mid), s.utr, [s.id], [], true);
    }

    // Money that arrives with a gateway-looking narration but corresponds to no settlement.
    const days = businessDaysOfSplit(ctx, split);
    for (let i = 0; i < noiseCount(ctx, "UNIDENTIFIED_CREDIT", split, all.length) && days.length > 0; i++) {
      const date = rng.pick(days);
      const utr = freshUtr(ctx, rng, date);
      credit(split, date, rng.int(5_000_00, 5_00_000_00) | 1, devNarration(rng, utr, ctx.mid), utr, [], [{ kind: "UNIDENTIFIED_CREDIT", details: {} }], false);
    }
  }
  return credits;
}

function buildStatement(ctx: Ctx, rng: Rng, credits: CreditSpec[]): { bankLines: BankLine[]; debits: DebitLine[] } {
  const debits: DebitLine[] = [];
  for (const date of datesInRange(ctx.start, ctx.end)) {
    if (!isBusinessDay(date, ctx.cal)) continue;
    for (let i = rng.int(0, 2); i > 0; i--) debits.push({ date, spec: makeDebit(rng), split: splitForDate(ctx, date), order: rng.next() });
  }

  type Row = { kind: "credit"; c: CreditSpec } | { kind: "debit"; d: DebitLine };
  const rows: Row[] = [...credits.map((c) => ({ kind: "credit" as const, c })), ...debits.map((d) => ({ kind: "debit" as const, d }))];
  const dateOf = (r: Row) => (r.kind === "credit" ? r.c.date : r.d.date);
  const orderOf = (r: Row) => (r.kind === "credit" ? r.c.order : r.d.order);
  rows.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || orderOf(a) - orderOf(b));

  const bankLines: BankLine[] = [];
  const kept: DebitLine[] = [];
  let balance = ctx.cfg.generator.opening_balance_paise;
  for (const r of rows) {
    if (r.kind === "debit" && balance - r.d.spec.amount < 0) continue; // never overdraw the account
    const credit = r.kind === "credit" ? r.c.amount : 0;
    const debit = r.kind === "debit" ? r.d.spec.amount : 0;
    balance += credit - debit;
    const line: BankLine = {
      id: `bnk_${String(bankLines.length + 1).padStart(6, "0")}`,
      txn_date: dateOf(r),
      narration: r.kind === "credit" ? r.c.narration : r.d.spec.narration,
      credit_paise: credit,
      debit_paise: debit,
      balance_paise: balance,
    };
    bankLines.push(line);
    if (r.kind === "credit") r.c.line = line;
    else {
      r.d.line = line;
      kept.push(r.d);
    }
    ctx.splitOf.set(line.id, r.kind === "credit" ? r.c.split : r.d.split);
  }

  for (const c of credits) {
    const line = must(c.line, "credit line");
    for (const l of c.labels) label(ctx, l.kind, line.id, c.split, l.details);
    ctx.links.push({ kind: "BANK_SETTLEMENT", from_id: line.id, to_ids: c.settlementIds, split: c.split });
  }
  return { bankLines, debits: kept };
}

// ---------- stage 4: ledger (Tally / Zoho Books style export) ----------

const RECEIPT_NOISE = [
  "MISSING_LEDGER_RECEIPT",
  "DUPLICATE_LEDGER_ENTRY",
  "LEDGER_WRONG_REFERENCE",
  "LEDGER_ABSENT_REFERENCE",
  "RECEIPT_AMOUNT_MISMATCH",
] as const satisfies readonly NoiseKind[];

function buildLedger(ctx: Ctx, rng: Rng, credits: CreditSpec[], debits: DebitLine[], drafts: SettlementDraft[]): LedgerEntry[] {
  const { cal } = ctx;
  const entries: EntryDraft[] = [];
  const push = (e: EntryDraft) => {
    entries.push(e);
    return e;
  };
  const receipt = (date: string, amount: number, reference: string): Omit<LedgerEntry, "id"> => ({
    entry_date: date,
    voucher_type: "Receipt",
    party: GATEWAY_PARTY,
    amount_paise: amount,
    reference,
    narration: reference ? `Being Razorpay settlement received vide ${reference}` : "Being Razorpay settlement received",
  });

  for (const split of SPLITS) {
    const inSplit = credits.filter((c) => c.split === split);
    const eligible = inSplit.filter((c) => c.ledgerNoiseEligible);
    const noise = new Map<CreditSpec, NoiseKind>();
    const pool = rng.shuffle(eligible);
    for (const kind of RECEIPT_NOISE) {
      for (const c of pool.splice(0, Math.min(noiseCount(ctx, kind, split, eligible.length), pool.length))) noise.set(c, kind);
    }

    for (const c of inSplit) {
      const line = must(c.line, "credit line");
      const kind = noise.get(c);
      if (kind === "MISSING_LEDGER_RECEIPT") {
        label(ctx, kind, line.id, split, {});
        continue;
      }
      // Accountants usually book the receipt the same day, sometimes the next business day.
      const lagged = nextBusinessDay(c.date, cal);
      const date = rng.chance(0.2) && lagged <= ctx.end ? lagged : c.date;
      const link = { kind: "RECEIPT_BANK" as const, to_ids: [line.id] };
      let entry = receipt(date, c.amount, c.printedRef);
      const labels: EntryDraft["labels"] = [];
      if (kind === "LEDGER_WRONG_REFERENCE") {
        entry = receipt(date, c.amount, makeUtr(rng, date));
        labels.push({ kind, details: { bank_line_id: line.id } });
      } else if (kind === "LEDGER_ABSENT_REFERENCE") {
        entry = receipt(date, c.amount, "");
        labels.push({ kind, details: { bank_line_id: line.id } });
      } else if (kind === "RECEIPT_AMOUNT_MISMATCH") {
        const magnitude = rng.int(100, 5_000_00);
        const delta = rng.chance(0.5) && c.amount - magnitude > 0 ? -magnitude : magnitude;
        entry = receipt(date, c.amount + delta, c.printedRef);
        label(ctx, kind, line.id, split, { receipt_amount_paise: c.amount + delta, delta_paise: delta });
      }
      const original = push({ entry, split, order: rng.next(), link, labels });
      if (kind === "DUPLICATE_LEDGER_ENTRY") {
        const dupDate = rng.chance(0.5) && lagged <= ctx.end ? lagged : date;
        push({
          entry: { ...entry, entry_date: dupDate },
          split,
          order: dupDate === date ? original.order + 0.5 : rng.next(),
          link,
          labels: [{ kind, details: { bank_line_id: line.id }, duplicateOf: original }],
        });
      }
    }

    // A receipt booked for money that never reached the bank.
    const days = businessDaysOfSplit(ctx, split);
    for (let i = 0; i < noiseCount(ctx, "PHANTOM_RECEIPT", split, inSplit.length) && days.length > 0; i++) {
      const date = rng.pick(days);
      push({
        entry: receipt(date, rng.int(10_000_00, 3_00_000_00), makeUtr(rng, date)),
        split,
        order: rng.next(),
        link: { kind: "RECEIPT_BANK", to_ids: [] },
        labels: [{ kind: "PHANTOM_RECEIPT", details: {} }],
      });
    }

    // One journal per settlement books the gateway fee + GST deducted from it.
    const settlementsInSplit = drafts.filter((d) => d.split === split);
    const missingJournal = new Set(
      rng.sample(settlementsInSplit.filter((d) => !d.trap), noiseCount(ctx, "MISSING_LEDGER_JOURNAL", split, settlementsInSplit.length)),
    );
    for (const d of settlementsInSplit) {
      const s = must(d.settlement, "settlement");
      if (missingJournal.has(d)) {
        label(ctx, "MISSING_LEDGER_JOURNAL", s.id, split, {});
        continue;
      }
      const charges = sumPaise(d.items.map((i) => i.fee_paise + i.gst_paise));
      push({
        entry: {
          entry_date: s.settled_at,
          voucher_type: "Journal",
          party: GATEWAY_PARTY,
          amount_paise: charges,
          reference: s.id,
          narration: `Being payment gateway charges and GST on fees for settlement ${s.id}`,
        },
        split,
        order: rng.next(),
        link: { kind: "JOURNAL_SETTLEMENT", to_ids: [s.id] },
        labels: [],
      });
    }
  }

  for (const d of debits) {
    push({
      entry: {
        entry_date: d.date,
        voucher_type: "Payment",
        party: d.spec.party,
        amount_paise: d.spec.amount,
        reference: d.spec.reference,
        narration: `Being payment made: ${d.spec.narration}`,
      },
      split: d.split,
      order: rng.next(),
      labels: [],
    });
  }

  entries.sort((a, b) => a.entry.entry_date.localeCompare(b.entry.entry_date) || a.order - b.order);
  entries.forEach((e, i) => {
    e.id = `led_${String(i + 1).padStart(6, "0")}`;
    ctx.splitOf.set(e.id, e.split);
  });
  for (const e of entries) {
    const id = must(e.id, "ledger id");
    if (e.link) ctx.links.push({ ...e.link, from_id: id, split: e.split });
    for (const l of e.labels) {
      const details = l.duplicateOf ? { ...l.details, original_ledger_id: must(l.duplicateOf.id, "original id") } : l.details;
      label(ctx, l.kind, id, e.split, details);
    }
  }
  return entries.map((e) => ({ id: must(e.id, "ledger id"), ...e.entry }));
}

// ---------- entry point ----------

export function generateDataset(options: GenerateOptions): Dataset {
  const cfg = options.config ?? loadConfig();
  const g = cfg.generator;
  const payments = options.payments ?? g.default_payments;
  const days = options.days ?? g.days;
  const root = new Rng(options.seed);
  const start = g.period_start;
  const end = addDays(start, days - 1);
  const ctx: Ctx = {
    cfg,
    cal: cfg.calendar,
    start,
    end,
    heldoutStart: addDays(start, days - Math.max(1, Math.round(days * g.heldout_share))),
    mid: makeMerchantId(root.fork("merchant")),
    usedIds: new Set(),
    usedUtrs: new Set(),
    splitOf: new Map(),
    labels: [],
    links: [],
  };

  const { recs, trapKeys } = buildPayments(ctx, root.fork("payments"), payments, days);
  const refunds = buildRefunds(ctx, root.fork("refunds"), recs);
  const drafts = buildSettlements(ctx, root.fork("settlements"), recs, refunds);
  const credits = buildCredits(ctx, root.fork("bank"), drafts, trapKeys);
  const { bankLines, debits } = buildStatement(ctx, root.fork("statement"), credits);
  const ledgerEntries = buildLedger(ctx, root.fork("ledger"), credits, debits, drafts);

  const settlements = drafts.map((d) => must(d.settlement, "settlement"));
  return {
    meta: {
      seed: options.seed,
      payments_requested: payments,
      days,
      period_start: start,
      period_end: end,
      as_of: end,
      heldout_start: ctx.heldoutStart,
      merchant_id: ctx.mid,
    },
    payments: recs.map((r) => r.payment),
    refunds,
    settlements,
    settlementItems: drafts.flatMap((d) => d.items),
    bankLines,
    ledgerEntries,
    labels: ctx.labels,
    links: ctx.links,
    splitOf: ctx.splitOf,
  };
}
