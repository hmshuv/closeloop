import type { ReactNode } from "react";
import { Badge, Card } from "@/components/ui";
import { dateLabel, pct } from "@/lib/format";
import { snapshot, type ModeScore, type ModeTally } from "@/lib/snapshot";

type Row = [label: string, amountOnly: ReactNode, withReport: ReactNode];

function Rows({ heading, rows }: { heading: string; rows: Row[] }) {
  return (
    <>
      <tr>
        <th colSpan={3} className="pb-1 pt-3 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {heading}
        </th>
      </tr>
      {rows.map(([label, a, w]) => (
        <tr key={label} className="border-t border-zinc-100 dark:border-zinc-800">
          <td className="py-1.5 pr-3 text-zinc-700 dark:text-zinc-300">{label}</td>
          <td className="tabular py-1.5 pr-3 text-right">{a}</td>
          <td className="tabular py-1.5 text-right font-semibold text-emerald-800 dark:text-emerald-300">{w}</td>
        </tr>
      ))}
    </>
  );
}

const demoRows = (a: ModeTally, w: ModeTally): Row[] => [
  ["Batched credits matched from the report's rows", a.batch_credits.gateway_report, w.batch_credits.gateway_report],
  ["Batched credits matched on amounts alone", a.batch_credits.contiguous + a.batch_credits.subset, w.batch_credits.contiguous + w.batch_credits.subset],
  ["Ambiguous batches waiting for a human", a.ambiguous_batch, w.ambiguous_batch],
  ["Match conflicts waiting for a human", a.match_conflict, w.match_conflict],
  ["Settlements parked on a batch decision", a.unresolved_in_batch, w.unresolved_in_batch],
  ["Report ↔ bank mismatches raised", "—", w.gateway_report_mismatch],
];

const evalRows = (a: ModeScore, w: ModeScore): Row[] => [
  ["Batched credits matched to exactly the right settlements", pct([a.batch.correct, a.batch.n]), pct([w.batch.correct, w.batch.n])],
  ["… sent to a human as ambiguous", a.batch.ambiguous, w.batch.ambiguous],
  ["… blocked by a match conflict", a.batch.conflict, w.batch.conflict],
  ["Wrong links (all bank credits)", a.credits.wrong_links, w.credits.wrong_links],
  ["Human review items on bank credits", a.queue.ambiguous_batch + a.queue.match_conflict + a.queue.suggested_match, w.queue.ambiguous_batch + w.queue.match_conflict + w.queue.suggested_match + w.queue.gateway_report_mismatch],
];

/**
 * Overview card: the same data reconciled on amounts alone vs with the gateway's settlement recon report.
 * Both halves were computed by the engine (snapshot run and `pnpm eval`); nothing here is typed by hand.
 */
export function GatewayComparison() {
  const s = snapshot();
  const g = s.gateway_report;
  const ev = s.eval?.gateway_report_vs_amount_only;
  if (!g && !ev) return null;
  const n = ev?.amount_only.batch.n;
  return (
    <Card
      className="mb-6"
      title="Gateway report vs amount-only"
      subtitle="The gateway's settlement recon report says which settlements each bank transfer paid, so a batched credit is matched from its item-level rows instead of an amount-only subset search. Amounts must still agree to the paisa."
      action={<Badge tone="amber" title={g?.note}>Synthetic report</Badge>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="pb-1 pr-3 text-left font-medium" />
              <th className="pb-1 pr-3 text-right font-medium">Amount-only</th>
              <th className="pb-1 text-right font-medium">With gateway report</th>
            </tr>
          </thead>
          <tbody>
            {g && <Rows heading={`Demo data · open items as of ${dateLabel(g.as_of)}`} rows={demoRows(g.amount_only, g.with_report)} />}
            {ev && s.eval && <Rows heading={`Held-out eval · ${s.eval.seeds_used.length} seeds · ${n} batched credits`} rows={evalRows(ev.amount_only, ev.with_report)} />}
          </tbody>
        </table>
      </div>
      {g && (
        <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          {g.import.rows.toLocaleString("en-IN")} report rows covering {g.import.settlements_covered} settlements paid under {g.import.payout_utrs} bank transfer UTRs. The report is generated from the same synthetic data, so it never disagrees with the bank here; disagreements raise a mismatch exception instead of a match.
        </p>
      )}
    </Card>
  );
}
