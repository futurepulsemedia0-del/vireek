import type { Job, TeamMember } from '@/lib/supabase';
import { WORKFLOW_STATUS_META, isWorkflowStatus } from '@/lib/jobWorkflow';
import { toDateKey } from '@/lib/scheduleDnd';

// ============================================================
// Dispatch Calendar — view model (PURE: no React, no network).
//
// Everything the Month / Agenda / Resources views need — date math, grid
// building, grouping, filtering, colour coding, keyboard navigation — lives
// here so it is unit-tested once (calendarViews.test.ts) and the components
// stay thin. Week & Day keep their existing implementation; this file only
// supplies their navigation/label helpers so all five views behave alike.
// ============================================================

export type CalendarView = 'month' | 'week' | 'day' | 'agenda' | 'resources';
export type ExtendedView = 'month' | 'agenda' | 'resources';
export type ColorMode = 'status' | 'trade' | 'technician';
export type AgendaGroupBy = 'date' | 'technician';
type JobStatus = Job['job_status'];

export const VIEW_OPTIONS: readonly { key: CalendarView; label: string; shortcut: string }[] = [
  { key: 'month', label: 'Month', shortcut: 'M' },
  { key: 'week', label: 'Week', shortcut: 'W' },
  { key: 'day', label: 'Day', shortcut: 'D' },
  { key: 'resources', label: 'Resources', shortcut: 'R' },
  { key: 'agenda', label: 'Agenda', shortcut: 'A' },
];

export const COLOR_MODE_OPTIONS: readonly { key: ColorMode; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'trade', label: 'Trade' },
  { key: 'technician', label: 'Technician' },
];

export function isExtendedView(view: string): view is ExtendedView {
  return view === 'month' || view === 'agenda' || view === 'resources';
}

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === 'string' && VIEW_OPTIONS.some((v) => v.key === value);
}

export function isColorMode(value: unknown): value is ColorMode {
  return value === 'status' || value === 'trade' || value === 'technician';
}

/** Maps a pressed key to a view (M/W/D/R/A) — null for anything else. */
export function viewForShortcut(key: string): CalendarView | null {
  const hit = VIEW_OPTIONS.find((v) => v.shortcut.toLowerCase() === key.toLowerCase());
  return hit ? hit.key : null;
}

