import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchIndex, BatchView } from "@/components/batch-view";
import { PageTitle } from "@/components/ui";
import { batchFor, snapshot } from "@/lib/snapshot";

export const dynamicParams = false;

export function generateStaticParams() {
  return snapshot().batches.map((b) => ({ line: b.bank_line.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ line: string }> }): Promise<Metadata> {
  const { line } = await params;
  return { title: `Bank credit ${line}` };
}

export default async function BatchPage({ params }: { params: Promise<{ line: string }> }) {
  const { line } = await params;
  const b = batchFor(line);
  if (!b) notFound();
  return (
    <>
      <Link href="/batches/" className="text-xs text-zinc-500 hover:underline">
        ← Batch decomposition
      </Link>
      <PageTitle title={`Bank credit ${b.bank_line.id}`}>{b.summary}</PageTitle>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          <BatchView b={b} />
        </div>
        <aside>
          <BatchIndex current={b.bank_line.id} />
        </aside>
      </div>
    </>
  );
}
