import { EXPOSURE_CLASSES } from "../matcher/types.ts";
import { formatINR } from "../money.ts";
import { EXCEPTION_TYPES, type Split } from "../types.ts";
import type { EvalResult, SeedRun } from "./run.ts";
import { BATCH_OUTCOMES, FUZZY_KINDS, FUZZY_OUTCOMES, type BatchOutcome, type Counts, type ModeScore, type SplitScore } from "./score.ts";

// ---------- aggregation ----------

const scores = (r: EvalResult, split: Split) => r.runs.map((x: SeedRun) => x[split]);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const pct = (num: number, den: number) => (den === 0 ? "—" : `${((100 * num) / den).toFixed(1)}%`);
const rate = (num: number, den: number) => `${pct(num, den)} (${num}/${den})`;

/** min / median / max of a per-seed rate, skipping seeds where the denominator is 0. */
function spread(per: SplitScore[], f: (s: SplitScore) => [number, number]): string {
  const rates = per.map(f).filter(([, d]) => d > 0).map(([n, d]) => (100 * n) / d);
  if (rates.length === 0) return "—";
  return `${Math.min(...rates).toFixed(1)} / ${median(rates).toFixed(1)} / ${Math.max(...rates).toFixed(1)}`;
}

function pooledCounts(per: SplitScore[], type: (typeof EXCEPTION_TYPES)[number]): Counts {
  return { tp: sum(per.map((s) => s.exceptions[type].tp)), fp: sum(per.map((s) => s.exceptions[type].fp)), fn: sum(per.map((s) => s.exceptions[type].fn)) };
}

function batchTotals(per: Pick<SplitScore, "batch">[], side: "contiguous" | "non_contiguous" | "all"): Record<BatchOutcome, number> {
  const out = Object.fromEntries(BATCH_OUTCOMES.map((o) => [o, 0])) as Record<BatchOutcome, number>;
  for (const s of per) for (const sd of side === "all" ? (["contiguous", "non_contiguous"] as const) : [side]) for (const o of BATCH_OUTCOMES) out[o] += s.batch[sd][o] ?? 0;
  return out;
}
const batchN = (b: Record<BatchOutcome, number>) => sum(Object.values(b));
const recovered = (f: Record<(typeof FUZZY_OUTCOMES)[number], number>) => f.auto_fuzzy + f.auto_other + f.suggested_correct;
const batchOk = (b: Record<BatchOutcome, number>) => b.correct_contiguous + b.correct_subset;

export interface Headline {
  credits: [number, number];
  fuzzy: [number, number];
  batch: [number, number];
  batchContiguous: [number, number];
  batchNonContiguous: [number, number];
  batchAmbiguous: [number, number];
  wrongLinks: number;
  missing: { n: number; detected: number; deferred: number; missed: number };
  macroRecall: number;
  macroPrecision: number;
  /** Exception types with at least one labelled case (the macro averages run over these). */
  typesScored: number;
  recordsPerSecond: number;
}

/** Held-out pooled over seeds, amount-only vs with the synthetic gateway recon report. */
export function gatewayComparison(r: EvalResult): { amount_only: ModeScore; with_report: ModeScore } {
  const pool = (side: "amount_only" | "with_report"): ModeScore => {
    const add = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));
    return r.runs
      .map((x) => x.gateway[side])
      .reduce((acc, m) => ({
        credits: add(acc.credits, m.credits) as ModeScore["credits"],
        batch: add(acc.batch, m.batch) as ModeScore["batch"],
        queue: add(acc.queue, m.queue) as ModeScore["queue"],
        unresolved_in_batch: acc.unresolved_in_batch + m.unresolved_in_batch,
        never_credited: add(acc.never_credited, m.never_credited) as ModeScore["never_credited"],
        decoys: add(acc.decoys, m.decoys) as ModeScore["decoys"],
      }));
  };
  return { amount_only: pool("amount_only"), with_report: pool("with_report") };
}

const queueSize = (m: ModeScore) => m.queue.ambiguous_batch + m.queue.match_conflict + m.queue.suggested_match + m.queue.gateway_report_mismatch;

