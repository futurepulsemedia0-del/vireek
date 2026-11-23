// Labor-compliance SIGNALS — rule configuration (pure data + validation, no Supabase, no DOM).
//
// [COUNSEL] [VERIFY] — EVERYTHING in this file.
// These are starter parameters for *flagging records for a human to look at*. They are not
// statements of what the law requires of any particular employer, worker or job. Wage-and-hour
// rules differ by state, city, industry, contract, union agreement and worker status, and they
// change. Every pack below ships with `lastReviewed: null` (= nobody has checked it against the
// source yet) and every saved configuration starts as "needs counsel review".
//
// Meal & rest break rules are NOT duplicated here: they already live in ./breakRules.ts and the
// break_compliance_settings table. This module only adds overtime + prevailing-wage signal config.

export const LABOR_SIGNALS_DISCLAIMER =
  'Signals highlight time-clock records that may deserve a closer look. They are not legal conclusions and do not say that any law was or was not followed. Rules depend on facts this app cannot see — confirm with qualified employment counsel. [COUNSEL] [VERIFY]';

export type RuleTopic = 'overtime' | 'prevailing_wage';
export const RULE_TOPICS: readonly RuleTopic[] = ['overtime', 'prevailing_wage'];

export const CUSTOM_RULE = 'CUSTOM' as const;

// ------------------------------------------------------------------
// Overtime-threshold parameters
// ------------------------------------------------------------------

export interface OvertimeParams {
  /** 0 = Sunday … 6 = Saturday. The business's own fixed workweek. */
  workweek_start_dow: number;
  /** Weekly hours above which a signal is raised. null = not used. */
  weekly_threshold_hours: number | null;
  /** Daily hours above which a signal is raised. null = not used. */
  daily_ot_after_hours: number | null;
  /** Second, higher daily tier. Must be greater than daily_ot_after_hours. null = not used. */
  daily_dt_after_hours: number | null;
  /** Raise a signal when all 7 days of a workweek have clocked time. */
  seventh_day_signal: boolean;
  /** A shift still open after this many hours is probably a missed clock-out. */
  open_shift_alert_hours: number;
  /** Ignore payroll-vs-clock overtime gaps smaller than this many hours. */
  payroll_gap_tolerance_hours: number;
}

export const DEFAULT_OVERTIME_PARAMS: OvertimeParams = {
  workweek_start_dow: 1,
  weekly_threshold_hours: 40,
  daily_ot_after_hours: null,
  daily_dt_after_hours: null,
  seventh_day_signal: false,
  open_shift_alert_hours: 16,
  payroll_gap_tolerance_hours: 0.25,
};

export interface PrevailingWageParams {
  /** Time on a job that has a wage table, but no recorded classification for the worker. */
  check_missing_classification: boolean;
  /** Recorded hourly pay (+ plan fringe) lower than the wage-table rate for the recorded classification. */
  check_rate_below_table: boolean;
}

export const DEFAULT_PW_PARAMS: PrevailingWageParams = {
  check_missing_classification: true,
  check_rate_below_table: true,
};

export interface RulePack<P> {
  code: string;
  name: string;
  /** One neutral sentence: which thresholds the pack sets. Never says what the law "requires". */
  summary: string;
  citation: string;
  sourceUrl: string | null;
  /** YYYY-MM-DD the pack was last compared with the source; null = not yet verified. */
  lastReviewed: string | null;
  /** Things the signals do NOT look at — shown next to the pack. */
  notChecked: string[];
  params: P;
}

