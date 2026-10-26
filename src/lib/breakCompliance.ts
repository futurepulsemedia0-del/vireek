// Meal & rest break compliance — pure logic (no Supabase, no DOM).
//
// Violations are COMPUTED from time-clock shifts, never stored, so changing a
// rule re-evaluates history. A closed break is classified by its length:
//   >= meal_min_minutes                    -> meal break
//   rest_min_minutes .. meal_min_minutes   -> rest break
//   shorter                                -> does not count

export interface BreakSettings {
  enabled: boolean;
  meal_min_minutes: number;
  /** The first meal must start before this many WORKED minutes. */
  meal_deadline_minutes: number;
  /** A meal is required once worked time reaches each value (ascending). */
  meal_thresholds: number[];
  rest_min_minutes: number;
  /** A rest break is required once worked time reaches each value (ascending). */
  rest_thresholds: number[];
  /** Premium pay owed per shift for a meal violation and for a rest violation. */
  premium_minutes: number;
  prompts_enabled: boolean;
  prompt_lead_minutes: number;
}

export const DEFAULT_SETTINGS: BreakSettings = {
  enabled: true,
  meal_min_minutes: 30,
  meal_deadline_minutes: 300,
  meal_thresholds: [300, 600],
  rest_min_minutes: 10,
  rest_thresholds: [210, 360, 600],
  premium_minutes: 60,
  prompts_enabled: true,
  prompt_lead_minutes: 30,
};

export type ViolationCode = 'meal_missing' | 'meal_late' | 'rest_missing';
export type ReviewStatus = 'open' | 'waived' | 'excused' | 'premium_paid';
export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad';

export const VIOLATION_LABELS: Record<ViolationCode, string> = {
  meal_missing: 'Meal break missed',
  meal_late: 'Meal break late',
  rest_missing: 'Rest break missed',
};

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  open: 'Needs review',
  waived: 'Waived',
  excused: 'Excused',
  premium_paid: 'Premium paid',
};

export const REVIEW_TONES: Record<ReviewStatus, StatusTone> = {
  open: 'bad',
  waived: 'neutral',
  excused: 'neutral',
  premium_paid: 'good',
};

const MIN = 60_000;

// ------------------------------------------------------------------
// Shapes
// ------------------------------------------------------------------

export interface ShiftRecord {
  id: string;
  team_member_id: string;
  work_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  breaks: { started_at: string; ended_at: string | null }[];
}

export interface Violation {
  code: ViolationCode;
  label: string;
  detail: string;
  status: ReviewStatus;
  note: string | null;
}

export interface ShiftCompliance {
  shiftId: string;
  memberId: string;
  workDate: string;
  open: boolean;
  clockInAt: number;
  clockOutAt: number | null;
  workedMinutes: number;
  mealsRequired: number;
  mealsTaken: number;
  restsRequired: number;
  restsTaken: number;
  violations: Violation[];
}

export interface ReviewRecord {
  shift_id: string;
  code: ViolationCode;
  status: Exclude<ReviewStatus, 'open'>;
  note: string | null;
}

// ------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------

