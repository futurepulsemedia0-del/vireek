import { describe, it, expect } from 'vitest';
import {
  addDays,
  bucketCounts,
  computeDelta,
  countDays,
  describeDelta,
  formatDelta,
  inRange,
  parseISODate,
  parseRangeParams,
  resolveRange,
  serializeRangeParams,
  toISODate,
  validateCustomRange,
  type RangeSelection,
} from './dateRange';

// Sunday 11 Oct 2026, 14:30 local — fixed so every test is deterministic.
const NOW = new Date(2026, 9, 11, 14, 30, 0, 0);
const sel = (over: Partial<RangeSelection> = {}): RangeSelection => ({
  preset: '30d',
  from: null,
  to: null,
  compare: true,
  ...over,
});
const ymd = (d: Date) => toISODate(d);

describe('parseISODate / toISODate', () => {
  it('round-trips real dates and rejects impossible ones', () => {
    expect(ymd(parseISODate('2026-10-11') as Date)).toBe('2026-10-11');
    expect(parseISODate('2026-02-30')).toBeNull();
    expect(parseISODate('2026-13-01')).toBeNull();
    expect(parseISODate('10/11/2026')).toBeNull();
    expect(parseISODate('')).toBeNull();
    expect(parseISODate(null)).toBeNull();
  });
});

describe('resolveRange — presets', () => {
  it('today vs yesterday, full local days', () => {
    const r = resolveRange(sel({ preset: 'today' }), '30d', NOW);
    expect(ymd(r.start)).toBe('2026-10-11');
    expect(r.start.getHours()).toBe(0);
    expect(r.end.getHours()).toBe(23);
    expect(r.end.getMilliseconds()).toBe(999);
    expect(ymd(r.prevStart)).toBe('2026-10-10');
    expect(ymd(r.prevEnd)).toBe('2026-10-10');
    expect(r.days).toBe(1);
  });

  it('7d is 7 calendar days ending today, compared to the 7 before', () => {
    const r = resolveRange(sel({ preset: '7d' }), '30d', NOW);
    expect(ymd(r.start)).toBe('2026-10-05');
    expect(ymd(r.end)).toBe('2026-10-11');
    expect(ymd(r.prevStart)).toBe('2026-09-28');
    expect(ymd(r.prevEnd)).toBe('2026-10-04');
    expect(r.days).toBe(7);
    expect(r.prevDays).toBe(7);
  });

  it('30d and 90d have equal-length, adjacent, non-overlapping previous windows', () => {
    for (const [preset, n] of [
      ['30d', 30],
      ['90d', 90],
    ] as const) {
      const r = resolveRange(sel({ preset }), '30d', NOW);
      expect(r.days).toBe(n);
      expect(r.prevDays).toBe(n);
      expect(ymd(addDays(r.prevEnd, 1))).toBe(ymd(r.start));
    }
  });

  it('mtd compares the same elapsed days of the previous month', () => {
    const r = resolveRange(sel({ preset: 'mtd' }), '30d', NOW);
    expect(ymd(r.start)).toBe('2026-10-01');
    expect(ymd(r.end)).toBe('2026-10-11');
    expect(ymd(r.prevStart)).toBe('2026-09-01');
    expect(ymd(r.prevEnd)).toBe('2026-09-11');
    expect(r.prevDays).toBe(r.days);
  });

  it('mtd clamps to a shorter previous month (31 Mar vs February)', () => {
    const r = resolveRange(sel({ preset: 'mtd' }), '30d', new Date(2026, 2, 31, 9));
    expect(r.days).toBe(31);
    expect(ymd(r.prevStart)).toBe('2026-02-01');
    expect(ymd(r.prevEnd)).toBe('2026-02-28');
    expect(r.prevDays).toBe(28);
  });

  it('mtd on 1 January compares to 1 December (year wrap)', () => {
    const r = resolveRange(sel({ preset: 'mtd' }), '30d', new Date(2027, 0, 1, 8));
    expect(ymd(r.prevStart)).toBe('2026-12-01');
    expect(ymd(r.prevEnd)).toBe('2026-12-01');
  });

  it('qtd starts on the quarter boundary and compares equal elapsed days of the last quarter', () => {
    const r = resolveRange(sel({ preset: 'qtd' }), '30d', NOW);
    expect(ymd(r.start)).toBe('2026-10-01');
    expect(ymd(r.prevStart)).toBe('2026-07-01');
    expect(ymd(r.prevEnd)).toBe('2026-07-11');
  });

  it('qtd in Q1 wraps back to Q4 of the previous year', () => {
    const r = resolveRange(sel({ preset: 'qtd' }), '30d', new Date(2027, 1, 15, 10));
    expect(ymd(r.start)).toBe('2027-01-01');
    expect(ymd(r.prevStart)).toBe('2026-10-01');
    expect(r.prevDays).toBe(r.days);
  });

  it('custom uses the dates given and an equal-length preceding window', () => {
    const r = resolveRange(
      sel({ preset: 'custom', from: '2026-09-10', to: '2026-09-19' }),
      '30d',
      NOW,
    );
    expect(ymd(r.start)).toBe('2026-09-10');
    expect(ymd(r.end)).toBe('2026-09-19');
    expect(r.days).toBe(10);
    expect(ymd(r.prevStart)).toBe('2026-08-31');
    expect(ymd(r.prevEnd)).toBe('2026-09-09');
  });

  it('custom with invalid dates falls back to the page default instead of throwing', () => {
    const r = resolveRange(sel({ preset: 'custom', from: 'nope', to: null }), 'mtd', NOW);
    expect(r.preset).toBe('mtd');
  });

  it('is DST-safe: a 7-day window across a spring-forward still starts at local midnight', () => {
    const r = resolveRange(sel({ preset: '7d' }), '30d', new Date(2026, 2, 12, 12)); // US DST starts 8 Mar 2026
    expect(r.start.getHours()).toBe(0);
    expect(r.prevStart.getHours()).toBe(0);
    expect(r.days).toBe(7);
    expect(countDays(r.prevStart, r.prevEnd)).toBe(7);
  });
});

