import { describe, expect, it } from "vitest";
import { exposureClassOf, summarizeExposure } from "../src/matcher/exposure.ts";
import { reconcile } from "../src/matcher/reconcile.ts";
import { stage1Items } from "../src/matcher/stage1-items.ts";
import { stage2Bank } from "../src/matcher/stage2-bank.ts";
import { CONTIGUITY_ASSUMPTION } from "../src/matcher/stage2-batch.ts";
import { stage3Ledger } from "../src/matcher/stage3-ledger.ts";
import { stage4Timing } from "../src/matcher/stage4-timing.ts";
import { computeTieOut, tieOutExceptions } from "../src/matcher/tieout.ts";
import type { ExceptionDraft, StageResult } from "../src/matcher/types.ts";
import { EXCEPTION_TYPES } from "../src/types.ts";
import { cfg, credit, itemFor, journal, neft, payment, receipt, refundItem, settlement, source, ts } from "./fixtures.ts";

const ofType = (r: { exceptions: ExceptionDraft[] }, type: ExceptionDraft["type"]) => r.exceptions.filter((e) => e.type === type);
const matchesOf = (r: StageResult, kind: string) => r.matches.filter((m) => m.kind === kind);

// Two same-bank, same-day settlements whose UTRs share 15 of 16 characters.
const A = settlement("setl_A", "AXISN26278123456", "2026-10-05", 1_00_000);
const B = settlement("setl_B", "AXISN26278123457", "2026-10-05", 2_50_000);

describe("stage 2a/2c: exact and fuzzy UTR matching", () => {
  it("matches an exact UTR after uppercasing and stripping spaces/hyphens", () => {
    const r = stage2Bank(source({ settlements: [A], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("axisn2627-8123 456"))] }), cfg);
    expect(matchesOf(r, "EXACT")).toHaveLength(1);
    expect(r.exceptions).toHaveLength(0);
  });

  it("(a) auto-matches a distance-1 typo when the runner-up is clearly worse", () => {
    // Typo in the bank code: distance 1 from A, distance 2 from B.
    const r = stage2Bank(source({ settlements: [A, B], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("AXJSN26278123456"))] }), cfg);
    const fuzzy = matchesOf(r, "FUZZY");
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0]?.left.id).toBe("setl_A");
    expect(fuzzy[0]?.trace).toMatchObject({ best: { distance: 1 }, runner_up: { settlement_id: "setl_B", distance: 2 } });
    expect(ofType(r, "SUGGESTED_MATCH")).toHaveLength(0);
  });

  it("(b) downgrades the same distance-1 typo to SUGGESTED_MATCH when a prefix-sharing runner-up is just as close", () => {
    // Typo in the last digit: distance 1 from both A and B, so the margin is 0.
    const r = stage2Bank(source({ settlements: [A, B], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("AXISN26278123458"))] }), cfg);
    expect(matchesOf(r, "FUZZY")).toHaveLength(0);
    const [s] = ofType(r, "SUGGESTED_MATCH");
    expect(s?.trace).toMatchObject({ reason: "margin_below_threshold", suggested: { settlement_id: "setl_A" } });
    // A suggested settlement is pending review, not missing.
    expect(ofType(r, "MISSING_BANK_CREDIT").map((e) => e.primary.id)).toEqual(["setl_B"]);
  });

  it("suggests (never auto-matches) at edit distance 2 or for a truncated UTR", () => {
    const d2 = stage2Bank(source({ settlements: [A], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("AXJSN26278123446"))] }), cfg);
    expect(ofType(d2, "SUGGESTED_MATCH")[0]?.trace).toMatchObject({ reason: "edit_distance_2" });
    expect(matchesOf(d2, "FUZZY")).toHaveLength(0);

    const truncated = stage2Bank(source({ settlements: [A, B], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("AXISN2627812"))] }), cfg);
    const [s] = ofType(truncated, "SUGGESTED_MATCH");
    expect(s?.trace).toMatchObject({ reason: "truncated_utr", suggested: { settlement_id: "setl_A" } });
  });

  it("treats amount and settlement-date window as hard requirements", () => {
    // Distance 2 with a different amount: no suggestion.
    const wrongAmount = stage2Bank(source({ settlements: [A], bankLines: [credit("bl1", "2026-10-05", 99_000, neft("AXJSN26278123446"))] }), cfg);
    expect(ofType(wrongAmount, "SUGGESTED_MATCH")).toHaveLength(0);
    expect(ofType(wrongAmount, "UNIDENTIFIED_BANK_CREDIT")).toHaveLength(1);
    // Distance 1 but the credit arrives 4 business days later (tolerance is 2).
    const late = stage2Bank(source({ settlements: [A], bankLines: [credit("bl1", "2026-10-09", 1_00_000, neft("AXJSN26278123456"))] }), cfg);
    expect(matchesOf(late, "FUZZY")).toHaveLength(0);
  });

  it("(c) links an exact or distance-1 UTR with the wrong amount and raises AMOUNT_MISMATCH by subtype", () => {
    const rounding = stage2Bank(source({ settlements: [A], bankLines: [credit("bl1", "2026-10-05", 1_00_050, neft(A.utr))] }), cfg);
    expect(matchesOf(rounding, "EXACT")).toHaveLength(1);
    expect(ofType(rounding, "AMOUNT_MISMATCH")[0]).toMatchObject({ subtype: "ROUNDING", amount_paise: 50 });
    expect(ofType(rounding, "UNIDENTIFIED_BANK_CREDIT")).toHaveLength(0);
    expect(ofType(rounding, "MISSING_BANK_CREDIT")).toHaveLength(0);

    const material = stage2Bank(source({ settlements: [A, B], bankLines: [credit("bl1", "2026-10-05", 1_50_000, neft("AXJSN26278123456"))] }), cfg);
    expect(matchesOf(material, "FUZZY")).toHaveLength(1);
    expect(ofType(material, "AMOUNT_MISMATCH")[0]).toMatchObject({ subtype: "MATERIAL", amount_paise: 50_000 });
  });
});

