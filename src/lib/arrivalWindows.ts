// Pure arrival-window logic (no I/O): offering windows at booking, narrowing on dispatch,
// formatting, and on-time statistics. Network calls live in arrivalWindowsApi.ts.
//
// KEEP IN SYNC: narrowArrivalWindow() mirrors the SQL function arrival_window_narrow()
// (supabase/migrations/20271011000000_arrival_windows.sql).

import type { HoursMap } from '@/lib/bookingPolicy';

const MIN = 60_000;
const QUARTER = 15 * MIN;

export const ARRIVAL_WINDOW_LENGTHS = [60, 120, 180, 240] as const;
export const MIN_WINDOW_MINUTES = 60;
export const MAX_WINDOW_MINUTES = 240;
/** Below this many measured jobs a rate is shown with a "low sample" note. */
export const MIN_RELIABLE_SAMPLE = 5;

export interface ArrivalWindowConfig {
  enabled: boolean;
  optionsMinutes: number[];
  narrowMinutes: number;
  graceMinutes: number;
  notifyCustomer: boolean;
}

export const DEFAULT_ARRIVAL_WINDOW_CONFIG: ArrivalWindowConfig = {
  enabled: false,
  optionsMinutes: [...ARRIVAL_WINDOW_LENGTHS],
  narrowMinutes: 120,
  graceMinutes: 0,
  notifyCustomer: true,
};

export interface ArrivalWindow { start: Date; end: Date }
/** A window the customer can pick. `anchor` = earliest free slot inside it (becomes jobs.scheduled_datetime). */
export interface OfferedWindow extends ArrivalWindow { anchor: Date; lengthMinutes: number }

// ---------------------------------------------------------------- sanitizing

export function sanitizeWindowOptions(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ARRIVAL_WINDOW_CONFIG.optionsMinutes];
  const allowed = new Set<number>(ARRIVAL_WINDOW_LENGTHS);
  const out = [...new Set(raw.map(Number).filter((n) => allowed.has(n)))].sort((a, b) => a - b);
  return out.length > 0 ? out : [...DEFAULT_ARRIVAL_WINDOW_CONFIG.optionsMinutes];
}

export function sanitizeNarrowMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ARRIVAL_WINDOW_CONFIG.narrowMinutes;
  const snapped = Math.round(n / 15) * 15;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, snapped));
}

export function sanitizeGraceMinutes(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : 0;
}

// ------------------------------------------------------------------ windows

export function windowLengthMinutes(w: ArrivalWindow): number {
  return Math.round((w.end.getTime() - w.start.getTime()) / MIN);
}

export function isValidWindow(w: ArrivalWindow): boolean {
  const len = windowLengthMinutes(w);
  return Number.isFinite(len) && len >= MIN_WINDOW_MINUTES && len <= MAX_WINDOW_MINUTES;
}

/**
 * Narrow `window` to `targetMinutes`, centred on the planned arrival (`anchor`), snapped to 15 minutes and
 * clamped inside the current window. Never widens, never goes below 60 minutes.
 */
export function narrowArrivalWindow(window: ArrivalWindow, anchor: Date, targetMinutes: number): ArrivalWindow {
  const len = windowLengthMinutes(window);
  const target = Math.min(len, Math.max(MIN_WINDOW_MINUTES, Number.isFinite(targetMinutes) ? targetMinutes : len));
  if (target >= len) return { start: new Date(window.start), end: new Date(window.end) };

  const desired = Math.floor((anchor.getTime() - target * 30_000) / QUARTER) * QUARTER;
  const start = Math.min(Math.max(desired, window.start.getTime()), window.end.getTime() - target * MIN);
  return { start: new Date(start), end: new Date(start + target * MIN) };
}

/** Narrower options the dispatcher can pick for an existing window (always shorter than the current one). */
export function narrowingChoices(window: ArrivalWindow): number[] {
  const len = windowLengthMinutes(window);
  return ARRIVAL_WINDOW_LENGTHS.filter((l) => l < len);
}

// ----------------------------------------------------------- offering windows

const JS_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseTime(value: string | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
}

export interface OfferWindowsInput {
  /** Free bookable slots (output of generateSlots in bookingPolicy.ts — pass a high maxSlots, it defaults to 40). */
  slots: Date[];
  hours: HoursMap | null;
  holidays: string[]; // 'YYYY-MM-DD' local
  lengthMinutes: number;
  leadTimeHours: number;
  windowDays: number;
  now?: Date;
}

/**
 * Tiles each open day into back-to-back windows of `lengthMinutes` starting at opening time
 * (e.g. 8:00-17:00 with 4h -> 8-12, 12-16) and keeps the ones that still contain a free slot and start
 * after the lead time. Windows never extend past closing time.
 */
