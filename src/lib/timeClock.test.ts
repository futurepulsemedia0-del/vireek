import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  breakMs,
  buildEvent,
  clockStatus,
  currentJobId,
  fixQuality,
  foldEvents,
  formatClock,
  formatHoursMinutes,
  getCurrentFix,
  jobBreakdown,
  netMs,
  weekMinutes,
  weekStartIso,
  type ClockEvent,
  type ClockEventType,
} from '@/lib/timeClock';
import { enqueue, flushQueue, loadQueue, saveQueue, EMPTY_QUEUE, MAX_BATCH, type StorageLike } from '@/lib/timeClockQueue';

const T0 = Date.UTC(2026, 9, 5, 8, 0, 0); // Monday
const min = (n: number) => T0 + n * 60_000;
let n = 0;
const ev = (type: ClockEventType, at: number, extra: Partial<ClockEvent> = {}): ClockEvent => ({
  id: `e${++n}`,
  type,
  at: new Date(at).toISOString(),
  shift_id: 's1',
  ...(type === 'clock_in' ? { work_date: '2026-10-05' } : {}),
  ...extra,
});

describe('state machine', () => {
  it('runs a full shift with break and job switch', () => {
    const { view, skipped } = foldEvents(null, [
      ev('clock_in', min(0), { job_id: 'A' }),
      ev('break_start', min(60)),
      ev('break_end', min(90)),
      ev('switch_job', min(120), { job_id: 'B' }),
      ev('clock_out', min(240)),
    ]);
    expect(skipped).toEqual([]);
    expect(clockStatus(view)).toBe('off');
    expect(netMs(view, min(999))).toBe(210 * 60_000);
    expect(breakMs(view, min(999))).toBe(30 * 60_000);
    const by = Object.fromEntries(jobBreakdown(view, min(999)).map((r) => [r.jobId, r.ms / 60_000]));
    expect(by).toEqual({ A: 90, B: 120 });
  });

  it('subtracts a running break from live net time', () => {
    const { view } = foldEvents(null, [ev('clock_in', min(0)), ev('break_start', min(30))]);
    expect(clockStatus(view)).toBe('on_break');
    expect(netMs(view, min(50))).toBe(30 * 60_000);
    expect(currentJobId(view)).toBeNull();
  });

  it.each([
    ['second clock in', [ev('clock_in', min(0)), ev('clock_in', min(1))], 'tc_already_clocked_in'],
    ['break without shift', [ev('break_start', min(0))], 'tc_no_open_shift'],
    ['double break', [ev('clock_in', min(0)), ev('break_start', min(1)), ev('break_start', min(2))], 'tc_already_on_break'],
    ['end without break', [ev('clock_in', min(0)), ev('break_end', min(1))], 'tc_not_on_break'],
    ['same job', [ev('clock_in', min(0), { job_id: 'A' }), ev('switch_job', min(1), { job_id: 'A' })], 'tc_same_job'],
    ['out of order', [ev('clock_in', min(10)), ev('break_start', min(5))], 'tc_out_of_order'],
    ['zero length', [ev('clock_in', min(0)), ev('clock_out', min(0))], 'tc_zero_length'],
    ['wrong shift', [ev('clock_in', min(0)), ev('break_start', min(1), { shift_id: 'other' })], 'tc_wrong_shift'],
  ])('rejects %s', (_n, events, code) => {
    expect(foldEvents(null, events).skipped.at(-1)?.code).toBe(code);
  });

  it('rejects clock-in overlapping a closed shift and bad timestamps', () => {
    const closed = foldEvents(null, [ev('clock_in', min(0)), ev('clock_out', min(60))]).view;
    expect(applyEvent(closed, { ...ev('clock_in', min(30)), shift_id: 's2' })).toEqual({ ok: false, code: 'tc_overlaps_previous_shift' });
    expect(applyEvent(null, { ...ev('clock_in', 0), at: 'nope' })).toEqual({ ok: false, code: 'tc_invalid_event' });
  });

  it('ends a running break on clock out', () => {
    const { view } = foldEvents(null, [ev('clock_in', min(0)), ev('break_start', min(30)), ev('clock_out', min(60))]);
    expect(netMs(view, min(999))).toBe(30 * 60_000);
    expect(breakMs(view, min(999))).toBe(30 * 60_000);
  });
});

describe('formatting and dates', () => {
  it('formats clocks and durations', () => {
    expect(formatClock(3_725_000)).toBe('01:02:05');
    expect(formatClock(-5)).toBe('00:00:00');
    expect(formatHoursMinutes(45)).toBe('45m');
    expect(formatHoursMinutes(125)).toBe('2h 05m');
  });
  it('uses Monday-based weeks', () => {
    expect(weekStartIso('2026-10-05')).toBe('2026-10-05');
    expect(weekStartIso('2026-10-11')).toBe('2026-10-05');
    expect(weekStartIso('2026-10-12')).toBe('2026-10-12');
  });
  it('sums only this week', () => {
    const shifts = [
      { work_date: '2026-10-05', net_minutes: 480 },
      { work_date: '2026-10-07', net_minutes: 60 },
      { work_date: '2026-10-04', net_minutes: 999 },
      { work_date: '2026-10-08', net_minutes: null },
    ];
    expect(weekMinutes(shifts, '2026-10-09')).toBe(540);
  });
});

