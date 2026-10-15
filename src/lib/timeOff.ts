/**
 * Time Off, Availability & Blackouts — pure logic for /dashboard/time-off and the Dispatch hooks.
 *
 * Framework-free and timezone-safe: calendar days are plain "YYYY-MM-DD" strings and are only ever
 * manipulated through UTC arithmetic, so a day never shifts because of the viewer's timezone.
 *
 * Availability model (day granularity, same as the existing per-day capacity logic):
 *   1. Company blackout (active)           -> nobody can be dispatched that day
 *   2. Approved time off for the technician -> that technician is out
 *   3. Weekly working days (if a row exists) -> not scheduled on that weekday
 *   No rows at all means "available every day", so nothing changes until a manager configures it.
 *
 * The database is the authority: technician_unavailable_reason() in
 * supabase/migrations/20270502000000_time_off_availability.sql mirrors unavailability() and is enforced
 * inside assign_technician_to_job() plus a trigger on jobs.assigned_technician_id.
 */

// ---------------------------------------------------------------------------
// Types & labels
// ---------------------------------------------------------------------------

export type TimeOffKind = 'pto' | 'sick' | 'training' | 'personal' | 'other';
export type TimeOffStatus = 'approved' | 'cancelled';
export type BlackoutStatus = 'active' | 'cancelled';

export const TIME_OFF_KINDS: readonly TimeOffKind[] = ['pto', 'sick', 'training', 'personal', 'other'];

export const KIND_LABELS: Record<TimeOffKind, string> = {
  pto: 'PTO',
  sick: 'Sick leave',
  training: 'Training',
  personal: 'Personal day',
  other: 'Other',
};

const KIND_REASONS: Record<TimeOffKind, string> = {
  pto: 'On PTO',
  sick: 'Out sick',
  training: 'In training',
  personal: 'Personal day',
  other: 'Out of office',
};

export const KIND_LETTERS: Record<TimeOffKind, string> = { pto: 'P', sick: 'S', training: 'T', personal: 'D', other: 'O' };

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

export const MAX_SPAN_DAYS = 366;
export const NOTE_LIMIT = 500;
export const LABEL_LIMIT = 80;
export const ACTIVE_JOB_STATUSES: readonly string[] = ['scheduled', 'en_route', 'in_progress'];
export const DEFAULT_MAX_JOBS = 6;

