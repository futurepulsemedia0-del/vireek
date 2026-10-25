import { describe, expect, it } from 'vitest';
import {
  applyIntegrity,
  computeScoreboard,
  currentMonthWindow,
  evidencePath,
  expectedTicketCents,
  formatHours,
  formatMultiple,
  isMonthlyStatementDue,
  minutesToHours,
  monthOf,
  monthWindowFor,
  planMonthlyCents,
  previousMonthWindow,
  shiftMonth,
  type ValueEvent,
  type ValueReview,
} from './engine.ts';

const UUID = '3f2b8c1e-7a41-4d6e-9b0a-1c2d3e4f5a6b';
let seq = 0;
function ev(p: Partial<ValueEvent> = {}): ValueEvent {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    source_feature: 'after_hours_answering',
    type: 'recovered_revenue',
    amount: 10000,
    unit: 'cents',
    currency: 'USD',
    confidence: 'measured',
    method_note: 'note',
    evidence_ref: `jobs:${UUID.slice(0, -2)}${String(seq).padStart(2, '0')}`,
    supersedes_ref: null,
    occurred_at: '2026-10-10T15:00:00Z',
    ...p,
  };
}
const NY = 'America/New_York';
const board = (events: ValueEvent[], extra: Partial<Parameters<typeof computeScoreboard>[0]> = {}) =>
  computeScoreboard({ events, window: monthWindowFor('2026-10', NY)!, currency: 'USD', ...extra });

describe('dedupe', () => {
  it('counts one event per (type, evidence_ref)', () => {
    const a = ev({ evidence_ref: `jobs:${UUID}`, amount: 5000 });
    const b = ev({ evidence_ref: `jobs:${UUID}`, amount: 5000, occurred_at: '2026-10-11T15:00:00Z' });
    const r = applyIntegrity([b, a]);
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0].id).toBe(a.id); // earliest wins, regardless of input order
    expect(r.counts.duplicates).toBe(1);
  });
  it('treats the same evidence under a different type as distinct', () => {
    const r = applyIntegrity([
      ev({ evidence_ref: `calls:${UUID}` }),
      ev({ evidence_ref: `calls:${UUID}`, type: 'saved_hours', unit: 'minutes', currency: null, amount: 3, confidence: 'estimated' }),
    ]);
    expect(r.effective).toHaveLength(2);
  });
  it('drops malformed rows instead of corrupting totals', () => {
    const r = applyIntegrity([
      ev({ amount: 0 }), ev({ amount: -5 }), ev({ amount: 10.5 }), ev({ amount: Number.NaN }),
      ev({ currency: null }), ev({ currency: 'usd' }),
      ev({ type: 'saved_hours', unit: 'cents', currency: null }),
      ev({ occurred_at: 'not-a-date' }),
      ev({ type: 'bogus' as never }),
    ]);
    expect(r.effective).toHaveLength(0);
    expect(r.counts.invalid).toBe(9);
  });
});

describe('measured vs estimated separation', () => {
  it('never merges the two buckets and reports both totals', () => {
    const s = board([
      ev({ amount: 120000, confidence: 'measured' }),
      ev({ amount: 30000, confidence: 'estimated', evidence_ref: `calls:${UUID}` }),
    ]);
    expect(s.money).toEqual({ measuredCents: 120000, estimatedCents: 30000, totalCents: 150000 });
    expect(s.counts.measured).toBe(1);
    expect(s.counts.estimated).toBe(1);
    expect(s.byFeature[0].measuredCents).toBe(120000);
    expect(s.byFeature[0].estimatedCents).toBe(30000);
  });
  it('a measured event supersedes its estimate (no double counting)', () => {
    const callRef = `calls:${UUID}`;
    const est = ev({ confidence: 'estimated', amount: 20000, evidence_ref: callRef });
    const meas = ev({ confidence: 'measured', amount: 45000, supersedes_ref: callRef });
    const s = board([est, meas]);
    expect(s.money).toEqual({ measuredCents: 45000, estimatedCents: 0, totalCents: 45000 });
    expect(s.counts.superseded).toBe(1);
  });
  it('excluding the measured job does not resurrect its estimate', () => {
    const callRef = `calls:${UUID}`;
    const est = ev({ confidence: 'estimated', amount: 20000, evidence_ref: callRef });
    const meas = ev({ confidence: 'measured', amount: 45000, supersedes_ref: callRef });
    const s = board([est, meas], { reviews: [{ value_event_id: meas.id, decision: 'not_due_to_vireek', decided_at: '2026-10-12T00:00:00Z' }] });
    expect(s.money.totalCents).toBe(0);
    expect(s.excludedEvents).toHaveLength(1);
  });
  it('keeps hours separate from money', () => {
    const s = board([ev({ type: 'saved_hours', unit: 'minutes', currency: null, amount: 90, confidence: 'estimated' })]);
    expect(s.money.totalCents).toBe(0);
    expect(s.hours).toEqual({ measuredMinutes: 0, estimatedMinutes: 90, totalMinutes: 90 });
  });
});

