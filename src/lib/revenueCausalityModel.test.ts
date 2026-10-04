import { describe, it, expect } from 'vitest';
import {
  RESPONSE_BUCKETS, buildRevenueCausalityGraph, estimateExposure, normalizeRcgData, runScenario,
  simulateTarget, simulateUnanswered, type Bucket, type RcgData,
} from './revenueCausalityModel';

const mk = (rows: Array<[number, number]>): Bucket[] =>
  RESPONSE_BUCKETS.map((d, i) => ({ ...d, n: rows[i]?.[0] ?? 0, wins: rows[i]?.[1] ?? 0 }));

// fast = 60% win, slow = 20% win
const BUCKETS = mk([[40, 24], [20, 11], [30, 9], [30, 6], [20, 3]]);

describe('simulateTarget', () => {
  it('finds positive exposure when slower buckets convert worse', () => {
    const s = simulateTarget(BUCKETS, 0.5);
    expect(s.reference?.fallback).toBe(false);
    expect(s.wins.expected).toBeGreaterThan(10);
    expect(s.wins.low).toBeLessThanOrEqual(s.wins.expected);
    expect(s.wins.high).toBeGreaterThanOrEqual(s.wins.expected);
  });
  it('a stricter target never yields less upside than a looser one', () => {
    const tight = simulateTarget(BUCKETS, 0.5).wins.expected;
    const loose = simulateTarget(BUCKETS, 4).wins.expected;
    expect(tight).toBeGreaterThanOrEqual(loose);
  });
  it('reach scales linearly', () => {
    const full = simulateTarget(BUCKETS, 1, 1).wins.expected;
    const half = simulateTarget(BUCKETS, 1, 0.5).wins.expected;
    expect(half).toBeCloseTo(full / 2, 6);
  });
  it('never returns negative upside when speed does not matter', () => {
    const flat = mk([[30, 9], [30, 9], [30, 9], [30, 9], [30, 9]]);
    expect(simulateTarget(flat, 0.5).wins.expected).toBeLessThan(1.5);
    expect(simulateTarget(flat, 0.5).wins.low).toBeGreaterThanOrEqual(0);
  });
  it('falls back (and flags it) when the fast bucket is thin', () => {
    const thin = mk([[2, 2], [3, 2], [30, 9], [30, 6], [20, 3]]);
    const s = simulateTarget(thin, 0.5);
    expect(s.reference?.fallback).toBe(true);
    expect(s.confidence).toBe('low');
  });
  it('returns an empty simulation with no data', () => {
    const s = simulateTarget(mk([]), 0.5);
    expect(s.reference).toBeNull();
    expect(s.wins.expected).toBe(0);
  });
});

describe('estimateExposure / unanswered', () => {
  it('exposure equals simulating against the best evidenced speed', () => {
    expect(estimateExposure(BUCKETS).wins.expected).toBeGreaterThan(0);
  });
  it('unanswered opportunities cost more when the touched baseline is strong', () => {
    const s = simulateUnanswered(BUCKETS, 30, 0);
    expect(s.wins.expected).toBeGreaterThan(5);
  });
  it('is zero without enough touched history', () => {
    expect(simulateUnanswered(mk([[2, 1]]), 30, 0).wins.expected).toBe(0);
  });
});

const DATA: RcgData = {
  window_days: 180, computed_at: null, avg_job_value: 800, ltv_multiplier: 2.5,
  response: {
    buckets: [
      { key: 'lt_30m', n: 40, wins: 24 }, { key: '30m_1h', n: 20, wins: 11 }, { key: '1h_4h', n: 30, wins: 9 },
      { key: '4h_24h', n: 30, wins: 6 }, { key: 'gte_24h', n: 20, wins: 3 }, { key: 'never', n: 25, wins: 1 },
    ],
    missed_total: 60, missed_unrecovered: 25,
  },
  quotes: {
    buckets: [
      { key: 'lt_4h', n: 30, wins: 20, accepted_value: 24000, value_all: 36000 },
      { key: '4h_24h', n: 30, wins: 15, accepted_value: 12000, value_all: 24000 },
      { key: '24h_72h', n: 20, wins: 6, accepted_value: 4800, value_all: 16000 },
      { key: 'gte_72h', n: 20, wins: 4, accepted_value: 3200, value_all: 16000 },
    ],
    accepted: 45, declined: 35, expired: 20, lost_value: 44000, avg_value: 900,
    median_response_hours: 30, top_decline_reasons: [{ reason: 'Price', count: 18, value: 20000 }],
  },
  lost_leads: 40,
};

describe('buildRevenueCausalityGraph', () => {
  const g = buildRevenueCausalityGraph(DATA);
  it('is ready and builds the 6-node chain with 5 edges', () => {
    expect(g.ready).toBe(true);
    expect(g.nodes.map((n) => n.id)).toEqual(['missed_call', 'delayed_response', 'quote_delay', 'hesitation', 'lost_job', 'lost_ltv']);
    expect(g.edges).toHaveLength(5);
  });
  it('totals equal the sum of the estimated stages and LTV is reported', () => {
    const est = g.edges.filter((e) => e.kind === 'estimated').reduce((s, e) => s + (e.usd?.expected ?? 0), 0);
    expect(g.totals?.revenue.expected).toBeCloseTo(est, 6);
    expect(g.totals?.ltv?.expected).toBeGreaterThan(0);
  });
  it('writes the headline sentence', () => {
    expect(g.narrative.some((s) => s.startsWith('Response latency generated $'))).toBe(true);
  });
  it('hides dollars (not the structure) when there is no job value', () => {
    const g2 = buildRevenueCausalityGraph({ ...DATA, avg_job_value: null, quotes: { ...DATA.quotes, avg_value: null } });
    expect(g2.totals).toBeNull();
    expect(g2.edges[1].usd).toBeNull();
  });
  it('is not ready on an empty account', () => {
    const empty = normalizeRcgData({ response: { buckets: [] }, quotes: { buckets: [] } })!;
    expect(buildRevenueCausalityGraph(empty).ready).toBe(false);
  });
});

describe('runScenario', () => {
  it('answers "what if we respond within 30 minutes?"', () => {
    const r = runScenario(BUCKETS, 0.5, 0.8, 800, 2.5);
    expect(r.revenue!.expected).toBeGreaterThan(0);
    expect(r.ltv!.expected).toBeCloseTo(r.revenue!.expected * 1.5, 6);
    expect(r.evidence).toMatch(/Based on 40 opportunities/);
  });
});

describe('normalizeRcgData', () => {
  it('rejects junk and coerces string numerics', () => {
    expect(normalizeRcgData(null)).toBeNull();
    expect(normalizeRcgData({ avg_job_value: '812.5' })!.avg_job_value).toBe(812.5);
  });
});
