/**
 * Callback Promise — pure helpers (no I/O, no imports).
 *
 * Mirrors supabase/migrations/20290312000000_callback_promise.sql:
 *   - the window / escalation bounds and formatWindow() match the SQL CHECKs and callback_promise_fmt_minutes()
 *   - the stats shape is what callback_promise_stats() returns
 * There is deliberately NO default window: the number of minutes in "every missed call gets a callback within X"
 * is the owner's decision (TODO(owner)), so an unconfigured account is "off", never "off with a made-up limit".
 */

export const CALLBACK_WINDOW_MIN_MINUTES = 5;
export const CALLBACK_WINDOW_MAX_MINUTES = 10_080; // 7 days
export const CALLBACK_MIN_CASES_MAX = 100_000;

export interface CallbackPromiseSettings {
  enabled: boolean;
  /** null until the owner chooses it. */
  windowMinutes: number | null;
  /** null = overdue alert only, no human-escalation step. */
  escalateAfterMinutes: number | null;
  publicStatOptIn: boolean;
  /** null = the public stat can never be published. */
  publicStatMinCases: number | null;
}

export const UNCONFIGURED_SETTINGS: CallbackPromiseSettings = {
  enabled: false,
  windowMinutes: null,
  escalateAfterMinutes: null,
  publicStatOptIn: false,
  publicStatMinCases: null,
};

export interface CallbackStats {
  decided: number;
  keptSystem: number;
  keptManual: number;
  late: number;
  broken: number;
  openOverdue: number;
  medianMinutesToCallback: number | null;
  windowMin: number | null;
  windowMax: number | null;
}

export interface CallbackStatsSummary {
  /** Share of decided cases with a SYSTEM-recorded callback inside the window. null when nothing is decided. */
  verifiedRatePct: number | null;
  /** Same, but also counting outcomes a team member confirmed by hand. Owner view only, never published. */
  ownerRatePct: number | null;
  needsAttention: number;
  windowChanged: boolean;
}