export function headline(r: EvalResult, split: Split): Headline {
  const per = scores(r, split);
  const fuzzyRecovered = sum(per.flatMap((s) => FUZZY_KINDS.map((k) => recovered(s.fuzzy[k]))));
  const fuzzyN = sum(per.flatMap((s) => FUZZY_KINDS.map((k) => sum(Object.values(s.fuzzy[k])))));
  const all = batchTotals(per, "all");
  const contig = batchTotals(per, "contiguous");
  const non = batchTotals(per, "non_contiguous");
  const types = EXCEPTION_TYPES.map((t) => pooledCounts(per, t)).filter((c) => c.tp + c.fn > 0);
  const recall = types.map((c) => c.tp / (c.tp + c.fn));
  const precision = types.filter((c) => c.tp + c.fp > 0).map((c) => c.tp / (c.tp + c.fp));
  return {
    credits: [sum(per.map((s) => s.credits.correct)), sum(per.map((s) => s.credits.truth_linked))],
    fuzzy: [fuzzyRecovered, fuzzyN],
    batch: [batchOk(all), batchN(all)],
    batchContiguous: [batchOk(contig), batchN(contig)],
    batchNonContiguous: [batchOk(non), batchN(non)],
    batchAmbiguous: [all.ambiguous, batchN(all)],
    wrongLinks: sum(per.map((s) => s.credits.wrong + s.credits.false_links_on_unlinked)),
    missing: {
      n: sum(per.map((s) => s.missing_credit.n)),
      detected: sum(per.map((s) => s.missing_credit.detected)),
      deferred: sum(per.map((s) => s.missing_credit.deferred)),
      missed: sum(per.map((s) => s.missing_credit.missed)),
    },
    macroRecall: recall.length ? sum(recall) / recall.length : 0,
    macroPrecision: precision.length ? sum(precision) / precision.length : 0,
    typesScored: types.length,
    recordsPerSecond: sum(per.map((s) => s.records)) / (sum(per.map((s) => s.reconcile_ms)) / 1000),
  };
}

// ---------- markdown ----------