describe('validateCustomRange', () => {
  it('accepts a valid range', () => {
    expect(validateCustomRange('2026-09-01', '2026-09-30', NOW)).toEqual({
      ok: true,
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });
  it('clamps an end date in the future to today', () => {
    expect(validateCustomRange('2026-10-01', '2026-12-31', NOW)).toEqual({
      ok: true,
      from: '2026-10-01',
      to: '2026-10-11',
    });
  });
  it('rejects missing, reversed, future-start and over-long ranges', () => {
    expect(validateCustomRange('', '2026-09-30', NOW).ok).toBe(false);
    expect(validateCustomRange('2026-09-30', '2026-09-01', NOW).ok).toBe(false);
    expect(validateCustomRange('2026-11-01', '2026-11-05', NOW).ok).toBe(false);
    expect(validateCustomRange('2024-01-01', '2026-10-01', NOW).ok).toBe(false);
  });
});

describe('URL parse / serialize', () => {
  it('defaults when the URL has no params; compare is on by default', () => {
    expect(parseRangeParams(new URLSearchParams(), 'mtd', NOW)).toEqual(sel({ preset: 'mtd' }));
  });

  it('reads preset, compare=0 and custom dates', () => {
    expect(parseRangeParams(new URLSearchParams('range=7d&compare=0'), '30d', NOW)).toEqual(
      sel({ preset: '7d', compare: false }),
    );
    expect(
      parseRangeParams(
        new URLSearchParams('range=custom&from=2026-09-01&to=2026-09-30'),
        '30d',
        NOW,
      ),
    ).toEqual(sel({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' }));
  });

  it('ignores garbage: unknown preset, broken custom range', () => {
    expect(parseRangeParams(new URLSearchParams('range=forever'), '30d', NOW).preset).toBe('30d');
    expect(
      parseRangeParams(
        new URLSearchParams('range=custom&from=2026-09-30&to=2026-09-01'),
        '7d',
        NOW,
      ),
    ).toEqual(sel({ preset: '7d' }));
  });

  it('keeps URLs clean for defaults and preserves unrelated params', () => {
    const base = new URLSearchParams('tab=segments&job=abc&range=7d&compare=0');
    expect(serializeRangeParams(sel({ preset: '30d' }), base, '30d').toString()).toBe(
      'tab=segments&job=abc',
    );
    const out = serializeRangeParams(sel({ preset: 'qtd', compare: false }), base, '30d');
    expect(out.get('tab')).toBe('segments');
    expect(out.get('job')).toBe('abc');
    expect(out.get('range')).toBe('qtd');
    expect(out.get('compare')).toBe('0');
  });

  it('round-trips every selection', () => {
    const cases: RangeSelection[] = [
      sel({ preset: 'today' }),
      sel({ preset: 'mtd', compare: false }),
      sel({ preset: 'custom', from: '2026-08-01', to: '2026-08-15' }),
      sel({ preset: '30d' }),
    ];
    for (const c of cases) {
      const params = serializeRangeParams(c, new URLSearchParams(), '30d');
      expect(parseRangeParams(params, '30d', NOW)).toEqual(c);
    }
  });

  it('serializes the page default as no param, and a non-default as ?range=', () => {
    expect(
      serializeRangeParams(sel({ preset: 'mtd' }), new URLSearchParams(), 'mtd').toString(),
    ).toBe('');
    expect(
      serializeRangeParams(sel({ preset: '30d' }), new URLSearchParams(), 'mtd').get('range'),
    ).toBe('30d');
  });
});

describe('inRange', () => {
  const start = new Date(2026, 9, 1, 0, 0, 0, 0);
  const end = new Date(2026, 9, 11, 23, 59, 59, 999);
  it('is inclusive at both edges and false for null / invalid', () => {
    expect(inRange(start.toISOString(), start, end)).toBe(true);
    expect(inRange(end.toISOString(), start, end)).toBe(true);
    expect(inRange(new Date(start.getTime() - 1).toISOString(), start, end)).toBe(false);
    expect(inRange(new Date(end.getTime() + 1).toISOString(), start, end)).toBe(false);
    expect(inRange(null, start, end)).toBe(false);
    expect(inRange('not-a-date', start, end)).toBe(false);
  });
});

describe('computeDelta — percent', () => {
  it('computes and rounds relative change', () => {
    const d = computeDelta(150, 100);
    expect(d).toMatchObject({ direction: 'up', value: 50, sentiment: 'good' });
    expect(computeDelta(2, 3)).toMatchObject({ direction: 'down', value: -33.3, sentiment: 'bad' });
  });
  it('never divides by zero: previous 0 is "new", 0 → 0 is flat', () => {
    expect(computeDelta(5, 0)).toMatchObject({ direction: 'new', value: null, sentiment: 'good' });
    expect(computeDelta(0, 0)).toMatchObject({ direction: 'flat', value: 0, sentiment: 'neutral' });
    expect(computeDelta(0, 5)).toMatchObject({ direction: 'down', value: -100 });
  });
  it('treats equal values and sub-0.05% noise as flat', () => {
    expect(computeDelta(10, 10).direction).toBe('flat');
    expect(computeDelta(100000, 100001).direction).toBe('flat');
  });
  it('handles negative baselines (profit recovering from a loss is an improvement)', () => {
    expect(computeDelta(-50, -100)).toMatchObject({
      direction: 'up',
      value: 50,
      sentiment: 'good',
    });
    expect(computeDelta(-20, 0)).toMatchObject({ direction: 'new', sentiment: 'bad' });
  });
  it('polarity flips colour but not direction', () => {
    expect(computeDelta(8, 10, { polarity: 'lowerIsBetter' })).toMatchObject({
      direction: 'down',
      sentiment: 'good',
    });
    expect(computeDelta(12, 10, { polarity: 'lowerIsBetter' })).toMatchObject({
      direction: 'up',
      sentiment: 'bad',
    });
    expect(computeDelta(12, 10, { polarity: 'neutral' }).sentiment).toBe('neutral');
  });
  it('returns "none" for missing or non-finite inputs', () => {
    expect(computeDelta(null, 5).direction).toBe('none');
    expect(computeDelta(5, undefined).direction).toBe('none');
    expect(computeDelta(NaN, 5).direction).toBe('none');
    expect(computeDelta(5, Infinity).direction).toBe('none');
  });
});

describe('computeDelta — points', () => {
  it('uses absolute percentage-point change', () => {
    expect(computeDelta(45, 40, { kind: 'points' })).toMatchObject({
      direction: 'up',
      value: 5,
      sentiment: 'good',
    });
    expect(computeDelta(12, 20, { kind: 'points', polarity: 'lowerIsBetter' })).toMatchObject({
      direction: 'down',
      value: -8,
      sentiment: 'good',
    });
  });
  it('previous 0 is a real baseline for rates (no "new")', () => {
    expect(computeDelta(30, 0, { kind: 'points' })).toMatchObject({ direction: 'up', value: 30 });
  });
  it('flat within 0.05 points', () => {
    expect(computeDelta(40.02, 40, { kind: 'points' }).direction).toBe('flat');
  });
});

describe('formatDelta / describeDelta', () => {
  it('formats each direction', () => {
    expect(formatDelta(computeDelta(150, 100))).toBe('+50.0%');
    expect(formatDelta(computeDelta(50, 100))).toBe('−50.0%');
    expect(formatDelta(computeDelta(5, 0))).toBe('New');
    expect(formatDelta(computeDelta(5, 5))).toBe('0%');
    expect(formatDelta(computeDelta(null, 5))).toBe('—');
    expect(formatDelta(computeDelta(45, 40, { kind: 'points' }))).toBe('+5.0 pts');
    expect(formatDelta(computeDelta(5000, 1))).toBe('+999%+');
  });
  it('writes screen-reader sentences', () => {
    expect(describeDelta(computeDelta(150, 100), 'Sep 11 – Oct 10')).toBe(
      'Up 50.0% versus Sep 11 – Oct 10',
    );
    expect(describeDelta(computeDelta(45, 40, { kind: 'points' }))).toBe(
      'Up 5.0 percentage points versus the previous period',
    );
    expect(describeDelta(computeDelta(null, 1))).toBe('No data for the previous period');
  });
});

describe('bucketCounts', () => {
  const start = new Date(2026, 9, 1);
  const end = new Date(2026, 9, 5, 23, 59, 59, 999);
  it('zero-fills every day and counts items on the right day', () => {
    const items = [
      { at: new Date(2026, 9, 1, 0, 0, 0).toISOString() },
      { at: new Date(2026, 9, 1, 23, 59, 59).toISOString() },
      { at: new Date(2026, 9, 3, 12).toISOString() },
      { at: new Date(2026, 9, 5, 23, 59, 59, 999).toISOString() },
      { at: new Date(2026, 8, 30, 23, 59).toISOString() }, // before range
      { at: new Date(2026, 9, 6, 0, 0).toISOString() }, // after range
      { at: null },
    ];
    const { points, bucketDays } = bucketCounts(items, (i) => i.at, start, end);
    expect(bucketDays).toBe(1);
    expect(points.map((p) => p.count)).toEqual([2, 0, 1, 0, 1]);
  });
  it('switches to weekly buckets for long ranges and still counts every item once', () => {
    const longEnd = new Date(2027, 0, 10, 23, 59, 59, 999); // ~102 days
    const items = Array.from({ length: 50 }, (_, i) => ({
      at: addDays(start, i * 2).toISOString(),
    }));
    const { points, bucketDays } = bucketCounts(items, (i) => i.at, start, longEnd);
    expect(bucketDays).toBe(7);
    expect(points.reduce((s, p) => s + p.count, 0)).toBe(50);
    expect(points.length).toBe(Math.ceil(countDays(start, longEnd) / 7));
  });
});