export const OVERTIME_PACKS: readonly RulePack<OvertimeParams>[] = [
  {
    code: 'FED',
    name: 'Federal (weekly threshold)',
    summary: 'Flags weeks with more than 40 clocked hours.',
    citation: 'FLSA, 29 U.S.C. § 207 [VERIFY]',
    sourceUrl: 'https://www.dol.gov/agencies/whd/overtime',
    lastReviewed: null,
    notChecked: [
      'Exemptions and the worker-status tests that decide who an exemption covers',
      'Special industry rules, fixed work periods and averaging arrangements',
      'State or local rules that are stricter than the federal one',
    ],
    params: { ...DEFAULT_OVERTIME_PARAMS, weekly_threshold_hours: 40 },
  },
  {
    code: 'CA',
    name: 'California (daily + weekly + seventh day)',
    summary: 'Flags days over 8 and over 12 clocked hours, weeks over 40, and a clocked seventh day in a workweek.',
    citation: 'Cal. Labor Code § 510; IWC wage orders [VERIFY]',
    sourceUrl: 'https://www.dir.ca.gov/dlse/FAQ_Overtime.htm',
    lastReviewed: null,
    notChecked: [
      'Alternative workweek schedules and collective-bargaining exceptions',
      'Exempt classifications and industry wage orders',
      'City or county rules',
    ],
    params: {
      ...DEFAULT_OVERTIME_PARAMS,
      weekly_threshold_hours: 40,
      daily_ot_after_hours: 8,
      daily_dt_after_hours: 12,
      seventh_day_signal: true,
    },
  },
];

export const PW_PACKS: readonly RulePack<PrevailingWageParams>[] = [
  {
    code: 'FED',
    name: 'Federal contracts (wage-table checks)',
    summary: 'Compares clocked time on wage-table jobs with the classification and pay recorded in Vireek.',
    citation: 'Davis-Bacon and Related Acts — applicability depends on the contract [VERIFY]',
    sourceUrl: 'https://www.dol.gov/agencies/whd/government-contracts/construction',
    lastReviewed: null,
    notChecked: [
      'Whether a given job is actually covered by a wage determination',
      'Fringe-benefit crediting, apprentice ratios and work-classification disputes',
      'Certified-payroll filing content',
    ],
    params: DEFAULT_PW_PARAMS,
  },
  {
    code: 'STATE',
    name: 'State or local program (wage-table checks)',
    summary: 'Same data checks as above, for a state or local prevailing-wage program.',
    citation: 'Varies by state and contract [COUNSEL] [VERIFY]',
    sourceUrl: null,
    lastReviewed: null,
    notChecked: ['Program-specific coverage, thresholds, classifications and reporting rules'],
    params: DEFAULT_PW_PARAMS,
  },
];

export function getOvertimePack(code: string): RulePack<OvertimeParams> | null {
  return OVERTIME_PACKS.find((p) => p.code === code) ?? null;
}
export function getPwPack(code: string): RulePack<PrevailingWageParams> | null {
  return PW_PACKS.find((p) => p.code === code) ?? null;
}

// ------------------------------------------------------------------
// Validation / normalisation (mirrors labor_validate_params() in SQL)
// ------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function nullableNumber(v: unknown, min: number, max: number, field: string): Parsed<number | null> {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  if (!isNum(v) || v < min || v > max) return { ok: false, error: `${field} must be between ${min} and ${max}.` };
  return { ok: true, value: v };
}

function requiredNumber(v: unknown, min: number, max: number, field: string): Parsed<number> {
  if (!isNum(v) || v < min || v > max) return { ok: false, error: `${field} must be between ${min} and ${max}.` };
  return { ok: true, value: v };
}

