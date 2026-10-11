import type { Job, TeamMember } from '@/lib/supabase';

// ============================================================
// Drag-and-drop scheduling engine — PURE logic, no React, no network.
//
// Used by Calendar, Dispatch Board and Jobs Kanban so all three apply
// exactly the same rules before a move is sent to the server. These checks
// are ADVISORY (instant feedback while dragging); the authoritative checks
// live in the `move_job` RPC + the `jobs_no_double_booking` constraint.
// ============================================================

export type JobStatus = Job['job_status'];

export interface MovePatch {
  scheduled_datetime?: string | null;
  assigned_technician_id?: string | null;
  job_status?: JobStatus;
}

export type JobSnapshot = Pick<Job, 'scheduled_datetime' | 'assigned_technician_id' | 'job_status'>;

export const LIVE_STATUSES: readonly JobStatus[] = ['scheduled', 'en_route', 'in_progress'];
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'cancelled', 'no_show'];

export const DEFAULT_DURATION_MINUTES = 60;
export const DEFAULT_CAPACITY = 6;
const DEFAULT_START_HOUR = 9;
const WORKDAY_START_HOUR = 7;
const WORKDAY_END_HOUR = 19;
const SLOT_STEP_MINUTES = 30;
const MINUTE_MS = 60_000;

/** Board-stage moves allowed from each status (completed/cancelled/no_show are locked). */
export const STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  scheduled: ['en_route', 'in_progress', 'completed'],
  en_route: ['scheduled', 'in_progress', 'completed'],
  in_progress: ['en_route', 'completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

// ------------------------------------------------------------
// Drag / drop identifiers
// ------------------------------------------------------------

export type DropTarget =
  | { kind: 'day'; date: string } // local YYYY-MM-DD
  | { kind: 'lane'; technicianId: string | null }
  | { kind: 'unscheduled' }
  | { kind: 'status'; status: JobStatus }
  | { kind: 'technician'; technicianId: string };

export const dragId = (jobId: string): string => `job:${jobId}`;

export function parseDragId(id: string | number): string | null {
  const s = String(id);
  return s.startsWith('job:') ? s.slice(4) : null;
}

export function dropId(t: DropTarget): string {
  switch (t.kind) {
    case 'day':
      return `drop:day:${t.date}`;
    case 'lane':
      return `drop:lane:${t.technicianId ?? 'none'}`;
    case 'unscheduled':
      return 'drop:unscheduled';
    case 'status':
      return `drop:status:${t.status}`;
    case 'technician':
      return `drop:technician:${t.technicianId}`;
  }
}

const STATUS_SET = new Set<string>(['scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show']);

export function parseDropId(id: string | number | null | undefined): DropTarget | null {
  if (id === null || id === undefined) return null;
  const s = String(id);
  if (s === 'drop:unscheduled') return { kind: 'unscheduled' };
  const m = /^drop:(day|lane|status|technician):(.+)$/.exec(s);
  if (!m) return null;
  const [, kind, value] = m;
  if (kind === 'day') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { kind: 'day', date: value } : null;
  if (kind === 'lane') return { kind: 'lane', technicianId: value === 'none' ? null : value };
  if (kind === 'status') return STATUS_SET.has(value) ? { kind: 'status', status: value as JobStatus } : null;
  return { kind: 'technician', technicianId: value };
}

// ------------------------------------------------------------
// Date helpers (local time — same convention as CalendarPage)
// ------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function dayKeyOf(iso: string | null): string | null {
  return iso ? toDateKey(new Date(iso)) : null;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------
// Context
// ------------------------------------------------------------

export interface MoveContext {
  jobs: Job[];
  technicians: TeamMember[];
  /** false → the user may not reschedule/reassign (e.g. technician without can_view_all_jobs). */
  canManage: boolean;
  /** Day shown in Calendar day-lane view (YYYY-MM-DD); lets lane drops schedule unscheduled jobs. */
  viewDay?: string;
  now?: Date;
}

export type MoveBlockCode =
  | 'forbidden'
  | 'terminal'
  | 'transition'
  | 'needs_technician'
  | 'technician_not_found'
  | 'at_capacity'
  | 'conflict';

export type MoveCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; code: MoveBlockCode; reason: string };

export interface MoveResolution {
  patch: MovePatch;
  /** Human note about an automatic adjustment (e.g. a free slot was picked). */
  note?: string;
}

export function snapshotOf(job: JobSnapshot): JobSnapshot {
  return {
    scheduled_datetime: job.scheduled_datetime,
    assigned_technician_id: job.assigned_technician_id,
    job_status: job.job_status,
  };
}

export function applyPatch<T extends JobSnapshot>(job: T, patch: MovePatch): T {
  return { ...job, ...patch };
}

/** The inverse patch that restores `before` for every field `patch` touched. */
export function invertPatch(before: JobSnapshot, patch: MovePatch): MovePatch {
  const inv: MovePatch = {};
  if ('scheduled_datetime' in patch) inv.scheduled_datetime = before.scheduled_datetime;
  if ('assigned_technician_id' in patch) inv.assigned_technician_id = before.assigned_technician_id;
  if ('job_status' in patch) inv.job_status = before.job_status;
  return inv;
}

