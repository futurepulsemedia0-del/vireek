import { describe, expect, it } from 'vitest';
import {
  buildEvidenceLog, buildManualPayload, checkOutcome, computeDrillStatus, isValidInterval, scheduleFromRow, validateManualDraft,
  type CheckRow, type ManualRow,
} from './voiceDrills';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const chk = (id: string, status: CheckRow['status'], ago: number, kind: CheckRow['kind'] = 'forward_on'): CheckRow => ({ id, kind, status, started_at: day(ago), finished_at: day(ago) });
const man = (id: string, ago: number, outcome: ManualRow['outcome'] = 'passed'): ManualRow => ({ id, kind: 'voicemail', outcome, note: null, created_at: day(ago) });

describe('checkOutcome', () => {
  it('maps statuses; pending is not evidence; non-conclusive results stay inconclusive', () => {
    expect(checkOutcome('passed')).toBe('passed');
    expect(checkOutcome('failed')).toBe('failed');
    expect(checkOutcome('pending')).toBeNull();
    for (const s of ['answered_by_human', 'expired', 'error'] as const) expect(checkOutcome(s)).toBe('inconclusive');
  });
});

describe('buildEvidenceLog', () => {
  it('merges system + manual newest-first and drops pending checks', () => {
    const log = buildEvidenceLog([chk('a', 'passed', 10), chk('b', 'pending', 1)], [man('m', 3)]);
    expect(log.map((e) => e.id)).toEqual(['m:m', 'c:a']);
    expect(log[0].source).toBe('manual');
  });
  it('is stable for equal timestamps and honours the limit', () => {
    const rows = [chk('b', 'passed', 2), chk('a', 'passed', 2), chk('c', 'passed', 2)];
    expect(buildEvidenceLog(rows, []).map((e) => e.id)).toEqual(['c:a', 'c:b', 'c:c']);
    expect(buildEvidenceLog(rows, [], 2)).toHaveLength(2);
    expect(buildEvidenceLog(rows, [], -5)).toHaveLength(0);
  });
  it('tolerates an unparsable timestamp without throwing', () => {
    expect(() => buildEvidenceLog([{ ...chk('x', 'passed', 1), started_at: 'nope', finished_at: null }], [])).not.toThrow();
  });
});

describe('computeDrillStatus', () => {
  const sched = { enabled: true, interval_days: 30 };
  const log = (rows: CheckRow[], m: ManualRow[] = []) => buildEvidenceLog(rows, m);
  it('never: no passed forward_on test yet', () => {
    expect(computeDrillStatus(sched, log([]), NOW).state).toBe('never');
    expect(computeDrillStatus(sched, log([chk('a', 'failed', 1)]), NOW).state).toBe('never');
  });
  it('ok / due_soon / overdue around the interval', () => {
    expect(computeDrillStatus(sched, log([chk('a', 'passed', 5)]), NOW)).toMatchObject({ state: 'ok', daysLeft: 25 });
    expect(computeDrillStatus(sched, log([chk('a', 'passed', 28)]), NOW).state).toBe('due_soon');
    expect(computeDrillStatus(sched, log([chk('a', 'passed', 30)]), NOW).state).toBe('overdue');
    expect(computeDrillStatus(sched, log([chk('a', 'passed', 90)]), NOW).state).toBe('overdue');
  });
  it('only a passed forward_on test call resets the clock (not forward_off, not manual entries)', () => {
    const l = log([chk('off', 'passed', 1, 'forward_off'), chk('on', 'passed', 40)], [man('m', 1)]);
    expect(computeDrillStatus(sched, l, NOW).state).toBe('overdue');
  });
  it('uses the newest passed test; disabled schedule reports disabled but keeps last proof', () => {
    const l = log([chk('old', 'passed', 60), chk('new', 'passed', 2)]);
    expect(computeDrillStatus(sched, l, NOW).lastPassedAt).toBe(day(2));
    expect(computeDrillStatus({ ...sched, enabled: false }, l, NOW)).toMatchObject({ state: 'disabled', dueAt: null });
  });
});

describe('schedule + manual validation', () => {
  it('interval must be an integer 7..90', () => {
    for (const ok of [7, 30, 90]) expect(isValidInterval(ok)).toBe(true);
    for (const bad of [6, 91, 7.5, NaN, '30', null, undefined]) expect(isValidInterval(bad)).toBe(false);
  });
  it('scheduleFromRow falls back to safe defaults', () => {
    expect(scheduleFromRow(null)).toEqual({ enabled: true, interval_days: 30 });
    expect(scheduleFromRow({ enabled: false, interval_days: 999 })).toEqual({ enabled: false, interval_days: 30 });
  });
  it('manual draft: kind whitelist, note length, payload trimming', () => {
    expect(validateManualDraft({ kind: 'voicemail', outcome: 'passed', note: '' })).toBeNull();
    expect(validateManualDraft({ kind: 'hack' as never, outcome: 'passed', note: '' })).toBe('kindInvalid');
    expect(validateManualDraft({ kind: 'other', outcome: 'failed', note: 'x'.repeat(501) })).toBe('noteTooLong');
    expect(buildManualPayload({ kind: 'other', outcome: 'failed', note: '  hi  ' })).toEqual({ action: 'drill_log', kind: 'other', outcome: 'failed', note: 'hi' });
    expect(buildManualPayload({ kind: 'other', outcome: 'passed', note: '   ' }).note).toBeNull();
  });
});
