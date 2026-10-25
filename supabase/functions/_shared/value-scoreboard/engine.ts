// supabase/functions/_shared/value-scoreboard/engine.ts
//
// Value Scoreboard — pure engine (no Deno / network / DOM).
// Shared by the dashboard page, the monthly email/PDF edge function and the tests, so the number an
// owner sees on screen is exactly the number that was emailed.
//
// Rules this file enforces (every one is covered by engine.test.ts):
//   1. All money is integer minor units (cents) and all time is integer minutes. No floats are ever
//      summed, so totals cannot drift. Ratios/percentages are derived once, at the very end.
//   2. Measured and estimated value are NEVER merged into one undifferentiated number.
//   3. Events are de-duplicated by (type, evidence_ref); owner "not due to Vireek" reviews remove an
//      event; a measured event supersedes the estimate it replaced (no double counting).
//   4. Currencies are never added together. The headline uses the account currency; anything else is
//      listed separately.
//   5. Month boundaries are calendar months in the account's own time zone.

import { isValidTimeZone, zonedMidnightUtc } from "../executive-report/period.ts";
import { formatMoney } from "../money-recovered/engine.ts";

export { isValidTimeZone, formatMoney };

export const METHOD_VERSION = "value-v1";
export const DEFAULT_TREND_MONTHS = 6;
export const MAX_SNAPSHOT_EVENTS = 200;

export type ValueType = "recovered_revenue" | "saved_hours" | "avoided_cost";
export type Confidence = "measured" | "estimated";
export type ValueUnit = "cents" | "minutes";
export type ReviewDecision = "not_due_to_vireek" | "restored";

export const VALUE_TYPES: ValueType[] = ["recovered_revenue", "saved_hours", "avoided_cost"];

export const TYPE_LABELS: Record<ValueType, string> = {
  recovered_revenue: "Recovered revenue",
  saved_hours: "Hours saved",
  avoided_cost: "Costs avoided",
};

const FEATURE_LABELS: Record<string, string> = {
  revenue_recovery: "Missed-revenue recovery",
  after_hours_answering: "After-hours answering",
  call_handling: "Call handling (time saved)",
};

export const featureLabel = (feature: string): string =>
  FEATURE_LABELS[feature] ??
  feature.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** One row of value_events as read from the database. */
export interface ValueEvent {
  id: string;
  source_feature: string;
  type: ValueType;
  amount: number;
  unit: ValueUnit;
  currency: string | null;
  confidence: Confidence;
  method_note: string;
  evidence_ref: string;
  supersedes_ref: string | null;
  occurred_at: string;
}

/** One row of value_event_reviews (append-only; the newest decision for an event wins). */
export interface ValueReview {
  value_event_id: string;
  decision: ReviewDecision;
  decided_at: string;
}

// ---------------------------------------------------------------- plans / assumptions

/** Mirrors PRICING_PLANS in src/lib/pricing.ts (monthly list price, USD cents). A unit test keeps them in sync. */
export const PLAN_MONTHLY_CENTS: Record<string, number> = { free: 0, starter: 7900, professional: 19900, business: 39900 };

export function planMonthlyCents(plan: string | null | undefined): number | null {
  if (!plan) return null;
  const v = PLAN_MONTHLY_CENTS[plan.toLowerCase()];
  return typeof v === "number" ? v : null; // enterprise / unknown = custom: owner supplies the figure
}

/** avg ticket × close rate (basis points), integer-only. Never negative, never NaN. */
export function expectedTicketCents(avgTicketCents: number, closeRateBp: number): number {
  if (!Number.isFinite(avgTicketCents) || !Number.isFinite(closeRateBp)) return 0;
  const bp = Math.min(10000, Math.max(0, Math.trunc(closeRateBp)));
  const avg = Math.max(0, Math.trunc(avgTicketCents));
  return Math.round((avg * bp) / 10000);
}

// ---------------------------------------------------------------- months & time zones

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface MonthWindow {
  /** "YYYY-MM" (local calendar month). */
  month: string;
  label: string;
  /** Inclusive start / exclusive end, as UTC instants of local midnight. */
  startUtc: string;
  endUtc: string;
  timezone: string;
}

