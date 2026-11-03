import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditTimeline } from "@/components/audit";
import { DraftCard, ExplanationCard } from "@/components/explanation";
import { JsonBlock, RecordCard } from "@/components/records";
import { Badge, Card, ClassBadge, PageTitle, StatusBadge } from "@/components/ui";
import { dateLabel, TYPE_LABEL } from "@/lib/format";
import { batchFor, snapshot } from "@/lib/snapshot";

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(snapshot().details).map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const d = snapshot().details[id];
  return { title: d ? `${TYPE_LABEL[d.evidence.exception.type] ?? d.evidence.exception.type} ${d.evidence.exception.amount.amount_inr}` : "Exception" };
}

export default async function ExceptionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = snapshot().details[id];
  if (!d) notFound();
  const e = d.evidence.exception;
  const batch = e.primary.type === "bank_line" ? batchFor(e.primary.id) : undefined;

  return (
    <>
      <Link href="/exceptions/" className="text-xs text-zinc-500 hover:underline">
        ← Exception queue
      </Link>
      <PageTitle title={`${TYPE_LABEL[e.type] ?? e.type}${e.subtype ? ` · ${e.subtype.toLowerCase()}` : ""}`}>{d.evidence.summary}</PageTitle>

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="tabular text-2xl font-semibold">{e.amount.amount_inr}</span>
        <ClassBadge value={e.exposure_class} />
        <StatusBadge value={e.status} />
        <Badge>{dateLabel(e.anchor_date)}</Badge>
        <Badge>
          {e.primary.type} {e.primary.id}
        </Badge>
        {batch && (
          <Link href={`/batches/${batch.bank_line.id}/`} className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            See batch decomposition →
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <ExplanationCard e={d.explanation} />
          {d.draft && <DraftCard d={d.draft} />}
          <Card title="Evidence records" subtitle="Read-only source records involved in this exception.">
            <div className="grid gap-3 md:grid-cols-2">
              {d.evidence.records.map((r) => (
                <RecordCard key={r.evidence_id} id={r.evidence_id} type={r.type} data={r.data} />
              ))}
            </div>
            {d.evidence.candidate_sets.length > 0 && (
              <p className="mt-3 text-xs text-zinc-500">
                {d.evidence.candidate_sets.length} candidate set(s) fit this credit exactly; see the batch decomposition page.
              </p>
            )}
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Rule trace" subtitle="The deterministic rule that fired and what it saw.">
            <JsonBlock value={d.evidence.rule_trace} />
          </Card>
          {d.evidence.deferred_settlements.length > 0 && (
            <Card title="Deferred settlements" subtitle="Possible members of this batch; re-evaluated when a human picks a set.">
              <ul className="space-y-1 font-mono text-xs">
                {d.evidence.deferred_settlements.map((s) => (
                  <li key={s.settlement_id} className="flex justify-between gap-2">
                    <span>{s.settlement_id}</span>
                    <span className="text-zinc-500">{s.status}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Audit history" subtitle="Append-only. Actor: system, llm or human.">
            <AuditTimeline events={d.evidence.audit_history} />
          </Card>
        </div>
      </div>
    </>
  );
}