// ------------------------------------------------------------
// Dates (local time, DST-safe: always via setDate/setMonth, never +24h)
// ------------------------------------------------------------

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Adds months and clamps the day (Jan 31 + 1 month = Feb 28/29, not Mar 3). */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export function startOfWeekMonday(date: Date): Date {
  const d = startOfDay(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Parsed `scheduled_datetime`, or null when missing/invalid. */
export function jobDate(job: Pick<Job, 'scheduled_datetime'>): Date | null {
  if (!job.scheduled_datetime) return null;
  const d = new Date(job.scheduled_datetime);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function jobDayKey(job: Pick<Job, 'scheduled_datetime'>): string | null {
  const d = jobDate(job);
  return d ? toDateKey(d) : null;
}

export const DEFAULT_JOB_MINUTES = 60;

export function jobMinutes(job: Pick<Job, 'duration_minutes'>): number {
  const m = job.duration_minutes;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : DEFAULT_JOB_MINUTES;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function formatClock(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unscheduled' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "9:00 AM" → "9:00a" — for chips too narrow for the full form. */
export function formatClockCompact(iso: string | null): string {
  return formatClock(iso).replace(/\s?(AM|PM)$/i, (_, m: string) => (m.toUpperCase() === 'AM' ? 'a' : 'p'));
}

// ------------------------------------------------------------
// Persisted view preferences (localStorage; the hook wraps every access in try/catch)
// ------------------------------------------------------------

export const CALENDAR_PREFS_KEY = 'vireek.calendar.prefs.v1';

export interface CalendarPrefs {
  view: CalendarView;
  colorMode: ColorMode;
  agendaGroupBy: AgendaGroupBy;
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = { view: 'week', colorMode: 'status', agendaGroupBy: 'date' };

/** Tolerant parser: anything missing, malformed or from an older version falls back per-field. */
export function parseCalendarPrefs(raw: string | null | undefined): CalendarPrefs {
  if (!raw) return { ...DEFAULT_CALENDAR_PREFS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof CalendarPrefs, unknown>> | null;
    return {
      view: isCalendarView(data?.view) ? data.view : DEFAULT_CALENDAR_PREFS.view,
      colorMode: isColorMode(data?.colorMode) ? data.colorMode : DEFAULT_CALENDAR_PREFS.colorMode,
      agendaGroupBy: data?.agendaGroupBy === 'technician' ? 'technician' : 'date',
    };
  } catch {
    return { ...DEFAULT_CALENDAR_PREFS };
  }
}

// ------------------------------------------------------------
// Navigation & labels
// ------------------------------------------------------------

/** Prev/next step for each view (month & agenda = a month, week & resources = 7 days, day = 1). */
export function shiftAnchor(view: CalendarView, anchor: Date, direction: -1 | 1): Date {
  switch (view) {
    case 'month':
    case 'agenda':
      return addMonths(anchor, direction);
    case 'week':
    case 'resources':
      return addDays(anchor, 7 * direction);
    case 'day':
      return addDays(anchor, direction);
  }
}

export function periodLabel(view: CalendarView, anchor: Date): string {
  switch (view) {
    case 'month':
    case 'agenda':
      return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    case 'week':
    case 'resources': {
      const start = startOfWeekMonday(anchor);
      const end = addDays(start, 6);
      // Built by hand: toLocaleDateString({ day, year }) without a month is mangled by some ICU builds.
      const monthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const b = isSameMonth(start, end) ? String(end.getDate()) : monthDay(end);
      return `${monthDay(start)} – ${b}, ${end.getFullYear()}`;
    }
    case 'day':
      return anchor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
}

/** Keys that move the focused day inside the month grid (WAI-ARIA grid pattern). */
export function moveGridFocus(current: Date, key: string): Date | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(current, -1);
    case 'ArrowRight':
      return addDays(current, 1);
    case 'ArrowUp':
      return addDays(current, -7);
    case 'ArrowDown':
      return addDays(current, 7);
    case 'Home':
      return startOfWeekMonday(current);
    case 'End':
      return addDays(startOfWeekMonday(current), 6);
    case 'PageUp':
      return addMonths(current, -1);
    case 'PageDown':
      return addMonths(current, 1);
    default:
      return null;
  }
}

// ------------------------------------------------------------
// Filtering & grouping
// ------------------------------------------------------------

export interface JobFilter {
  /** 'all' | 'unassigned' | technician id */
  technician: string;
  /** Empty / null = every status. */
  statuses?: ReadonlySet<string> | null;
}

export function filterJobs(jobs: readonly Job[], filter: JobFilter): Job[] {
  const { technician, statuses } = filter;
  const hasStatus = !!statuses && statuses.size > 0;
  return jobs.filter((j) => {
    if (technician === 'unassigned' && j.assigned_technician_id) return false;
    if (technician !== 'all' && technician !== 'unassigned' && j.assigned_technician_id !== technician) return false;
    if (hasStatus && !statuses!.has(j.job_status)) return false;
    return true;
  });
}

/** "Maria Lopez · Scheduled, In progress" — the filters line printed under the calendar title. */
export function describeFilters(technicianLabel: string | null, statusLabels: readonly string[]): string {
  return [technicianLabel, statusLabels.length ? statusLabels.join(', ') : null].filter(Boolean).join(' \u00b7 ');
}

/** Stable chronological order: time, then customer, then id. */
export function compareJobs(a: Job, b: Job): number {
  const ta = jobDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = jobDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  const byName = (a.customer_name ?? '').localeCompare(b.customer_name ?? '');
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** Local-day buckets (key = YYYY-MM-DD), each sorted. Unscheduled jobs are skipped. */
export function groupJobsByDay(jobs: readonly Job[]): Map<string, Job[]> {
  const map = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = jobDayKey(job);
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(job);
    else map.set(key, [job]);
  }
  map.forEach((bucket) => bucket.sort(compareJobs));
  return map;
}

export function splitOverflow<T>(items: readonly T[], max: number): { visible: T[]; hidden: number } {
  const cap = Math.max(0, max);
  return { visible: items.slice(0, cap), hidden: Math.max(0, items.length - cap) };
}

// ------------------------------------------------------------
// Month grid
// ------------------------------------------------------------

export interface MonthCell {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

/** Monday-first weeks covering the anchor's month — 4 to 6 rows, never padded with empty weeks. */
export function buildMonthGrid(anchor: Date, today: Date = new Date()): MonthCell[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const gridStart = startOfWeekMonday(first);
  const gridEnd = addDays(startOfWeekMonday(last), 6);
  const weeks: MonthCell[][] = [];
  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(cursor, i);
        const dow = date.getDay();
        return {
          date,
          key: toDateKey(date),
          inMonth: isSameMonth(date, anchor),
          isToday: isSameDay(date, today),
          isWeekend: dow === 0 || dow === 6,
        };
      }),
    );
  }
  return weeks;
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ------------------------------------------------------------
// Agenda
// ------------------------------------------------------------

export interface AgendaSection {
  /** Day key (YYYY-MM-DD) for date sections; technician id / 'unassigned' / 'other' for resource sections. */
  key: string;
  title: string;
  subtitle: string;
  jobs: Job[];
  date?: Date;
  technician?: TeamMember | null;
}

const techLabel = (t: TeamMember) => t.member_name ?? t.member_email;

/**
 * Agenda sections for the anchor's month. `date` = one section per day that has jobs
 * (empty days are omitted — an agenda is a list, not a grid); `technician` = one section per
 * resource lane, Unassigned first, jobs in time order.
 */
export function buildAgenda(
  jobs: readonly Job[],
  anchor: Date,
  groupBy: AgendaGroupBy,
  lanes: readonly { key: string; technician: TeamMember | null }[],
): AgendaSection[] {
  const inMonth = jobs.filter((j) => {
    const d = jobDate(j);
    return d !== null && isSameMonth(d, anchor);
  });

  if (groupBy === 'date') {
    const byDay = groupJobsByDay(inMonth);
    return [...byDay.keys()].sort().map((key) => {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const list = byDay.get(key)!;
      return {
        key,
        date,
        title: date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        subtitle: `${list.length} ${list.length === 1 ? 'job' : 'jobs'}`,
        jobs: list,
      };
    });
  }

  const sections: AgendaSection[] = [];
  const claimed = new Set<string>();
  for (const lane of lanes) {
    const list = inMonth
      .filter((j) => (lane.technician ? j.assigned_technician_id === lane.technician.id : !j.assigned_technician_id))
      .sort(compareJobs);
    list.forEach((j) => claimed.add(j.id));
    if (list.length === 0) continue;
    sections.push({
      key: lane.key,
      technician: lane.technician,
      title: lane.technician ? techLabel(lane.technician) : 'Unassigned',
      subtitle: `${list.length} ${list.length === 1 ? 'job' : 'jobs'}`,
      jobs: list,
    });
  }
  // Jobs of a technician that is not in `lanes` (inactive / filtered out) must never vanish.
  const orphans = inMonth.filter((j) => !claimed.has(j.id)).sort(compareJobs);
  if (orphans.length) {
    sections.push({
      key: 'other',
      technician: null,
      title: 'Other technicians',
      subtitle: `${orphans.length} ${orphans.length === 1 ? 'job' : 'jobs'}`,
      jobs: orphans,
    });
  }
  return sections;
}

// ------------------------------------------------------------
// Resource lanes (technicians × days)
// ------------------------------------------------------------

export interface ResourceCell {
  date: Date;
  key: string;
  jobs: Job[];
  minutes: number;
  /** More jobs than the technician's `max_jobs_per_day`. */
  overbooked: boolean;
}

export interface ResourceRow {
  key: string;
  technician: TeamMember | null;
  cells: ResourceCell[];
  totalJobs: number;
  totalMinutes: number;
}

export function buildResourceWeek(
  jobs: readonly Job[],
  weekDays: readonly Date[],
  lanes: readonly { key: string; technician: TeamMember | null }[],
): ResourceRow[] {
  const byDay = groupJobsByDay(jobs);
  const laneKeys = new Set(lanes.map((l) => l.key));
  const laneOf = (j: Job) => (j.assigned_technician_id && laneKeys.has(j.assigned_technician_id) ? j.assigned_technician_id : 'unassigned');

  return lanes.map((lane) => {
    const cells = weekDays.map((date): ResourceCell => {
      const key = toDateKey(date);
      const list = (byDay.get(key) ?? []).filter((j) => laneOf(j) === lane.key);
      const cap = lane.technician?.max_jobs_per_day;
      return {
        date,
        key,
        jobs: list,
        minutes: list.reduce((sum, j) => sum + jobMinutes(j), 0),
        overbooked: !!lane.technician && typeof cap === 'number' && cap > 0 && list.length > cap,
      };
    });
    return {
      key: lane.key,
      technician: lane.technician,
      cells,
      totalJobs: cells.reduce((s, c) => s + c.jobs.length, 0),
      totalMinutes: cells.reduce((s, c) => s + c.minutes, 0),
    };
  });
}

// ------------------------------------------------------------
// Colour coding (status | trade | technician)
// ------------------------------------------------------------
// Class names are written out in full so Tailwind's JIT can see them.

export interface ColorMeta {
  key: string;
  label: string;
  /** Solid `bg-*` class used for dots, legend swatches and the chip's accent bar. */
  dot: string;
}

const LEGACY_STATUS: Record<string, ColorMeta> = {
  scheduled: { key: 'scheduled', label: 'Scheduled', dot: 'bg-accent' },
  en_route: { key: 'en_route', label: 'En route', dot: 'bg-blue-500' },
  in_progress: { key: 'in_progress', label: 'In progress', dot: 'bg-warning-500' },
  completed: { key: 'completed', label: 'Completed', dot: 'bg-success-500' },
  cancelled: { key: 'cancelled', label: 'Cancelled', dot: 'bg-danger' },
  no_show: { key: 'no_show', label: 'No-show', dot: 'bg-warning-500' },
};

const humanize = (s: string) => {
  const t = s.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Unknown';
};

export function statusColor(status: JobStatus | string): ColorMeta {
  if (LEGACY_STATUS[status]) return LEGACY_STATUS[status];
  if (isWorkflowStatus(status)) {
    const meta = WORKFLOW_STATUS_META[status];
    return { key: status, label: meta.label, dot: meta.dot };
  }
  return { key: String(status), label: humanize(String(status)), dot: 'bg-text-secondary' };
}

/** Every status a calendar filter can offer: the legacy six + the five workflow statuses. */
export function allStatusOptions(): ColorMeta[] {
  return [
    ...Object.values(LEGACY_STATUS),
    ...(Object.keys(WORKFLOW_STATUS_META) as (keyof typeof WORKFLOW_STATUS_META)[]).map((k) => statusColor(k)),
  ];
}

export type TradeKey = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'restoration' | 'locksmith' | 'general';

const TRADE_META: Record<TradeKey, ColorMeta> = {
  hvac: { key: 'hvac', label: 'HVAC', dot: 'bg-blue-500' },
  plumbing: { key: 'plumbing', label: 'Plumbing', dot: 'bg-cyan-500' },
  electrical: { key: 'electrical', label: 'Electrical', dot: 'bg-warning-500' },
  roofing: { key: 'roofing', label: 'Roofing', dot: 'bg-orange-500' },
  restoration: { key: 'restoration', label: 'Restoration', dot: 'bg-success-500' },
  locksmith: { key: 'locksmith', label: 'Locksmith', dot: 'bg-purple-500' },
  general: { key: 'general', label: 'General', dot: 'bg-text-secondary' },
};

// First match wins; keep the more specific trades first.
const TRADE_PATTERNS: readonly [TradeKey, RegExp][] = [
  ['hvac', /\b(hvac|heating|cooling|furnace|boiler|a\/?c|air[\s-]?con\w*|heat\s?pump|thermostat|ductwork|refrigerat\w*|compressor)\b/i],
  ['electrical', /\b(electric\w*|wiring|outlet|breaker|panel|circuit|lighting|generator|ev\s?charger)\b/i],
  ['roofing', /\b(roof\w*|shingle\w*|gutter\w*|flashing|skylight)\b/i],
  ['restoration', /\b(restor\w*|water\s?damage|mold|mould|fire\s?damage|flood\w*|remediation)\b/i],
  ['plumbing', /\b(plumb\w*|pipe\w*|drain\w*|leak\w*|toilet|faucet|water\s?heater|sewer|sump|clog\w*)\b/i],
  ['locksmith', /\b(lock\w*|key\w*|deadbolt|rekey\w*|lockout)\b/i],
];

/** Best-effort trade from the free-text service type + tags (jobs carry no trade column). */
export function classifyTrade(job: Pick<Job, 'service_type' | 'tags'>): TradeKey {
  const text = `${job.service_type ?? ''} ${(Array.isArray(job.tags) ? job.tags : []).join(' ')}`;
  for (const [trade, re] of TRADE_PATTERNS) if (re.test(text)) return trade;
  return 'general';
}

export function tradeColor(trade: TradeKey): ColorMeta {
  return TRADE_META[trade];
}

export const ALL_TRADES: readonly ColorMeta[] = Object.values(TRADE_META);

/** Same order & length as the page's TECH_PALETTE so a technician keeps one identity everywhere. */
const TECH_DOTS = ['bg-accent', 'bg-cta', 'bg-success-500', 'bg-warning-500', 'bg-blue-500', 'bg-danger'] as const;
const UNASSIGNED_DOT = 'bg-text-secondary';

export function technicianColor(technicians: readonly TeamMember[], technicianId: string | null): ColorMeta {
  if (!technicianId) return { key: 'unassigned', label: 'Unassigned', dot: UNASSIGNED_DOT };
  const index = technicians.findIndex((t) => t.id === technicianId);
  if (index === -1) return { key: technicianId, label: 'Other technician', dot: UNASSIGNED_DOT };
  return { key: technicianId, label: techLabel(technicians[index]), dot: TECH_DOTS[index % TECH_DOTS.length] };
}

export function resolveJobColor(job: Job, mode: ColorMode, technicians: readonly TeamMember[]): ColorMeta {
  switch (mode) {
    case 'trade':
      return tradeColor(classifyTrade(job));
    case 'technician':
      return technicianColor(technicians, job.assigned_technician_id);
    default:
      return statusColor(job.job_status);
  }
}

export interface LegendEntry extends ColorMeta {
  count: number;
}

/** Legend of only the colours actually present in `jobs`, most common first. */
export function buildLegend(jobs: readonly Job[], mode: ColorMode, technicians: readonly TeamMember[]): LegendEntry[] {
  const counts = new Map<string, LegendEntry>();
  for (const job of jobs) {
    const c = resolveJobColor(job, mode, technicians);
    const hit = counts.get(c.key);
    if (hit) hit.count += 1;
    else counts.set(c.key, { ...c, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