export function buildOfferedWindows(input: OfferWindowsInput): OfferedWindow[] {
  const { slots, hours, holidays, lengthMinutes, leadTimeHours, windowDays } = input;
  const now = input.now ?? new Date();
  if (!hours || slots.length === 0 || lengthMinutes < MIN_WINDOW_MINUTES || lengthMinutes > MAX_WINDOW_MINUTES) return [];

  const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
  const earliest = now.getTime() + leadTimeHours * 60 * MIN;
  const holidaySet = new Set(holidays);
  const out: OfferedWindow[] = [];

  for (let d = 0; d <= windowDays; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const spec = hours[JS_DAY_KEYS[day.getDay()]];
    if (!spec || holidaySet.has(localDateKey(day))) continue;
    const open = parseTime(spec.open);
    const close = parseTime(spec.close);
    if (!open || !close) continue;

    const cursor = new Date(day);
    cursor.setHours(open[0], open[1], 0, 0);
    const closeAt = new Date(day);
    closeAt.setHours(close[0], close[1], 0, 0);

    while (cursor.getTime() + lengthMinutes * MIN <= closeAt.getTime()) {
      const start = new Date(cursor);
      const end = new Date(cursor.getTime() + lengthMinutes * MIN);
      if (start.getTime() >= earliest) {
        const anchor = sorted.find((s) => s.getTime() >= start.getTime() && s.getTime() < end.getTime());
        if (anchor) out.push({ start, end, anchor, lengthMinutes });
      }
      cursor.setTime(end.getTime());
    }
  }
  return out;
}

// ----------------------------------------------------------------- formatting

export interface FormatOptions { timeZone?: string; locale?: string }

function fmt(date: Date, options: Intl.DateTimeFormatOptions, o: FormatOptions): string {
  return new Intl.DateTimeFormat(o.locale, { ...options, timeZone: o.timeZone }).format(date);
}

/** "9:00 AM – 11:00 AM" */
export function formatWindowRange(w: ArrivalWindow, o: FormatOptions = {}): string {
  const t: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${fmt(w.start, t, o)} – ${fmt(w.end, t, o)}`;
}

/** "Tue, Oct 20" */
export function formatWindowDay(date: Date, o: FormatOptions = {}): string {
  return fmt(date, { weekday: 'short', month: 'short', day: 'numeric' }, o);
}

export function formatLength(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} min`;
}

// ------------------------------------------------------------------ on-time stats

export interface OnTimeRow {
  technician_id: string;
  technician_name: string | null;
  windowed_jobs: number;
  measured_jobs: number;
  on_time_jobs: number;
  late_jobs: number;
  early_jobs: number;
  missed_jobs: number;
  kept_original_jobs: number;
  total_minutes_late: number;
  max_minutes_late: number;
}

export interface OnTimeSummary {
  windowed: number;
  measured: number;
  onTime: number;
  late: number;
  early: number;
  missed: number;
  /** 0-100, one decimal; null when nothing has been measured yet. */
  onTimeRate: number | null;
  keptOriginalRate: number | null;
  avgMinutesLate: number | null;
  maxMinutesLate: number;
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function normalizeOnTimeRow(raw: Record<string, unknown>): OnTimeRow {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    technician_id: String(raw.technician_id ?? ''),
    technician_name: (raw.technician_name as string | null) ?? null,
    windowed_jobs: n(raw.windowed_jobs),
    measured_jobs: n(raw.measured_jobs),
    on_time_jobs: n(raw.on_time_jobs),
    late_jobs: n(raw.late_jobs),
    early_jobs: n(raw.early_jobs),
    missed_jobs: n(raw.missed_jobs),
    kept_original_jobs: n(raw.kept_original_jobs),
    total_minutes_late: n(raw.total_minutes_late),
    max_minutes_late: n(raw.max_minutes_late),
  };
}

export function summarizeOnTime(rows: OnTimeRow[]): OnTimeSummary {
  const sum = (pick: (r: OnTimeRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  const measured = sum((r) => r.measured_jobs);
  const onTime = sum((r) => r.on_time_jobs);
  const late = sum((r) => r.late_jobs);
  const lateWithArrival = late - sum((r) => r.missed_jobs);
  return {
    windowed: sum((r) => r.windowed_jobs),
    measured,
    onTime,
    late,
    early: sum((r) => r.early_jobs),
    missed: sum((r) => r.missed_jobs),
    onTimeRate: percent(onTime, measured),
    keptOriginalRate: percent(sum((r) => r.kept_original_jobs), measured),
    avgMinutesLate: lateWithArrival > 0 ? Math.round(sum((r) => r.total_minutes_late) / lateWithArrival) : null,
    maxMinutesLate: Math.round(Math.max(0, ...rows.map((r) => r.max_minutes_late))),
  };
}

export type RateTone = 'good' | 'warn' | 'bad' | 'none';

export function rateTone(rate: number | null): RateTone {
  if (rate === null) return 'none';
  if (rate >= 95) return 'good';
  if (rate >= 85) return 'warn';
  return 'bad';
}
