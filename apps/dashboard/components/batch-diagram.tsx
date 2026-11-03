"use client";

import { useState } from "react";
import { inr } from "@/lib/format";
import type { SettlementLine } from "@/lib/snapshot";

const SEGMENT_COLOURS = ["bg-emerald-500", "bg-teal-500", "bg-cyan-500", "bg-sky-500", "bg-indigo-400", "bg-emerald-600", "bg-teal-600", "bg-cyan-600"];

/**
 * One bank credit drawn as a bar, split underneath into its settlements in time order, with the settlement
 * table below. Hovering (or focusing) a segment highlights its row and shows a tooltip; hovering a row
 * highlights its segment. Segment widths are proportional to amount; amounts are the engine's ₹ strings.
 */
export function BatchDiagram({
  creditPaise,
  creditInr,
  settlements,
  label,
  highlight = [],
  highlightNote,
}: {
  creditPaise: number;
  creditInr: string;
  settlements: SettlementLine[];
  label: string;
  highlight?: string[];
  highlightNote?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const total = settlements.reduce((s, x) => s + x.amount.amount_paise, 0);
  const scale = Math.max(total, creditPaise);
  let offset = 0;
  const segments = settlements.map((s) => {
    const width = (100 * s.amount.amount_paise) / scale;
    const seg = { s, left: offset, width };
    offset += width;
    return seg;
  });
  const current = segments.find((x) => x.s.settlement_id === active);

  return (
    <div className="space-y-3">
      <figure className="space-y-2">
        <div className="flex h-10 items-center justify-between rounded-lg bg-zinc-900 px-3 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
          <span className="truncate">{label}</span>
          <span className="tabular font-semibold">{creditInr}</span>
        </div>
        <div className="relative">
          {current && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-[11px] text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
              style={{ left: `${Math.min(Math.max(current.left + current.width / 2, 12), 88)}%` }}
            >
              <span className="font-mono">{current.s.settlement_id}</span> · <span className="tabular font-semibold">{current.s.amount.amount_inr}</span>
            </div>
          )}
          <div className="flex h-10 w-full overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-700" role="list" aria-label={`${settlements.length} settlements totalling ${inr(total)}`}>
            {segments.map(({ s, width }, i) => {
              const hot = highlight.includes(s.settlement_id);
              const dim = active !== null && active !== s.settlement_id;
              return (
                <div
                  key={s.settlement_id}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${s.settlement_id}, ${s.amount.amount_inr}`}
                  onMouseEnter={() => setActive(s.settlement_id)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(s.settlement_id)}
                  onBlur={() => setActive(null)}
                  style={{ width: `${width}%` }}
                  className={`min-w-[3px] cursor-pointer border-r border-white/70 outline-none transition-opacity last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900 dark:border-zinc-900/70 ${hot ? "bg-rose-500" : SEGMENT_COLOURS[i % SEGMENT_COLOURS.length]} ${dim ? "opacity-35" : ""}`}
                />
              );
            })}
          </div>
        </div>
        <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            {settlements.length} settlement{settlements.length === 1 ? "" : "s"} in time order · hover a segment or row
            {highlight.length && highlightNote ? ` · red = ${highlightNote}` : ""}
          </span>
          <span className="tabular">
            Σ {inr(total)} · difference {inr(creditPaise - total)}
          </span>
        </figcaption>
      </figure>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="py-1 pr-3 font-medium">Settlement</th>
              <th className="py-1 pr-3 font-medium">UTR</th>
              <th className="py-1 pr-3 font-medium">Settled</th>
              <th className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="tabular divide-y divide-zinc-100 whitespace-nowrap font-mono dark:divide-zinc-800">
            {settlements.map((s) => {
              const isActive = active === s.settlement_id;
              const hot = highlight.includes(s.settlement_id);
              return (
                <tr
                  key={s.settlement_id}
                  onMouseEnter={() => setActive(s.settlement_id)}
                  onMouseLeave={() => setActive(null)}
                  className={`${isActive ? "bg-emerald-50 dark:bg-emerald-950/50" : hot ? "bg-rose-50 dark:bg-rose-950/40" : ""} cursor-default`}
                >
                  <td className={`py-1 pr-3 ${isActive ? "font-semibold" : ""}`}>{s.settlement_id}</td>
                  <td className="py-1 pr-3">{s.utr}</td>
                  <td className="py-1 pr-3">{s.settled_at}</td>
                  <td className="py-1 text-right">{s.amount.amount_inr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
