/**
 * Onboarding time-to-value (TTV): pure types and helpers for the staff TTV card.
 *
 * No network access here. The data comes from the staff-only RPC `staff_ttv_overview` (see
 * supabase/migrations/20290305000000_onboarding_ttv.sql); `ttvApi.ts` calls it and hands the raw JSON to
 * `parseTtvOverview`, which turns it into the typed shape below. Parsing is defensive on purpose: if the
 * payload drifts, the card degrades to "no data" instead of showing NaN.
 *
 * The limits below mirror the CHECK constraints and RPC validation in that migration. Keep them in sync.
 */

/** Ordered as in `ttv_milestone_config.position` (1..5). */
export const TTV_MILESTONES = [
  'setup_completed',
  'number_connected',
  'first_test_call',
  'first_real_call',
  'first_job_booked',
] as const;
export type TtvMilestone = (typeof TTV_MILESTONES)[number];

export function isTtvMilestone(value: unknown): value is TtvMilestone {
  return typeof value === 'string' && (TTV_MILESTONES as readonly string[]).includes(value);
}

/** Signup windows offered in the card (the RPC accepts 1..365). */
export const TTV_WINDOWS = [7, 14, 30, 60, 90] as const;

/** `ttv_milestone_config.stall_hours` CHECK (1..2160 hours = 90 days). */
export const TTV_STALL_HOURS_MIN = 1;
export const TTV_STALL_HOURS_MAX = 2160;
/** `ttv_settings.int_value` for key `watch_days` CHECK (7..365). */
export const TTV_WATCH_DAYS_MIN = 7;
export const TTV_WATCH_DAYS_MAX = 365;

export interface TtvMilestoneStat {
  milestone: TtvMilestone;
  position: number;
  label: string;
  /** Accounts in the cohort that reached this milestone. */
  reached: number;
  /** Median seconds from signup; null when no account has a measured time. */
  p50Seconds: number | null;
  p90Seconds: number | null;
}

export interface TtvConfigRow {
  milestone: TtvMilestone;
  position: number;
  label: string;
  stallHours: number;
  alertEnabled: boolean;
}

export interface TtvAlert {
  id: string;
  accountId: string;
  /** Company name only. No emails, phone numbers or transcripts ever reach this payload. */
  companyName: string | null;
  milestone: TtvMilestone;
  firedAt: string | null;
  stalledHours: number;
  thresholdHours: number;
  acknowledged: boolean;
}

export interface TtvOverview {
  generatedAt: string | null;
  windowDays: number;
  /** Accounts that signed up inside the window. */
  signups: number;
  /** True when the cohort hit the server-side cap (5000), so numbers are a floor, not exact. */
  truncated: boolean;
  watchDays: number;
  stalledNow: number;
  openAlertCount: number;
  milestones: TtvMilestoneStat[];
  config: TtvConfigRow[];
  alerts: TtvAlert[];
}

/* ---------------------------------- formatting ---------------------------------- */

export type TtvDurationUnit = 'minutes' | 'hours' | 'days';
export interface HumanDuration {
  unit: TtvDurationUnit;
  value: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Turns seconds into the largest readable unit: minutes below an hour, hours below 48 h, days above.
 * Anything under a minute is shown as 1 minute. Returns null for missing, negative or non-finite input
 * so the caller can render "unknown" rather than "0".
 */
export function humanizeSeconds(seconds: number | null | undefined): HumanDuration | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', value: Math.max(1, minutes) };
  if (seconds < 48 * 3600) return { unit: 'hours', value: round1(seconds / 3600) };
  return { unit: 'days', value: round1(seconds / 86400) };
}

/** Share of the cohort that reached a milestone, as a whole percent in 0..100. Null when the cohort is empty. */
export function reachedPercent(reached: number, signups: number): number | null {
  if (!Number.isFinite(reached) || !Number.isFinite(signups) || signups <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((reached / signups) * 100)));
}

/* ----------------------------------- validation ----------------------------------- */

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Whole hours in 1..2160, or null when the input is empty, fractional, negative or out of range. */
export const parseStallHours = (raw: string): number | null => parseBoundedInt(raw, TTV_STALL_HOURS_MIN, TTV_STALL_HOURS_MAX);

/** Whole days in 7..365, or null when invalid. */
export const parseWatchDays = (raw: string): number | null => parseBoundedInt(raw, TTV_WATCH_DAYS_MIN, TTV_WATCH_DAYS_MAX);

/* ------------------------------------- parsing ------------------------------------- */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parses the jsonb returned by `staff_ttv_overview`. Never throws; unknown milestones are dropped. */
export function parseTtvOverview(raw: unknown): TtvOverview {
  const d = rec(raw);

  const milestones: TtvMilestoneStat[] = arr(d.milestones).flatMap((x) => {
    const r = rec(x);
    if (!isTtvMilestone(r.milestone)) return [];
    return [{
      milestone: r.milestone,
      position: num(r.position),
      label: str(r.label),
      reached: num(r.reached),
      p50Seconds: numOrNull(r.p50_seconds),
      p90Seconds: numOrNull(r.p90_seconds),
    }];
  }).sort((a, b) => a.position - b.position);

  const config: TtvConfigRow[] = arr(d.config).flatMap((x) => {
    const r = rec(x);
    if (!isTtvMilestone(r.milestone)) return [];
    return [{
      milestone: r.milestone,
      position: num(r.position),
      label: str(r.label),
      stallHours: num(r.stall_hours),
      alertEnabled: r.alert_enabled === true,
    }];
  }).sort((a, b) => a.position - b.position);

  const alerts: TtvAlert[] = arr(d.open_alerts).flatMap((x) => {
    const r = rec(x);
    const id = str(r.id);
    if (!id || !isTtvMilestone(r.milestone)) return [];
    return [{
      id,
      accountId: str(r.account_id),
      companyName: strOrNull(r.company_name),
      milestone: r.milestone,
      firedAt: strOrNull(r.fired_at),
      stalledHours: num(r.stalled_hours),
      thresholdHours: num(r.threshold_hours),
      acknowledged: r.acknowledged === true,
    }];
  });

  return {
    generatedAt: strOrNull(d.generated_at),
    windowDays: num(d.window_days),
    signups: num(d.signups),
    truncated: d.truncated === true,
    watchDays: num(d.watch_days, 60),
    stalledNow: num(d.stalled_now),
    openAlertCount: num(d.open_alert_count, alerts.length),
    milestones,
    config,
    alerts,
  };
}
