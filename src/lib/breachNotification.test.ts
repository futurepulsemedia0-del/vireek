import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  computeDueAt,
  evaluateClock,
  evaluateClocks,
  type NotificationRule,
} from '@/lib/breachNotification';

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'r1',
  jurisdiction: 'Test',
  audience: 'regulator',
  clockStart: 'awareness',
  deadline: { unit: 'hours', amount: 72 },
  ...over,
});

// 2030-01-07 is a Monday (UTC).
const MON = '2030-01-07T09:00:00Z';

describe('computeDueAt', () => {
  it('adds hours and calendar days exactly (UTC)', () => {
    expect(computeDueAt(new Date(MON), { unit: 'hours', amount: 72 }).toISOString()).toBe('2030-01-10T09:00:00.000Z');
    expect(computeDueAt(new Date(MON), { unit: 'calendar_days', amount: 30 }).toISOString()).toBe('2030-02-06T09:00:00.000Z');
  });

  it('skips weekends for business days', () => {
    // Fri 2030-01-11 + 1 business day = Mon 2030-01-14
    expect(addBusinessDays(new Date('2030-01-11T10:00:00Z'), 1).toISOString()).toBe('2030-01-14T10:00:00.000Z');
    expect(addBusinessDays(new Date(MON), 5).toISOString()).toBe('2030-01-14T09:00:00.000Z');
  });

  it('skips listed holidays', () => {
    const due = addBusinessDays(new Date('2030-01-11T10:00:00Z'), 1, ['2030-01-14']);
    expect(due.toISOString()).toBe('2030-01-15T10:00:00.000Z');
  });

  it('handles zero and rejects invalid amounts', () => {
    expect(computeDueAt(new Date(MON), { unit: 'business_days', amount: 0 }).toISOString()).toBe('2030-01-07T09:00:00.000Z');
    for (const amount of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => computeDueAt(new Date(MON), { unit: 'hours', amount })).toThrow(RangeError);
    }
  });
});

describe('evaluateClock', () => {
  it('never guesses: no deadline means unspecified', () => {
    const r = evaluateClock(rule({ deadline: null }), { awarenessAt: MON, now: MON });
    expect(r).toMatchObject({ status: 'unspecified', dueAt: null, msRemaining: null });
  });

  it('is not_started until the rule clock start is known', () => {
    const r = evaluateClock(rule({ clockStart: 'determination' }), { awarenessAt: MON, now: MON });
    expect(r.status).toBe('not_started');
    const r2 = evaluateClock(rule(), { awarenessAt: null, now: MON });
    expect(r2.status).toBe('not_started');
  });

  it('uses the correct clock start', () => {
    const r = evaluateClock(rule({ clockStart: 'determination' }), {
      awarenessAt: MON,
      determinationAt: '2030-01-08T09:00:00Z',
      now: MON,
    });
    expect(r.dueAt?.toISOString()).toBe('2030-01-11T09:00:00.000Z');
  });

  it('moves on_track -> due_soon -> overdue at the boundaries', () => {
    const due = new Date('2030-01-10T09:00:00Z').getTime();
    const at = (ms: number) => evaluateClock(rule(), { awarenessAt: MON, now: new Date(due + ms) }).status;
    expect(at(-24 * 3_600_000 - 1)).toBe('on_track');
    expect(at(-24 * 3_600_000)).toBe('due_soon');
    expect(at(0)).toBe('due_soon');
    expect(at(1)).toBe('overdue');
  });

  it('reports msRemaining signed', () => {
    const r = evaluateClock(rule(), { awarenessAt: MON, now: '2030-01-10T10:00:00Z' });
    expect(r.msRemaining).toBe(-3_600_000);
  });

  it('distinguishes sent on time and sent late', () => {
    const onTime = evaluateClock(rule(), { awarenessAt: MON, sentAt: '2030-01-10T09:00:00Z', now: '2030-02-01T00:00:00Z' });
    const late = evaluateClock(rule(), { awarenessAt: MON, sentAt: '2030-01-10T09:00:01Z', now: '2030-02-01T00:00:00Z' });
    expect(onTime.status).toBe('sent');
    expect(late.status).toBe('sent_late');
  });

  it('throws on invalid dates instead of returning a wrong deadline', () => {
    expect(() => evaluateClock(rule(), { awarenessAt: 'not-a-date', now: MON })).toThrow(RangeError);
    expect(() => evaluateClock(rule(), { awarenessAt: MON, now: 'nope' })).toThrow(RangeError);
  });

  it('does not mutate its inputs', () => {
    const start = new Date(MON);
    const before = start.getTime();
    evaluateClock(rule({ deadline: { unit: 'business_days', amount: 3 } }), { awarenessAt: start, now: start });
    expect(start.getTime()).toBe(before);
  });
});

describe('evaluateClocks', () => {
  it('sorts by earliest due date, unspecified last, and applies per-rule sent times', () => {
    const rules = [
      rule({ id: 'none', deadline: null }),
      rule({ id: 'long', deadline: { unit: 'calendar_days', amount: 30 } }),
      rule({ id: 'short', deadline: { unit: 'hours', amount: 24 } }),
    ];
    const res = evaluateClocks(rules, { awarenessAt: MON, now: MON }, { short: '2030-01-07T10:00:00Z' });
    expect(res.map((r) => r.ruleId)).toEqual(['short', 'long', 'none']);
    expect(res[0].status).toBe('sent');
    expect(res[2].status).toBe('unspecified');
  });
});

describe('docs/security/breach-notification-rules.json', () => {
  const file = JSON.parse(readFileSync('docs/security/breach-notification-rules.json', 'utf8')) as {
    rules: (NotificationRule & { verifiedBy: string | null })[];
  };

  it('has unique ids and valid shapes', () => {
    const ids = file.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of file.rules) {
      expect(['awareness', 'determination']).toContain(r.clockStart);
      expect(['regulator', 'individuals', 'customers', 'other']).toContain(r.audience);
      if (r.deadline) {
        expect(['hours', 'calendar_days', 'business_days']).toContain(r.deadline.unit);
        expect(Number.isInteger(r.deadline.amount)).toBe(true);
      }
    }
  });

  it('never carries a deadline that counsel has not signed off', () => {
    for (const r of file.rules) {
      if (r.deadline !== null) expect(r.verifiedBy && r.verifiedBy.trim().length > 0).toBe(true);
    }
  });
});
