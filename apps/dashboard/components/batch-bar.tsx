import { inr } from "@/lib/format";
import type { SettlementLine } from "@/lib/snapshot";

const SEGMENT_COLOURS = ["bg-emerald-500", "bg-teal-500", "bg-cyan-500", "bg-sky-500", "bg-indigo-400", "bg-emerald-600", "bg-teal-600", "bg-cyan-600"];

/**
 * One bank credit drawn as a bar, split underneath into its settlements in time order. Segment widths are
 * proportional to amount; the amounts themselves are the engine's pre-formatted strings.
 */
export function BatchBar({ creditPaise, creditInr, settlements, highlight = [], highlightNote, label }: { creditPaise: number; creditInr: string; settlements: SettlementLine[]; highlight?: string[]; highlightNote?: string; label?: string }) {
  const total = settlements.reduce((s, x) => s + x.amount.amount_paise, 0);
  return (
    <figure className="space-y-2">
      <div className="flex h-10 items-center justify-between rounded-lg bg-zinc-900 px-3 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
        <span className="truncate">{label ?? "Bank credit"}</span>
        <span className="tabular font-semibold">{creditInr}</span>
      </div>
      <div className="flex h-10 w-full overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-700" role="img" aria-label={`${settlements.length} settlements totalling ${inr(total)}`}>
        {settlements.map((s, i) => {
          const hot = highlight.includes(s.settlement_id);
          return (
            <div
              key={s.settlement_id}
              title={`${s.settlement_id} · ${s.utr} · ${s.amount.amount_inr} · settled ${s.settled_at}`}
              style={{ width: `${(100 * s.amount.amount_paise) / Math.max(total, creditPaise)}%` }}
              className={`relative min-w-[3px] border-r border-white/70 last:border-r-0 dark:border-zinc-900/70 ${hot ? "bg-rose-500" : SEGMENT_COLOURS[i % SEGMENT_COLOURS.length]}`}
            />
          );
        })}
      </div>
      <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          {settlements.length} settlement{settlements.length === 1 ? "" : "s"} in time order{highlight.length && highlightNote ? ` · red = ${highlightNote}` : ""}
        </span>
        <span className="tabular">
          Σ {inr(total)} · difference {inr(creditPaise - total)}
        </span>
      </figcaption>
    </figure>
  );
}
