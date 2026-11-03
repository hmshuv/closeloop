import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { Card, Mono, PageTitle } from "@/components/ui";

export const metadata: Metadata = { title: "How it works" };

const STAGES = [
  ["1", "Payment ↔ settlement item", "Exact id link. Fee and 18% GST on the fee re-computed in integer paise; any difference is an exception."],
  ["2a", "Exact UTR", "Settlement UTR found in the bank narration after normalising case, spaces and hyphens."],
  ["2c", "Fuzzy UTR", "Edit distance on the UTR: ≤ 1 with a clear margin auto-matches; 2 or truncated is only suggested. Exact amount and date are required."],
  ["2b", "Batch decomposition", "A unique run of consecutive settlements, else a proven-unique subset (meet-in-the-middle / budgeted branch-and-bound). Otherwise: ranked candidate sets for a human."],
  ["3", "Bank ↔ ledger", "Receipts by reference, then amount + date + party. Duplicates, mismatches and missing entries; a period tie-out must explain every rupee."],
  ["4", "Timing", "Per-method T+n windows on Indian business days (Sundays, 2nd and 4th Saturdays, holidays). Late is always reported."],
];

const TRUST: { title: string; tone: string; points: string[] }[] = [
  {
    title: "Deterministic engine",
    tone: "border-t-emerald-500",
    points: ["Decides every match, exception and exposure class", "All money is integer paise; no floats", "Auto-matches a batch only with a uniqueness proof (or a stated contiguity assumption)", "Financial records are insert-only and can be mounted read-only"],
  },
  {
    title: "Constrained AI layer",
    tone: "border-t-violet-500",
    points: [
      "Reads a read-only evidence bundle; never writes financial data",
      "May suggest UTR tokens only if they literally appear in the narration",
      "Explanations citing evidence outside the bundle are rejected",
      "Draft journals must balance to the engine's amount; status pending_approval",
      "Any failure falls back to a deterministic template, labelled as such",
    ],
  },
  {
    title: "Human reviewer",
    tone: "border-t-amber-500",
    points: ["Approves suggestions and picks batch candidate sets", "Two steps: preview + 5-minute token, then token + name", "Every action lands in the append-only audit trail", "Approving a set re-checks the leftover settlements"],
  },
];

const TOOLS = ["run_reconciliation", "list_exceptions", "get_evidence", "explain_exception", "decompose_bank_credit", "draft_journal_entry", "approve_suggestion", "escalate", "get_audit_trail"];

export default function HowItWorks() {
  const media = ["demo.gif", "demo.png", "demo.webp"].find((f) => existsSync(join(process.cwd(), "public", f)));
  return (
    <>
      <PageTitle title="How it works">Keep financial truth deterministic; use AI only where the data is messy, and only from read-only evidence.</PageTitle>

      <h2 className="mb-3 text-sm font-semibold">Pipeline</h2>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["Sources", "Payments, refunds, gateway settlements, bank statement, ledger export. Insert-only, or attached read-only from the customer's export."],
          ...STAGES.map(([n, t, d]) => [`Stage ${n} · ${t}`, d]),
          ["Output", "Matches, exceptions with machine-readable rule traces, exposure per class, the tie-out, and an append-only audit trail."],
        ].map(([title, body], i) => (
          <div key={title} className="relative rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-1 text-xs font-medium text-zinc-400">{String(i + 1).padStart(2, "0")}</div>
            <div className="text-sm font-semibold">{title}</div>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{body}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-semibold">Trust boundary</h2>
      <div className="mb-8 grid gap-3 md:grid-cols-3">
        {TRUST.map((t) => (
          <div key={t.title} className={`rounded-xl border border-t-4 border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${t.tone}`}>
            <div className="text-sm font-semibold">{t.title}</div>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
              {t.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Run the full agent with approvals (MCP)" subtitle="This site is a read-only snapshot. The agent runs locally over stdio.">
          <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-100">{"npx -y closeloop-mcp          # MCP server; seeds demo data on first run\nnpx -y closeloop-mcp check    # one reconciliation, summary to stderr"}</pre>
          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">Claude Desktop config:</p>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-100">{'{ "mcpServers": { "closeloop": { "command": "npx", "args": ["-y", "closeloop-mcp"] } } }'}</pre>
          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">Tools:</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {TOOLS.map((t) => (
              <Mono key={t}>{t}</Mono>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            Plus the <Mono>month_end_review</Mono> prompt and the <Mono>closeloop://summary/latest</Mono> resource. Every amount arrives pre-formatted with totals, so the model never does arithmetic.
          </p>
        </Card>
        <Card title="Demo">
          {media ? (
            <img src={`/${media}`} alt="CloseLoop running in Claude Desktop" className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800" />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
              Screenshot or GIF slot: add <Mono>apps/dashboard/public/demo.gif</Mono> (or .png / .webp) and rebuild.
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
