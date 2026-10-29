// Project Daily Logs — pure logic (no I/O). The data layer lives in dailyLogsApi.ts.
// Server rules (one log per project per day, lock after submit) are enforced by
// supabase/migrations/20280301000000_project_daily_logs.sql; this file mirrors them for the UI.

export const WEATHER_OPTIONS = [
  { code: 'clear', label: 'Clear' },
  { code: 'partly_cloudy', label: 'Partly cloudy' },
  { code: 'cloudy', label: 'Cloudy' },
  { code: 'rain', label: 'Rain' },
  { code: 'storm', label: 'Thunderstorm' },
  { code: 'snow', label: 'Snow / ice' },
  { code: 'fog', label: 'Fog' },
  { code: 'wind', label: 'High wind' },
  { code: 'heat', label: 'Extreme heat' },
  { code: 'cold', label: 'Extreme cold' },
] as const;
export type WeatherCode = (typeof WEATHER_OPTIONS)[number]['code'];

export const DELAY_OPTIONS = [
  { code: 'weather', label: 'Weather' },
  { code: 'material', label: 'Material / delivery' },
  { code: 'inspection', label: 'Inspection' },
  { code: 'permit', label: 'Permit' },
  { code: 'customer', label: 'Customer / site access' },
  { code: 'crew', label: 'Crew availability' },
  { code: 'equipment', label: 'Equipment' },
  { code: 'other', label: 'Other' },
] as const;
export type DelayCause = (typeof DELAY_OPTIONS)[number]['code'];

export const LIMITS = { work: 5000, weatherNotes: 500, summary: 2000, crew: 60, delays: 30, visitors: 30, photos: 30, amendment: 2000 } as const;

export const WEATHER_LABEL = Object.fromEntries(WEATHER_OPTIONS.map((o) => [o.code, o.label])) as Record<WeatherCode, string>;
export const DELAY_LABEL = Object.fromEntries(DELAY_OPTIONS.map((o) => [o.code, o.label])) as Record<DelayCause, string>;

export const isWeatherCode = (v: unknown): v is WeatherCode => WEATHER_OPTIONS.some((o) => o.code === v);
export const isDelayCause = (v: unknown): v is DelayCause => DELAY_OPTIONS.some((o) => o.code === v);

// ---------------- Types (rows as stored) ----------------

export type LogStatus = 'draft' | 'submitted';

export interface DailyLog {
  id: string;
  project_id: string;
  log_date: string;
  status: LogStatus;
  weather_code: WeatherCode | null;
  temp_high_f: number | null;
  temp_low_f: number | null;
  wind_mph: number | null;
  weather_notes: string | null;
  work_performed: string | null;
  ai_summary: string | null;
  ai_generated_at: string | null;
  ai_edited: boolean;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrewRecord { id: string; employee_id: string | null; name: string; role: string | null; hours: number; source: 'timesheet' | 'manual'; sort_order: number }
export interface DelayRecord { id: string; cause: DelayCause; minutes: number; description: string | null; sort_order: number }
export interface VisitorRecord { id: string; name: string; company: string | null; purpose: string | null; sort_order: number }
export interface AmendmentRecord { id: string; note: string; created_at: string }

// ---------------- Editor form (strings, because they are bound to inputs) ----------------

export interface CrewEntry { employee_id: string | null; name: string; role: string; hours: string; source: 'timesheet' | 'manual' }
export interface DelayEntry { cause: DelayCause; minutes: string; description: string }
export interface VisitorEntry { name: string; company: string; purpose: string }

export interface LogForm {
  weather_code: WeatherCode | '';
  temp_high_f: string;
  temp_low_f: string;
  wind_mph: string;
  weather_notes: string;
  work_performed: string;
  ai_summary: string;
  ai_generated_at: string | null;
  ai_edited: boolean;
  crew: CrewEntry[];
  delays: DelayEntry[];
  visitors: VisitorEntry[];
}

export function emptyForm(): LogForm {
  return {
    weather_code: '', temp_high_f: '', temp_low_f: '', wind_mph: '', weather_notes: '', work_performed: '',
    ai_summary: '', ai_generated_at: null, ai_edited: false, crew: [], delays: [], visitors: [],
  };
}

export const blankCrew = (): CrewEntry => ({ employee_id: null, name: '', role: '', hours: '', source: 'manual' });
export const blankDelay = (): DelayEntry => ({ cause: 'weather', minutes: '', description: '' });
export const blankVisitor = (): VisitorEntry => ({ name: '', company: '', purpose: '' });

const numStr = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));