export interface TimeOffEntry {
  id: string;
  user_id: string;
  technician_id: string;
  kind: TimeOffKind;
  start_date: string;
  end_date: string;
  note: string | null;
  status: TimeOffStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BlackoutEntry {
  id: string;
  user_id: string;
  label: string;
  start_date: string;
  end_date: string;
  status: BlackoutStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AvailabilityData {
  timeOff: TimeOffEntry[];
  blackouts: BlackoutEntry[];
  /** technician_id -> working weekdays (0 = Sunday). A technician with no entry works every day. */
  weekly: Record<string, number[]>;
}

export const EMPTY_AVAILABILITY: AvailabilityData = { timeOff: [], blackouts: [], weekly: {} };

export interface TimeOffDraft {
  technician_id: string;
  kind: TimeOffKind;
  start_date: string;
  end_date: string;
  note: string;
}

export interface BlackoutDraft {
  label: string;
  start_date: string;
  end_date: string;
}

export interface TechnicianLite {
  id: string;
  member_name: string | null;
  member_email?: string | null;
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
}

export interface ScheduledJob {
  id: string;
  customer_name: string | null;
  assigned_technician_id: string | null;
  scheduled_datetime: string | null;
  job_status: string;
  service_type?: string | null;
}

export function technicianLabel(t: { member_name: string | null; member_email?: string | null }): string {
  return t.member_name?.trim() || t.member_email?.trim() || 'Technician';
}

// ---------------------------------------------------------------------------
// Calendar-day helpers (UTC arithmetic on YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

export function isValidIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtcMs(iso: string): number {
  const m = ISO_RE.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}

function fromUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(iso: string, n: number): string {
  const dt = new Date(toUtcMs(iso));
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

export function dayOfWeek(iso: string): number {
  return new Date(toUtcMs(iso)).getUTCDay();
}

export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Calendar day of a job timestamp in the viewer's local timezone (same convention as the dispatch board). */
export function jobDay(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? null : localIsoDate(d);
}

export function monthDays(year: number, month0: number): string[] {
  const count = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const first = `${year}-${pad(month0 + 1)}-01`;
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

export function shiftMonth(year: number, month0: number, delta: number): { year: number; month0: number } {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

export function formatDay(iso: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const ms = toUtcMs(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

export function formatRange(start: string, end: string): string {
  if (start === end) return formatDay(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${formatDay(start)}–${Number(end.slice(8, 10))}` : `${formatDay(start)} – ${formatDay(end)}`;
}

export function monthTitle(year: number, month0: number): string {
  return formatDay(`${year}-${pad(month0 + 1)}-01`, { month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Availability resolution (mirrors technician_unavailable_reason() in the database)
// ---------------------------------------------------------------------------

export type UnavailableCause = 'blackout' | 'time_off' | 'not_scheduled';

export interface Unavailability {
  cause: UnavailableCause;
  reason: string;
  entryId?: string;
  kind?: TimeOffKind;
}

const covers = (e: { start_date: string; end_date: string }, day: string) => e.start_date <= day && day <= e.end_date;
const byStart = (a: { start_date: string }, b: { start_date: string }) => a.start_date.localeCompare(b.start_date);

export function unavailability(technicianId: string, day: string, data: AvailabilityData): Unavailability | null {
  const blackout = data.blackouts.filter((b) => b.status === 'active' && covers(b, day)).sort(byStart)[0];
  if (blackout) return { cause: 'blackout', reason: `Company blackout: ${blackout.label}`, entryId: blackout.id };

  const off = data.timeOff
    .filter((e) => e.status === 'approved' && e.technician_id === technicianId && covers(e, day))
    .sort(byStart)[0];
  if (off) return { cause: 'time_off', reason: KIND_REASONS[off.kind], entryId: off.id, kind: off.kind };

  const days = data.weekly[technicianId];
  if (days && !days.includes(dayOfWeek(day)))
    return { cause: 'not_scheduled', reason: `Not scheduled on ${WEEKDAY_NAMES[dayOfWeek(day)]}s` };
  return null;
}

export function unavailabilityForTimestamp(
  technicianId: string,
  timestamp: string | null | undefined,
  data: AvailabilityData,
): Unavailability | null {
  const day = jobDay(timestamp);
  return day ? unavailability(technicianId, day, data) : null;
}

// ---------------------------------------------------------------------------
// Conflicts & capacity
// ---------------------------------------------------------------------------

const isActiveJob = (j: ScheduledJob) => ACTIVE_JOB_STATUSES.includes(j.job_status);

export interface JobConflict {
  job: ScheduledJob;
  technicianId: string;
  day: string;
  unavailability: Unavailability;
}

/** Active jobs already assigned to a technician on a day they are unavailable. */
export function findConflicts(jobs: readonly ScheduledJob[], data: AvailabilityData): JobConflict[] {
  const out: JobConflict[] = [];
  for (const job of jobs) {
    if (!isActiveJob(job) || !job.assigned_technician_id) continue;
    const day = jobDay(job.scheduled_datetime);
    if (!day) continue;
    const u = unavailability(job.assigned_technician_id, day, data);
    if (u) out.push({ job, technicianId: job.assigned_technician_id, day, unavailability: u });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.job.id.localeCompare(b.job.id));
}

/** Active assigned jobs that a new entry would put in conflict (technicianId null = any technician, for blackouts). */
export function previewConflicts(
  jobs: readonly ScheduledJob[],
  start: string,
  end: string,
  technicianId: string | null,
): ScheduledJob[] {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return [];
  return jobs.filter((j) => {
    if (!isActiveJob(j) || !j.assigned_technician_id) return false;
    if (technicianId && j.assigned_technician_id !== technicianId) return false;
    const day = jobDay(j.scheduled_datetime);
    return day !== null && day >= start && day <= end;
  });
}

export interface DayCapacity {
  day: string;
  availableTechnicians: number;
  totalTechnicians: number;
  slots: number;
  booked: number;
  unassigned: number;
  open: number;
}

export function capacityForDays(
  days: readonly string[],
  technicians: readonly TechnicianLite[],
  data: AvailabilityData,
  jobs: readonly ScheduledJob[],
): Record<string, DayCapacity> {
  const dispatchable = technicians.filter((t) => t.dispatch_enabled);
  const wanted = new Set(days);
  const assigned = new Map<string, Map<string, number>>();
  const unassigned = new Map<string, number>();
  for (const job of jobs) {
    if (!isActiveJob(job)) continue;
    const day = jobDay(job.scheduled_datetime);
    if (!day || !wanted.has(day)) continue;
    if (!job.assigned_technician_id) unassigned.set(day, (unassigned.get(day) ?? 0) + 1);
    else {
      const perTech = assigned.get(day) ?? new Map<string, number>();
      perTech.set(job.assigned_technician_id, (perTech.get(job.assigned_technician_id) ?? 0) + 1);
      assigned.set(day, perTech);
    }
  }

  const out: Record<string, DayCapacity> = {};
  for (const day of days) {
    let slots = 0;
    let booked = 0;
    let available = 0;
    for (const t of dispatchable) {
      if (unavailability(t.id, day, data)) continue;
      available += 1;
      slots += t.max_jobs_per_day || DEFAULT_MAX_JOBS;
      booked += assigned.get(day)?.get(t.id) ?? 0;
    }
    out[day] = {
      day,
      availableTechnicians: available,
      totalTechnicians: dispatchable.length,
      slots,
      booked,
      unassigned: unassigned.get(day) ?? 0,
      open: Math.max(0, slots - booked),
    };
  }
  return out;
}

export interface TimeOffSummary {
  offToday: number;
  upcoming30: number;
  conflicts: number;
  openSlotsToday: number;
}

export function summarizeTimeOff(
  today: string,
  technicians: readonly TechnicianLite[],
  data: AvailabilityData,
  jobs: readonly ScheduledJob[],
): TimeOffSummary {
  const horizon = addDays(today, 30);
  const upcoming = data.timeOff.filter((e) => e.status === 'approved' && e.end_date >= today && e.start_date <= horizon);
  return {
    offToday: technicians.filter((t) => unavailability(t.id, today, data)).length,
    upcoming30: upcoming.length,
    conflicts: findConflicts(jobs, data).length,
    openSlotsToday: capacityForDays([today], technicians, data, jobs)[today]?.open ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Validation & overlap detection
// ---------------------------------------------------------------------------

export function validateRange(start: string, end: string): { start_date?: string; end_date?: string } {
  const errors: { start_date?: string; end_date?: string } = {};
  if (!isValidIsoDate(start)) errors.start_date = 'Choose a valid start date.';
  if (!isValidIsoDate(end)) errors.end_date = 'Choose a valid end date.';
  if (errors.start_date || errors.end_date) return errors;
  if (end < start) errors.end_date = "The end date can't be before the start date.";
  else if (diffDays(start, end) + 1 > MAX_SPAN_DAYS) errors.end_date = `A single entry can cover at most ${MAX_SPAN_DAYS} days.`;
  return errors;
}

export type TimeOffErrors = Partial<Record<'technician_id' | 'start_date' | 'end_date' | 'note', string>>;
export type BlackoutErrors = Partial<Record<'label' | 'start_date' | 'end_date', string>>;

export function validateTimeOff(d: TimeOffDraft): TimeOffErrors {
  const errors: TimeOffErrors = { ...validateRange(d.start_date, d.end_date) };
  if (!d.technician_id) errors.technician_id = 'Choose a technician.';
  if (Array.from(d.note).length > NOTE_LIMIT) errors.note = `Keep the note under ${NOTE_LIMIT} characters.`;
  return errors;
}

export function validateBlackout(d: BlackoutDraft): BlackoutErrors {
  const errors: BlackoutErrors = { ...validateRange(d.start_date, d.end_date) };
  const label = d.label.trim();
  if (label === '') errors.label = 'Give the blackout a name, e.g. "Thanksgiving".';
  else if (Array.from(label).length > LABEL_LIMIT) errors.label = `Keep the name under ${LABEL_LIMIT} characters.`;
  return errors;
}

export function overlappingTimeOff(
  entries: readonly TimeOffEntry[],
  technicianId: string,
  start: string,
  end: string,
): TimeOffEntry[] {
  return entries.filter((e) => e.status === 'approved' && e.technician_id === technicianId && e.start_date <= end && start <= e.end_date);
}

export function overlappingBlackouts(entries: readonly BlackoutEntry[], start: string, end: string): BlackoutEntry[] {
  return entries.filter((e) => e.status === 'active' && e.start_date <= end && start <= e.end_date);
}

// ---------------------------------------------------------------------------
// Agenda (list view) and weekly pattern helpers
// ---------------------------------------------------------------------------

export interface AgendaItem {
  type: 'time_off' | 'blackout';
  id: string;
  start_date: string;
  end_date: string;
  title: string;
  detail: string | null;
  kind?: TimeOffKind;
}

export function buildAgenda(
  data: AvailabilityData,
  technicians: readonly Pick<TechnicianLite, 'id' | 'member_name' | 'member_email'>[],
  today: string,
): AgendaItem[] {
  const names = new Map(technicians.map((t) => [t.id, technicianLabel(t)]));
  const items: AgendaItem[] = [];
  for (const e of data.timeOff) {
    if (e.status !== 'approved' || e.end_date < today) continue;
    items.push({
      type: 'time_off',
      id: e.id,
      start_date: e.start_date,
      end_date: e.end_date,
      title: names.get(e.technician_id) ?? 'Technician',
      detail: e.note?.trim() ? `${KIND_LABELS[e.kind]} · ${e.note.trim()}` : KIND_LABELS[e.kind],
      kind: e.kind,
    });
  }
  for (const b of data.blackouts) {
    if (b.status !== 'active' || b.end_date < today) continue;
    items.push({ type: 'blackout', id: b.id, start_date: b.start_date, end_date: b.end_date, title: b.label, detail: 'Company blackout, no dispatch' });
  }
  return items.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.title.localeCompare(b.title));
}

export function toggleWorkingDay(current: readonly number[] | undefined, day: number): number[] {
  const set = new Set(current ?? ALL_DAYS);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return [...set].sort((a, b) => a - b);
}

export function workingDaysOf(technicianId: string, weekly: Readonly<Record<string, number[]>>): number[] {
  return weekly[technicianId] ?? [...ALL_DAYS];
}

// ---------------------------------------------------------------------------
// Defensive normalisers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function normalizeTimeOff(raw: unknown): TimeOffEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const userId = str(r.user_id);
  const techId = str(r.technician_id);
  const start = str(r.start_date);
  const end = str(r.end_date);
  const kind = TIME_OFF_KINDS.find((k) => k === r.kind);
  const status: TimeOffStatus | null = r.status === 'approved' || r.status === 'cancelled' ? r.status : null;
  if (!id || !userId || !techId || !kind || !status || !start || !end || !isValidIsoDate(start) || !isValidIsoDate(end)) return null;
  return {
    id,
    user_id: userId,
    technician_id: techId,
    kind,
    start_date: start,
    end_date: end,
    note: str(r.note),
    status,
    created_by: str(r.created_by) ?? '',
    created_at: str(r.created_at) ?? '',
    updated_at: str(r.updated_at) ?? '',
  };
}

export function normalizeBlackout(raw: unknown): BlackoutEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const userId = str(r.user_id);
  const start = str(r.start_date);
  const end = str(r.end_date);
  const status: BlackoutStatus | null = r.status === 'active' || r.status === 'cancelled' ? r.status : null;
  if (!id || !userId || !status || !start || !end || !isValidIsoDate(start) || !isValidIsoDate(end)) return null;
  return {
    id,
    user_id: userId,
    label: str(r.label) ?? '',
    start_date: start,
    end_date: end,
    status,
    created_by: str(r.created_by) ?? '',
    created_at: str(r.created_at) ?? '',
    updated_at: str(r.updated_at) ?? '',
  };
}

export function normalizeWeekly(rows: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = str(r.technician_id);
    if (!id || !Array.isArray(r.working_days)) continue;
    const days = r.working_days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6);
    out[id] = [...new Set(days)].sort((a, b) => a - b);
  }
  return out;
}

export function normalizeList<T>(rows: unknown, normalize: (raw: unknown) => T | null): T[] {
  return Array.isArray(rows) ? rows.map(normalize).filter((x): x is T => x !== null) : [];
}
