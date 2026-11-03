import Link from "next/link";
import { Badge, Card, ClassBadge, PageTitle, Stat } from "@/components/ui";
import { CLASS_HINT, CLASS_LABEL, dateLabel, pct, TYPE_LABEL } from "@/lib/format";
import { snapshot } from "@/lib/snapshot";

export default function Overview() {
  const s = snapshot();
  const m = s.summary.matched;
  const t = s.summary.tie_out;
  const ev = s.eval;
  const evalUrl = s.repo_url ? `${s.repo_url}/blob/main/EVAL.md` : null;
  const top = s.exceptions.slice(0, 6);

  return (
    <>
      <PageTitle title={`Month-end close · ${dateLabel(s.period.from)} – ${dateLabel(s.period.to)}`}>
        Gateway settlements reconciled against the bank statement and the ledger as of {dateLabel(s.period.to)}. Every number on this page was computed by the deterministic engine; nothing here was typed by hand.
      </PageTitle>

      {ev && (
        <section aria-label="Evaluation results" className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">Results · held-out evaluation</h2>
            <span className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
              {ev.seeds_used.length} seeds × {ev.payments_per_dataset.toLocaleString("en-IN")} payments, unseen noise variants included ·{" "}
              {evalUrl ? (
                <a className="underline" href={evalUrl}>
                  full report (EVAL.md)
                </a>
              ) : (
                "full report in EVAL.md"
              )}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Credits linked to the right settlements", pct(ev.heldout.credits), `n=${ev.heldout.credits[1]} · ${ev.heldout.wrongLinks} wrong`],
              ["Batch credits decomposed correctly", pct(ev.heldout.batch), `${pct(ev.heldout.batchAmbiguous)} sent to a human`],
              ["Corrupted UTRs recovered", pct(ev.heldout.fuzzy), "incl. correct suggestions"],
              ["Exception recall / precision", `${(ev.heldout.macroRecall * 100).toFixed(1)}% / ${(ev.heldout.macroPrecision * 100).toFixed(1)}%`, "macro, 13 types"],
            ].map(([k, v, sub]) => (
              <div key={k}>
                <dt className="text-xs text-emerald-900/70 dark:text-emerald-200/70">{k}</dt>
                <dd className="tabular text-lg font-semibold text-emerald-950 dark:text-emerald-100">{v}</dd>
                <dd className="text-[11px] text-emerald-900/60 dark:text-emerald-200/60">{sub}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <h2 className="mb-2 text-sm font-semibold">Bank credits matched, by kind</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Exact UTR" value={m.bank_credits_exact_utr} sub="UTR found after normalising case, spaces, hyphens" tone="good" />
        <Stat label="Fuzzy UTR" value={m.bank_credits_fuzzy_utr} sub="Edit distance ≤ 1, exact amount and date, clear margin" tone="good" />
        <Stat label="Contiguous batch" value={m.bank_credits_batch_contiguous} sub="One credit = a run of consecutive settlements" tone="info" />
        <Stat label="Arbitrary batch" value={m.bank_credits_batch_subset} sub="Proven-unique subset of settlements" tone="info" />
      </div>
      <p className="-mt-4 mb-6 text-xs text-zinc-500 dark:text-zinc-400">
        {m.settlements_inside_batch_credits} settlements sit inside batch credits · {m.payments_settled.toLocaleString("en-IN")} payments settled · {m.ledger_receipts_by_reference + m.ledger_receipts_by_attributes} ledger receipts linked ({m.ledger_receipts_by_attributes} by amount + date + party) · {s.summary.pending.payments_in_settlement_window} payments still inside their T+n window
      </p>

      <h2 className="mb-2 text-sm font-semibold">Exposure by class</h2>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{s.summary.exposure_note}</p>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {s.summary.exposure_by_class.map((c) => (
          <Stat
            key={c.exposure_class}
            label={CLASS_LABEL[c.exposure_class] ?? c.exposure_class}
            value={c.total.amount_inr}
            sub={`${c.count} exception${c.count === 1 ? "" : "s"} · ${CLASS_HINT[c.exposure_class] ?? ""}`}
            tone={c.exposure_class === "AMOUNT_AT_RISK" ? "bad" : c.exposure_class === "AWAITING_SETTLEMENT" ? "warn" : "info"}
          />
        ))}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2" title="Bank vs books tie-out" subtitle="Σ bank credits − Σ ledger receipts must equal the reconciling items the engine identified.">
          <dl className="tabular space-y-2 text-sm">
            {[
              ["Bank credits", t.bank_credits.amount_inr],
              ["Ledger receipts", t.book_receipts.amount_inr],
              ["Difference", t.difference.amount_inr],
              ["Explained by reconciling items", t.explained_by_reconciling_items.amount_inr],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-zinc-600 dark:text-zinc-400">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-zinc-100 pt-2 font-semibold dark:border-zinc-800">
              <dt>Unexplained residual</dt>
              <dd className="flex items-center gap-2">
                {t.unexplained_residual.amount_inr}
                {t.unexplained_residual.amount_paise === 0 ? <Badge tone="green">Ties out</Badge> : <Badge tone="rose">Investigate</Badge>}
              </dd>
            </div>
          </dl>
        </Card>

        <Card
          className="lg:col-span-3"
          title="Largest exceptions"
          subtitle={`${s.summary.exceptions.total_count} exceptions in ${dateLabel(s.period.from).replace(/^\d+ /, "")}`}
          action={
            <Link href="/exceptions/" className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
              Open queue →
            </Link>
          }
        >
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {top.map((e) => (
              <li key={e.exception_id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <Link href={`/exceptions/${e.exception_id}/`} className="font-medium hover:underline">
                    {TYPE_LABEL[e.type] ?? e.type}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                    <ClassBadge value={e.exposure_class} />
                    <span className="truncate font-mono">{e.primary.id}</span>
                  </div>
                </div>
                <span className="tabular shrink-0 font-semibold">{e.amount.amount_inr}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">AI: {s.llm.note}</p>
    </>
  );
}