export function formFromDetail(d: { log: DailyLog | null; crew: CrewRecord[]; delays: DelayRecord[]; visitors: VisitorRecord[] }): LogForm {
  const l = d.log;
  if (!l) return emptyForm();
  return {
    weather_code: l.weather_code ?? '',
    temp_high_f: numStr(l.temp_high_f),
    temp_low_f: numStr(l.temp_low_f),
    wind_mph: numStr(l.wind_mph),
    weather_notes: l.weather_notes ?? '',
    work_performed: l.work_performed ?? '',
    ai_summary: l.ai_summary ?? '',
    ai_generated_at: l.ai_generated_at,
    ai_edited: l.ai_edited,
    crew: d.crew.map((c) => ({ employee_id: c.employee_id, name: c.name, role: c.role ?? '', hours: String(c.hours), source: c.source })),
    delays: d.delays.map((x) => ({ cause: x.cause, minutes: String(x.minutes), description: x.description ?? '' })),
    visitors: d.visitors.map((v) => ({ name: v.name, company: v.company ?? '', purpose: v.purpose ?? '' })),
  };
}

// ---------------- Validation ----------------

/** '' -> null (empty is allowed). Not a whole number in range -> 'invalid'. */
export function parseWhole(raw: string, min: number, max: number): number | null | 'invalid' {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  return n >= min && n <= max ? n : 'invalid';
}

/** Decimal hours with at most 2 decimals, 0..24. */
export function parseHours(raw: string): number | 'invalid' {
  const s = raw.trim();
  if (s === '') return 0;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return 'invalid';
  const n = Number(s);
  return n >= 0 && n <= 24 ? n : 'invalid';
}

export interface FormCheck {
  /** Field-level problems; any entry blocks saving. Keys: temp_high_f, crew-0-name, delay-1-minutes ... */
  errors: Record<string, string>;
  /** Extra things a log needs before it can be submitted and locked. */
  submitBlockers: string[];
}

export function validateForm(f: LogForm): FormCheck {
  const errors: Record<string, string> = {};
  const hi = parseWhole(f.temp_high_f, -60, 150);
  const lo = parseWhole(f.temp_low_f, -60, 150);
  if (hi === 'invalid') errors.temp_high_f = 'Use a whole number from -60 to 150.';
  if (lo === 'invalid') errors.temp_low_f = 'Use a whole number from -60 to 150.';
  if (typeof hi === 'number' && typeof lo === 'number' && hi < lo) errors.temp_high_f = 'High cannot be below the low.';
  if (parseWhole(f.wind_mph, 0, 250) === 'invalid') errors.wind_mph = 'Use a whole number from 0 to 250.';
  if (f.weather_notes.length > LIMITS.weatherNotes) errors.weather_notes = `Keep it under ${LIMITS.weatherNotes} characters.`;
  if (f.work_performed.length > LIMITS.work) errors.work_performed = `Keep it under ${LIMITS.work} characters.`;
  if (f.ai_summary.length > LIMITS.summary) errors.ai_summary = `Keep it under ${LIMITS.summary} characters.`;

  if (f.crew.length > LIMITS.crew) errors.crew = `At most ${LIMITS.crew} crew rows.`;
  f.crew.forEach((c, i) => {
    if (!c.name.trim()) errors[`crew-${i}-name`] = 'Name is required.';
    else if (c.name.trim().length > 120) errors[`crew-${i}-name`] = 'Name is too long.';
    if (c.role.length > 80) errors[`crew-${i}-role`] = 'Role is too long.';
    if (parseHours(c.hours) === 'invalid') errors[`crew-${i}-hours`] = 'Hours: 0 to 24, up to 2 decimals.';
  });

  if (f.delays.length > LIMITS.delays) errors.delays = `At most ${LIMITS.delays} delays.`;
  f.delays.forEach((d, i) => {
    const m = parseWhole(d.minutes, 1, 1440);
    if (m === null || m === 'invalid') errors[`delay-${i}-minutes`] = 'Minutes: 1 to 1440.';
    if (d.description.length > 500) errors[`delay-${i}-description`] = 'Keep it under 500 characters.';
  });

  if (f.visitors.length > LIMITS.visitors) errors.visitors = `At most ${LIMITS.visitors} visitors.`;
  f.visitors.forEach((v, i) => {
    if (!v.name.trim()) errors[`visitor-${i}-name`] = 'Name is required.';
    else if (v.name.trim().length > 120) errors[`visitor-${i}-name`] = 'Name is too long.';
    if (v.company.length > 120) errors[`visitor-${i}-company`] = 'Company is too long.';
    if (v.purpose.length > 300) errors[`visitor-${i}-purpose`] = 'Keep it under 300 characters.';
  });

  const submitBlockers: string[] = [];
  if (!f.weather_code) submitBlockers.push('Choose the weather.');
  if (!f.work_performed.trim()) submitBlockers.push('Describe the work performed.');
  return { errors, submitBlockers };
}

