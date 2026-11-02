import { businessDaysBetween } from "../calendar.ts";
import { settlementWindow, type CloseLoopConfig } from "../config.ts";
import { dueDate } from "./stage1-items.ts";
import type { ExceptionDraft, SourceData } from "./types.ts";

/**
 * Stage 4: every payment must settle within its method's T+n business-day window.
 * Exceeding it is always reported (TIMING_WINDOW_EXCEEDED), one exception per settlement.
 */
export function stage4Timing(src: SourceData, cfg: CloseLoopConfig): ExceptionDraft[] {
  const payments = new Map(src.payments.map((p) => [p.id, p]));
  const latePayments = new Map<string, { id: string; due: string; days: number }[]>();
  const settledAt = new Map(src.settlements.map((s) => [s.id, s.settled_at]));

  for (const item of src.items) {
    if (item.entity_type !== "payment") continue;
    const p = payments.get(item.entity_id);
    const date = settledAt.get(item.settlement_id);
    if (!p || !date) continue;
    const due = dueDate(cfg, p);
    if (date > due) {
      const list = latePayments.get(item.settlement_id) ?? [];
      list.push({ id: p.id, due, days: businessDaysBetween(due, date, cfg.calendar) });
      latePayments.set(item.settlement_id, list);
    }
  }

  const exceptions: ExceptionDraft[] = [];
  for (const s of src.settlements) {
    const late = latePayments.get(s.id);
    if (!late) continue;
    const methods = new Set(late.map((l) => payments.get(l.id)?.method));
    exceptions.push({
      type: "TIMING_WINDOW_EXCEEDED",
      amount_paise: s.amount_paise,
      primary: { type: "settlement", id: s.id },
      anchor_date: s.settled_at,
      related: late.map((l) => ({ type: "payment" as const, id: l.id })),
      trace: {
        rule: "stage4.settlement_window",
        windows_business_days: Object.fromEntries([...methods].filter((m) => m !== undefined).map((m) => [m, settlementWindow(cfg, m)])),
        earliest_due_date: late.map((l) => l.due).sort()[0],
        settled_at: s.settled_at,
        max_business_days_late: Math.max(...late.map((l) => l.days)),
        late_payments: late.length,
      },
    });
  }
  return exceptions;
}
