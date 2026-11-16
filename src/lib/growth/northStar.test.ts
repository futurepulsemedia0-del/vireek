import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE } from '@/lib/growth/growthMetrics';
import { buildNorthStarTree, isPartialWeek, NORTH_STAR_WINDOW_WEEKS, parseNorthStar, ratioMetric, type NorthStarWeek } from '@/lib/growth/northStar';

const wk = (weekStart: string, o: Partial<NorthStarWeek> = {}): NorthStarWeek => ({
  weekStart, callsN: 0, bookedCallsN: 0, jobsN: 0, keptN: 0, resolvedN: 0, pendingN: 0, accountsWithCallsN: 0, activeAccountsN: 0, paidCents: 0, ...o,
});

// Wednesday 2026-11-11 (UTC): week of 2026-11-09 is partial; 2026-11-02 and earlier are complete.
const NOW = new Date('2026-11-11T12:00:00Z');

describe('parseNorthStar', () => {
  it('returns safe empties for garbage input', () => {
    const r = parseNorthStar(null);
    expect(r.weeks).toEqual([]);
    expect(r.generatedAt).toBeNull();
    expect(r.dataQuality.callsQualifying90d).toBe(0);
  });

  it('drops rows with a bad week_start, coerces numeric strings, zeroes negatives/NaN, sorts newest first', () => {
    const r = parseNorthStar({
      generated_at: '2026-11-11T10:00:00Z',
      weeks: [
        { week_start: '2026-10-26', calls_n: '40', kept_n: -3, jobs_n: 'x' },
        { week_start: 'nope', calls_n: 99 },
        { week_start: '2026-11-02', calls_n: 10, booked_calls_n: 4 },
      ],
      data_quality: { calls_with_answer_ms_90d: 0, calls_all_sources_90d: 12 },
    });
    expect(r.weeks.map((w) => w.weekStart)).toEqual(['2026-11-02', '2026-10-26']);
    expect(r.weeks[1]).toMatchObject({ callsN: 40, keptN: 0, jobsN: 0 });
    expect(r.dataQuality.callsAllSources90d).toBe(12);
    expect(r.generatedAt).toBeInstanceOf(Date);
  });
});

describe('ratioMetric', () => {
  it('is null (never 0) without a denominator', () => {
    for (const den of [0, -1, Number.NaN]) {
      const m = ratioMetric(5, den, 'why');
      expect(m.value).toBeNull();
      expect(m.status).toBe('insufficient');
      expect(m.reason).toBe('why');
    }
  });

  it('flags low sample below the shared minimum and is ok at it', () => {
    expect(ratioMetric(1, MIN_SAMPLE - 1, 'r').status).toBe('low_sample');
    const ok = ratioMetric(MIN_SAMPLE / 2, MIN_SAMPLE, 'r');
    expect(ok.status).toBe('ok');
    expect(ok.value).toBeCloseTo(0.5);
    expect(ok.n).toBe(MIN_SAMPLE);
  });

  it('clamps to 0..1 so a data glitch cannot show >100%', () => {
    expect(ratioMetric(500, 100, 'r').value).toBe(1);
  });
});

describe('isPartialWeek', () => {
  it('is partial until the 7 days have fully elapsed', () => {
    expect(isPartialWeek('2026-11-09', NOW)).toBe(true);
    expect(isPartialWeek('2026-11-02', NOW)).toBe(false);
    expect(isPartialWeek('2026-11-02', new Date('2026-11-09T00:00:00Z'))).toBe(false);
    expect(isPartialWeek('2026-11-02', new Date('2026-11-08T23:59:59Z'))).toBe(true);
  });
  it('treats an unparsable date as partial (never counted)', () => {
    expect(isPartialWeek('garbage', NOW)).toBe(true);
  });
});

describe('buildNorthStarTree', () => {
  const weeks = [
    wk('2026-11-09', { callsN: 5, bookedCallsN: 5, keptN: 99 }), // partial: must be ignored
    wk('2026-11-02', { callsN: 100, bookedCallsN: 40, jobsN: 42, keptN: 20, resolvedN: 30, pendingN: 12, accountsWithCallsN: 8, activeAccountsN: 6, paidCents: 50_000 }),
    wk('2026-10-26', { callsN: 80, bookedCallsN: 30, jobsN: 31, keptN: 25, resolvedN: 30, pendingN: 1, accountsWithCallsN: 7, activeAccountsN: 5, paidCents: 70_000 }),
    wk('2026-10-19', { callsN: 10 }),
    wk('2026-10-12', { callsN: 10 }),
    wk('2026-10-05', { callsN: 1000, keptN: 1000 }), // older than the window: must be ignored
  ];

  it('sums only the most recent complete weeks and ignores the partial one', () => {
    const t = buildNorthStarTree(weeks, NOW);
    expect(t.windowWeeks).toEqual(['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12']);
    expect(t.windowWeeks).toHaveLength(NORTH_STAR_WINDOW_WEEKS);
    expect(t.keptN).toBe(45);
    expect(t.pendingN).toBe(13);
    expect(t.callsN).toBe(200);
    expect(t.paidCents).toBe(120_000);
  });

  it('computes ratios as ratio of sums with the denominator as n', () => {
    const t = buildNorthStarTree(weeks, NOW);
    expect(t.bookingRate.value).toBeCloseTo(70 / 200);
    expect(t.bookingRate.n).toBe(200);
    expect(t.keepRate.value).toBeCloseTo(45 / 60);
    expect(t.keepRate.n).toBe(60);
  });

  it('takes breadth from the latest complete week only', () => {
    const t = buildNorthStarTree(weeks, NOW);
    expect(t.breadth).toMatchObject({ weekStart: '2026-11-02', activeAccountsN: 6, accountsWithCallsN: 8 });
    expect(t.breadth?.reach.value).toBeCloseTo(6 / 8);
  });

  it('shows no data as null/zero-count with a reason, not as a 0% rate', () => {
    const t = buildNorthStarTree([], NOW);
    expect(t.keptN).toBe(0);
    expect(t.bookingRate.value).toBeNull();
    expect(t.keepRate.value).toBeNull();
    expect(t.breadth).toBeNull();
  });

  it('keeps the tree identity kept = calls x booking x (kept/booked jobs) when nothing is pending', () => {
    const settled = [wk('2026-11-02', { callsN: 100, bookedCallsN: 40, jobsN: 40, keptN: 30, resolvedN: 40, pendingN: 0 })];
    const t = buildNorthStarTree(settled, NOW);
    const jobsPerBookedCall = 40 / 40;
    const keptPerJob = 30 / 40;
    expect(t.callsN * (t.bookingRate.value ?? 0) * jobsPerBookedCall * keptPerJob).toBeCloseTo(t.keptN);
  });
});