export function validateOvertimeParams(raw: unknown): Parsed<OvertimeParams> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const dow = requiredNumber(r.workweek_start_dow, 0, 6, 'workweek_start_dow');
  if (!dow.ok) return dow;
  if (!Number.isInteger(dow.value)) return { ok: false, error: 'workweek_start_dow must be a whole number.' };
  const weekly = nullableNumber(r.weekly_threshold_hours, 1, 168, 'weekly_threshold_hours');
  if (!weekly.ok) return weekly;
  const dailyOt = nullableNumber(r.daily_ot_after_hours, 1, 24, 'daily_ot_after_hours');
  if (!dailyOt.ok) return dailyOt;
  const dailyDt = nullableNumber(r.daily_dt_after_hours, 1, 24, 'daily_dt_after_hours');
  if (!dailyDt.ok) return dailyDt;
  if (dailyDt.value !== null && dailyOt.value === null) return { ok: false, error: 'daily_dt_after_hours needs daily_ot_after_hours.' };
  if (dailyDt.value !== null && dailyOt.value !== null && dailyDt.value <= dailyOt.value) {
    return { ok: false, error: 'daily_dt_after_hours must be greater than daily_ot_after_hours.' };
  }
  if (weekly.value === null && dailyOt.value === null && r.seventh_day_signal !== true) {
    return { ok: false, error: 'Set at least one threshold.' };
  }
  const open = requiredNumber(r.open_shift_alert_hours, 4, 48, 'open_shift_alert_hours');
  if (!open.ok) return open;
  const tol = requiredNumber(r.payroll_gap_tolerance_hours, 0, 8, 'payroll_gap_tolerance_hours');
  if (!tol.ok) return tol;
  if (typeof r.seventh_day_signal !== 'boolean') return { ok: false, error: 'seventh_day_signal must be true or false.' };
  return {
    ok: true,
    value: {
      workweek_start_dow: dow.value,
      weekly_threshold_hours: weekly.value,
      daily_ot_after_hours: dailyOt.value,
      daily_dt_after_hours: dailyDt.value,
      seventh_day_signal: r.seventh_day_signal,
      open_shift_alert_hours: open.value,
      payroll_gap_tolerance_hours: tol.value,
    },
  };
}

export function validatePwParams(raw: unknown): Parsed<PrevailingWageParams> {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.check_missing_classification !== 'boolean' || typeof r.check_rate_below_table !== 'boolean') {
    return { ok: false, error: 'Both checks must be true or false.' };
  }
  if (!r.check_missing_classification && !r.check_rate_below_table) return { ok: false, error: 'Turn on at least one check.' };
  return { ok: true, value: { check_missing_classification: r.check_missing_classification, check_rate_below_table: r.check_rate_below_table } };
}

/** Defensive read of server JSON — invalid input falls back to defaults instead of throwing. */
export function normalizeOvertimeParams(raw: unknown): OvertimeParams {
  const p = validateOvertimeParams({ ...DEFAULT_OVERTIME_PARAMS, ...((raw ?? {}) as object) });
  return p.ok ? p.value : DEFAULT_OVERTIME_PARAMS;
}
export function normalizePwParams(raw: unknown): PrevailingWageParams {
  const p = validatePwParams({ ...DEFAULT_PW_PARAMS, ...((raw ?? {}) as object) });
  return p.ok ? p.value : DEFAULT_PW_PARAMS;
}

// ------------------------------------------------------------------
// Review state of a saved configuration
// ------------------------------------------------------------------

export type CounselStatus = 'needs_counsel' | 'counsel_reviewed';

export interface RuleConfigRecord<P> {
  topic: RuleTopic;
  jurisdiction: string;
  enabled: boolean;
  params: P;
  citation: string | null;
  source_url: string | null;
  counsel_status: CounselStatus;
  counsel_reviewed_by: string | null;
  counsel_reviewed_at: string | null;
  /** YYYY-MM-DD someone compared the numbers with the source; null = still [VERIFY]. */
  verified_on: string | null;
}

/** Markers the UI must show next to a configuration until the matching step is recorded. */
export function openMarkers(c: Pick<RuleConfigRecord<unknown>, 'counsel_status' | 'verified_on'>): ('COUNSEL' | 'VERIFY')[] {
  const out: ('COUNSEL' | 'VERIFY')[] = [];
  if (c.counsel_status !== 'counsel_reviewed') out.push('COUNSEL');
  if (!c.verified_on) out.push('VERIFY');
  return out;
}
