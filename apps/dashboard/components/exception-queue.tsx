"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, ClassBadge, StatusBadge } from "@/components/ui";
import { CLASS_LABEL, inr, TYPE_LABEL } from "@/lib/format";
import type { ExceptionItem } from "@/lib/snapshot";

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ExceptionQueue({ items, llmIds }: { items: ExceptionItem[]; llmIds: string[] }) {
  const [type, setType] = useState("");
  const [cls, setCls] = useState("");
  const [status, setStatus] = useState("");
  const types = useMemo(() => [...new Set(items.map((i) => i.type))].sort(), [items]);
  const statuses = useMemo(() => [...new Set(items.map((i) => i.status))].sort(), [items]);
  const rows = items.filter((i) => (!type || i.type === type) && (!cls || i.exposure_class === cls) && (!status || i.status === status));
  const total = rows.reduce((s, i) => s + i.amount.amount_paise, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Type" value={type} onChange={setType} options={types.map((t) => [t, TYPE_LABEL[t] ?? t])} />
        <Select label="Exposure class" value={cls} onChange={setCls} options={Object.entries(CLASS_LABEL)} />
        <Select label="Status" value={status} onChange={setStatus} options={statuses.map((s) => [s, s])} />
        <p className="tabular ml-auto text-right text-sm text-zinc-600 dark:text-zinc-400">
          {rows.length} of {items.length}
          {cls ? (
            <span className="block font-medium text-zinc-900 dark:text-zinc-100">
              {CLASS_LABEL[cls]}: {inr(total)}
            </span>
          ) : (
            <span className="block text-[11px] text-zinc-400">Pick an exposure class to see its total; classes are never added together.</span>
          )}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="hidden w-full text-sm md:table">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 font-medium">Exception</th>
              <th className="px-4 py-2 font-medium">Exposure</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Record</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((i) => (
              <tr key={i.exception_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <td className="tabular px-4 py-2 text-right font-medium">{i.amount.amount_inr}</td>
                <td className="px-4 py-2">
                  <Link href={`/exceptions/${i.exception_id}/`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                    {TYPE_LABEL[i.type] ?? i.type}
                  </Link>
                  {i.subtype && <span className="ml-1 text-xs text-zinc-500">({i.subtype.toLowerCase()})</span>}
                  {llmIds.includes(i.exception_id) && (
                    <span className="ml-2">
                      <Badge tone="violet">LLM explained</Badge>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <ClassBadge value={i.exposure_class} />
                </td>
                <td className="px-4 py-2">
                  <StatusBadge value={i.status} />
                </td>
                <td className="tabular px-4 py-2 text-zinc-600 dark:text-zinc-400">{i.anchor_date}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{i.primary.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
          {rows.map((i) => (
            <li key={i.exception_id}>
              <Link href={`/exceptions/${i.exception_id}/`} className="block px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{TYPE_LABEL[i.type] ?? i.type}</span>
                  <span className="tabular font-semibold">{i.amount.amount_inr}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  <ClassBadge value={i.exposure_class} />
                  <StatusBadge value={i.status} />
                  <span className="tabular">{i.anchor_date}</span>
                  <span className="font-mono">{i.primary.id}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-500">No exceptions match these filters.</p>}
      </div>
    </div>
  );
}