export function shiftMonth(ym: string, delta: number): string {
  const m = YM_RE.exec(ym);
  if (!m) throw new Error(`Bad month: ${ym}`);
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function monthLabel(ym: string): string {
  const m = YM_RE.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ym;
}

/** The local "YYYY-MM" an instant falls in, in `tz`. */
export function monthOf(iso: string | number | Date, tz: string): string {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${pad(Number(get("month")))}`;
}

/** Window for an explicit "YYYY-MM"; null when the month or time zone is malformed. */
export function monthWindowFor(ym: string, tz: string): MonthWindow | null {
  const m = YM_RE.exec(ym);
  if (!m || !isValidTimeZone(tz)) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const next = shiftMonth(ym, 1);
  const n = YM_RE.exec(next)!;
  return {
    month: ym,
    label: monthLabel(ym),
    startUtc: new Date(zonedMidnightUtc(y, mo, 1, tz)).toISOString(),
    endUtc: new Date(zonedMidnightUtc(Number(n[1]), Number(n[2]), 1, tz)).toISOString(),
    timezone: tz,
  };
}

export const currentMonthWindow = (now: Date, tz: string): MonthWindow =>
  monthWindowFor(monthOf(now, tz), tz) as MonthWindow;

export const previousMonthWindow = (now: Date, tz: string): MonthWindow =>
  monthWindowFor(shiftMonth(monthOf(now, tz), -1), tz) as MonthWindow;

/** True once `tz`-local time is on/after `sendHour` on the 1st of a month (stays due all month: self-healing). */
export function isMonthlyStatementDue(s: { enabled: boolean; send_hour: number; timezone: string }, now: Date): boolean {
  if (!s.enabled || !isValidTimeZone(s.timezone)) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, day: "numeric", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "0");
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return day > 1 || hour >= s.send_hour;
}

// ---------------------------------------------------------------- integrity: validate, dedupe, review, supersede

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

function isValidEvent(e: ValueEvent): boolean {
  if (!VALUE_TYPES.includes(e.type)) return false;
  if (!Number.isSafeInteger(e.amount) || e.amount <= 0) return false;
  if (e.confidence !== "measured" && e.confidence !== "estimated") return false;
  if (!e.evidence_ref || Number.isNaN(Date.parse(e.occurred_at))) return false;
  if (e.type === "saved_hours") return e.unit === "minutes";
  return e.unit === "cents" && !!e.currency && CURRENCY_RE.test(e.currency);
}

export interface IntegrityResult {
  effective: ValueEvent[];
  excluded: ValueEvent[]; // owner marked "not due to Vireek"
  counts: { input: number; invalid: number; duplicates: number; superseded: number; excluded: number };
}

const byTimeThenId = (a: ValueEvent, b: ValueEvent) =>
  Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function applyIntegrity(events: ValueEvent[], reviews: ValueReview[] = []): IntegrityResult {
  const valid = events.filter(isValidEvent);
  const invalid = events.length - valid.length;

  // 1. Dedupe by (type, evidence_ref): the earliest event wins, deterministically.
  const seen = new Set<string>();
  const unique: ValueEvent[] = [];
  for (const e of [...valid].sort(byTimeThenId)) {
    const key = `${e.type}\u0000${e.evidence_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  const duplicates = valid.length - unique.length;

  // 2. Supersede: a measured event replaces the estimate it was derived from (same type). This
  //    ignores owner exclusions on purpose, so excluding the measured job never resurrects its estimate.
  const superseded = new Set<string>();
  for (const e of unique) {
    if (e.confidence === "measured" && e.supersedes_ref) superseded.add(`${e.type}\u0000${e.supersedes_ref}`);
  }
  const live = unique.filter((e) => !(e.confidence === "estimated" && superseded.has(`${e.type}\u0000${e.evidence_ref}`)));
  const supersededCount = unique.length - live.length;

  // 3. Owner reviews: the newest decision per event wins; later array position breaks timestamp ties.
  const latest = new Map<string, ReviewDecision>();
  [...reviews]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(a.r.decided_at) - Date.parse(b.r.decided_at) || a.i - b.i)
    .forEach(({ r }) => latest.set(r.value_event_id, r.decision));
  const effective: ValueEvent[] = [];
  const excluded: ValueEvent[] = [];
  for (const e of live) (latest.get(e.id) === "not_due_to_vireek" ? excluded : effective).push(e);

  return {
    effective,
    excluded,
    counts: { input: events.length, invalid, duplicates, superseded: supersededCount, excluded: excluded.length },
  };
}

// ---------------------------------------------------------------- scoreboard

export interface Subscription { cents: number; currency: string }

export interface FeatureRow {
  feature: string;
  label: string;
  measuredCents: number;
  estimatedCents: number;
  totalCents: number;
  measuredMinutes: number;
  estimatedMinutes: number;
  events: number;
  /** Share of the month's money total, in basis points (0–10000). */
  shareBp: number;
}

export interface TrendPoint {
  month: string;
  label: string;
  measuredCents: number;
  estimatedCents: number;
  totalCents: number;
  totalMinutes: number;
}

export type CostReason = "no_plan" | "free_plan" | "currency_mismatch" | null;

export interface CostComparison {
  subscriptionCents: number | null;
  reason: CostReason;
  valueCents: number;
  measuredCents: number;
  netCents: number | null;
  /** Total value ÷ cost, one decimal (e.g. 4.2). Null when there is no comparable cost. */
  multiple: number | null;
  /** Measured-only value ÷ cost — the number nobody can argue with. */
  measuredMultiple: number | null;
  measuredCoversCost: boolean | null;
}

export interface Scoreboard {
  methodVersion: string;
  window: MonthWindow;
  currency: string;
  money: { measuredCents: number; estimatedCents: number; totalCents: number };
  hours: { measuredMinutes: number; estimatedMinutes: number; totalMinutes: number };
  byFeature: FeatureRow[];
  trend: TrendPoint[];
  cost: CostComparison;
  otherCurrencies: { currency: string; measuredCents: number; estimatedCents: number }[];
  counts: IntegrityResult["counts"] & { measured: number; estimated: number };
  /** This month's effective events, newest first (capped at MAX_SNAPSHOT_EVENTS by amount when snapshotted). */
  events: ValueEvent[];
  excludedEvents: ValueEvent[];
  eventsTruncated: boolean;
}

export interface ScoreboardInput {
  events: ValueEvent[];
  reviews?: ValueReview[];
  window: MonthWindow;
  currency: string;
  subscription?: Subscription | null;
  trendMonths?: number;
  /** Cap `events` (largest first) — used for stored snapshots so they stay small. */
  maxEvents?: number;
}

const inWindow = (e: ValueEvent, w: { startUtc: string; endUtc: string }) => {
  const t = Date.parse(e.occurred_at);
  return t >= Date.parse(w.startUtc) && t < Date.parse(w.endUtc);
};

export const minutesToHours = (minutes: number): number => Math.round(minutes / 6) / 10;
export const formatHours = (minutes: number): string => `${minutesToHours(minutes).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
export const formatMultiple = (m: number | null): string => (m === null ? "—" : `${m.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`);
export const formatShare = (bp: number): string => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

function costComparison(measuredCents: number, totalCents: number, currency: string, sub: Subscription | null | undefined): CostComparison {
  const empty = (reason: CostReason): CostComparison => ({
    subscriptionCents: sub ? sub.cents : null, reason, valueCents: totalCents, measuredCents,
    netCents: null, multiple: null, measuredMultiple: null, measuredCoversCost: null,
  });
  if (!sub) return empty("no_plan");
  if (sub.currency !== currency) return empty("currency_mismatch");
  if (!Number.isSafeInteger(sub.cents) || sub.cents < 0) return empty("no_plan");
  if (sub.cents === 0) return empty("free_plan");
  return {
    subscriptionCents: sub.cents,
    reason: null,
    valueCents: totalCents,
    measuredCents,
    netCents: totalCents - sub.cents,
    multiple: Math.round((totalCents * 10) / sub.cents) / 10,
    measuredMultiple: Math.round((measuredCents * 10) / sub.cents) / 10,
    measuredCoversCost: measuredCents >= sub.cents,
  };
}

export function computeScoreboard(input: ScoreboardInput): Scoreboard {
  const currency = CURRENCY_RE.test(input.currency) ? input.currency : "USD";
  const tz = input.window.timezone;
  const integrity = applyIntegrity(input.events, input.reviews ?? []);

  const monthEvents = integrity.effective.filter((e) => inWindow(e, input.window));
  const money = { measuredCents: 0, estimatedCents: 0, totalCents: 0 };
  const hours = { measuredMinutes: 0, estimatedMinutes: 0, totalMinutes: 0 };
  const features = new Map<string, FeatureRow>();
  const other = new Map<string, { currency: string; measuredCents: number; estimatedCents: number }>();
  let measuredN = 0;
  let estimatedN = 0;

  for (const e of monthEvents) {
    if (e.confidence === "measured") measuredN++;
    else estimatedN++;
    const row = features.get(e.source_feature) ?? {
      feature: e.source_feature, label: featureLabel(e.source_feature),
      measuredCents: 0, estimatedCents: 0, totalCents: 0, measuredMinutes: 0, estimatedMinutes: 0, events: 0, shareBp: 0,
    };
    row.events++;
    if (e.unit === "minutes") {
      if (e.confidence === "measured") { hours.measuredMinutes += e.amount; row.measuredMinutes += e.amount; }
      else { hours.estimatedMinutes += e.amount; row.estimatedMinutes += e.amount; }
    } else if (e.currency === currency) {
      if (e.confidence === "measured") { money.measuredCents += e.amount; row.measuredCents += e.amount; }
      else { money.estimatedCents += e.amount; row.estimatedCents += e.amount; }
      row.totalCents += e.amount;
    } else if (e.currency) {
      const o = other.get(e.currency) ?? { currency: e.currency, measuredCents: 0, estimatedCents: 0 };
      if (e.confidence === "measured") o.measuredCents += e.amount; else o.estimatedCents += e.amount;
      other.set(e.currency, o);
    }
    features.set(e.source_feature, row);
  }
  money.totalCents = money.measuredCents + money.estimatedCents;
  hours.totalMinutes = hours.measuredMinutes + hours.estimatedMinutes;

  const byFeature = [...features.values()]
    .map((r) => ({ ...r, shareBp: money.totalCents > 0 ? Math.round((r.totalCents * 10000) / money.totalCents) : 0 }))
    .sort((a, b) => b.totalCents - a.totalCents || b.measuredMinutes + b.estimatedMinutes - (a.measuredMinutes + a.estimatedMinutes) || a.feature.localeCompare(b.feature));

  // Trend: last N local months ending with the window's month; zero-filled so gaps are visible.
  const n = Math.max(1, Math.min(24, input.trendMonths ?? DEFAULT_TREND_MONTHS));
  const buckets = new Map<string, TrendPoint>();
  for (let i = n - 1; i >= 0; i--) {
    const m = shiftMonth(input.window.month, -i);
    buckets.set(m, { month: m, label: monthLabel(m), measuredCents: 0, estimatedCents: 0, totalCents: 0, totalMinutes: 0 });
  }
  for (const e of integrity.effective) {
    const b = buckets.get(monthOf(e.occurred_at, tz));
    if (!b) continue;
    if (e.unit === "minutes") b.totalMinutes += e.amount;
    else if (e.currency === currency) {
      if (e.confidence === "measured") b.measuredCents += e.amount; else b.estimatedCents += e.amount;
      b.totalCents += e.amount;
    }
  }

  const newestFirst = [...monthEvents].sort((a, b) => byTimeThenId(b, a));
  const cap = input.maxEvents && input.maxEvents > 0 ? input.maxEvents : Infinity;
  const events = newestFirst.length > cap
    ? [...newestFirst].sort((a, b) => b.amount - a.amount || byTimeThenId(b, a)).slice(0, cap).sort((a, b) => byTimeThenId(b, a))
    : newestFirst;

  return {
    methodVersion: METHOD_VERSION,
    window: input.window,
    currency,
    money,
    hours,
    byFeature,
    trend: [...buckets.values()],
    cost: costComparison(money.measuredCents, money.totalCents, currency, input.subscription),
    otherCurrencies: [...other.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    counts: { ...integrity.counts, measured: measuredN, estimated: estimatedN },
    events,
    excludedEvents: integrity.excluded.filter((e) => inWindow(e, input.window)).sort((a, b) => byTimeThenId(b, a)),
    eventsTruncated: newestFirst.length > events.length,
  };
}

// ---------------------------------------------------------------- evidence links (the "how was this calculated" drawer)

const EVIDENCE_ROUTES: Record<string, string> = {
  calls: "/dashboard/calls/",
  jobs: "/dashboard/jobs/",
  quotes: "/dashboard/quotes/",
};

/** "jobs:<uuid>" → in-app path. Anything we cannot safely link (demo/manual/unknown) returns null. */
export function evidencePath(ref: string): string | null {
  const [table, id, ...rest] = ref.split(":");
  if (rest.length > 0 || !id) return null;
  if (table === "revenue_recovery_events") return UUID_RE.test(id) ? "/dashboard/recovery" : null;
  const base = EVIDENCE_ROUTES[table];
  return base && UUID_RE.test(id) ? `${base}${id}` : null;
}

export const methodology: { title: string; body: string }[] = [
  {
    title: "Measured",
    body: "Backed by a record in your account that shows the money or time actually changed hands — for example an after-hours call answered by Vireek that became a booked job and a paid invoice. Measured value uses the invoice amount, in the invoice currency.",
  },
  {
    title: "Estimated",
    body: "Calculated from assumptions you control in Results settings (average ticket, close rate, minutes saved per handled call). Estimates are listed separately, are never added into the measured total, and are replaced by a measured event as soon as the evidence exists.",
  },
  {
    title: "Conservative by design",
    body: "Each event is counted once. Calls under 20 seconds earn no time savings, jobs are only attributed within 14 days of the call, and nothing is counted when there is no way to price it. Hours saved are shown on their own and are not converted to dollars.",
  },
  {
    title: "You have the final say",
    body: "If an item was not really due to Vireek, mark it. It leaves your totals immediately and the decision is kept in an audit trail. You can restore it at any time.",
  },
];
