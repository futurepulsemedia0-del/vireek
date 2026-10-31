// supabase/functions/_shared/payment-reminders/window.ts
// Time-window rules of send-payment-reminders, extracted verbatim (no behaviour change).

export const MAX_REMINDERS = 3;
export const REMINDER_INTERVAL_DAYS = 3;
export const OVERDUE_AFTER_DAYS = 14;

export function reminderCutoffs(nowMs: number = Date.now()): { cutoff: string; overdueCutoff: string } {
  return {
    cutoff: new Date(nowMs - REMINDER_INTERVAL_DAYS * 86400000).toISOString(),
    overdueCutoff: new Date(nowMs - OVERDUE_AFTER_DAYS * 86400000).toISOString(),
  };
}

/** The row update applied after one reminder was sent. */
export function nextReminderUpdate(
  request: { reminder_count: number; created_at: string; status: string },
  overdueCutoff: string,
  nowIso: string = new Date().toISOString(),
): { reminder_count: number; last_reminder_sent_at: string; status: string } {
  const isOverdue = request.created_at < overdueCutoff;
  return { reminder_count: request.reminder_count + 1, last_reminder_sent_at: nowIso, status: isOverdue ? 'overdue' : request.status };
}
