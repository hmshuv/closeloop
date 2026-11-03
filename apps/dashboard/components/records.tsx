import { Badge } from "@/components/ui";
import { inr } from "@/lib/format";

const TYPE_TITLE: Record<string, string> = {
  payment: "Payment",
  refund: "Refund",
  settlement: "Settlement",
  settlement_item: "Settlement item",
  bank_line: "Bank statement line",
  ledger_entry: "Ledger entry",
  period: "Period tie-out",
};

function display(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** A source record as key/value rows. Paise fields are shown via their pre-formatted ₹ twin. */
export function RecordCard({ id, type, data }: { id: string; type: string; data: Record<string, unknown> }) {
  const rows = Object.entries(data).filter(([k]) => !(k.endsWith("_paise") && `${k.slice(0, -6)}_inr` in data) && k !== "id");
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{TYPE_TITLE[type] ?? type}</span>
        <Badge>{id}</Badge>
      </div>
      <dl className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
        {rows.map(([k, v]) => {
          // Any remaining paise field (e.g. fee_paise_total) is shown in rupees too.
          const paise = k.includes("_paise") && typeof v === "number";
          const money = k.endsWith("_inr") || paise;
          return (
            <div key={k} className="grid grid-cols-[9rem_1fr] gap-2 px-3 py-1.5">
              <dt className="text-zinc-500 dark:text-zinc-400">{k.replace(/_inr$/, "").replace("_paise", "").replace(/_/g, " ")}</dt>
              <dd className={`break-all ${money ? "tabular font-medium" : ""} ${k === "narration" ? "font-mono" : ""}`}>{paise ? inr(v) : display(v)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100 dark:bg-black">{JSON.stringify(value, null, 2)}</pre>;
}