describe("stage 2b: batch decomposition", () => {
  const s1 = settlement("s1", "HDFCN26278000001", "2026-10-05", 1_00_000);
  const x = settlement("x", "HDFCN26278000002", "2026-10-05", 55_555);
  const s2 = settlement("s2", "HDFCN26278000003", "2026-10-06", 2_00_000);
  const payout = (id: string, date: string, amount: number) => credit(id, date, amount, neft("ICICN26279999999"));

  it("matches a unique contiguous run as BATCH_CONTIGUOUS and states the assumption", () => {
    const r = stage2Bank(source({ settlements: [s1, x, s2], bankLines: [payout("p1", "2026-10-06", 55_555 + 2_00_000)] }), cfg);
    const m = matchesOf(r, "BATCH_CONTIGUOUS");
    expect(m.map((v) => v.left.id).sort()).toEqual(["s2", "x"]);
    expect(m[0]?.trace.assumption).toBe(CONTIGUITY_ASSUMPTION);
    expect(ofType(r, "MISSING_BANK_CREDIT").map((e) => e.primary.id)).toEqual(["s1"]);
  });

  it("falls back to proof-only arbitrary subsets for a non-contiguous payout", () => {
    const r = stage2Bank(source({ settlements: [s1, x, s2], bankLines: [payout("p1", "2026-10-06", 1_00_000 + 2_00_000)] }), cfg);
    expect(matchesOf(r, "BATCH_CONTIGUOUS")).toHaveLength(0);
    expect(matchesOf(r, "BATCH").map((v) => v.left.id).sort()).toEqual(["s1", "s2"]);
  });

  it("leaves a credit with no decomposition unidentified", () => {
    const r = stage2Bank(source({ settlements: [s1, x], bankLines: [payout("p1", "2026-10-06", 77_777)] }), cfg);
    expect(ofType(r, "UNIDENTIFIED_BANK_CREDIT")[0]?.trace).toMatchObject({ batch: { status: "none" } });
  });

  it("(d) raises AMBIGUOUS_BATCH for equal-amount twin settlements, ranks candidates, and doesn't call the twin missing", () => {
    const a = settlement("twin_a", "AXISN26278000011", "2026-10-05", 97_000);
    const o = settlement("other", "AXISN26278000012", "2026-10-05", 1_50_000);
    const b = settlement("twin_b", "AXISN26278000013", "2026-10-06", 97_000);
    const r = stage2Bank(source({ settlements: [a, o, b], bankLines: [payout("p1", "2026-10-06", 2_47_000)] }), cfg);
    const [amb] = ofType(r, "AMBIGUOUS_BATCH");
    expect(amb?.candidate_sets?.map((set) => set.slice().sort())).toEqual([["other", "twin_b"], ["other", "twin_a"]]);
    expect(amb?.trace).toMatchObject({ uniqueness_proven: true, solutions_found: 2 });
    expect(r.matches.filter((m) => m.kind.startsWith("BATCH"))).toHaveLength(0);
    expect(ofType(r, "MISSING_BANK_CREDIT")).toHaveLength(0);
  });

  it("raises MATCH_CONFLICT when the unique batch needs a settlement that has a pending suggestion", () => {
    const S = settlement("S", "AXISN26278555555", "2026-10-05", 1_23_456);
    const o = settlement("o", "AXISN26278666666", "2026-10-05", 2_00_000);
    const decoy = credit("decoy", "2026-10-05", 1_23_456, neft("AXISN26278555588")); // distance 2 from S
    const r = stage2Bank(source({ settlements: [S, o], bankLines: [decoy, payout("p1", "2026-10-06", 3_23_456)] }), cfg);
    const [conflict] = ofType(r, "MATCH_CONFLICT");
    expect(conflict?.primary.id).toBe("p1");
    expect(conflict?.trace).toMatchObject({ conflicting_settlement_ids: ["S"], suggested_on_bank_lines: ["decoy"] });
    expect(ofType(r, "SUGGESTED_MATCH").map((e) => e.primary.id)).toEqual(["decoy"]);
    expect(r.matches.filter((m) => m.kind.startsWith("BATCH"))).toHaveLength(0);
    expect(ofType(r, "MISSING_BANK_CREDIT")).toHaveLength(0);
  });

  it("only considers settlements inside the W-business-day window", () => {
    const early = settlement("early", "AXISN26271000001", "2026-09-28", 1_00_000);
    const near = settlement("near", "AXISN26278000002", "2026-10-06", 2_00_000);
    const r = stage2Bank(source({ settlements: [early, near], bankLines: [payout("p1", "2026-10-06", 3_00_000)] }), cfg);
    expect(ofType(r, "UNIDENTIFIED_BANK_CREDIT")).toHaveLength(1);
  });
});

