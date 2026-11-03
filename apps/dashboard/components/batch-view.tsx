import Link from "next/link";
import { BatchBar } from "@/components/batch-bar";
import { Badge, Card, type Tone } from "@/components/ui";
import { dateLabel, KIND_LABEL } from "@/lib/format";
import { snapshot, type Decomposition, type SettlementLine } from "@/lib/snapshot";

const STATUS: Record<Decomposition["status"], [string, Tone]> = {
  decomposed: ["Decomposed", "green"],
  matched_single_settlement: ["Single settlement", "green"],
  human_approved: ["Human approved", "green"],
  ambiguous: ["Ambiguous: needs a human", "amber"],
  conflict: ["Match conflict: needs a human", "rose"],
  suggested: ["Suggested match", "amber"],
  unidentified: ["Unidentified", "rose"],
};

function uniquenessNote(b: Decomposition): string {
  if (b.match_kind === "BATCH_CONTIGUOUS") return b.assumption ?? "Unique among contiguous runs (payout-model assumption).";
  if (b.match_kind === "BATCH") return "Proven unique: an exhaustive subset search found exactly one set of unmatched settlements in the window that sums to this credit.";
  if (b.status === "ambiguous") return "Several different sets of settlements sum exactly to this credit, so the amounts alone cannot say which one is right. Candidate sets are ranked by contiguity, then date closeness.";
  if (b.status === "conflict") return "Exactly one set sums to this credit, but it needs a settlement that a different bank credit's suggested match also claims. The engine refuses to guess; a human decides which is right.";
  return b.note;
}

function SettlementTable({ rows, highlight = [] }: { rows: SettlementLine[]; highlight?: string[] }) {
  return (
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
          {rows.map((s) => (
            <tr key={s.settlement_id} className={highlight.includes(s.settlement_id) ? "bg-rose-50 dark:bg-rose-950/40" : ""}>
              <td className="py-1 pr-3">{s.settlement_id}</td>
              <td className="py-1 pr-3">{s.utr}</td>
              <td className="py-1 pr-3">{s.settled_at}</td>
              <td className="py-1 text-right">{s.amount.amount_inr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BatchView({ b }: { b: Decomposition }) {
  const s = snapshot();
  const [label, tone] = STATUS[b.status];
  const conflict = b.status === "conflict" && b.exception_id ? s.details[b.exception_id] : undefined;
  const conflicting = (conflict?.evidence.rule_trace.conflicting_settlement_ids as string[] | undefined) ?? [];
  const decoyIds = (conflict?.evidence.rule_trace.suggested_on_bank_lines as string[] | undefined) ?? [];
  const decoys = conflict?.evidence.records.filter((r) => decoyIds.includes(r.evidence_id)) ?? [];
  // For ambiguous credits, the settlements that differ between candidate sets are what a reviewer must decide on.
  const differing = b.status === "ambiguous" ? [...new Set(b.candidate_sets.flatMap((c) => c.settlement_ids))].filter((id) => !b.candidate_sets.every((c) => c.settlement_ids.includes(id))) : [];
  const highlight = b.status === "conflict" ? conflicting : differing;
  const highlightNote = b.status === "conflict" ? "settlement also claimed by a pending suggested match" : "settlement that differs between candidate sets";

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{b.bank_line.id}</span>
          <span className="tabular">{b.bank_line.credit.amount_inr}</span>
          <span className="font-normal text-zinc-500">· {dateLabel(b.bank_line.txn_date)}</span>
        </span>
      }
      subtitle={<span className="break-all font-mono">{b.bank_line.narration}</span>}
      action={
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={tone}>{label}</Badge>
          {b.match_kind && <Badge tone="sky">{KIND_LABEL[b.match_kind] ?? b.match_kind}</Badge>}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">{uniquenessNote(b)}</p>

        {b.settlements.length > 0 && (
          <>
            <BatchBar creditPaise={b.bank_line.credit.amount_paise} creditInr={b.bank_line.credit.amount_inr} settlements={b.settlements} label={`Bank credit ${b.bank_line.id}`} />
            <SettlementTable rows={b.settlements} />
          </>
        )}

        {b.candidate_sets.map((c) => (
          <div key={c.index} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold">
                {b.status === "conflict" ? "The only set that fits" : `Candidate set #${c.index + 1}`} · {c.settlements.length} settlements
              </span>
              <span className="tabular flex items-center gap-2">
                Σ {c.total.amount_inr} {c.matches_credit ? <Badge tone="green">sums exactly</Badge> : <Badge tone="rose">off by {c.difference_vs_credit.amount_inr}</Badge>}
              </span>
            </div>
            <BatchBar creditPaise={b.bank_line.credit.amount_paise} creditInr={b.bank_line.credit.amount_inr} settlements={c.settlements} highlight={highlight} highlightNote={highlightNote} label={`Bank credit ${b.bank_line.id}`} />
            <SettlementTable rows={c.settlements} highlight={highlight} />
          </div>
        ))}

        {decoys.length > 0 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-xs dark:border-rose-900 dark:bg-rose-950/30">
            <div className="mb-1 font-semibold text-rose-900 dark:text-rose-200">The competing claim</div>
            {decoys.map((d) => (
              <p key={d.evidence_id} className="text-rose-900/80 dark:text-rose-200/80">
                Bank line <span className="font-mono">{d.evidence_id}</span> ({String(d.data.credit_inr)}) carries a look-alike UTR, <span className="font-mono">{String(d.data.narration)}</span>, and has a pending suggested match to the same settlement.
              </p>
            ))}
          </div>
        )}

        {b.exception_id && s.details[b.exception_id] && (
          <Link href={`/exceptions/${b.exception_id}/`} className="inline-block text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            Open the exception, evidence and explanation →
          </Link>
        )}
      </div>
    </Card>
  );
}

export function BatchIndex({ current }: { current: string }) {
  const s = snapshot();
  return (
    <Card title="All batch credits" subtitle="Every credit that nets several settlements, plus the unresolved ones.">
      <ul className="space-y-1 text-sm">
        {s.batches.map((b) => (
          <li key={b.bank_line.id}>
            <Link
              href={`/batches/${b.bank_line.id}/`}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 ${b.bank_line.id === current ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"}`}
            >
              <span className="font-mono text-xs">{b.bank_line.id}</span>
              <span className="flex items-center gap-2">
                <span className="tabular text-xs">{b.bank_line.credit.amount_inr}</span>
                <Badge tone={STATUS[b.status][1]}>{b.settlements.length || b.candidate_sets[0]?.settlements.length || 0}</Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
