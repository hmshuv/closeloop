import { Badge } from "@/components/ui";
import type { AuditEvent } from "@/lib/snapshot";

const ACTOR_TONE = { system: "neutral", llm: "violet", human: "green" } as const;

export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-zinc-500">No audit events yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-zinc-200 pl-4 dark:border-zinc-800">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-zinc-300 ring-4 ring-white dark:bg-zinc-600 dark:ring-zinc-900" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={ACTOR_TONE[e.actor as keyof typeof ACTOR_TONE] ?? "neutral"}>{e.actor}</Badge>
            <span className="font-medium">{e.action.replace(/_/g, " ")}</span>
            <time className="text-zinc-500" dateTime={e.ts}>
              {new Date(e.ts).toISOString().replace("T", " ").slice(0, 19)} UTC
            </time>
          </div>
          <p className="mt-0.5 break-all font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            {Object.entries(e.payload)
              .filter(([, v]) => v !== null && typeof v !== "object")
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" · ")}
          </p>
        </li>
      ))}
    </ol>
  );
}
