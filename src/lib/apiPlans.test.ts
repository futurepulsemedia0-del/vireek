import { describe, expect, it } from 'vitest';
import { formatCents, hardLimit, overageCostCents, parsePlanUsage, projectMonthEnd, quotaStatus } from './apiPlans';

const block = { monthly_quota: 10_000, overage_policy: 'block' as const, max_overage_pct: 0 };
const meter = { monthly_quota: 250_000, overage_policy: 'meter' as const, max_overage_pct: 50 };

describe('overageCostCents (mirrors api_overage_cost_cents)', () => {
  it('charges each started block of 1,000', () => {
    expect(overageCostCents(0, 30)).toBe(0);
    expect(overageCostCents(1, 30)).toBe(30);
    expect(overageCostCents(1000, 30)).toBe(30);
    expect(overageCostCents(1001, 30)).toBe(60);
    expect(overageCostCents(125_000, 30)).toBe(3750);
  });
  it('is zero for negative input or a free rate', () => {
    expect(overageCostCents(-5, 30)).toBe(0);
    expect(overageCostCents(5000, 0)).toBe(0);
  });
});

describe('hardLimit / quotaStatus', () => {
  it('unlimited plans never warn or block', () => {
    const s = quotaStatus(9_999_999, { monthly_quota: null, overage_policy: 'block', max_overage_pct: 0 });
    expect(s.state).toBe('unlimited');
    expect(s.hardLimit).toBeNull();
  });
  it('block plan: ok -> warning at 80% -> blocked at 100%', () => {
    expect(quotaStatus(7_999, block).state).toBe('ok');
    expect(quotaStatus(8_000, block).state).toBe('warning');
    expect(quotaStatus(9_999, block).remaining).toBe(1);
    expect(quotaStatus(10_000, block).state).toBe('blocked');
    expect(hardLimit(block)).toBe(10_000);
  });
  it('meter plan: over quota is allowed until the hard cap', () => {
    expect(hardLimit(meter)).toBe(375_000);
    expect(quotaStatus(250_000, meter).state).toBe('over_quota');
    expect(quotaStatus(300_000, meter)).toMatchObject({ state: 'over_quota', overage: 50_000, remaining: 0 });
    expect(quotaStatus(375_000, meter).state).toBe('blocked');
  });
  it('caps the bar at 100% and ignores negative usage', () => {
    expect(quotaStatus(900_000, meter).pctUsed).toBe(100);
    expect(quotaStatus(-3, block)).toMatchObject({ pctUsed: 0, remaining: 10_000 });
  });
});

describe('projectMonthEnd', () => {
  it('projects linearly inside the period', () => {
    expect(projectMonthEnd(1000, '2029-03-01', '2029-04-01', new Date('2029-03-16T12:00:00Z'))).toBe(Math.round(1000 * (31 / 15.5)));
  });
  it('returns null outside the period or with too little elapsed time', () => {
    expect(projectMonthEnd(1000, '2029-03-01', '2029-04-01', new Date('2029-04-02T00:00:00Z'))).toBeNull();
    expect(projectMonthEnd(1000, '2029-03-01', '2029-04-01', new Date('2029-02-28T00:00:00Z'))).toBeNull();
    expect(projectMonthEnd(10, '2029-03-01', '2029-04-01', new Date('2029-03-01T02:00:00Z'))).toBeNull();
    expect(projectMonthEnd(10, 'garbage', '2029-04-01', new Date('2029-03-10T00:00:00Z'))).toBeNull();
  });
});

describe('parsePlanUsage', () => {
  const good = {
    enabled: true, assigned: false,
    plan: { slug: 'growth', name: 'Growth', rate_limit_per_minute: 300, monthly_quota: 250000, overage_policy: 'meter', overage_cents_per_1000: 30, max_overage_pct: 50, is_proposed: true },
    period: '2029-03', period_start: '2029-03-01', period_end: '2029-04-01', total_requests: 12, keys: [{ key_id: 'k1', requests: 12 }], overage_requests: 0, estimated_overage_cents: 0,
  };
  it('parses a well-formed payload', () => {
    const p = parsePlanUsage(good);
    expect(p.plan?.monthly_quota).toBe(250000);
    expect(p.keys).toHaveLength(1);
    expect(p.enabled).toBe(true);
  });
  it('keeps null quota as unlimited and tolerates a missing plan', () => {
    expect(parsePlanUsage({ ...good, plan: { ...good.plan, monthly_quota: null } }).plan?.monthly_quota).toBeNull();
    expect(parsePlanUsage({ ...good, plan: null }).plan).toBeNull();
  });
  it('drops malformed key rows and rejects unusable payloads', () => {
    expect(parsePlanUsage({ ...good, keys: [{ key_id: 1 }, null, { key_id: 'k2', requests: 'x' }] }).keys).toEqual([{ key_id: 'k2', requests: 0 }]);
    expect(() => parsePlanUsage(null)).toThrow();
    expect(() => parsePlanUsage({ period: 3 })).toThrow();
  });
});

describe('formatCents', () => {
  it('formats USD', () => {
    expect(formatCents(3750, 'en')).toBe('$37.50');
  });
});