describe('gps', () => {
  it('grades accuracy', () => {
    expect([fixQuality(10), fixQuality(100), fixQuality(500)]).toEqual(['good', 'fair', 'poor']);
  });
  it('returns a fix', async () => {
    const geo = { getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) => ok({ coords: { latitude: 1, longitude: 2, accuracy: 9 } }) };
    expect(await getCurrentFix(geo)).toEqual({ ok: true, lat: 1, lng: 2, accuracy: 9 });
  });
  it('maps errors and unsupported', async () => {
    const mk = (code: number) => ({ getCurrentPosition: (_o: unknown, err: (e: { code: number }) => void) => err({ code }) });
    expect(await getCurrentFix(mk(1) as never)).toEqual({ ok: false, error: 'denied' });
    expect(await getCurrentFix(mk(3) as never)).toEqual({ ok: false, error: 'timeout' });
    expect(await getCurrentFix(mk(2) as never)).toEqual({ ok: false, error: 'unavailable' });
    expect(await getCurrentFix(undefined as never)).toEqual({ ok: false, error: 'unsupported' });
  });
  it('never hangs when the browser never answers', async () => {
    expect(await getCurrentFix({ getCurrentPosition: () => undefined } as never, 10)).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('buildEvent', () => {
  it('stamps work date, job and gps', () => {
    const e = buildEvent('clock_in', 's9', T0, { jobId: 'J', fix: { ok: true, lat: 1.5, lng: 2.5, accuracy: 12.4 } });
    expect(e).toMatchObject({ type: 'clock_in', shift_id: 's9', job_id: 'J', lat: 1.5, lng: 2.5, accuracy: 12 });
    expect(e.work_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('records gps errors and unique ids', () => {
    const a = buildEvent('clock_out', 's', T0, { fix: { ok: false, error: 'denied' } });
    expect(a.gps_error).toBe('denied');
    expect(a.lat).toBeUndefined();
    expect(buildEvent('break_start', 's', T0).id).not.toBe(a.id);
  });
});

function memStore(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('queue', () => {
  const e1 = ev('clock_in', min(0));
  const e2 = ev('break_start', min(5));
  const e3 = ev('break_end', min(10));

  it('persists, reloads, drops junk and dedupes', () => {
    const s = memStore();
    const q = enqueue(enqueue(enqueue(EMPTY_QUEUE, e1), e1), e2);
    expect(q.pending).toHaveLength(2);
    expect(saveQueue(s, 'k', q)).toBe(true);
    expect(loadQueue(s, 'k').pending.map((e) => e.id)).toEqual([e1.id, e2.id]);
    s.setItem('k', '{bad');
    expect(loadQueue(s, 'k')).toEqual(EMPTY_QUEUE);
    s.setItem('k', JSON.stringify({ pending: [{ id: 1 }, e1], rejected: 'x' }));
    expect(loadQueue(s, 'k').pending).toHaveLength(1);
    saveQueue(s, 'k', EMPTY_QUEUE);
    expect(s.data.has('k')).toBe(false);
  });

  it('reports a storage failure', () => {
    const bad: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
    expect(saveQueue(bad, 'k', enqueue(EMPTY_QUEUE, e1))).toBe(false);
  });

  it('confirms applied and duplicate, parks rejected', async () => {
    const q = { pending: [e1, e2, e3], rejected: [] };
    const out = await flushQueue(q, async (b) => [
      { id: b[0].id, outcome: 'applied' },
      { id: b[1].id, outcome: 'duplicate' },
      { id: b[2].id, outcome: 'rejected', code: 'tc_not_on_break' },
    ]);
    expect(out).toMatchObject({ confirmed: 2, retry: false });
    expect(out.state.pending).toEqual([]);
    expect(out.state.rejected).toEqual([{ event: e3, code: 'tc_not_on_break' }]);
  });

  it('keeps everything on a network failure', async () => {
    const q = { pending: [e1, e2], rejected: [] };
    const out = await flushQueue(q, async () => { throw new Error('offline'); });
    expect(out).toEqual({ state: q, confirmed: 0, retry: true });
  });

  it('stops at a transient error and never drops later events', async () => {
    const q = { pending: [e1, e2, e3], rejected: [] };
    const out = await flushQueue(q, async (b) => [
      { id: b[0].id, outcome: 'applied' },
      { id: b[1].id, outcome: 'error' },
      { id: b[2].id, outcome: 'applied' }, // must be ignored: order matters
    ]);
    expect(out.retry).toBe(true);
    expect(out.state.pending.map((e) => e.id)).toEqual([e2.id, e3.id]);
    expect(out.confirmed).toBe(1);
  });

  it('keeps events with no result', async () => {
    const out = await flushQueue({ pending: [e1], rejected: [] }, async () => []);
    expect(out.state.pending).toEqual([e1]);
    expect(out.retry).toBe(true);
  });

  it('sends in batches of at most MAX_BATCH', async () => {
    const many = Array.from({ length: MAX_BATCH + 20 }, (_, i) => ev('break_start', min(i)));
    const sizes: number[] = [];
    const out = await flushQueue({ pending: many, rejected: [] }, async (b) => {
      sizes.push(b.length);
      return b.map((e) => ({ id: e.id, outcome: 'applied' as const }));
    });
    expect(sizes).toEqual([MAX_BATCH, 20]);
    expect(out.confirmed).toBe(MAX_BATCH + 20);
    expect(out.state.pending).toEqual([]);
  });
});
