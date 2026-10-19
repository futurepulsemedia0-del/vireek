// supabase/functions/_shared/money-recovered/engine.ts
//
// Weekly "Money Recovered" statement — pure engine (no Deno / network / DOM).
// Shared by the edge function (email + PDF), the dashboard page and the tests, so the
// number an owner sees on screen is exactly the number that was emailed.
//
// It never invents revenue: every figure comes from revenue_recovery_events, and money is
// only *claimed* for Vireek when the evidence bar in `attribute()` is met.

import { isValidTimeZone, zonedMidnightUtc } from "../executive-report/period.ts";

export { isValidTimeZone };

export const METHOD_VERSION = "conservative-v1";
export const ATTRIBUTION_WINDOW_DAYS = 14;
export const MAX_SNAPSHOT_ROWS = 200;
const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.4375;

// ------------------------------------------------------------------ categories

export type Category = "missed_calls" | "quotes" | "jobs_billing" | "payments" | "memberships" | "other";

export const CATEGORY_ORDER: Category[] = ["missed_calls", "quotes", "jobs_billing", "payments", "memberships", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
  missed_calls: "Calls & leads",
  quotes: "Quotes",
  jobs_billing: "Jobs & billing",
  payments: "Payments",
  memberships: "Memberships",
  other: "Other",
};

const SOURCE_CATEGORY: Record<string, Category> = {
  missed_call: "missed_calls",
  voicemail: "missed_calls",
  not_booked: "missed_calls",
  declined_quote: "quotes",
  expired_quote: "quotes",
  quote_financing_stalled: "quotes",
  quote_accepted_unbooked: "quotes",
  cancelled_job: "jobs_billing",
  job_completed_unbilled: "jobs_billing",
  job_parts_unbilled: "jobs_billing",
  invoice_overdue: "payments",
  payment_failed: "payments",
  membership_cancelled: "memberships",
  membership_churned: "memberships",
};

const SOURCE_LABELS: Record<string, string> = {
  missed_call: "Missed call",
  voicemail: "Voicemail",
  not_booked: "Answered, not booked",
  declined_quote: "Quote declined",
  expired_quote: "Quote expired",
  quote_financing_stalled: "Quote stalled",
  quote_accepted_unbooked: "Accepted, not booked",
  cancelled_job: "Job cancelled",
  job_completed_unbilled: "Completed, not invoiced",
  job_parts_unbilled: "Parts not fully billed",
  invoice_overdue: "Invoice overdue",
  payment_failed: "Payment failed",
  membership_cancelled: "Membership cancelled",
  membership_churned: "Membership churned",
};

export const categoryOf = (sourceType: string): Category => SOURCE_CATEGORY[sourceType] ?? "other";
export const sourceLabel = (sourceType: string): string => SOURCE_LABELS[sourceType] ?? "Other";

// ------------------------------------------------------------------ attribution

export interface LedgerEvent {
  id: string;
  source_type: string;
  call_id: string | null;
  customer_name: string | null;
  occurred_at: string;
  estimated_value_cents: number;
  status: string;
  recovery_method: string | null;
  recovered_amount_cents: number | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  resolved_at: string | null;
}

export type NotClaimedReason =
  | "owner_reported"
  | "no_documented_follow_up"
  | "follow_up_too_old"
  | "follow_up_after_recovery"
  | "no_amount";

export const REASON_LABELS: Record<NotClaimedReason, string> = {
  owner_reported: "Entered manually by your team (not independently verifiable)",
  no_documented_follow_up: "No logged follow-up before it was paid, so the customer may have come back on their own",
  follow_up_too_old: `Last follow-up was more than ${ATTRIBUTION_WINDOW_DAYS} days before the payment`,
  follow_up_after_recovery: "The only follow-up was logged after the money came in",
  no_amount: "No money collected yet",
};

export type Attribution =
  | { claimed: true; creditedCents: number; cappedByEstimate: boolean }
  | { claimed: false; reason: NotClaimedReason };

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const cents = (n: number | null | undefined): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0);

/**
 * Conservative attribution. Money is claimed only when ALL of these hold:
 *  1. real money was collected (the recorded amount, never the estimate);
 *  2. it was not typed in by hand (manual entries cannot be verified);
 *  3. a follow-up was logged on that entry BEFORE it was resolved;
 *  4. that follow-up was within `windowDays` of the resolution.
 * The claim is capped at the value estimated when the opportunity was lost, so upsells and
 * unrelated later spend are never credited.
 */
