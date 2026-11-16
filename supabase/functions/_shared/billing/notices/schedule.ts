// supabase/functions/_shared/billing/notices/schedule.ts
// Pure scheduling rules for billing notices (no Deno, no I/O).

/** [LAWYER TO CONFIRM] annual renewals are announced up to this many days ahead. */
export const RENEWAL_NOTICE_DAYS = 30;
/** [LAWYER TO CONFIRM] minimum notice before a price increase / limit reduction takes effect. */
export const PRICE_CHANGE_MIN_NOTICE_DAYS = 30;
export const DEFAULT_TIME_ZONE = "America/New_York";
/** Non-urgent notices go out between these local hours (inclusive start, exclusive end). */
export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 20;
/** Trial notices fire this many local calendar days before trial_end (day 11 and day 13 of a 14-day trial). */
export const TRIAL_NOTICE_DAYS_BEFORE_END = { ends_in_3_days: 3, ends_tomorrow: 1 } as const;

export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** "YYYY-MM-DD" of `d` on the calendar of `tz`. */
export function localYmd(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: safeTimeZone(tz), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function localHour(d: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: safeTimeZone(tz), hour: "2-digit", hourCycle: "h23" }).format(d);
  return Number(h) % 24;
}

/** Whole calendar days from fromYmd to toYmd (negative if toYmd is earlier). */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Local calendar days from `now` until `target` (both interpreted on the calendar of `tz`). */
export function daysUntilLocal(target: Date, now: Date, tz: string): number {
  return calendarDaysBetween(localYmd(now, tz), localYmd(target, tz));
}

export function inSendWindow(now: Date, tz: string): boolean {
  const h = localHour(now, tz);
  return h >= SEND_WINDOW_START_HOUR && h < SEND_WINDOW_END_HOUR;
}

export interface RenewalInput {
  periodEnd: Date;
  interval: string | null | undefined;
  cancelAtPeriodEnd: boolean;
  now: Date;
  tz: string;
}

/** Annual, not-canceling subscriptions get ONE notice once they are within 30 local days of renewal. */
export function renewalNoticeDue(i: RenewalInput): boolean {
  if (i.interval !== "year" || i.cancelAtPeriodEnd) return false;
  const days = daysUntilLocal(i.periodEnd, i.now, i.tz);
  return days >= 1 && days <= RENEWAL_NOTICE_DAYS && inSendWindow(i.now, i.tz);
}

export type TrialNoticeKind = keyof typeof TRIAL_NOTICE_DAYS_BEFORE_END;

/** Which trial reminder (if any) is due right now. Ready for when trials exist; not wired to any sender yet. */
export function trialNoticeDue(trialEnd: Date, now: Date, tz: string): TrialNoticeKind | null {
  if (!inSendWindow(now, tz)) return null;
  const days = daysUntilLocal(trialEnd, now, tz);
  if (days === TRIAL_NOTICE_DAYS_BEFORE_END.ends_in_3_days) return "ends_in_3_days";
  if (days === TRIAL_NOTICE_DAYS_BEFORE_END.ends_tomorrow) return "ends_tomorrow";
  return null;
}

export type PriceNoticeDecision = "send" | "blocked_late" | "completed";

/**
 * effectiveDate is a date-only string (UTC calendar). Sending is allowed only while >= 30 days remain.
 * Once dispatch has started, falling under 30 days just ends the run; it is never "late" retroactively.
 */
export function priceNoticeDecision(effectiveDate: string, now: Date, dispatchStarted: boolean): PriceNoticeDecision {
  const days = calendarDaysBetween(now.toISOString().slice(0, 10), effectiveDate);
  if (days >= PRICE_CHANGE_MIN_NOTICE_DAYS) return "send";
  return dispatchStarted ? "completed" : "blocked_late";
}
