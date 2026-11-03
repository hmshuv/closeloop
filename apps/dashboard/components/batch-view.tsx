import Link from "next/link";
import { BatchDiagram } from "@/components/batch-diagram";
import { Badge, Card, type Tone } from "@/components/ui";
import { dateLabel, KIND_LABEL } from "@/lib/format";
import { snapshot, type Decomposition } from "@/lib/snapshot";

const isSinglePayout = (b: Decomposition) => b.status === "decomposed" && b.settlements.length === 1;

function statusBadge(b: Decomposition): [string, Tone] {
  if (isSinglePayout(b)) return ["Single payout", "green"];
  const map: Record<Decomposition["status"], [string, Tone]> = {
    decomposed: ["Decomposed", "green"],
    matched_single_settlement: ["Single settlement", "green"],
    human_approved: ["Human approved", "green"],
    ambiguous: ["Ambiguous: needs a human", "amber"],
    conflict: ["Match conflict: needs a human", "rose"],
    suggested: ["Suggested match", "amber"],
    unidentified: ["Unidentified", "rose"],
  };
  return map[b.status];
}

/** Count-badge colour in the sidebar, keyed the same way as the legend below it. */
const countTone = (b: Decomposition): Tone => (b.status === "ambiguous" ? "amber" : b.status === "conflict" ? "rose" : "green");

const provenByFullSearch = (b: Decomposition) => b.match_kind === "BATCH_CONTIGUOUS" && b.full_search === "unique";

function uniquenessNote(b: Decomposition): string {
  if (b.match_kind === "BATCH_CONTIGUOUS") {
    const base = b.assumption ?? "Unique among contiguous runs (payout-model assumption).";
    return provenByFullSearch(b)
      ? `${base} Here the exhaustive subset search also found no other set of unmatched settlements that sums to this credit, so the match holds even without that assumption.`
      : base;
  }
  if (b.match_kind === "BATCH") return "Proven unique: an exhaustive subset search found exactly one set of unmatched settlements in the window that sums to this credit.";
  if (b.status === "ambiguous") return "Several different sets of settlements sum exactly to this credit, so the amounts alone cannot say which one is right. Candidate sets are ranked by contiguity, then date closeness.";
  if (b.status === "conflict") return "Exactly one set sums to this credit, but it needs a settlement that a different bank credit's suggested match also claims. The engine refuses to guess; a human decides which is right.";
  return b.note;
}

/** "15 settlements · contiguous run · ₹12,33,701.15 · difference ₹0.00" */
export function compactLine(b: Decomposition): string {
  const credit = b.bank_line.credit.amount_inr;
  const n = b.settlements.length;
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  if (b.status === "decomposed" || b.status === "human_approved") {
    const how = isSinglePayout(b) ? "single payout" : b.match_kind === "BATCH_CONTIGUOUS" ? "contiguous run" : b.match_kind === "BATCH" ? "proven-unique subset" : "human-approved set";
    return [plural(n, "settlement"), how, credit, `difference ${b.difference_vs_credit?.amount_inr ?? "—"}`].join(" · ");
  }
  if (b.status === "ambiguous") return [plural(b.candidate_sets.length, "candidate set"), "ambiguous", credit].join(" · ");
  if (b.status === "conflict") return [plural(b.candidate_sets[0]?.settlements.length ?? 0, "settlement"), "match conflict", credit].join(" · ");
  return [b.status.replace(/_/g, " "), credit].join(" · ");
}

export function BatchView({ b }: { b: Decomposition }) {
  const s = snapshot();
  const [label, tone] = statusBadge(b);
  const conflict = b.status === "conflict" && b.exception_id ? s.details[b.exception_id] : undefined;
  const conflicting = (conflict?.evidence.rule_trace.conflicting_settlement_ids as string[] | undefined) ?? [];
  const decoyIds = (conflict?.evidence.rule_trace.suggested_on_bank_lines as string[] | undefined) ?? [];
  const decoys = conflict?.evidence.records.filter((r) => decoyIds.includes(r.evidence_id)) ?? [];
  // For ambiguous credits, the settlements that differ between candidate sets are what a reviewer must decide on.
  const differing = b.status === "ambiguous" ? [...new Set(b.candidate_sets.flatMap((c) => c.settlement_ids))].filter((id) => !b.candidate_sets.every((c) => c.settlement_ids.includes(id))) : [];
  const highlight = b.status === "conflict" ? conflicting : differing;
  const highlightNote = b.status === "conflict" ? "settlement also claimed by a pending suggested match" : "settlement that differs between candidate sets";
  const creditLabel = `Bank credit ${b.bank_line.id}`;

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
          {b.match_kind && !isSinglePayout(b) && <Badge tone="sky">{KIND_LABEL[b.match_kind] ?? b.match_kind}</Badge>}
          {provenByFullSearch(b) && (
            <Badge tone="green" title="The exhaustive arbitrary-subset search also found exactly one set of settlements that sums to this credit">
              Proven unique (full search)
            </Badge>
          )}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">{uniquenessNote(b)}</p>

        {b.settlements.length > 0 && <BatchDiagram creditPaise={b.bank_line.credit.amount_paise} creditInr={b.bank_line.credit.amount_inr} settlements={b.settlements} label={creditLabel} />}

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
            <BatchDiagram creditPaise={b.bank_line.credit.amount_paise} creditInr={b.bank_line.credit.amount_inr} settlements={c.settlements} highlight={highlight} highlightNote={highlightNote} label={creditLabel} />
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

const LEGEND: [Tone, string][] = [
  ["green", "matched (batch or single payout)"],
  ["amber", "ambiguous: needs a human"],
  ["rose", "match conflict: needs a human"],
];

export function BatchIndex({ current }: { current: string }) {
  const s = snapshot();
  return (
    <Card title="Batch credits" subtitle="Bank credits matched by batch decomposition (including single payouts), plus the ones still waiting for a human.">
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
                <Badge tone={countTone(b)}>{b.settlements.length || b.candidate_sets[0]?.settlements.length || 0}</Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <p>The number is how many settlements the credit splits into.</p>
        {LEGEND.map(([tone, text]) => (
          <p key={tone} className="flex items-center gap-2">
            <Badge tone={tone}>n</Badge>
            {text}
          </p>
        ))}
      </div>
    </Card>
  );
}
