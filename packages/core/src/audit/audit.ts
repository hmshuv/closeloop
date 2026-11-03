import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/open.ts";

export const ACTORS = ["system", "llm", "human"] as const;
export type Actor = (typeof ACTORS)[number];

export const AUDIT_ACTIONS = [
  "reconciliation_run",
  "investigation",
  "journal_draft",
  "approval",
  "escalation",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  ts: z.string(),
  actor: z.enum(ACTORS),
  action: z.enum(AUDIT_ACTIONS),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface AuditInput {
  actor: Actor;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  payload?: Record<string, unknown>;
}

/** Append one event. The table is append-only (UPDATE/DELETE are blocked by triggers). */
export function appendAudit(db: Db, event: AuditInput): string {
  const id = randomUUID();
  db.prepare("INSERT INTO audit_log (id, ts, actor, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    new Date().toISOString(),
    event.actor,
    event.action,
    event.entity_type,
    event.entity_id,
    JSON.stringify(event.payload ?? {}),
  );
  return id;
}

/** Oldest first. With an entity id, returns events about that entity or that mention it in their payload links. */
export function getAuditTrail(db: Db, entityId?: string, limit = 200, offset = 0): AuditEvent[] {
  const rows = (
    entityId
      ? db.prepare("SELECT * FROM audit_log WHERE entity_id = ? OR instr(payload_json, ?) > 0 ORDER BY ts, rowid LIMIT ? OFFSET ?").all(entityId, `"${entityId}"`, limit, offset)
      : db.prepare("SELECT * FROM audit_log ORDER BY ts, rowid LIMIT ? OFFSET ?").all(limit, offset)
  ) as { id: string; ts: string; actor: string; action: string; entity_type: string; entity_id: string; payload_json: string }[];
  return rows.map(({ payload_json, ...r }) => AuditEventSchema.parse({ ...r, payload: JSON.parse(payload_json) as unknown }));
}