describe('owner reviews', () => {
  const e = ev({ amount: 7000 });
  const r = (decision: ValueReview['decision'], at: string): ValueReview => ({ value_event_id: e.id, decision, decided_at: at });
  it('not_due_to_vireek removes the event', () => {
    expect(board([e], { reviews: [r('not_due_to_vireek', '2026-10-11T00:00:00Z')] }).money.totalCents).toBe(0);
  });
  it('the newest decision wins (restore)', () => {
    const rs = [r('restored', '2026-10-13T00:00:00Z'), r('not_due_to_vireek', '2026-10-11T00:00:00Z')];
    expect(board([e], { reviews: rs }).money.totalCents).toBe(7000);
  });
});

describe('currency', () => {
  it('never adds different currencies', () => {
    const s = board([ev({ amount: 10000 }), ev({ amount: 99900, currency: 'EUR' }), ev({ amount: 500, currency: 'EUR', confidence: 'estimated', evidence_ref: `calls:${UUID}` })]);
    expect(s.money.totalCents).toBe(10000);
    expect(s.otherCurrencies).toEqual([{ currency: 'EUR', measuredCents: 99900, estimatedCents: 500 }]);
  });
  it('refuses a cost comparison across currencies', () => {
    const s = board([ev({ amount: 100000 })], { subscription: { cents: 7900, currency: 'EUR' } });
    expect(s.cost.reason).toBe('currency_mismatch');
    expect(s.cost.multiple).toBeNull();
  });
  it('falls back to USD for a malformed account currency', () => {
    expect(computeScoreboard({ events: [], window: monthWindowFor('2026-10', NY)!, currency: 'dollars' }).currency).toBe('USD');
  });
});

describe('time zones', () => {
  it('builds month windows from local midnight (DST-aware)', () => {
    expect(monthWindowFor('2026-10', 'America/Los_Angeles')).toMatchObject({ startUtc: '2026-10-01T07:00:00.000Z', endUtc: '2026-11-01T07:00:00.000Z' });
    expect(monthWindowFor('2026-11', 'America/Los_Angeles')).toMatchObject({ startUtc: '2026-11-01T07:00:00.000Z', endUtc: '2026-12-01T08:00:00.000Z' });
    expect(monthWindowFor('2026-10', 'Europe/Berlin')!.startUtc).toBe('2026-09-30T22:00:00.000Z');
  });
  it('assigns the same instant to different months in different zones', () => {
    const iso = '2026-10-01T02:30:00Z';
    expect(monthOf(iso, 'America/Los_Angeles')).toBe('2026-09');
    expect(monthOf(iso, 'Europe/Berlin')).toBe('2026-10');
  });
  it('uses a half-open window: start included, end excluded', () => {
    const w = monthWindowFor('2026-10', 'America/Los_Angeles')!;
    const inside = ev({ occurred_at: w.startUtc, amount: 100 });
    const outside = ev({ occurred_at: w.endUtc, amount: 900 });
    const s = computeScoreboard({ events: [inside, outside], window: w, currency: 'USD' });
    expect(s.money.totalCents).toBe(100);
  });
  it('rejects bad months and time zones', () => {
    expect(monthWindowFor('2026-13', NY)).toBeNull();
    expect(monthWindowFor('2026-10', 'Mars/Phobos')).toBeNull();
  });
  it('current/previous month follow the account zone, not UTC', () => {
    const now = new Date('2026-11-01T03:00:00Z'); // still Oct 31 in New York
    expect(currentMonthWindow(now, NY).month).toBe('2026-10');
    expect(previousMonthWindow(now, NY).month).toBe('2026-09');
    expect(currentMonthWindow(now, 'Asia/Tokyo').month).toBe('2026-11');
  });
  it('shifts months across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', -14)).toBe('2025-01');
  });
  it('monthly statement is due from the send hour on the 1st, all month long', () => {
    const s = { enabled: true, send_hour: 8, timezone: NY };
    expect(isMonthlyStatementDue(s, new Date('2026-11-01T11:59:00Z'))).toBe(false); // 06:59 local on the 1st
    expect(isMonthlyStatementDue(s, new Date('2026-11-01T13:00:00Z'))).toBe(true); // 08:00 local
    expect(isMonthlyStatementDue(s, new Date('2026-11-17T01:00:00Z'))).toBe(true); // self-healing
    expect(isMonthlyStatementDue({ ...s, enabled: false }, new Date('2026-11-17T13:00:00Z'))).toBe(false);
  });
});