export function minutesLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m} min` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// ------------------------------------------------------------------
// Settings parsing / validation (form <-> rules)
// ------------------------------------------------------------------

export interface SettingsForm {
  enabled: boolean;
  meal_min_minutes: string;
  meal_deadline_minutes: string;
  meal_thresholds: string;
  rest_min_minutes: string;
  rest_thresholds: string;
  premium_minutes: string;
  prompts_enabled: boolean;
  prompt_lead_minutes: string;
}

export function settingsToForm(s: BreakSettings): SettingsForm {
  return {
    enabled: s.enabled,
    meal_min_minutes: String(s.meal_min_minutes),
    meal_deadline_minutes: String(s.meal_deadline_minutes),
    meal_thresholds: s.meal_thresholds.join(', '),
    rest_min_minutes: String(s.rest_min_minutes),
    rest_thresholds: s.rest_thresholds.join(', '),
    premium_minutes: String(s.premium_minutes),
    prompts_enabled: s.prompts_enabled,
    prompt_lead_minutes: String(s.prompt_lead_minutes),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseWholeNumber(raw: string, min: number, max: number, label: string): Parsed<number> {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: `${label} must be a whole number.` };
  const n = Number(t);
  if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

/** "300, 600" -> [300, 600]; sorted, de-duplicated, empty allowed. */
export function parseThresholds(raw: string, maxItems: number, label: string): Parsed<number[]> {
  const parts = raw
    .split(/[,\s;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = parseWholeNumber(p, 1, 1440, label);
    if (!n.ok) return { ok: false, error: `${label}: use whole minutes between 1 and 1440, separated by commas.` };
    out.push(n.value);
  }
  const unique = [...new Set(out)].sort((a, b) => a - b);
  if (unique.length > maxItems) return { ok: false, error: `${label}: use at most ${maxItems} values.` };
  return { ok: true, value: unique };
}

export function validateSettingsForm(f: SettingsForm): Parsed<BreakSettings> {
  const mealMin = parseWholeNumber(f.meal_min_minutes, 5, 180, 'Meal break length');
  if (!mealMin.ok) return mealMin;
  const restMin = parseWholeNumber(f.rest_min_minutes, 1, 60, 'Rest break length');
  if (!restMin.ok) return restMin;
  if (restMin.value >= mealMin.value) return { ok: false, error: 'A meal break must be longer than a rest break.' };
  const deadline = parseWholeNumber(f.meal_deadline_minutes, 60, 1440, 'First meal deadline');
  if (!deadline.ok) return deadline;
  const premium = parseWholeNumber(f.premium_minutes, 0, 480, 'Premium pay');
  if (!premium.ok) return premium;
  const lead = parseWholeNumber(f.prompt_lead_minutes, 5, 120, 'Prompt lead time');
  if (!lead.ok) return lead;
  const meals = parseThresholds(f.meal_thresholds, 4, 'Meal break shift lengths');
  if (!meals.ok) return meals;
  const rests = parseThresholds(f.rest_thresholds, 6, 'Rest break shift lengths');
  if (!rests.ok) return rests;
  return {
    ok: true,
    value: {
      enabled: f.enabled,
      meal_min_minutes: mealMin.value,
      meal_deadline_minutes: deadline.value,
      meal_thresholds: meals.value,
      rest_min_minutes: restMin.value,
      rest_thresholds: rests.value,
      premium_minutes: premium.value,
      prompts_enabled: f.prompts_enabled,
      prompt_lead_minutes: lead.value,
    },
  };
}

export function settingsEqual(a: BreakSettings, b: BreakSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Defensive read of the server JSON: bad or missing fields fall back to defaults. */
export function normalizeSettings(raw: unknown): BreakSettings {
  const r = (raw ?? {}) as Partial<Record<keyof BreakSettings, unknown>>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const list = (v: unknown, d: number[]) =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b) : d;
  const mealMin = num(r.meal_min_minutes, DEFAULT_SETTINGS.meal_min_minutes);
  const restMin = num(r.rest_min_minutes, DEFAULT_SETTINGS.rest_min_minutes);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    meal_min_minutes: mealMin,
    meal_deadline_minutes: num(r.meal_deadline_minutes, DEFAULT_SETTINGS.meal_deadline_minutes),
    meal_thresholds: list(r.meal_thresholds, DEFAULT_SETTINGS.meal_thresholds),
    rest_min_minutes: restMin < mealMin ? restMin : Math.max(1, mealMin - 1),
    rest_thresholds: list(r.rest_thresholds, DEFAULT_SETTINGS.rest_thresholds),
    premium_minutes: num(r.premium_minutes, DEFAULT_SETTINGS.premium_minutes),
    prompts_enabled: typeof r.prompts_enabled === 'boolean' ? r.prompts_enabled : DEFAULT_SETTINGS.prompts_enabled,
    prompt_lead_minutes: num(r.prompt_lead_minutes, DEFAULT_SETTINGS.prompt_lead_minutes),
  };
}

// ------------------------------------------------------------------
// Evaluation
// ------------------------------------------------------------------

interface ClosedBreak {
  startMs: number;
  durMin: number;
  /** Worked minutes (breaks excluded) before this break began. */
  workedBefore: number;
}

function normalizeBreaks(shift: ShiftRecord, endMs: number): { items: ClosedBreak[]; totalBreakMin: number } {
  const inMs = Date.parse(shift.clock_in_at);
  const raw = shift.breaks
    .map((b) => {
      const s = Date.parse(b.started_at);
      const e = b.ended_at ? Date.parse(b.ended_at) : endMs;
      return { s: Math.max(inMs, s), e: Math.min(endMs, e) };
    })
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s)
    .sort((a, b) => a.s - b.s);

  const items: ClosedBreak[] = [];
  let prior = 0;
  for (const b of raw) {
    const durMin = (b.e - b.s) / MIN;
    items.push({ startMs: b.s, durMin, workedBefore: (b.s - inMs) / MIN - prior });
    prior += durMin;
  }
  return { items, totalBreakMin: prior };
}

const countReached = (thresholds: number[], worked: number) => thresholds.filter((t) => worked >= t).length;

export function evaluateShift(shift: ShiftRecord, settings: BreakSettings, now: number): ShiftCompliance {
  const inMs = Date.parse(shift.clock_in_at);
  const outMs = shift.clock_out_at ? Date.parse(shift.clock_out_at) : null;
  const endMs = outMs ?? now;
  const open = outMs === null;
  const { items, totalBreakMin } = normalizeBreaks(shift, endMs);
  const worked = Math.max(0, (endMs - inMs) / MIN - totalBreakMin);

  const meals = items.filter((b) => b.durMin >= settings.meal_min_minutes);
  const rests = items.filter((b) => b.durMin >= settings.rest_min_minutes && b.durMin < settings.meal_min_minutes);

  const mealsRequired = countReached(settings.meal_thresholds, worked);
  const restsRequired = countReached(settings.rest_thresholds, worked);
  const violations: Violation[] = [];
  const push = (code: ViolationCode, detail: string) =>
    violations.push({ code, label: VIOLATION_LABELS[code], detail, status: 'open', note: null });

  if (settings.enabled) {
    if (meals.length < mealsRequired) {
      const longest = items.reduce((m, b) => Math.max(m, b.durMin), 0);
      const missing = mealsRequired - meals.length;
      const had = longest > 0 ? ` Longest break taken: ${minutesLabel(longest)}.` : ' No breaks recorded.';
      push(
        'meal_missing',
        `${missing === 1 ? 'A' : missing} meal break of at least ${settings.meal_min_minutes} min ${missing === 1 ? 'was' : 'were'} required after ${minutesLabel(worked)} worked.${had}`,
      );
    }
    const firstMeal = meals[0];
    if (firstMeal && firstMeal.workedBefore > settings.meal_deadline_minutes) {
      push(
        'meal_late',
        `The first meal break started after ${minutesLabel(firstMeal.workedBefore)} of work; it was due before ${minutesLabel(settings.meal_deadline_minutes)}.`,
      );
    }
    if (rests.length < restsRequired) {
      const missing = restsRequired - rests.length;
      push(
        'rest_missing',
        `${missing} rest break${missing === 1 ? '' : 's'} of at least ${settings.rest_min_minutes} min missing (${restsRequired} required, ${rests.length} taken).`,
      );
    }
  }

  return {
    shiftId: shift.id,
    memberId: shift.team_member_id,
    workDate: shift.work_date,
    open,
    clockInAt: inMs,
    clockOutAt: outMs,
    workedMinutes: Math.round(worked),
    mealsRequired,
    mealsTaken: meals.length,
    restsRequired,
    restsTaken: rests.length,
    violations,
  };
}

export function evaluateShifts(shifts: ShiftRecord[], settings: BreakSettings, now: number): ShiftCompliance[] {
  return shifts.map((s) => evaluateShift(s, settings, now)).sort((a, b) => b.clockInAt - a.clockInAt);
}

/** Attaches manager decisions to violations. A decision for a violation that no longer exists is ignored. */
export function applyReviews(list: ShiftCompliance[], reviews: ReviewRecord[]): ShiftCompliance[] {
  const byKey = new Map(reviews.map((r) => [`${r.shift_id}:${r.code}`, r]));
  return list.map((sc) => ({
    ...sc,
    violations: sc.violations.map((v) => {
      const r = byKey.get(`${sc.shiftId}:${v.code}`);
      return r ? { ...v, status: r.status, note: r.note } : v;
    }),
  }));
}

// ------------------------------------------------------------------
// Premium pay + summary
// ------------------------------------------------------------------

/** One premium per shift for meal violations and one for rest violations, for violations still open. */
export function premiumMinutesFor(sc: ShiftCompliance, settings: BreakSettings, statuses: ReviewStatus[] = ['open']): number {
  const live = sc.violations.filter((v) => statuses.includes(v.status));
  const meal = live.some((v) => v.code === 'meal_missing' || v.code === 'meal_late');
  const rest = live.some((v) => v.code === 'rest_missing');
  return (meal ? settings.premium_minutes : 0) + (rest ? settings.premium_minutes : 0);
}

export interface ComplianceSummary {
  shifts: number;
  compliantShifts: number;
  /** 0-100, or null when there is nothing to measure. */
  complianceRate: number | null;
  openViolations: number;
  byCode: Record<ViolationCode, number>;
  premiumOwedMinutes: number;
  premiumPaidMinutes: number;
}

export function summarize(list: ShiftCompliance[], settings: BreakSettings): ComplianceSummary {
  const byCode: Record<ViolationCode, number> = { meal_missing: 0, meal_late: 0, rest_missing: 0 };
  let compliant = 0;
  let openViolations = 0;
  let owed = 0;
  let paid = 0;
  for (const sc of list) {
    const live = sc.violations.filter((v) => v.status === 'open');
    if (sc.violations.length === 0 || live.length === 0) compliant += 1;
    for (const v of live) {
      openViolations += 1;
      byCode[v.code] += 1;
    }
    owed += premiumMinutesFor(sc, settings, ['open']);
    paid += premiumMinutesFor(sc, settings, ['premium_paid']);
  }
  return {
    shifts: list.length,
    compliantShifts: compliant,
    complianceRate: list.length === 0 ? null : Math.round((compliant / list.length) * 100),
    openViolations,
    byCode,
    premiumOwedMinutes: owed,
    premiumPaidMinutes: paid,
  };
}

export interface MemberRollup {
  memberId: string;
  shifts: number;
  openViolations: number;
  complianceRate: number;
}

/** Worst compliance first. */
export function rollupByMember(list: ShiftCompliance[]): MemberRollup[] {
  const m = new Map<string, { shifts: number; bad: number; open: number }>();
  for (const sc of list) {
    const cur = m.get(sc.memberId) ?? { shifts: 0, bad: 0, open: 0 };
    const live = sc.violations.filter((v) => v.status === 'open').length;
    cur.shifts += 1;
    cur.open += live;
    if (live > 0) cur.bad += 1;
    m.set(sc.memberId, cur);
  }
  return [...m.entries()]
    .map(([memberId, c]) => ({
      memberId,
      shifts: c.shifts,
      openViolations: c.open,
      complianceRate: Math.round(((c.shifts - c.bad) / c.shifts) * 100),
    }))
    .sort((a, b) => a.complianceRate - b.complianceRate || b.openViolations - a.openViolations);
}

export type ViolationFilter = 'open' | 'all';

export function filterShifts(list: ShiftCompliance[], memberId: string, filter: ViolationFilter): ShiftCompliance[] {
  return list.filter((sc) => {
    if (memberId !== 'all' && sc.memberId !== memberId) return false;
    if (filter === 'all') return sc.violations.length > 0;
    return sc.violations.some((v) => v.status === 'open');
  });
}

// ------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------

export interface ViolationCsvRow {
  date: string;
  employee: string;
  clockIn: string;
  clockOut: string;
  workedMinutes: number;
  violation: string;
  detail: string;
  status: string;
  note: string;
}

export function buildViolationCsvRows(list: ShiftCompliance[], nameOf: (memberId: string) => string): ViolationCsvRow[] {
  const rows: ViolationCsvRow[] = [];
  for (const sc of list) {
    for (const v of sc.violations) {
      rows.push({
        date: sc.workDate,
        employee: nameOf(sc.memberId),
        clockIn: new Date(sc.clockInAt).toISOString(),
        clockOut: sc.clockOutAt ? new Date(sc.clockOutAt).toISOString() : 'Still working',
        workedMinutes: sc.workedMinutes,
        violation: v.label,
        detail: v.detail,
        status: REVIEW_LABELS[v.status],
        note: v.note ?? '',
      });
    }
  }
  return rows;
}

export const VIOLATION_CSV_COLUMNS: { header: string; accessor: (r: ViolationCsvRow) => string | number }[] = [
  { header: 'Date', accessor: (r) => r.date },
  { header: 'Employee', accessor: (r) => r.employee },
  { header: 'Clock in', accessor: (r) => r.clockIn },
  { header: 'Clock out', accessor: (r) => r.clockOut },
  { header: 'Worked minutes', accessor: (r) => r.workedMinutes },
  { header: 'Violation', accessor: (r) => r.violation },
  { header: 'Detail', accessor: (r) => r.detail },
  { header: 'Review status', accessor: (r) => r.status },
  { header: 'Review note', accessor: (r) => r.note },
];

// ------------------------------------------------------------------
// Technician prompts (open shift, runs on the device — works offline)
// ------------------------------------------------------------------

export interface PromptShift {
  clockInAt: number;
  clockOutAt: number | null;
  breaks: { startAt: number; endAt: number | null }[];
}

export type PromptKind = 'meal_overdue' | 'rest_overdue' | 'meal_soon' | 'rest_soon' | 'break_too_short';

export interface BreakPrompt {
  /** Changes whenever a different prompt applies, so a dismissal never hides the next one. */
  key: string;
  kind: PromptKind;
  tone: StatusTone;
  title: string;
  message: string;
}

export function nextBreakPrompt(shift: PromptShift | null, settings: BreakSettings | null, now: number): BreakPrompt | null {
  if (!shift || shift.clockOutAt !== null || !settings || !settings.enabled || !settings.prompts_enabled) return null;

  const record: ShiftRecord = {
    id: 'live',
    team_member_id: 'self',
    work_date: '',
    clock_in_at: new Date(shift.clockInAt).toISOString(),
    clock_out_at: null,
    breaks: shift.breaks.map((b) => ({
      started_at: new Date(b.startAt).toISOString(),
      ended_at: b.endAt === null ? null : new Date(b.endAt).toISOString(),
    })),
  };

  const openBreak = shift.breaks.find((b) => b.endAt === null);
  const closed = { ...record, breaks: record.breaks.filter((b) => b.ended_at !== null) };
  const sc = evaluateShift(closed, settings, now);

  // Worked time so far, counting a running break as time off the clock.
  const { totalBreakMin } = normalizeBreaks(record, now);
  const worked = Math.max(0, (now - shift.clockInAt) / MIN - totalBreakMin);
  const lead = settings.prompt_lead_minutes;

  // On a break that is still too short to count as the break that is due.
  if (openBreak) {
    const elapsed = (now - openBreak.startAt) / MIN;
    const mealDue = sc.mealsTaken < countReached(settings.meal_thresholds, worked + 0.001);
    const need = mealDue ? settings.meal_min_minutes : settings.rest_min_minutes;
    if (elapsed < need && (mealDue || sc.restsTaken < countReached(settings.rest_thresholds, worked + 0.001))) {
      const left = Math.ceil(need - elapsed);
      return {
        key: `short:${mealDue ? 'meal' : 'rest'}:${sc.mealsTaken}:${sc.restsTaken}`,
        kind: 'break_too_short',
        tone: 'neutral',
        title: mealDue ? 'Meal break in progress' : 'Rest break in progress',
        message: `Stay on break for about ${left} more minute${left === 1 ? '' : 's'} so it counts as your ${mealDue ? 'meal' : 'rest'} break.`,
      };
    }
    return null;
  }

  const nextMealAt =
    sc.mealsTaken === 0
      ? Math.min(settings.meal_deadline_minutes, settings.meal_thresholds[0] ?? Infinity)
      : settings.meal_thresholds[sc.mealsTaken] ?? Infinity;
  const nextRestAt = settings.rest_thresholds[sc.restsTaken] ?? Infinity;
  const mealIn = nextMealAt - worked;
  const restIn = nextRestAt - worked;

  if (Number.isFinite(mealIn) && mealIn <= 0) {
    return {
      key: `meal_overdue:${sc.mealsTaken}`,
      kind: 'meal_overdue',
      tone: 'bad',
      title: 'Your meal break is overdue',
      message: `Please take a ${settings.meal_min_minutes}-minute meal break as soon as it is safe to stop.`,
    };
  }
  if (Number.isFinite(restIn) && restIn <= 0) {
    return {
      key: `rest_overdue:${sc.restsTaken}`,
      kind: 'rest_overdue',
      tone: 'bad',
      title: 'Your rest break is overdue',
      message: `Please take a ${settings.rest_min_minutes}-minute rest break as soon as it is safe to stop.`,
    };
  }
  if (Number.isFinite(mealIn) && mealIn <= lead) {
    const m = Math.ceil(mealIn);
    return {
      key: `meal_soon:${sc.mealsTaken}`,
      kind: 'meal_soon',
      tone: 'warn',
      title: 'Meal break coming up',
      message: `Your ${settings.meal_min_minutes}-minute meal break is due in about ${m} minute${m === 1 ? '' : 's'}. Plan a good stopping point.`,
    };
  }
  if (Number.isFinite(restIn) && restIn <= lead) {
    const m = Math.ceil(restIn);
    return {
      key: `rest_soon:${sc.restsTaken}`,
      kind: 'rest_soon',
      tone: 'warn',
      title: 'Rest break coming up',
      message: `Your ${settings.rest_min_minutes}-minute rest break is due in about ${m} minute${m === 1 ? '' : 's'}.`,
    };
  }
  return null;
}

// ------------------------------------------------------------------
// Errors (same shape handling as the other Vireek RPC modules)
// ------------------------------------------------------------------

interface DbErrorLike {
  code?: string;
  message?: string;
}

export function breakErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as DbErrorLike | null;
  if (!e) return fallback;
  if (e.code === '42501') return e.message && !/not authorised/i.test(e.message) ? e.message : "You don't have permission to do that.";
  if (e.message && (e.code === 'P0001' || e.code === 'P0002')) return e.message;
  if (e.message && /Failed to fetch|NetworkError|network/i.test(e.message)) return "You're offline — check your connection and try again.";
  return fallback;
}