describe("stage 1: settlement items", () => {
  const p = payment("p1", 1_00_000, "card", "2026-10-05");
  const good = itemFor(p, "s1");

  it("accepts correct fee and GST-on-fee arithmetic", () => {
    const r = stage1Items(source({ payments: [p], items: [good], settlements: [settlement("s1", "U1", "2026-10-07", good.net_paise)] }), cfg);
    expect(r.exceptions).toHaveLength(0);
    expect(r.matches).toHaveLength(1);
  });

  it("raises FEE_GST_MISMATCH when GST is charged on the payment instead of the fee", () => {
    const gst = Math.floor((p.amount_paise * 1800 + 5000) / 10000);
    const bad = { ...good, gst_paise: gst, net_paise: p.amount_paise - good.fee_paise - gst };
    const r = stage1Items(source({ payments: [p], items: [bad], settlements: [settlement("s1", "U1", "2026-10-07", bad.net_paise)] }), cfg);
    expect(ofType(r, "FEE_GST_MISMATCH")[0]?.trace).toMatchObject({ gst_matches_wrong_base: true });
  });

  it("raises REFUND_AMOUNT_MISMATCH when the deduction differs from the refund", () => {
    const refund = { id: "r1", payment_id: "p1", amount_paise: 40_000, created_at: ts("2026-10-06") };
    const r = stage1Items(
      source({ payments: [p], refunds: [refund], items: [good, refundItem(refund, "s1", 40_500)], settlements: [settlement("s1", "U1", "2026-10-07", good.net_paise - 40_500)] }),
      cfg,
    );
    expect(ofType(r, "REFUND_AMOUNT_MISMATCH")[0]).toMatchObject({ amount_paise: 500, primary: { id: "r1" } });
  });

  it("raises MISSING_SETTLEMENT only after the method's window has elapsed", () => {
    const overdue = payment("p_old", 50_000, "upi", "2026-10-26");
    const fresh = payment("p_new", 50_000, "card", "2026-10-30"); // T+2 lands after 31 Oct
    const failed = payment("p_failed", 50_000, "upi", "2026-10-01", "failed");
    const r = stage1Items(source({ payments: [overdue, fresh, failed] }), cfg);
    expect(ofType(r, "MISSING_SETTLEMENT").map((e) => e.primary.id)).toEqual(["p_old"]);
    expect(r.pendingInWindow).toBe(1);
  });
});