export function attribute(e: LedgerEvent, windowDays = ATTRIBUTION_WINDOW_DAYS): Attribution {
  const amount = cents(e.recovered_amount_cents);
  if (amount <= 0) return { claimed: false, reason: "no_amount" };
  if (e.recovery_method === "manual") return { claimed: false, reason: "owner_reported" };

  const touch = toMs(e.last_follow_up_at);
  const resolved = toMs(e.resolved_at);
  if (!(e.follow_up_count >= 1) || touch === null || resolved === null) {
    return { claimed: false, reason: "no_documented_follow_up" };
  }
  if (touch > resolved) return { claimed: false, reason: "follow_up_after_recovery" };
  if (resolved - touch > windowDays * DAY_MS) return { claimed: false, reason: "follow_up_too_old" };

  const estimate = cents(e.estimated_value_cents);
  const creditedCents = estimate > 0 ? Math.min(amount, estimate) : amount;
  return { claimed: true, creditedCents, cappedByEstimate: estimate > 0 && amount > estimate };
}

// ------------------------------------------------------------------ weeks (Mon–Sun, owner's timezone)

export interface Window {
  /** Local calendar dates, inclusive: Monday … Sunday. */
  start: string;
  end: string;
  label: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = (n: number) => String(n).padStart(2, "0");

function localInfo(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")) % 24, weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Window for the Monday given as UTC-midnight milliseconds of its calendar date. */
function windowFromMonday(mondayUtcMs: number, tz: string): Window {
  const s = new Date(mondayUtcMs);
  const n = new Date(mondayUtcMs + 7 * DAY_MS);
  const e = new Date(mondayUtcMs + 6 * DAY_MS);
  const [sy, sm, sd] = [s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate()];
  const [ey, em, ed] = [e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate()];
  const label = sy === ey
    ? `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}, ${ey}`
    : `${MONTHS[sm - 1]} ${sd}, ${sy} – ${MONTHS[em - 1]} ${ed}, ${ey}`;
  return {
    start: `${sy}-${pad(sm)}-${pad(sd)}`,
    end: `${ey}-${pad(em)}-${pad(ed)}`,
    label,
    startUtc: new Date(zonedMidnightUtc(sy, sm, sd, tz)).toISOString(),
    endUtc: new Date(zonedMidnightUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), tz)).toISOString(),
    timezone: tz,
  };
}

function mondayOf(now: Date, tz: string): number {
  const l = localInfo(now.getTime(), tz);
  return Date.UTC(l.year, l.month - 1, l.day) - ((l.weekday + 6) % 7) * DAY_MS;
}

/** The last fully elapsed Monday–Sunday week in `tz`. */
export function previousWeekWindow(now: Date, tz: string): Window {
  return windowFromMonday(mondayOf(now, tz) - 7 * DAY_MS, tz);
}

/** The week that contains `now` (for the live, not-yet-sent preview). */
export function currentWeekWindow(now: Date, tz: string): Window {
  return windowFromMonday(mondayOf(now, tz), tz);
}

/** Window for an explicit Monday "YYYY-MM-DD"; null if malformed or not a Monday. */
export function weekWindowFor(weekStart: string, tz: string): Window | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(weekStart);
  if (!m || !isValidTimeZone(tz)) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCDay() !== 1 || d.getUTCDate() !== Number(m[3])) return null;
  return windowFromMonday(ms, tz);
}

/**
 * Due from `send_hour` on Monday (local) until the next Monday. Staying due all week makes the
 * sweep self-healing after downtime; the unique (user_id, week_start) row keeps it idempotent.
 */
export function isStatementDue(s: { enabled: boolean; send_hour: number; timezone: string }, now: Date): boolean {
  if (!s.enabled || !isValidTimeZone(s.timezone)) return false;
  const l = localInfo(now.getTime(), s.timezone);
  return l.weekday !== 1 || l.hour >= s.send_hour;
}

// ------------------------------------------------------------------ statement

export interface CallInfo {
  id: string;
  summary: string | null;
  has_recording: boolean;
}

export interface Baseline {
  monthly_leak_cents: number;
  source: string;
  captured_at: string;
  label: string | null;
}

export type RowState = "credited" | "in_progress" | "not_claimed";

export interface StatementRow {
  eventId: string;
  callId: string | null;
  customer: string;
  category: Category;
  source: string;
  occurredAt: string;
  resolvedAt: string | null;
  summary: string | null;
  hasRecording: boolean;
  /** Value estimated when the opportunity was lost. */
  estimatedCents: number;
  /** Money actually collected (0 while in progress). */
  recoveredCents: number;
  /** Money claimed for Vireek (0 unless state === "credited"). */
  creditedCents: number;
  state: RowState;
  cappedByEstimate: boolean;
  reason: NotClaimedReason | null;
}

