import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RULES,
  alertDetail,
  buildBars,
  errorRate,
  formatMs,
  formatPct,
  formatRelative,
  friendlyUsageError,
  keyHealth,
  toRules,
  toSummaryRow,
  totals,
  validateRules,
  type Breach,
  type UsageSummaryRow,
} from './apiUsage';

const row = (over: Partial<UsageSummaryRow> = {}): UsageSummaryRow => ({
  key_id: 'k1', requests: 100, ok: 90, client_errors: 6, server_errors: 4, rate_limited: 0, p50_ms: 80, p95_ms: 400, last_request_at: null, ...over,
});
const breach = (over: Partial<Breach> = {}): Breach => ({ key_id: 'k1', kind: 'error_rate', value: 12, threshold: 10, requests: 100, window_minutes: 60, ...over });

describe('coercion', () => {
  it('coerces Postgres bigint/numeric strings', () => {
    const r = toSummaryRow({ key_id: 'k', requests: '12', ok: '10', client_errors: '1', server_errors: '1', rate_limited: '0', p50_ms: '40', p95_ms: null, last_request_at: null });
    expect(r.requests).toBe(12);
    expect(r.p95_ms).toBeNull();
  });
  it('falls back to defaults for missing rules', () => {
    expect(toRules(null)).toEqual(DEFAULT_RULES);
    expect(toRules({ enabled: false, error_rate_pct: '25.00' }).error_rate_pct).toBe(25);
    expect(toRules({ enabled: false }).enabled).toBe(false);
  });
});

describe('metrics', () => {
  it('computes error rate and handles no traffic', () => {
    expect(errorRate(row())).toBeCloseTo(0.1);
    expect(errorRate(row({ requests: 0, client_errors: 0, server_errors: 0 }))).toBeNull();
  });
  it('aggregates totals with worst p95', () => {
    const t = totals([row(), row({ key_id: 'k2', requests: 50, client_errors: 0, server_errors: 0, rate_limited: 3, p95_ms: 900 })]);
    expect(t).toMatchObject({ requests: 150, errors: 10, rateLimited: 3, worstP95: 900 });
    expect(totals([]).errorRate).toBeNull();
  });
  it('derives key health from live breaches', () => {
    expect(keyHealth(undefined, [])).toBe('idle');
    expect(keyHealth(row({ requests: 0 }), [])).toBe('idle');
    expect(keyHealth(row(), [])).toBe('healthy');
    expect(keyHealth(row(), [breach({ kind: 'latency', value: 3000, threshold: 2000 })])).toBe('warning');
    expect(keyHealth(row(), [breach({ value: 25 })])).toBe('critical');
    expect(keyHealth(row(), [breach({ key_id: 'other' })])).toBe('healthy');
  });
});

describe('formatting', () => {
  it('formats percentages and latency', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(0.0004)).toBe('<0.1%');
    expect(formatPct(0.052)).toBe('5.2%');
    expect(formatPct(0.5)).toBe('50%');
    expect(formatMs(null)).toBe('—');
    expect(formatMs(412.4)).toBe('412 ms');
    expect(formatMs(2350)).toBe('2.4 s');
  });
  it('formats relative time', () => {
    const now = new Date('2027-05-01T12:00:00Z').getTime();
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative('2027-05-01T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2027-05-01T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelative('2027-05-01T08:00:00Z', now)).toBe('4 h ago');
    expect(formatRelative('2027-04-29T12:00:00Z', now)).toBe('2 d ago');
  });
  it('describes alerts', () => {
    expect(alertDetail(breach())).toBe('12% of requests failed in the last 1 h (threshold 10%).');
    expect(alertDetail(breach({ kind: 'latency', value: 2500, threshold: 2000, window_minutes: 45 }))).toBe('p95 latency 2.5 s in the last 45 min (threshold 2.0 s).');
    expect(alertDetail(breach({ kind: 'rate_limit', value: 14, threshold: 10 }))).toContain('14 requests were rate limited');
  });
});

describe('buildBars', () => {
  it('scales to the max and splits ok / error / rate-limited', () => {
    const { bars, max } = buildBars([
      { bucket: 'a', requests: 100, errors: 20, rate_limited: 10, p95_ms: 1 },
      { bucket: 'b', requests: 50, errors: 0, rate_limited: 0, p95_ms: null },
      { bucket: 'c', requests: 0, errors: 0, rate_limited: 0, p95_ms: null },
    ], 300, 100);
    expect(max).toBe(100);
    expect(bars[0].okH + bars[0].errH + bars[0].rlH).toBeCloseTo(100);
    expect(bars[0].errH).toBeCloseTo(20);
    expect(bars[1].okH).toBeCloseTo(50);
    expect(bars[2].okH).toBe(0);
  });
  it('never divides by zero on empty data', () => {
    expect(buildBars([], 300, 100)).toEqual({ bars: [], max: 1 });
  });
});

describe('validateRules', () => {
  it('accepts defaults', () => {
    expect(validateRules(DEFAULT_RULES)).toEqual({});
  });
  it('flags out-of-range and non-numeric values', () => {
    const e = validateRules({ ...DEFAULT_RULES, window_minutes: 5, error_rate_pct: 0, p95_latency_ms: NaN, min_requests: 2.5, rate_limit_hits: 0 });
    expect(Object.keys(e).sort()).toEqual(['error_rate_pct', 'min_requests', 'p95_latency_ms', 'rate_limit_hits', 'window_minutes']);
  });
});

describe('friendlyUsageError', () => {
  it('maps forbidden errors', () => {
    expect(friendlyUsageError(new Error('API_USAGE_FORBIDDEN'))).toContain('account owner');
    expect(friendlyUsageError({ message: 'violates row-level security' })).toContain('account owner');
    expect(friendlyUsageError(new Error('x'), 'fb')).toBe('fb');
  });
});