describe("stage 4: business-day settlement windows", () => {
  // Card is T+2. Captured Fri 9 Oct; Sat 10 Oct (2nd Saturday) and Sun are bank holidays, so due Tue 13 Oct.
  const p = payment("p1", 1_00_000, "card", "2026-10-09");
  const run = (settledAt: string) =>
    stage4Timing(source({ payments: [p], items: [itemFor(p, "s1")], settlements: [settlement("s1", "U1", settledAt, itemFor(p, "s1").net_paise)] }), cfg);

  it("does not flag a settlement on the last business day of the window", () => {
    expect(run("2026-10-13")).toHaveLength(0);
  });

  it("flags TIMING_WINDOW_EXCEEDED one business day late", () => {
    const [e] = run("2026-10-14");
    expect(e?.type).toBe("TIMING_WINDOW_EXCEEDED");
    expect(e?.trace).toMatchObject({ earliest_due_date: "2026-10-13", max_business_days_late: 1 });
  });
});

describe("stage 3: bank ↔ ledger and the tie-out", () => {
  const line = credit("bl1", "2026-10-05", 1_00_000, neft("AXISN26278123456"));

  it("matches a receipt by reference, then flags a duplicate receipt", () => {
    const r = stage3Ledger(source({ bankLines: [line], ledger: [receipt("led1", "2026-10-05", 1_00_000, "AXISN26278123456"), receipt("led2", "2026-10-06", 1_00_000, "AXISN26278123456")] }), cfg);
    expect(matchesOf(r, "LEDGER_REF")).toHaveLength(1);
    expect(ofType(r, "DUPLICATE_LEDGER_ENTRY")[0]).toMatchObject({ primary: { id: "led2" } });
  });

  it("falls back to amount + date + party when the reference is absent or wrong", () => {
    const r = stage3Ledger(source({ bankLines: [line], ledger: [receipt("led1", "2026-10-06", 1_00_000, "")] }), cfg);
    expect(matchesOf(r, "LEDGER_ATTR")).toHaveLength(1);
  });

  it("raises BANK_LEDGER_MISMATCH per line when the receipt amount differs", () => {
    const r = stage3Ledger(source({ bankLines: [line], ledger: [receipt("led1", "2026-10-05", 99_000, "AXISN26278123456")] }), cfg);
    expect(ofType(r, "BANK_LEDGER_MISMATCH")[0]).toMatchObject({ primary: { id: "bl1" }, amount_paise: 1_000 });
  });

  it("raises BANK_LEDGER_MISMATCH for a receipt with no bank credit, and MISSING_LEDGER_ENTRY after the grace day", () => {
    const later = credit("bl2", "2026-10-30", 5_000, neft("AXISN26303000001"));
    const lastDay = credit("bl3", "2026-10-31", 6_000, neft("AXISN26304000001"));
    const r = stage3Ledger(source({ bankLines: [line, later, lastDay], ledger: [receipt("ghost", "2026-10-07", 4_44_444, "SBINN26280111111")] }), cfg);
    expect(ofType(r, "BANK_LEDGER_MISMATCH")[0]).toMatchObject({ primary: { id: "ghost" }, subtype: "RECEIPT_WITHOUT_BANK_CREDIT" });
    expect(ofType(r, "MISSING_LEDGER_ENTRY").map((e) => e.primary.id).sort()).toEqual(["bl1", "bl2"]);
    expect(r.pendingReceipts).toBe(1); // 31 Oct is still inside the one-business-day booking grace
  });

  it("checks one fee/GST journal per settlement", () => {
    const p = payment("p1", 1_00_000, "card", "2026-10-05");
    const item = itemFor(p, "s1");
    const s = settlement("s1", "U1", "2026-10-07", item.net_paise);
    const charges = item.fee_paise + item.gst_paise;
    const ok = stage3Ledger(source({ payments: [p], items: [item], settlements: [s], ledger: [journal("j1", "2026-10-07", charges, "s1")] }), cfg);
    expect(matchesOf(ok, "JOURNAL")).toHaveLength(1);
    expect(ok.exceptions).toHaveLength(0);
    const missing = stage3Ledger(source({ payments: [p], items: [item], settlements: [s] }), cfg);
    expect(ofType(missing, "MISSING_LEDGER_ENTRY")[0]).toMatchObject({ subtype: "JOURNAL", primary: { id: "s1" } });
  });

  it("explains the period difference with reconciling items and flags any unexplained residual", () => {
    const base = {
      from: "2026-10-01",
      to: "2026-10-31",
      bankCredits: [{ id: "bl1", date: "2026-10-05", amount_paise: 1_00_000 }, { id: "bl2", date: "2026-10-06", amount_paise: 50_000 }],
      receipts: [{ id: "r1", date: "2026-10-05", amount_paise: 99_000 }, { id: "r2", date: "2026-10-08", amount_paise: 7_000 }],
      pairs: [{ lineId: "bl1", receiptId: "r1" }],
      duplicateReceipts: [],
      unreceiptedCredits: ["bl2"],
    };
    const explained = computeTieOut({ ...base, unmatchedReceipts: ["r2"] });
    expect(explained.difference_paise).toBe(1_50_000 - 1_06_000);
    expect(explained.residual_paise).toBe(0);
    expect(tieOutExceptions(explained)).toHaveLength(0);

    // r2 is in the books but no stage explained it.
    const unexplained = computeTieOut({ ...base, unmatchedReceipts: [] });
    expect(unexplained.residual_paise).toBe(-7_000);
    expect(tieOutExceptions(unexplained)[0]).toMatchObject({ type: "BANK_LEDGER_MISMATCH", subtype: "UNEXPLAINED_TIE_OUT_RESIDUAL", amount_paise: 7_000 });
  });
});

