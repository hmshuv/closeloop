import { describe, expect, it } from "vitest";
import { openReconDb, type Db } from "../src/db/open.ts";
import { stage2Bank } from "../src/matcher/stage2-bank.ts";
import { runReconciliation } from "../src/matcher/run.ts";
import { approveBatchCandidate } from "../src/review/batch.ts";
import type { BankLine, Settlement } from "../src/types.ts";
import { cfg, credit, neft, settlement, source } from "./fixtures.ts";

function dbWith(settlements: Settlement[], lines: BankLine[]): Db {
  const db = openReconDb(":memory:");
  const meta = db.prepare("INSERT INTO dataset_meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({ period_start: "2026-10-01", period_end: "2026-10-31", as_of: "2026-10-31" })) meta.run(k, v);
  const s = db.prepare("INSERT INTO settlements (id, utr, amount_paise, settled_at, created_at) VALUES (@id, @utr, @amount_paise, @settled_at, @created_at)");
  for (const row of settlements) s.run(row);
  const b = db.prepare("INSERT INTO bank_lines (id, txn_date, narration, credit_paise, debit_paise, balance_paise) VALUES (@id, @txn_date, @narration, @credit_paise, @debit_paise, @balance_paise)");
  for (const row of lines) b.run(row);
  return db;
}

describe("single-settlement batches", () => {
  const s = settlement("only", "AXISN26278000777", "2026-10-05", 1_11_111);
  const other = settlement("other", "AXISN26278000778", "2026-10-05", 2_22_222);

  it("auto-match when the narration names the gateway and the settlement is unique in the pool", () => {
    // UTR unreadable (no fuzzy evidence), but the narration identifies Razorpay.
    const r = stage2Bank(source({ settlements: [s, other], bankLines: [credit("bl1", "2026-10-05", 1_11_111, "NEFT CR-XXXXXXXXXXXX-RAZORPAY SOFTWARE")] }), cfg);
    const m = r.matches.filter((x) => x.kind.startsWith("BATCH"));
    expect(m.map((x) => x.left.id)).toEqual(["only"]);
    expect(m[0]?.trace).toMatchObject({ single_settlement: { gateway_pattern: "RAZORPAY", same_amount_in_pool: 1 } });
  });

  it("become SUGGESTED_MATCH when the narration doesn't identify the gateway", () => {
    const r = stage2Bank(source({ settlements: [s, other], bankLines: [credit("bl1", "2026-10-05", 1_11_111, "NEFT CR-XXXXXXXXXXXX-ACME TRADERS")] }), cfg);
    expect(r.matches.filter((x) => x.kind.startsWith("BATCH"))).toHaveLength(0);
    expect(r.exceptions.find((e) => e.type === "SUGGESTED_MATCH")?.trace).toMatchObject({ reason: "gateway_not_identified" });
  });

  it("become SUGGESTED_MATCH when another pool settlement has the same amount", () => {
    const twin = settlement("twin", "AXISN26278000779", "2026-10-05", 1_11_111);
    const r = stage2Bank(source({ settlements: [s, twin], bankLines: [credit("bl1", "2026-10-05", 1_11_111, "NEFT CR-XXXXXXXXXXXX-RAZORPAY SOFTWARE")] }), cfg);
    expect(r.matches.filter((x) => x.kind.startsWith("BATCH"))).toHaveLength(0);
    expect(r.exceptions.some((e) => e.type === "SUGGESTED_MATCH" || e.type === "AMBIGUOUS_BATCH")).toBe(true);
    expect(r.exceptions.some((e) => e.type === "MISSING_BANK_CREDIT")).toBe(false);
  });
});

describe("deferred missing credits", () => {
  // Equal-amount twins: the payout is either {other, twin_a} or {other, twin_b}.
  const a = settlement("twin_a", "AXISN26278000011", "2026-10-05", 97_000);
  const o = settlement("other", "AXISN26278000012", "2026-10-05", 1_50_000);
  const b = settlement("twin_b", "AXISN26278000013", "2026-10-06", 97_000);
  const payout = credit("p1", "2026-10-06", 2_47_000, neft("ICICN26279999999"));

  it("marks possible members unresolved_in_batch, then raises MISSING_BANK_CREDIT for the leftover once a set is approved", () => {
    const db = dbWith([a, o, b], [payout]);
    const { summary } = runReconciliation(db, cfg);
    expect(summary.exceptions_by_type.MISSING_BANK_CREDIT.count).toBe(0);
    expect(summary.pending.unresolved_in_batch).toBe(3);

    const exc = db.prepare("SELECT id FROM exceptions WHERE type = 'AMBIGUOUS_BATCH'").get() as { id: string };
    const reviews = db.prepare("SELECT settlement_id, status FROM settlement_reviews WHERE exception_id = ? ORDER BY settlement_id").all(exc.id);
    expect(reviews).toEqual([
      { settlement_id: "other", status: "unresolved_in_batch" },
      { settlement_id: "twin_a", status: "unresolved_in_batch" },
      { settlement_id: "twin_b", status: "unresolved_in_batch" },
    ]);

    const sets = db.prepare("SELECT set_index, settlement_ids_json FROM batch_candidate_sets WHERE exception_id = ?").all(exc.id) as { set_index: number; settlement_ids_json: string }[];
    const withA = sets.find((s) => s.settlement_ids_json.includes("twin_a"))!;
    const res = approveBatchCandidate(db, { exceptionId: exc.id, setIndex: withA.set_index, reviewer: "asha@finance" });

    expect(res.approved_settlement_ids.sort()).toEqual(["other", "twin_a"]);
    expect(res.leftovers).toEqual([{ settlement_id: "twin_b", outcome: "missing_raised", exception_id: expect.any(String) as string }]);
    const missing = db.prepare("SELECT primary_id, status, trace_json FROM exceptions WHERE type = 'MISSING_BANK_CREDIT'").all() as { primary_id: string; status: string; trace_json: string }[];
    expect(missing.map((m) => m.primary_id)).toEqual(["twin_b"]);
    expect(JSON.parse(missing[0]!.trace_json)).toMatchObject({ rule: "review.leftover_after_batch_approval", approved_exception_id: exc.id });
    expect(db.prepare("SELECT status FROM exceptions WHERE id = ?").get(exc.id)).toEqual({ status: "approved" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE kind = 'HUMAN_APPROVED'").get()).toEqual({ n: 2 });
    expect(() => approveBatchCandidate(db, { exceptionId: exc.id, setIndex: withA.set_index, reviewer: "asha@finance" })).toThrow(/already approved/);
  });
});
