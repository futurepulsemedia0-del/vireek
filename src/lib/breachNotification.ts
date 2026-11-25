/**
 * Breach notification deadline calculator (pure, no I/O).
 *
 * Deadlines are DATA, not code: callers pass rules whose `deadline` was confirmed
 * by counsel (docs/security/breach-notification-rules.json). A rule with
 * `deadline: null` yields status 'unspecified', never a guessed date.
 * All arithmetic is UTC. Business days skip Saturday/Sunday and any listed
 * holidays (ISO dates, UTC). Not legal advice.
 */

export type DeadlineUnit = 'hours' | 'calendar_days' | 'business_days';
export type ClockStart = 'awareness' | 'determination';
export type NotificationAudience = 'regulator' | 'individuals' | 'customers' | 'other';

export interface NotificationRule {
  id: string;
  jurisdiction: string;
  audience: NotificationAudience;
  clockStart: ClockStart;
  deadline: { unit: DeadlineUnit; amount: number } | null;
  /** ISO dates (YYYY-MM-DD) that do not count as business days. */
  holidays?: readonly string[];
}

export interface ClockInput {
  awarenessAt: Date | string | null;
  determinationAt?: Date | string | null;
  sentAt?: Date | string | null;
  now: Date | string;
  /** Window before the deadline that counts as "due soon". Default 24 hours. */
  dueSoonMs?: number;
}

export type ClockStatus =
  | 'unspecified'
  | 'not_started'
  | 'on_track'
  | 'due_soon'
  | 'overdue'
  | 'sent'
  | 'sent_late';

export interface ClockResult {
  ruleId: string;
  status: ClockStatus;
  startedAt: Date | null;
  dueAt: Date | null;
  /** Positive = time left, negative = time past due. Null when there is no due date or it was sent. */
  msRemaining: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function toDate(value: Date | string, label: string): Date {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date for ${label}`);
  return d;
}

function optionalDate(value: Date | string | null | undefined, label: string): Date | null {
  return value === null || value === undefined ? null : toDate(value, label);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addBusinessDays(start: Date, days: number, holidays: readonly string[] = []): Date {
  const skip = new Set(holidays);
  const out = new Date(start.getTime());
  let left = days;
  while (left > 0) {
    out.setTime(out.getTime() + DAY_MS);
    const dow = out.getUTCDay();
    if (dow !== 0 && dow !== 6 && !skip.has(isoDay(out))) left -= 1;
  }
  return out;
}

export function computeDueAt(
  start: Date,
  deadline: NonNullable<NotificationRule['deadline']>,
  holidays: readonly string[] = [],
): Date {
  const { unit, amount } = deadline;
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    throw new RangeError('Deadline amount must be a non-negative integer');
  }
  if (unit === 'hours') return new Date(start.getTime() + amount * HOUR_MS);
  if (unit === 'calendar_days') return new Date(start.getTime() + amount * DAY_MS);
  return addBusinessDays(start, amount, holidays);
}

export function evaluateClock(rule: NotificationRule, input: ClockInput): ClockResult {
  const now = toDate(input.now, 'now');
  const sentAt = optionalDate(input.sentAt, 'sentAt');
  const awareness = optionalDate(input.awarenessAt, 'awarenessAt');
  const determination = optionalDate(input.determinationAt, 'determinationAt');
  const startedAt = rule.clockStart === 'awareness' ? awareness : determination;

  if (!rule.deadline) {
    return { ruleId: rule.id, status: sentAt ? 'sent' : 'unspecified', startedAt, dueAt: null, msRemaining: null };
  }
  if (!startedAt) {
    return { ruleId: rule.id, status: sentAt ? 'sent' : 'not_started', startedAt: null, dueAt: null, msRemaining: null };
  }

  const dueAt = computeDueAt(startedAt, rule.deadline, rule.holidays);
  if (sentAt) {
    return {
      ruleId: rule.id,
      status: sentAt.getTime() <= dueAt.getTime() ? 'sent' : 'sent_late',
      startedAt,
      dueAt,
      msRemaining: null,
    };
  }

  const msRemaining = dueAt.getTime() - now.getTime();
  const dueSoonMs = input.dueSoonMs ?? DAY_MS;
  const status: ClockStatus = msRemaining < 0 ? 'overdue' : msRemaining <= dueSoonMs ? 'due_soon' : 'on_track';
  return { ruleId: rule.id, status, startedAt, dueAt, msRemaining };
}

/** Evaluates every rule for one incident; earliest due date first, unspecified/not-started last. */
export function evaluateClocks(
  rules: readonly NotificationRule[],
  input: ClockInput,
  sentByRule: Readonly<Record<string, Date | string | null | undefined>> = {},
): ClockResult[] {
  return rules
    .map((r) => evaluateClock(r, { ...input, sentAt: sentByRule[r.id] ?? null }))
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
}