describe("exposure classes", () => {
  it("maps every exception type and defaults unknown types to AMOUNT_AT_RISK", () => {
    for (const t of EXCEPTION_TYPES) expect(["AMOUNT_AT_RISK", "AWAITING_SETTLEMENT", "STRUCTURAL"]).toContain(exposureClassOf(t));
    expect(exposureClassOf("SOMETHING_NEW")).toBe("AMOUNT_AT_RISK");
    expect(exposureClassOf("MATCH_CONFLICT")).toBe("STRUCTURAL");
    expect(exposureClassOf("BANK_LEDGER_MISMATCH")).toBe("AMOUNT_AT_RISK");
  });

  it("reports exposure per class, never as one total", () => {
    const summary = summarizeExposure([
      { type: "MISSING_BANK_CREDIT", amount_paise: 100 },
      { type: "MISSING_SETTLEMENT", amount_paise: 200 },
      { type: "AMBIGUOUS_BATCH", amount_paise: 300 },
    ]);
    expect(summary).toEqual({
      AMOUNT_AT_RISK: { count: 1, amount_paise: 100 },
      AWAITING_SETTLEMENT: { count: 1, amount_paise: 200 },
      STRUCTURAL: { count: 1, amount_paise: 300 },
    });
    expect(Object.keys(summary)).not.toContain("total");
  });
});

describe("reconcile()", () => {
  it("is deterministic for the same input", () => {
    const src = source({ settlements: [A, B], bankLines: [credit("bl1", "2026-10-05", 1_00_000, neft("AXJSN26278123456"))] });
    const strip = (r: ReturnType<typeof reconcile>) => ({ m: r.matches, e: r.exceptions });
    expect(strip(reconcile(src, cfg, { from: "2026-10-01", to: "2026-10-31" }))).toEqual(strip(reconcile(src, cfg, { from: "2026-10-01", to: "2026-10-31" })));
  });
});