export interface CategoryRow {
  category: Category;
  label: string;
  creditedCents: number;
  creditedCount: number;
  notClaimedCents: number;
  notClaimedCount: number;
  openCents: number;
  openCount: number;
}

export interface BaselineComparison {
  source: string;
  label: string | null;
  capturedAt: string;
  monthlyLeakCents: number;
  weeklyLeakCents: number;
  /** Estimated value of every opportunity that slipped this week. */
  leakedThisWeekCents: number;
  creditedCents: number;
  /** creditedCents as % of the baseline weekly leak; null when baseline is 0. */
  recoveredVsBaselinePct: number | null;
  /** (leakedThisWeek - baselineWeekly) / baselineWeekly as %; null when baseline is 0. */
  leakVsBaselinePct: number | null;
}

export interface Statement {
  v: 1;
  methodVersion: string;
  windowDays: number;
  generatedAt: string;
  currency: string;
  period: Window;
  creditedCents: number;
  creditedCount: number;
  /** Recoveries this week that did NOT meet the evidence bar — shown, never added to the headline. */
  notClaimedCents: number;
  notClaimedCount: number;
  notClaimedByReason: Partial<Record<NotClaimedReason, { count: number; cents: number }>>;
  inProgressCount: number;
  /** Everything still open or contacted at generation time (estimates). */
  stillOpenCents: number;
  stillOpenCount: number;
  categories: CategoryRow[];
  rows: StatementRow[];
  rowsOmitted: number;
  baseline: BaselineComparison | null;
}

export interface StatementInput {
  events: LedgerEvent[];
  calls: CallInfo[];
  baseline: Baseline | null;
  window: Window;
  now: Date;
  currency?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (s: string | null | undefined, n: number): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? clip(t, n) : null;
};
const inRange = (ms: number | null, a: number, b: number) => ms !== null && ms >= a && ms < b;