export function isNoopPatch(job: JobSnapshot, patch: MovePatch): boolean {
  const same = (k: keyof JobSnapshot) => !(k in patch) || patch[k] === job[k];
  return same('scheduled_datetime') && same('assigned_technician_id') && same('job_status');
}

// ------------------------------------------------------------
// Conflict / capacity primitives
// ------------------------------------------------------------

const isLive = (status: JobStatus) => LIVE_STATUSES.includes(status);
const durationOf = (j: Pick<Job, 'duration_minutes'>) => j.duration_minutes && j.duration_minutes > 0 ? j.duration_minutes : DEFAULT_DURATION_MINUTES;
/** Mirrors the DB `booking_resource`: the technician, otherwise the business as a whole. */
const resourceOf = (techId: string | null) => techId ?? 'business';

/** Another live job that overlaps [startIso, +duration) for the same technician/business. */
export function findOverlap(
  jobs: Job[],
  subject: { id: string; duration_minutes: number | null },
  techId: string | null,
  startIso: string,
): Job | null {
  const start = new Date(startIso).getTime();
  const end = start + durationOf(subject) * MINUTE_MS;
  const resource = resourceOf(techId);
  for (const other of jobs) {
    if (other.id === subject.id || !other.scheduled_datetime || !isLive(other.job_status)) continue;
    if (resourceOf(other.assigned_technician_id) !== resource) continue;
    const oStart = new Date(other.scheduled_datetime).getTime();
    const oEnd = oStart + durationOf(other) * MINUTE_MS;
    if (start < oEnd && oStart < end) return other;
  }
  return null;
}

export function dayLoad(jobs: Job[], techId: string, dayKey: string, excludeJobId: string): number {
  return jobs.filter(
    (j) =>
      j.id !== excludeJobId &&
      j.assigned_technician_id === techId &&
      isLive(j.job_status) &&
      dayKeyOf(j.scheduled_datetime) === dayKey,
  ).length;
}

/** First free slot on `dayKey` (07:00–19:00, 30-min steps) at or after `preferred`, else before it. */
export function findFreeSlot(
  jobs: Job[],
  subject: { id: string; duration_minutes: number | null },
  techId: string | null,
  dayKey: string,
  preferred: Date,
): Date | null {
  const day = fromDateKey(dayKey);
  const slots: Date[] = [];
  for (let minutes = WORKDAY_START_HOUR * 60; minutes < WORKDAY_END_HOUR * 60; minutes += SLOT_STEP_MINUTES) {
    const s = new Date(day);
    s.setHours(0, minutes, 0, 0);
    slots.push(s);
  }
  const free = (s: Date) => !findOverlap(jobs, subject, techId, s.toISOString());
  const p = preferred.getTime();
  const after = slots.filter((s) => s.getTime() >= p).find(free);
  if (after) return after;
  return [...slots].reverse().filter((s) => s.getTime() < p).find(free) ?? null;
}

// ------------------------------------------------------------
// Resolve a drop target into a concrete patch
// ------------------------------------------------------------

export function resolveDrop(job: Job, target: DropTarget, ctx: MoveContext): MoveResolution | null {
  switch (target.kind) {
    case 'status':
      return target.status === job.job_status ? null : { patch: { job_status: target.status } };

    case 'technician':
      return target.technicianId === job.assigned_technician_id
        ? null
        : { patch: { assigned_technician_id: target.technicianId } };

    case 'unscheduled':
      return job.scheduled_datetime ? { patch: { scheduled_datetime: null } } : null;

    case 'lane': {
      const patch: MovePatch = {};
      let note: string | undefined;
      if (target.technicianId !== job.assigned_technician_id) patch.assigned_technician_id = target.technicianId;
      if (!job.scheduled_datetime && ctx.viewDay) {
        const slot = pickSlotOnDay(job, target.technicianId, ctx.viewDay, ctx.jobs);
        patch.scheduled_datetime = slot.iso;
        note = slot.note;
      }
      return Object.keys(patch).length ? { patch, note } : null;
    }

    case 'day': {
      if (job.scheduled_datetime && dayKeyOf(job.scheduled_datetime) === target.date) return null;
      const slot = pickSlotOnDay(job, job.assigned_technician_id, target.date, ctx.jobs);
      return { patch: { scheduled_datetime: slot.iso }, note: slot.note };
    }
  }
}

/** Keep the job's time-of-day (default 09:00); if taken, pick the nearest free slot that day. */
function pickSlotOnDay(
  job: Job,
  techId: string | null,
  dayKey: string,
  jobs: Job[],
): { iso: string; note?: string } {
  const preferred = fromDateKey(dayKey);
  if (job.scheduled_datetime) {
    const t = new Date(job.scheduled_datetime);
    preferred.setHours(t.getHours(), t.getMinutes(), 0, 0);
  } else {
    preferred.setHours(DEFAULT_START_HOUR, 0, 0, 0);
  }
  const preferredIso = preferred.toISOString();
  if (!findOverlap(jobs, job, techId, preferredIso)) return { iso: preferredIso };
  const free = findFreeSlot(jobs, job, techId, dayKey, preferred);
  if (!free) return { iso: preferredIso }; // evaluateMove will report the conflict
  return {
    iso: free.toISOString(),
    note: `${formatClock(preferred)} was already booked — placed at ${formatClock(free)}.`,
  };
}