export type PublicStatResult =
  | { publishable: true; windowMinutes: number; periodDays: number; cases: number; keptOnTime: number; ratePct: number; asOf: string }
  | { publishable: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toCount(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toNullableNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** "45 min", "1 h", "90 min", "24 h" — same text as callback_promise_fmt_minutes() in SQL. */
export function formatWindow(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '-';
  const m = Math.round(minutes);
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

/**
 * Accepts "30", "30m", "30 min", "2h", "2 hours". Whole minutes only; returns null when the text is empty,
 * not understood, or outside 5 minutes – 7 days.
 */
export function parseWindowInput(raw: string): number | null {
  const m = /^\s*(\d{1,6})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?\s*$/i.exec(raw ?? '');
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const minutes = unit.startsWith('h') ? value * 60 : value;
  if (!Number.isInteger(minutes) || minutes < CALLBACK_WINDOW_MIN_MINUTES || minutes > CALLBACK_WINDOW_MAX_MINUTES) return null;
  return minutes;
}

/** Plain whole number of minutes/cases for the optional fields; '' means "not set" (null). Invalid -> undefined. */
export function parseOptionalMinutes(raw: string): number | null | undefined {
  if ((raw ?? '').trim() === '') return null;
  const parsed = parseWindowInput(raw);
  return parsed === null ? undefined : parsed;
}

export function parseOptionalCases(raw: string): number | null | undefined {
  if ((raw ?? '').trim() === '') return null;
  if (!/^\d{1,6}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 1 && n <= CALLBACK_MIN_CASES_MAX ? n : undefined;
}

/** Same rules as the SQL RPC; returns human-readable problems (empty = valid). */
export function validateSettings(s: CallbackPromiseSettings): string[] {
  const errors: string[] = [];
  const inRange = (n: number) => Number.isInteger(n) && n >= CALLBACK_WINDOW_MIN_MINUTES && n <= CALLBACK_WINDOW_MAX_MINUTES;
  if (s.windowMinutes !== null && !inRange(s.windowMinutes)) errors.push('The callback window must be between 5 minutes and 7 days.');
  if (s.escalateAfterMinutes !== null && !inRange(s.escalateAfterMinutes)) errors.push('The escalation delay must be between 5 minutes and 7 days.');
  if (s.enabled && s.windowMinutes === null) errors.push('Choose the callback window before turning the promise on.');
  if (s.publicStatMinCases !== null && (!Number.isInteger(s.publicStatMinCases) || s.publicStatMinCases < 1 || s.publicStatMinCases > CALLBACK_MIN_CASES_MAX)) {
    errors.push('The minimum sample must be a whole number of at least 1.');
  }
  if (s.publicStatOptIn && s.publicStatMinCases === null) errors.push('Set a minimum sample size before allowing a public stat.');
  return errors;
}

export function mapSettingsRow(row: unknown): CallbackPromiseSettings {
  if (!isRecord(row)) return UNCONFIGURED_SETTINGS;
  return {
    enabled: row.enabled === true,
    windowMinutes: toNullableNumber(row.window_minutes),
    escalateAfterMinutes: toNullableNumber(row.escalate_after_minutes),
    publicStatOptIn: row.public_stat_opt_in === true,
    publicStatMinCases: toNullableNumber(row.public_stat_min_cases),
  };
}

export function mapStatsRow(row: unknown): CallbackStats {
  const r = isRecord(row) ? row : {};
  return {
    decided: toCount(r.decided),
    keptSystem: toCount(r.kept_system),
    keptManual: toCount(r.kept_manual),
    late: toCount(r.late),
    broken: toCount(r.broken),
    openOverdue: toCount(r.open_overdue),
    medianMinutesToCallback: toNullableNumber(r.median_minutes_to_callback),
    windowMin: toNullableNumber(r.window_min),
    windowMax: toNullableNumber(r.window_max),
  };
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export function summarizeStats(s: CallbackStats): CallbackStatsSummary {
  return {
    verifiedRatePct: pct(s.keptSystem, s.decided),
    ownerRatePct: pct(s.keptSystem + s.keptManual, s.decided),
    needsAttention: s.openOverdue,
    windowChanged: s.windowMin !== null && s.windowMax !== null && s.windowMin !== s.windowMax,
  };
}

export function mapPublicStat(raw: unknown): PublicStatResult | null {
  if (!isRecord(raw)) return null;
  if (raw.publishable !== true) return { publishable: false, reason: typeof raw.reason === 'string' ? raw.reason : 'not_publishable' };
  const cases = toCount(raw.cases);
  const keptOnTime = toCount(raw.kept_on_time);
  const windowMinutes = toNullableNumber(raw.window_minutes);
  const periodDays = toCount(raw.period_days);
  const ratePct = toNullableNumber(raw.rate_pct);
  if (cases < 1 || keptOnTime > cases || windowMinutes === null || periodDays < 1 || ratePct === null || typeof raw.as_of !== 'string') {
    return { publishable: false, reason: 'invalid_data' };
  }
  return { publishable: true, windowMinutes, periodDays, cases, keptOnTime, ratePct, asOf: raw.as_of };
}

/**
 * The only sentence allowed to leave the building. Built exclusively from a publishable, real-data result;
 * returns null for anything else, so a caller can never render a number the database did not vouch for.
 */
export function buildPublicStatLine(stat: PublicStatResult | null): string | null {
  if (!stat || !stat.publishable) return null;
  return `${stat.keptOnTime} of ${stat.cases} missed-call callbacks were made within ${formatWindow(stat.windowMinutes)} (last ${stat.periodDays} days).`;
}

export type PromiseOutcome = 'on_time' | 'late' | 'overdue' | 'open' | 'cancelled' | 'broken';

/** Display outcome of one callback-policy promise. `now` is injected for deterministic tests. */
export function classifyPolicyPromise(
  p: { status: string; due_at: string | null; resolved_at: string | null },
  now: number,
): PromiseOutcome {
  if (p.status === 'cancelled') return 'cancelled';
  if (p.status === 'broken') return 'broken';
  const due = p.due_at ? Date.parse(p.due_at) : NaN;
  if (p.status === 'fulfilled') {
    const done = p.resolved_at ? Date.parse(p.resolved_at) : NaN;
    if (Number.isNaN(due) || Number.isNaN(done)) return 'late';
    return done <= due ? 'on_time' : 'late';
  }
  if (!Number.isNaN(due) && due <= now) return 'overdue';
  return 'open';
}