export function computeStatement(input: StatementInput): Statement {
  const { window: w } = input;
  const a = Date.parse(w.startUtc);
  const b = Date.parse(w.endUtc);
  const callById = new Map(input.calls.map((c) => [c.id, c]));
  const events = [...new Map(input.events.map((e) => [e.id, e])).values()];

  const catMap = new Map<Category, CategoryRow>(
    CATEGORY_ORDER.map((c) => [c, {
      category: c, label: CATEGORY_LABELS[c], creditedCents: 0, creditedCount: 0,
      notClaimedCents: 0, notClaimedCount: 0, openCents: 0, openCount: 0,
    }]),
  );
  const rows: StatementRow[] = [];
  const byReason: Statement["notClaimedByReason"] = {};
  let creditedCents = 0, creditedCount = 0, notClaimedCents = 0, notClaimedCount = 0;
  let inProgressCount = 0, stillOpenCents = 0, stillOpenCount = 0, leakedCents = 0;

  const makeRow = (e: LedgerEvent, state: RowState, extra: Partial<StatementRow>): StatementRow => {
    const call = e.call_id ? callById.get(e.call_id) : undefined;
    return {
      eventId: e.id,
      callId: call ? call.id : null,
      customer: tidy(e.customer_name, 80) ?? "Unknown caller",
      category: categoryOf(e.source_type),
      source: sourceLabel(e.source_type),
      occurredAt: e.occurred_at,
      resolvedAt: e.resolved_at,
      summary: tidy(call?.summary, 220),
      hasRecording: Boolean(call?.has_recording),
      estimatedCents: cents(e.estimated_value_cents),
      recoveredCents: 0,
      creditedCents: 0,
      state,
      cappedByEstimate: false,
      reason: null,
      ...extra,
    };
  };

  for (const e of events) {
    const cat = catMap.get(categoryOf(e.source_type))!;
    const occurred = toMs(e.occurred_at);
    if (inRange(occurred, a, b)) leakedCents += cents(e.estimated_value_cents);

    if (e.status === "open" || e.status === "contacted") {
      if (occurred !== null && occurred < b) {
        stillOpenCount += 1;
        stillOpenCents += cents(e.estimated_value_cents);
        cat.openCount += 1;
        cat.openCents += cents(e.estimated_value_cents);
      }
      if (e.status === "contacted" && inRange(toMs(e.last_follow_up_at), a, b)) {
        inProgressCount += 1;
        rows.push(makeRow(e, "in_progress", {}));
      }
      continue;
    }

    if (e.status !== "recovered" || !inRange(toMs(e.resolved_at), a, b)) continue;
    const att = attribute(e);
    if (att.claimed) {
      creditedCents += att.creditedCents;
      creditedCount += 1;
      cat.creditedCents += att.creditedCents;
      cat.creditedCount += 1;
      rows.push(makeRow(e, "credited", {
        recoveredCents: cents(e.recovered_amount_cents), creditedCents: att.creditedCents, cappedByEstimate: att.cappedByEstimate,
      }));
    } else if (att.reason !== "no_amount") {
      const amt = cents(e.recovered_amount_cents);
      notClaimedCents += amt;
      notClaimedCount += 1;
      cat.notClaimedCents += amt;
      cat.notClaimedCount += 1;
      const r = (byReason[att.reason] ??= { count: 0, cents: 0 });
      r.count += 1;
      r.cents += amt;
      rows.push(makeRow(e, "not_claimed", { recoveredCents: amt, reason: att.reason }));
    }
  }

  const order: Record<RowState, number> = { credited: 0, in_progress: 1, not_claimed: 2 };
  rows.sort((x, y) =>
    order[x.state] - order[y.state]
    || (y.creditedCents || y.recoveredCents || y.estimatedCents) - (x.creditedCents || x.recoveredCents || x.estimatedCents)
    || x.eventId.localeCompare(y.eventId));

  const weeklyLeakCents = (m: number) => Math.round((m * 7) / DAYS_PER_MONTH);
  let baseline: BaselineComparison | null = null;
  if (input.baseline && cents(input.baseline.monthly_leak_cents) > 0) {
    const monthly = cents(input.baseline.monthly_leak_cents);
    const weekly = weeklyLeakCents(monthly);
    baseline = {
      source: input.baseline.source,
      label: input.baseline.label,
      capturedAt: input.baseline.captured_at,
      monthlyLeakCents: monthly,
      weeklyLeakCents: weekly,
      leakedThisWeekCents: leakedCents,
      creditedCents,
      recoveredVsBaselinePct: weekly > 0 ? Math.round((creditedCents / weekly) * 1000) / 10 : null,
      leakVsBaselinePct: weekly > 0 ? Math.round(((leakedCents - weekly) / weekly) * 1000) / 10 : null,
    };
  }

  return {
    v: 1,
    methodVersion: METHOD_VERSION,
    windowDays: ATTRIBUTION_WINDOW_DAYS,
    generatedAt: input.now.toISOString(),
    currency: input.currency || "USD",
    period: w,
    creditedCents, creditedCount, notClaimedCents, notClaimedCount,
    notClaimedByReason: byReason,
    inProgressCount, stillOpenCents, stillOpenCount,
    categories: CATEGORY_ORDER.map((c) => catMap.get(c)!).filter(
      (c) => c.creditedCount + c.notClaimedCount + c.openCount > 0,
    ),
    rows: rows.slice(0, MAX_SNAPSHOT_ROWS),
    rowsOmitted: Math.max(0, rows.length - MAX_SNAPSHOT_ROWS),
    baseline,
  };
}

// ------------------------------------------------------------------ formatting + method text

export function formatMoney(valueCents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(valueCents / 100);
  } catch {
    return `$${(valueCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function formatPct(p: number | null): string {
  if (p === null) return "n/a";
  return `${p > 0 ? "+" : ""}${p.toFixed(1).replace(/\.0$/, "")}%`;
}

export const METHODOLOGY: { title: string; body: string }[] = [
  {
    title: "Only money that was actually collected",
    body: "We count the amount that was really paid or accepted, never the estimate we made when the opportunity was lost.",
  },
  {
    title: "A logged follow-up is required",
    body: `A recovery is credited to Vireek only if a follow-up (call back, text, or resent quote) was logged on that entry before the money came in, and no more than ${ATTRIBUTION_WINDOW_DAYS} days earlier. Customers who simply came back on their own are not claimed.`,
  },
  {
    title: "Capped at the original value",
    body: "If a customer ends up spending more than the value estimated when the opportunity was lost, we credit only the estimate. We never take credit for upsells.",
  },
  {
    title: "Manual entries are listed, not claimed",
    body: "Recoveries typed in by hand cannot be independently verified, so they appear under \"Recovered, not claimed\" and are never added to the headline total.",
  },
  {
    title: "Estimates are labelled as estimates",
    body: "\"Still recoverable\" is an estimate of what open items could be worth. It is not revenue and is never added to the amount recovered.",
  },
  {
    title: "Baseline comparison is directional",
    body: "Your baseline Leak Report figure is a monthly estimate; we scale it to one week (×7 ÷ 30.44) to compare. Treat the comparison as a guide, not a guarantee.",
  },
];