// ------------------------------------------------------------
// Evaluate a move (advisory validation)
// ------------------------------------------------------------

export function evaluateMove(job: Job, patch: MovePatch, ctx: MoveContext): MoveCheck {
  if (!ctx.canManage) {
    return { ok: false, code: 'forbidden', reason: "You don't have permission to move jobs." };
  }

  const after = applyPatch(job, patch);
  const touchesStatus = 'job_status' in patch && patch.job_status !== job.job_status;
  const touchesTech = 'assigned_technician_id' in patch && patch.assigned_technician_id !== job.assigned_technician_id;
  const touchesTime = 'scheduled_datetime' in patch && patch.scheduled_datetime !== job.scheduled_datetime;
  const warnings: string[] = [];

  if (TERMINAL_STATUSES.includes(job.job_status) && (touchesStatus || touchesTech || touchesTime)) {
    return {
      ok: false,
      code: 'terminal',
      reason: `A ${job.job_status.replace(/_/g, ' ')} job can't be moved. Open the job to reopen it.`,
    };
  }

  if (touchesStatus && !STATUS_TRANSITIONS[job.job_status].includes(after.job_status)) {
    return {
      ok: false,
      code: 'transition',
      reason: `A job can't go from ${job.job_status.replace(/_/g, ' ')} to ${after.job_status.replace(/_/g, ' ')} this way.`,
    };
  }

  if ((after.job_status === 'en_route' || after.job_status === 'in_progress') && !after.assigned_technician_id) {
    return { ok: false, code: 'needs_technician', reason: 'Assign a technician before starting this job.' };
  }

  let tech: TeamMember | null = null;
  if (after.assigned_technician_id) {
    tech = ctx.technicians.find((t) => t.id === after.assigned_technician_id) ?? null;
    if (!tech) return { ok: false, code: 'technician_not_found', reason: 'That technician is no longer available.' };
  }

  const live = isLive(after.job_status);
  const placement = touchesTech || touchesTime;

  if (placement && live && after.scheduled_datetime) {
    const dayKey = dayKeyOf(after.scheduled_datetime)!;

    if (tech) {
      const capacity = tech.max_jobs_per_day || DEFAULT_CAPACITY;
      const load = dayLoad(ctx.jobs, tech.id, dayKey, job.id);
      const name = tech.member_name ?? tech.member_email;
      if (load >= capacity) {
        return { ok: false, code: 'at_capacity', reason: `${name} already has ${load} of ${capacity} jobs that day.` };
      }
      if (load + 1 === capacity) warnings.push(`${name} will be at full capacity (${capacity}/${capacity}).`);
      if (!tech.dispatch_enabled) warnings.push(`${name} is excluded from automatic dispatch.`);
      if (touchesTech && job.service_type && !tech.skills.includes(job.service_type)) {
        warnings.push(`${name} has no listed skill for ${job.service_type}.`);
      }
    }

    const clash = findOverlap(ctx.jobs, job, after.assigned_technician_id, after.scheduled_datetime);
    if (clash) {
      return {
        ok: false,
        code: 'conflict',
        reason: `Overlaps ${clash.customer_name} at ${formatClock(new Date(clash.scheduled_datetime as string))} for the same ${tech ? 'technician' : 'calendar'}.`,
      };
    }
  }

  if (touchesTime && after.scheduled_datetime) {
    const now = ctx.now ?? new Date();
    if (new Date(after.scheduled_datetime).getTime() < now.getTime() - SLOT_STEP_MINUTES * MINUTE_MS) {
      warnings.push('This time is in the past.');
    }
  }

  return { ok: true, warnings };
}

/** Short, screen-reader friendly description of a move for toasts and announcements. */
export function describePatch(patch: MovePatch, technicians: TeamMember[]): string {
  const parts: string[] = [];
  if ('scheduled_datetime' in patch) {
    parts.push(
      patch.scheduled_datetime
        ? `to ${new Date(patch.scheduled_datetime).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'off the schedule',
    );
  }
  if ('assigned_technician_id' in patch) {
    const t = technicians.find((x) => x.id === patch.assigned_technician_id);
    parts.push(patch.assigned_technician_id ? `to ${t?.member_name ?? t?.member_email ?? 'technician'}` : 'to Unassigned');
  }
  if ('job_status' in patch && patch.job_status) parts.push(`to ${patch.job_status.replace(/_/g, ' ')}`);
  return parts.join(' and ');
}

/** A prospective move: what would change (`resolution`) and whether it is allowed (`check`). */
export interface MovePlan {
  resolution: MoveResolution;
  check: MoveCheck;
}

export interface MoveTargetOption {
  key: string;
  label: string;
  /** Optional group heading in the Move menu (e.g. "Day", "Technician"). */
  group?: string;
  target: DropTarget;
}