describe('rounding', () => {
  it('sums integers exactly (no float drift)', () => {
    const events = Array.from({ length: 1000 }, () => ev({ amount: 10 })); // 10 cents × 1000
    expect(board(events).money.totalCents).toBe(10000);
  });
  it('computes share in basis points that are stable', () => {
    const s = board([ev({ amount: 1, source_feature: 'a' }), ev({ amount: 2, source_feature: 'b' })]);
    expect(s.byFeature.map((r) => [r.feature, r.shareBp])).toEqual([['b', 6667], ['a', 3333]]);
  });
  it('rounds the cost multiple to one decimal, half-up', () => {
    const s = board([ev({ amount: 33000 })], { subscription: { cents: 7900, currency: 'USD' } });
    expect(s.cost.multiple).toBe(4.2); // 4.177…
    expect(s.cost.netCents).toBe(25100);
    expect(s.cost.measuredCoversCost).toBe(true);
  });
  it('expected ticket uses integer math and clamps inputs', () => {
    expect(expectedTicketCents(45000, 2500)).toBe(11250);
    expect(expectedTicketCents(33333, 3333)).toBe(11110);
    expect(expectedTicketCents(45000, 99999)).toBe(45000);
    expect(expectedTicketCents(-5, 2500)).toBe(0);
    expect(expectedTicketCents(Number.NaN, 2500)).toBe(0);
  });
  it('formats hours to one decimal', () => {
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(100)).toBe(1.7);
    expect(formatHours(450)).toBe('7.5 h');
    expect(formatMultiple(null)).toBe('—');
    expect(formatMultiple(4)).toBe('4.0×');
  });
});

describe('trend, cost and snapshots', () => {
  it('zero-fills the trend and orders oldest → newest', () => {
    const s = board([ev({ amount: 500, occurred_at: '2026-08-15T12:00:00Z' }), ev({ amount: 700 })], { trendMonths: 4 });
    expect(s.trend.map((t) => [t.month, t.totalCents])).toEqual([['2026-07', 0], ['2026-08', 500], ['2026-09', 0], ['2026-10', 700]]);
  });
  it('handles free / unknown plans honestly', () => {
    expect(board([], { subscription: { cents: 0, currency: 'USD' } }).cost.reason).toBe('free_plan');
    expect(board([]).cost.reason).toBe('no_plan');
    expect(planMonthlyCents('Professional')).toBe(19900);
    expect(planMonthlyCents('enterprise')).toBeNull();
  });
  it('caps stored events by amount and flags truncation', () => {
    const events = [ev({ amount: 100 }), ev({ amount: 900 }), ev({ amount: 500 })];
    const s = board(events, { maxEvents: 2 });
    expect(s.events.map((e) => e.amount).sort()).toEqual([500, 900]);
    expect(s.eventsTruncated).toBe(true);
    expect(s.money.totalCents).toBe(1500); // totals are never capped
  });
});

describe('evidence links', () => {
  it('links only well-formed references', () => {
    expect(evidencePath(`jobs:${UUID}`)).toBe(`/dashboard/jobs/${UUID}`);
    expect(evidencePath(`calls:${UUID}`)).toBe(`/dashboard/calls/${UUID}`);
    expect(evidencePath(`revenue_recovery_events:${UUID}`)).toBe('/dashboard/recovery');
    expect(evidencePath('jobs:not-a-uuid')).toBeNull();
    expect(evidencePath('demo:abc')).toBeNull();
    expect(evidencePath(`jobs:${UUID}:extra`)).toBeNull();
  });
});
