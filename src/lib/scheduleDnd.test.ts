import { describe, it, expect } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import {
  applyPatch,
  dragId,
  dropId,
  evaluateMove,
  findFreeSlot,
  findOverlap,
  invertPatch,
  isNoopPatch,
  parseDragId,
  parseDropId,
  resolveDrop,
  type MoveContext,
} from './scheduleDnd';

function at(day: string, hour: number, minute = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
}

function makeJob(o: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    user_id: 'owner-1',
    customer_name: 'Jane Doe',
    service_type: 'plumbing',
    scheduled_datetime: at('2026-10-12', 9),
    duration_minutes: 60,
    assigned_technician_id: 'tech-1',
    job_status: 'scheduled',
    ...o,
  } as Job;
}

function makeTech(o: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'tech-1',
    account_owner_id: 'owner-1',
    member_email: 'tech@example.com',
    member_name: 'Tech One',
    role: 'technician',
    skills: ['plumbing'],
    max_jobs_per_day: 3,
    dispatch_enabled: true,
    ...o,
  } as TeamMember;
}

function ctx(jobs: Job[], technicians: TeamMember[] = [makeTech()], o: Partial<MoveContext> = {}): MoveContext {
  return { jobs, technicians, canManage: true, now: new Date(2026, 9, 1), ...o };
}

describe('drag / drop ids', () => {
  it('round-trips every target kind', () => {
    const targets = [
      { kind: 'day', date: '2026-10-12' },
      { kind: 'lane', technicianId: 'tech-1' },
      { kind: 'lane', technicianId: null },
      { kind: 'unscheduled' },
      { kind: 'status', status: 'en_route' },
      { kind: 'technician', technicianId: 'tech-9' },
    ] as const;
    for (const t of targets) expect(parseDropId(dropId(t))).toEqual(t);
  });

  it('rejects malformed ids', () => {
    expect(parseDropId('drop:day:tomorrow')).toBeNull();
    expect(parseDropId('drop:status:bogus')).toBeNull();
    expect(parseDropId('nope')).toBeNull();
    expect(parseDropId(null)).toBeNull();
    expect(parseDragId('drop:day:2026-10-12')).toBeNull();
    expect(parseDragId(dragId('abc'))).toBe('abc');
  });
});

describe('resolveDrop', () => {
  it('keeps time-of-day when moving to another day', () => {
    const job = makeJob();
    const res = resolveDrop(job, { kind: 'day', date: '2026-10-14' }, ctx([job]));
    expect(res?.patch.scheduled_datetime).toBe(at('2026-10-14', 9));
    expect(res?.note).toBeUndefined();
  });

  it('is a no-op when dropped on its own day / lane / status', () => {
    const job = makeJob();
    expect(resolveDrop(job, { kind: 'day', date: '2026-10-12' }, ctx([job]))).toBeNull();
    expect(resolveDrop(job, { kind: 'lane', technicianId: 'tech-1' }, ctx([job]))).toBeNull();
    expect(resolveDrop(job, { kind: 'status', status: 'scheduled' }, ctx([job]))).toBeNull();
    expect(resolveDrop(job, { kind: 'technician', technicianId: 'tech-1' }, ctx([job]))).toBeNull();
  });

  it('moves to the nearest free slot when the preferred time is taken', () => {
    const job = makeJob();
    const blocker = makeJob({ id: 'job-2', customer_name: 'Bob', scheduled_datetime: at('2026-10-14', 9) });
    const res = resolveDrop(job, { kind: 'day', date: '2026-10-14' }, ctx([job, blocker]));
    expect(res?.patch.scheduled_datetime).toBe(at('2026-10-14', 10));
    expect(res?.note).toMatch(/already booked/);
  });

  it('defaults an unscheduled job to 09:00 and schedules it on lane drop', () => {
    const job = makeJob({ scheduled_datetime: null, assigned_technician_id: null });
    expect(resolveDrop(job, { kind: 'day', date: '2026-10-14' }, ctx([job]))?.patch.scheduled_datetime).toBe(at('2026-10-14', 9));
    const lane = resolveDrop(job, { kind: 'lane', technicianId: 'tech-1' }, ctx([job], [makeTech()], { viewDay: '2026-10-14' }));
    expect(lane?.patch).toEqual({ assigned_technician_id: 'tech-1', scheduled_datetime: at('2026-10-14', 9) });
  });

  it('unschedules on the unscheduled strip', () => {
    expect(resolveDrop(makeJob(), { kind: 'unscheduled' }, ctx([]))?.patch).toEqual({ scheduled_datetime: null });
    expect(resolveDrop(makeJob({ scheduled_datetime: null }), { kind: 'unscheduled' }, ctx([]))).toBeNull();
  });
});

