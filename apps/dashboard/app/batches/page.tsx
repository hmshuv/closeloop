import type { Metadata } from "next";
import { BatchIndex, BatchView } from "@/components/batch-view";
import { PageTitle } from "@/components/ui";
import { batchFor, snapshot } from "@/lib/snapshot";

export const metadata: Metadata = { title: "Batch decomposition" };

export default function BatchesPage() {
  const s = snapshot();
  const main = batchFor(s.default_batch_line ?? "bnk_000080") ?? s.batches[0];
  const ambiguous = s.batches.filter((b) => b.status === "ambiguous");
  const conflicts = s.batches.filter((b) => b.status === "conflict");
  return (
    <>
      <PageTitle title="Batch decomposition">
        One bank credit can net many gateway settlements. The engine first looks for a unique run of consecutive settlements, then for a proven-unique subset; anything it cannot prove goes to a human with ranked candidate sets.
      </PageTitle>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-8">
          {main && <BatchView b={main} />}
          {ambiguous.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Ambiguous: ranked candidate sets</h2>
              {ambiguous.map((b) => (
                <BatchView key={b.bank_line.id} b={b} />
              ))}
            </section>
          )}
          {conflicts.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Match conflict</h2>
              {conflicts.map((b) => (
                <BatchView key={b.bank_line.id} b={b} />
              ))}
            </section>
          )}
        </div>
        <aside>
          <BatchIndex current={main?.bank_line.id ?? ""} />
        </aside>
      </div>
    </>
  );
}