const table = (head: string[], rows: (string | number)[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export interface ReportMeta {
  generatedAt: string;
  commit: string | null;
  command: string;
}

export function renderEvalMarkdown(r: EvalResult, meta: ReportMeta): string {
  const o = r.options;
  const dev = scores(r, "dev");
  const held = scores(r, "heldout");
  const H = headline(r, "heldout");
  const D = headline(r, "dev");
  const out: string[] = [];

  out.push(
    "# CloseLoop evaluation",
    "",
    `> Generated by \`${meta.command}\` on ${meta.generatedAt}${meta.commit ? ` at commit \`${meta.commit}\`` : ""}. **Every number below comes from that run.** Re-run to regenerate; never edit by hand.`,
    "",
    `**Total eval runtime: ${(r.totalMs / 1000).toFixed(1)} s.**`,
    "",
    "## Setup",
    "",
    `- ${r.seedsUsed.length} independent synthetic datasets of ${o.payments.toLocaleString("en-IN")} payments over ${o.days} days (≈${Math.round(o.payments / o.days)} payments/day). Seeds were fixed up front, ${o.seeds.join(", ")}, and consumed in order. Used: **${r.seedsUsed.join(", ")}**${r.stoppedEarly ? " (stopped early)" : ""}.`,
    `- Stopping rule: stop once every evaluation target has ≥ ${o.minPerType} held-out truth labels. It looks only at ground-truth label counts, never at matcher results.`,
    "- Each dataset is split chronologically (last 20% of days = held-out). Every split is reconciled in its own in-memory database; ground truth sits in a separate in-memory database that the matcher never receives.",
    "- Held-out contains two noise variants the rules were never written around: a new payout narration format (`HELDOUT_NARRATION_FORMAT`) and OCR-style character confusions (`HELDOUT_OCR_CONFUSION`).",
    "- Noise rates are realistic (≈0.2–3% per kind) and never inflated to hit the minimums; the data grows instead.",
    "",
    r.shortfall.length
      ? `⚠️ **Coverage shortfall:** ${r.shortfall.map((c) => `${c.target} n=${c.count}`).join(", ")} (minimum ${o.minPerType}).`
      : `Coverage met: every target has ≥ ${o.minPerType} held-out labels.`,
    "",
    table(["Target", "Held-out n"], r.coverage.map((c) => [c.target, c.count])),
    "",
    "## Headline",
    "",
    "Pooled over all seeds; the spread column is the per-seed held-out min / median / max.",
    "",
    table(
      ["Metric", "Dev", "Held-out", "Held-out spread (min / median / max %)"],
      [
        ["Bank credits linked to exactly the right settlements", rate(...D.credits), rate(...H.credits), spread(held, (s) => [s.credits.correct, s.credits.truth_linked])],
        ["Wrong links (wrong set, or a link where none exists)", String(D.wrongLinks), String(H.wrongLinks), "—"],
        ["Fuzzy UTR recovery (auto + correct suggestion)", rate(...D.fuzzy), rate(...H.fuzzy), spread(held, (s) => [sum(FUZZY_KINDS.map((k) => recovered(s.fuzzy[k]))), sum(FUZZY_KINDS.map((k) => sum(Object.values(s.fuzzy[k]))))])],
        ["Batch credits decomposed correctly", rate(...D.batch), rate(...H.batch), spread(held, (s) => { const b = batchTotals([s], "all"); return [batchOk(b), batchN(b)]; })],
        ["… contiguous payouts", rate(...D.batchContiguous), rate(...H.batchContiguous), "—"],
        ["… non-contiguous payouts", rate(...D.batchNonContiguous), rate(...H.batchNonContiguous), "—"],
        ["Batch ambiguity rate (sent to a human)", rate(...D.batchAmbiguous), rate(...H.batchAmbiguous), "—"],
        ["Exception recall (macro over types)", pct(D.macroRecall, 1), pct(H.macroRecall, 1), "—"],
        ["Exception precision (macro over types)", pct(D.macroPrecision, 1), pct(H.macroPrecision, 1), "—"],
        ["Throughput (records/s, reconcile only)", Math.round(D.recordsPerSecond).toLocaleString("en-IN"), Math.round(H.recordsPerSecond).toLocaleString("en-IN"), "—"],
      ],
    ),
    "",
    "## Exceptions: precision and recall per type",
    "",
    "TP = flagged on the labelled record; FP = flagged where no label expects it; FN = labelled but not flagged. A SUGGESTED_MATCH also counts as TP when its top candidate is the credit's true settlement. A DUPLICATE_LEDGER_ENTRY counts whichever entry of the pair is named.",
    "",
  );
  const typeRows = (per: SplitScore[]) =>
    EXCEPTION_TYPES.map((t) => {
      const c = pooledCounts(per, t);
      return [t, c.tp + c.fn, c.tp, c.fp, c.fn, pct(c.tp, c.tp + c.fp), pct(c.tp, c.tp + c.fn)];
    });
  out.push("### Held-out", "", table(["Type", "n (labelled)", "TP", "FP", "FN", "Precision", "Recall"], typeRows(held)), "");
  out.push(
    "Per-seed held-out recall (min / median / max %):",
    "",
    table(["Type", "Recall spread"], EXCEPTION_TYPES.map((t) => [t, spread(held, (s) => [s.exceptions[t].tp, s.exceptions[t].tp + s.exceptions[t].fn])])),
    "",
  );
  out.push("### Dev", "", table(["Type", "n (labelled)", "TP", "FP", "FN", "Precision", "Recall"], typeRows(dev)), "");

  const kinds = [...new Set([...dev, ...held].flatMap((s) => Object.keys(s.credits.by_kind)))].sort();
  out.push(
    "## Match rate by match kind",
    "",
    "Share of truth-linked bank credits auto-linked by each kind, and how often that kind's link was exactly right.",
    "",
    table(
      ["Kind", "Dev: share of credits", "Dev: correct", "Held-out: share of credits", "Held-out: correct"],
      kinds.map((k) => {
        const dm = sum(dev.map((s) => s.credits.by_kind[k]?.matched ?? 0));
        const dc = sum(dev.map((s) => s.credits.by_kind[k]?.correct ?? 0));
        const hm = sum(held.map((s) => s.credits.by_kind[k]?.matched ?? 0));
        const hc = sum(held.map((s) => s.credits.by_kind[k]?.correct ?? 0));
        return [k, rate(dm, D.credits[1]), rate(dc, dm), rate(hm, H.credits[1]), rate(hc, hm)];
      }),
    ),
    "",
    `Left for a human (no auto-link): dev ${sum(dev.map((s) => s.credits.unmatched))}, held-out ${sum(held.map((s) => s.credits.unmatched))}. Exact matching after normalising case/spaces/hyphens: dev ${rate(sum(dev.map((s) => s.exact_normalized.correct)), sum(dev.map((s) => s.exact_normalized.n)))}, held-out ${rate(sum(held.map((s) => s.exact_normalized.correct)), sum(held.map((s) => s.exact_normalized.n)))}. Ledger receipts with a wrong/absent reference re-linked by amount + date + party: dev ${rate(sum(dev.map((s) => s.ledger_attr.correct)), sum(dev.map((s) => s.ledger_attr.n)))}, held-out ${rate(sum(held.map((s) => s.ledger_attr.correct)), sum(held.map((s) => s.ledger_attr.n)))}.`,
    "",
  );

  const batchRows = (label: string, per: Pick<SplitScore, "batch">[]) =>
    (["contiguous", "non_contiguous"] as const).map((side) => {
      const b = batchTotals(per, side);
      return [label, side.replace("_", "-"), batchN(b), ...BATCH_OUTCOMES.map((o) => b[o]), pct(batchOk(b), batchN(b)), pct(b.ambiguous, batchN(b))];
    });
  out.push(
    "## Batch decomposition",
    "",
    "Outcome for every consolidated bank credit, by whether its settlements really were consecutive in time.",
    "",
    table(["Split", "Payout", "n", ...BATCH_OUTCOMES, "Success", "Ambiguity"], [...batchRows("dev", dev), ...batchRows("held-out", held)]),
    "",
    "### By daily volume",
    "",
    table(
      ["Payments / dataset", "≈ payments/day", "Seeds", "Consolidated credits", "Success", "Contiguous success", "Non-contiguous success", "Ambiguity", "Max candidate pool"],
      r.sweep.map((s) => {
        const all = batchTotals([s.score], "all");
        const c = batchTotals([s.score], "contiguous");
        const n = batchTotals([s.score], "non_contiguous");
        return [s.payments.toLocaleString("en-IN"), s.payments_per_day, s.seeds.join(", "), batchN(all), rate(batchOk(all), batchN(all)), rate(batchOk(c), batchN(c)), rate(batchOk(n), batchN(n)), rate(all.ambiguous, batchN(all)), s.max_pool];
      }),
    ),
    "",
    "**Why amount-only decomposition gets ambiguous at scale.** The candidate pool for a credit is every unmatched settlement paid in the window before it, so it grows with daily volume. Once a pool holds a few dozen settlements of lakh-scale amounts, the number of possible subsets (2ⁿ) exceeds the number of distinct paise totals, and other subsets genuinely sum to the same figure. No algorithm can recover what the amounts don't determine. CloseLoop auto-matches only proven-unique subsets, or a unique contiguous run under a stated payout-model assumption, and sends everything else to a human with ranked candidate sets. The way out is the gateway's own recon report, which lists the settlements inside each payout: see the next section.",
    "",
  );

  const G = gatewayComparison(r);
  const A = G.amount_only;
  const W = G.with_report;
  out.push(
    "## Gateway recon report vs amount-only (held-out)",
    "",
    `The same held-out data reconciled twice per seed: once on amounts alone, once after importing a Razorpay settlement recon report (documented \`recon/combined\` format) generated from the same synthetic data. The report gives each settlement's \`settlement_utr\`, so a batched credit is matched from item-level rows (\`BATCH_FROM_GATEWAY_REPORT\`), still checked to the paisa against the bank. Scored from truth links only, so both modes are judged identically. Pooled over ${r.seedsUsed.length} seeds.`,
    "",
    table(
      ["Metric", "Amount-only", "With gateway report"],
      [
        ["Batched bank credits matched to exactly the right settlements", rate(A.batch.correct, A.batch.n), rate(W.batch.correct, W.batch.n)],
        ["… sent to a human as ambiguous (AMBIGUOUS_BATCH)", rate(A.batch.ambiguous, A.batch.n), rate(W.batch.ambiguous, W.batch.n)],
        ["… blocked by a match conflict", rate(A.batch.conflict, A.batch.n), rate(W.batch.conflict, W.batch.n)],
        ["… matched to the wrong set", rate(A.batch.wrong, A.batch.n), rate(W.batch.wrong, W.batch.n)],
        ["… held for a report-vs-bank mismatch", rate(A.batch.report_mismatch, A.batch.n), rate(W.batch.report_mismatch, W.batch.n)],
        ["All bank credits linked to exactly the right settlements", rate(A.credits.correct, A.credits.truth_linked), rate(W.credits.correct, W.credits.truth_linked)],
        ["Wrong links", A.credits.wrong_links, W.credits.wrong_links],
        ["Settlements waiting on a batch decision (`unresolved_in_batch`)", A.unresolved_in_batch, W.unresolved_in_batch],
        ["Settlements never credited, flagged MISSING_BANK_CREDIT", rate(A.never_credited.detected, A.never_credited.n), rate(W.never_credited.detected, W.never_credited.n)],
        ["Look-alike decoy credits wrongly suggested for a settlement", rate(A.decoys.suggested, A.decoys.n), rate(W.decoys.suggested, W.decoys.n)],
        ["Human review items on bank credits (ambiguous + conflict + suggested + report mismatch)", queueSize(A), queueSize(W)],
        ["GATEWAY_REPORT_MISMATCH raised", A.queue.gateway_report_mismatch, W.queue.gateway_report_mismatch],
      ],
    ),
    "",
    "This measures what item-level links buy, not how the engine handles a faulty report: see Limitations.",
    "",
  );

  const fuzzyRows = (per: SplitScore[], split: string) =>
    FUZZY_KINDS.map((k) => {
      const t = Object.fromEntries(FUZZY_OUTCOMES.map((o) => [o, sum(per.map((s) => s.fuzzy[k][o]))])) as Record<(typeof FUZZY_OUTCOMES)[number], number>;
      const n = sum(Object.values(t));
      return [split, k + (k.startsWith("HELDOUT") ? " (held-out only)" : ""), n, ...FUZZY_OUTCOMES.map((o) => t[o]), pct(recovered(t), n)];
    }).filter((row) => Number(row[2]) > 0);
  out.push("## Fuzzy UTR recovery", "", "`auto_fuzzy` = linked by the fuzzy UTR stage (edit distance ≤ 1 with margin); `auto_other` = recovered by a later stage instead, typically an amount-only single-settlement match on a gateway narration; `suggested_correct` = sent to a human with the right settlement on top. Recovered = all three.", "", table(["Split", "Noise kind", "n", ...FUZZY_OUTCOMES, "Recovered"], [...fuzzyRows(dev, "dev"), ...fuzzyRows(held, "held-out")]), "");

  out.push(
    "## Missing bank credits: detected / deferred-to-human / missed",
    "",
    "A settlement that could belong to an open AMBIGUOUS_BATCH is deferred (status `unresolved_in_batch`), not reported missing; it is re-evaluated when a human approves a candidate set.",
    "",
    table(
      ["Split", "n", "Detected", "Deferred to human", "Missed"],
      ([["dev", D], ["held-out", H]] as const).map(([name, h]) => [name, h.missing.n, rate(h.missing.detected, h.missing.n), rate(h.missing.deferred, h.missing.n), rate(h.missing.missed, h.missing.n)]),
    ),
    "",
    "## Exposure by class",
    "",
    "Pooled across seeds. Classes measure different things and are never summed.",
    "",
    table(
      ["Split", ...EXPOSURE_CLASSES],
      ([["dev", dev], ["held-out", held]] as const).map(([name, per]) => [name, ...EXPOSURE_CLASSES.map((c) => `${formatINR(sum(per.map((s) => s.exposure[c].amount_paise)))} (${sum(per.map((s) => s.exposure[c].count))})`)]),
    ),
    "",
    "## Throughput",
    "",
    table(
      ["Seed", "Split", "Records", "Reconcile ms", "Records/s"],
      r.runs.flatMap((x) => [x.dev, x.heldout]).map((s) => [s.seed, s.split, s.records.toLocaleString("en-IN"), Math.round(s.reconcile_ms), Math.round(s.records / (s.reconcile_ms / 1000)).toLocaleString("en-IN")]),
    ),
    "",
  );

  const misses = held.flatMap((s) => s.misses);
  const byCategory = new Map<string, { kind: string; type: string; n: number; examples: string[] }>();
  for (const m of misses) {
    const key = `${m.kind}|${m.type}|${m.category}`;
    const c = byCategory.get(key) ?? { kind: m.kind, type: m.type, n: 0, examples: [] };
    c.n++;
    if (c.examples.length < 3) c.examples.push(m.entity_id);
    byCategory.set(key, c);
  }
  const misscats = [...byCategory.entries()].sort((a, b) => b[1].n - a[1].n);
  out.push(
    "## Held-out misses, categorised",
    "",
    misses.length === 0
      ? "None: held-out precision and recall are 100% for every type."
      : `${misses.length} held-out misses (${misses.filter((m) => m.kind === "FN").length} FN, ${misses.filter((m) => m.kind === "FP").length} FP), grouped by cause.`,
    "",
    ...(misses.length ? [table(["Kind", "Type", "Cause", "n", "Examples"], misscats.map(([key, c]) => [c.kind, c.type, key.split("|")[2] ?? "", c.n, c.examples.map((e) => `\`${e}\``).join(", ")]))] : []),
    "",
  );
  out.push(
    "## Limitations",
    "",
    "- **Synthetic data only.** Every dataset comes from CloseLoop's own generator. The held-out noise variants reduce, but don't remove, the bias of the same author writing the generator and the matcher.",
    `- **The gateway recon report always agrees with the bank.** The report in the comparison above is generated from the same synthetic data as the bank statement, so it never disagrees with it, and GATEWAY_REPORT_MISMATCH is never raised in this eval (${W.queue.gateway_report_mismatch} raised). That exception is covered by unit tests only (\`packages/core/test/gateway.test.ts\`: a bank credit off by one paisa, report rows that don't add up to the settlement), not by this eval. The eval also never sees a partial or late report, a report with extra or missing rows, or real dashboard export formats.`,
    "- **Exception labels assume amount-only matching.** For example, an ambiguity trap is labelled AMBIGUOUS_BATCH. The per-type precision and recall above are therefore reported for amount-only mode only; the gateway comparison is scored from truth links.",
    "",
  );
  return out.join("\n");
}

/** The Results block for the README, built from the same run. */
export function renderReadmeResults(r: EvalResult): string {
  const H = headline(r, "heldout");
  return [
    `- **Held-out** (${r.seedsUsed.length} seeds × ${r.options.payments.toLocaleString("en-IN")} payments, unseen noise variants included): ${pct(...H.credits)} of bank credits linked to exactly the right settlements (n=${H.credits[1]}), ${H.wrongLinks} wrong link${H.wrongLinks === 1 ? "" : "s"}; corrupted UTRs recovered ${pct(...H.fuzzy)} (n=${H.fuzzy[1]}), counting correct suggestions a human still confirms.`,
    `- **Batch credits:** ${pct(...H.batch)} decomposed correctly (contiguous ${pct(...H.batchContiguous)}, non-contiguous ${pct(...H.batchNonContiguous)}), ${pct(...H.batchAmbiguous)} sent to a human as ambiguous; missing bank credits ${H.missing.detected} detected / ${H.missing.deferred} deferred / ${H.missing.missed} missed.`,
    (() => {
      const { amount_only: A, with_report: W } = gatewayComparison(r);
      return `- **With Razorpay's settlement recon report** (same held-out data): batched credits matched exactly right ${pct(W.batch.correct, W.batch.n)} vs ${pct(A.batch.correct, A.batch.n)} amount-only (n=${W.batch.n}); ambiguous ${A.batch.ambiguous} → ${W.batch.ambiguous}, match conflicts ${A.batch.conflict} → ${W.batch.conflict}, human review items ${queueSize(A)} → ${queueSize(W)}.`;
    })(),
    `- **Exceptions:** macro recall ${pct(H.macroRecall, 1)}, precision ${pct(H.macroPrecision, 1)} across ${H.typesScored} types; ${Math.round(H.recordsPerSecond).toLocaleString("en-IN")} records/s; full eval ${(r.totalMs / 1000).toFixed(1)} s. Details in [EVAL.md](EVAL.md).`,
  ].join("\n");
}