describe('evaluateMove — conflicts', () => {
  it('blocks an overlap for the same technician', () => {
    const job = makeJob({ id: 'a', scheduled_datetime: at('2026-10-12', 9) });
    const other = makeJob({ id: 'b', customer_name: 'Bob', scheduled_datetime: at('2026-10-14', 9, 30) });
    const check = evaluateMove(job, { scheduled_datetime: at('2026-10-14', 9) }, ctx([job, other]));
    expect(check).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('allows back-to-back jobs (half-open ranges)', () => {
    const job = makeJob({ id: 'a' });
    const other = makeJob({ id: 'b', scheduled_datetime: at('2026-10-14', 10) });
    expect(evaluateMove(job, { scheduled_datetime: at('2026-10-14', 9) }, ctx([job, other])).ok).toBe(true);
  });

  it('ignores other technicians, finished jobs and itself', () => {
    const job = makeJob({ id: 'a' });
    const otherTech = makeJob({ id: 'b', assigned_technician_id: 'tech-2', scheduled_datetime: at('2026-10-14', 9) });
    const done = makeJob({ id: 'c', job_status: 'completed', scheduled_datetime: at('2026-10-14', 9) });
    expect(findOverlap([job, otherTech, done], job, 'tech-1', at('2026-10-14', 9))).toBeNull();
    expect(findOverlap([job], job, 'tech-1', job.scheduled_datetime as string)).toBeNull();
  });

  it('treats unassigned jobs as sharing one business calendar', () => {
    const a = makeJob({ id: 'a', assigned_technician_id: null });
    const b = makeJob({ id: 'b', assigned_technician_id: null, scheduled_datetime: at('2026-10-14', 9) });
    expect(findOverlap([a, b], a, null, at('2026-10-14', 9))?.id).toBe('b');
  });

  it('findFreeSlot searches later first, then earlier, and gives up when the day is full', () => {
    const job = makeJob({ id: 'a' });
    const busy = Array.from({ length: 24 }, (_, i) =>
      makeJob({ id: `x${i}`, scheduled_datetime: at('2026-10-14', 7 + Math.floor(i / 2), (i % 2) * 30), duration_minutes: 30 }),
    );
    expect(findFreeSlot(busy, job, 'tech-1', '2026-10-14', new Date(at('2026-10-14', 9)))).toBeNull();
    expect(findFreeSlot([], job, 'tech-1', '2026-10-14', new Date(at('2026-10-14', 9)))?.toISOString()).toBe(at('2026-10-14', 9));
  });
});

describe('evaluateMove — capacity', () => {
  const day = '2026-10-14';
  const fill = (n: number) =>
    Array.from({ length: n }, (_, i) => makeJob({ id: `f${i}`, scheduled_datetime: at(day, 8 + i * 2) }));

  it('blocks at capacity and names the technician', () => {
    const job = makeJob({ id: 'a', scheduled_datetime: at('2026-10-12', 9) });
    const check = evaluateMove(job, { scheduled_datetime: at(day, 17) }, ctx([job, ...fill(3)]));
    expect(check).toMatchObject({ ok: false, code: 'at_capacity' });
    expect((check as { reason: string }).reason).toContain('Tech One');
  });

  it('warns when the move fills the last slot', () => {
    const job = makeJob({ id: 'a', scheduled_datetime: at('2026-10-12', 9) });
    const check = evaluateMove(job, { scheduled_datetime: at(day, 17) }, ctx([job, ...fill(2)]));
    expect(check).toMatchObject({ ok: true });
    expect((check as { warnings: string[] }).warnings.join(' ')).toMatch(/full capacity/);
  });

  it('does not count the job itself when moving within the same day', () => {
    const jobs = fill(3);
    const check = evaluateMove(jobs[0], { scheduled_datetime: at(day, 18) }, ctx(jobs));
    expect(check.ok).toBe(true);
  });

  it('does not block a status-only move for a technician already over capacity', () => {
    const jobs = fill(4);
    expect(evaluateMove(jobs[0], { job_status: 'en_route' }, ctx(jobs)).ok).toBe(true);
  });

  it('warns about missing skills and unknown technicians', () => {
    const job = makeJob({ assigned_technician_id: null, service_type: 'hvac' });
    const check = evaluateMove(job, { assigned_technician_id: 'tech-1' }, ctx([job]));
    expect((check as { warnings: string[] }).warnings.join(' ')).toMatch(/no listed skill/);
    expect(evaluateMove(job, { assigned_technician_id: 'ghost' }, ctx([job]))).toMatchObject({ ok: false, code: 'technician_not_found' });
  });
});

describe('evaluateMove — status rules & permissions', () => {
  it('locks terminal jobs', () => {
    const job = makeJob({ job_status: 'completed' });
    expect(evaluateMove(job, { scheduled_datetime: at('2026-10-14', 9) }, ctx([job]))).toMatchObject({ ok: false, code: 'terminal' });
    expect(evaluateMove(job, { job_status: 'scheduled' }, ctx([job]))).toMatchObject({ ok: false, code: 'terminal' });
  });

  it('enforces the transition matrix', () => {
    const job = makeJob({ job_status: 'in_progress' });
    expect(evaluateMove(job, { job_status: 'scheduled' }, ctx([job]))).toMatchObject({ ok: false, code: 'transition' });
    expect(evaluateMove(job, { job_status: 'completed' }, ctx([job])).ok).toBe(true);
  });

  it('requires a technician to start a job', () => {
    const job = makeJob({ assigned_technician_id: null });
    expect(evaluateMove(job, { job_status: 'en_route' }, ctx([job]))).toMatchObject({ ok: false, code: 'needs_technician' });
  });

  it('blocks users without permission', () => {
    const job = makeJob();
    expect(evaluateMove(job, { job_status: 'en_route' }, ctx([job], [makeTech()], { canManage: false }))).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('warns about the past but allows it', () => {
    const job = makeJob();
    const check = evaluateMove(job, { scheduled_datetime: at('2026-09-01', 9) }, ctx([job]));
    expect(check.ok).toBe(true);
    expect((check as { warnings: string[] }).warnings.join(' ')).toMatch(/past/);
  });
});

describe('patch helpers', () => {
  it('inverts only the fields that were touched', () => {
    const job = makeJob();
    const patch = { assigned_technician_id: 'tech-2' };
    const moved = applyPatch(job, patch);
    expect(moved.assigned_technician_id).toBe('tech-2');
    expect(invertPatch(job, patch)).toEqual({ assigned_technician_id: 'tech-1' });
    expect(isNoopPatch(job, invertPatch(job, patch))).toBe(true);
    expect(isNoopPatch(job, patch)).toBe(false);
  });
});