/** Payload for save_project_daily_log(). Call only after validateForm() reports no errors. */
export function buildPayload(f: LogForm) {
  const summary = f.ai_summary.trim();
  const toInt = (s: string) => {
    const n = parseWhole(s, -1000, 100000);
    return typeof n === 'number' ? n : null;
  };
  return {
    weather_code: f.weather_code || null,
    temp_high_f: toInt(f.temp_high_f),
    temp_low_f: toInt(f.temp_low_f),
    wind_mph: toInt(f.wind_mph),
    weather_notes: f.weather_notes.trim() || null,
    work_performed: f.work_performed.trim() || null,
    ai_summary: summary || null,
    ai_generated_at: summary ? f.ai_generated_at : null,
    ai_edited: summary ? f.ai_edited : false,
    crew: f.crew.map((c, i) => ({
      employee_id: c.employee_id,
      name: c.name.trim(),
      role: c.role.trim() || null,
      hours: parseHours(c.hours) === 'invalid' ? 0 : parseHours(c.hours),
      source: c.source,
      sort_order: i,
    })),
    delays: f.delays.map((d, i) => ({ cause: d.cause, minutes: toInt(d.minutes), description: d.description.trim() || null, sort_order: i })),
    visitors: f.visitors.map((v, i) => ({ name: v.name.trim(), company: v.company.trim() || null, purpose: v.purpose.trim() || null, sort_order: i })),
  };
}

// ---------------- Totals & formatting ----------------

const round2 = (n: number) => Math.round(n * 100) / 100;

export function totalCrewHours(crew: { hours: string | number }[]): number {
  let sum = 0;
  for (const c of crew) {
    const h = typeof c.hours === 'number' ? c.hours : parseHours(c.hours);
    if (typeof h === 'number') sum += h;
  }
  return round2(sum);
}

export function totalDelayMinutes(delays: { minutes: string | number }[]): number {
  let sum = 0;
  for (const d of delays) {
    const m = typeof d.minutes === 'number' ? d.minutes : parseWhole(d.minutes, 1, 1440);
    if (typeof m === 'number') sum += m;
  }
  return sum;
}

export function formatHours(h: number): string {
  return `${round2(h)} h`;
}

export function formatMinutes(total: number): string {
  if (total <= 0) return '0 min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** YYYY-MM-DD -> "Mon, Oct 26, 2026", with no timezone drift (parsed at local noon). */
export function formatLogDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function addDays(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n, 12);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

/** The server rejects dates more than one day ahead (timezone slack). */
export const isTooFarAhead = (date: string, today: string) => date > addDays(today, 1);

/**
 * Weekdays (Mon-Fri) from the project start up to yesterday-or-today that have no log yet.
 * Looks back at most `lookback` days; newest first; capped at `limit`.
 */
export function missingLogDates(start: string | null, today: string, existing: ReadonlySet<string>, lookback = 21, limit = 10): string[] {
  if (!start || !isIsoDate(start)) return [];
  const out: string[] = [];
  for (let i = 0; i <= lookback && out.length < limit; i++) {
    const day = addDays(today, -i);
    if (day < start) break;
    const dow = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12).getDay();
    if (dow === 0 || dow === 6) continue;
    if (!existing.has(day)) out.push(day);
  }
  return out;
}

// ---------------- Errors ----------------

const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You do not have permission to edit daily logs for projects.',
  not_authenticated: 'Your session expired. Sign in again.',
  log_locked: 'This log is submitted and locked. Add an amendment instead.',
  already_submitted: 'This log was already submitted.',
  log_not_submitted: 'Amendments can only be added to a submitted log.',
  log_not_found: 'That log no longer exists. Reload and try again.',
  work_required: 'Describe the work performed before submitting.',
  weather_required: 'Choose the weather before submitting.',
  invalid_project: 'That project is not in your account.',
  invalid_employee: 'One of the crew members is not in your account.',
  invalid_photo: 'That photo is not in your account.',
  invalid_log: 'That log is not in your account.',
  future_date: 'Logs cannot be created for dates more than one day ahead.',
  too_many_photos: `A log can have at most ${LIMITS.photos} photos.`,
  too_many_rows: 'Too many rows in this log.',
  amendments_immutable: 'Amendments cannot be changed or deleted.',
  use_submit: 'Use Submit to lock a log.',
  no_zip: 'Add your business ZIP code in Weather settings to auto-fill weather.',
  weather_unavailable: 'Weather is unavailable for that date. Enter it manually.',
  not_enough_data: 'Add crew hours, work performed or photos first so there is something to summarize.',
  ai_unavailable: 'The AI draft is unavailable right now. Write the summary yourself or try again.',
  ai_cooldown: 'A draft was just generated. Wait a few seconds and try again.',
};

export function dailyLogError(error: unknown, fallback: string): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const key of Object.keys(ERROR_COPY)) if (message.includes(key)) return ERROR_COPY[key];
  if (/duplicate key value/i.test(message)) return 'A log already exists for that date. Open it instead.';
  return fallback;
}
