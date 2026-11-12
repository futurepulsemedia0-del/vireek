import { describe, it, expect } from 'vitest';
import { PRICING_PLANS, parseOverageRate } from '@/lib/pricing';
import {
  annualSavings,
  describeSuggestion,
  estimateOverageUsd,
  extraCompareValue,
  findPlan,
  formatPeriodRange,
  getBannerContent,
  getBillingPeriod,
  getLimitPolicy,
  getUsageSnapshot,
  parseLimit,
  planCardNote,
  planMonthlyPrice,
  projectMonthEndMinutes,
  suggestUpgrade,
  trialDays,
} from './usageLimits';

const plan = (id: string) => PRICING_PLANS.find((p) => p.id === id)!;
const MID_MONTH = new Date(2026, 10, 15); // Nov 15: 30-day month, 15 days elapsed

describe('getUsageSnapshot', () => {
  it('flags warning from 80% and limit at 100% of included + bonus', () => {
    const lv = (used: number, bonus = 0) => getUsageSnapshot({ minutesUsed: used, minutesIncluded: 400, bonusMinutes: bonus }).level;
    expect(lv(319)).toBe('ok');
    expect(lv(320)).toBe('warning');
    expect(lv(399)).toBe('warning');
    expect(lv(400)).toBe('limit');
    expect(lv(1000)).toBe('limit');
    // bonus extends the allowance: 400 used of 400 + 100 is 80%, not 100%
    expect(lv(400, 100)).toBe('warning');
    expect(lv(500, 100)).toBe('limit');
  });

  it('computes capacity, remaining and overage (bonus is consumed before overage)', () => {
    const s = getUsageSnapshot({ minutesUsed: 530, minutesIncluded: 400, bonusMinutes: 100 });
    expect(s.capacity).toBe(500);
    expect(s.remaining).toBe(0);
    expect(s.overageMinutes).toBe(30);
  });

  it('treats included <= 0 as unlimited and never alerts', () => {
    const s = getUsageSnapshot({ minutesUsed: 99999, minutesIncluded: 0, bonusMinutes: 50 });
    expect(s).toMatchObject({ unlimited: true, level: 'ok', capacity: 0, remaining: null, overageMinutes: 0 });
  });

  it('is defensive against null / NaN / negative / non-numeric input', () => {
    const s = getUsageSnapshot({ minutesUsed: null, minutesIncluded: Number.NaN, bonusMinutes: -5 });
    expect(s.unlimited).toBe(true);
    const t = getUsageSnapshot({ minutesUsed: '12', minutesIncluded: 400, bonusMinutes: undefined });
    expect(t.used).toBe(0);
    expect(t.bonus).toBe(0);
  });
});

describe('getLimitPolicy', () => {
  const snap = (included: number) => getUsageSnapshot({ minutesUsed: 0, minutesIncluded: included });
  it('maps plans to policies from pricing data', () => {
    expect(getLimitPolicy(plan('free'), snap(50))).toBe('block');
    for (const id of ['starter', 'professional', 'business']) expect(getLimitPolicy(plan(id), snap(100))).toBe('bill');
    expect(getLimitPolicy(plan('enterprise'), snap(0))).toBe('unlimited');
    expect(getLimitPolicy(plan('enterprise'), snap(500))).toBe('unlimited');
    expect(getLimitPolicy(undefined, snap(100))).toBe('unlimited');
  });
});

describe('getBannerContent', () => {
  const content = (planId: string, used: number, bonus = 0) => {
    const p = plan(planId);
    const snap = getUsageSnapshot({ minutesUsed: used, minutesIncluded: planId === 'free' ? 50 : parseInt(p.minutes.replace(/\D/g, ''), 10), bonusMinutes: bonus });
    return getBannerContent({ snap, policy: getLimitPolicy(p, snap), rate: parseOverageRate(p.overage), planName: p.name, assistantName: 'Sarah' });
  };

  it('returns null below 80% and for unlimited', () => {
    expect(content('starter', 100)).toBeNull();
    expect(content('enterprise', 100)).toBeNull();
  });

  it('bill policy reads the rate from the plan data (every metered plan)', () => {
    for (const id of ['starter', 'professional', 'business']) {
      const rate = parseOverageRate(plan(id).overage)!;
      const included = parseInt(plan(id).minutes.replace(/\D/g, ''), 10);
      const warn = content(id, Math.ceil(included * 0.85))!;
      expect(warn.tone).toBe('warning');
      expect(warn.dismissible).toBe(true);
      expect(warn.body).toContain(`Extra minutes cost $${rate.toFixed(2)}/min`);
      const limit = content(id, included + 10)!;
      expect(limit.body).toContain(`$${rate.toFixed(2)}/min`);
      expect(limit.body).toContain(`$${(10 * rate).toFixed(2)} in overage`);
    }
  });

  it('block policy never claims emergency forwarding and cannot be dismissed at the limit', () => {
    const warn = content('free', 42)!;
    expect(warn.body).toContain('Voice answering pauses at the limit');
    const limit = content('free', 50)!;
    expect(limit.tone).toBe('danger');
    expect(limit.dismissible).toBe(false);
    expect(limit.title).toContain('Sarah has paused answering');
    for (const c of [warn, limit]) expect(`${c.title} ${c.body}`.toLowerCase()).not.toContain('emergenc');
  });

  it('mentions bonus minutes when present', () => {
    expect(content('starter', 420, 100)!.title).toContain('includes 100 bonus');
  });
});

describe('billing period + projection', () => {
  it('returns calendar-month bounds', () => {
    const p = getBillingPeriod(MID_MONTH);
    expect(p.daysInMonth).toBe(30);
    expect(p.daysLeft).toBe(15);
    expect(formatPeriodRange(p.start, p.end)).toBe('Nov 1 – Nov 30, 2026');
  });
  it('projects linearly', () => {
    expect(projectMonthEndMinutes(150, 15, 30)).toBe(300);
    expect(projectMonthEndMinutes(10, 0, 30)).toBe(10);
  });
  it('rounds overage to cents without float noise', () => {
    expect(estimateOverageUsd(3, 0.15)).toBe(0.45);
    expect(estimateOverageUsd(0, 0.2)).toBe(0);
    expect(estimateOverageUsd(10, null)).toBe(0);
  });
});

describe('plan helpers', () => {
  it('annual savings equal exactly 2 months for every paid plan', () => {
    for (const id of ['starter', 'professional', 'business']) {
      const p = plan(id);
      expect(annualSavings(p)).toEqual({ amount: p.monthly! * 2, monthsFree: 2 });
    }
    expect(annualSavings(plan('free'))).toBeNull();
    expect(annualSavings(plan('enterprise'))).toBeNull();
  });
  it('reads trial days from the plan CTA and formats compare rows', () => {
    expect(trialDays(plan('starter'))).toBe(14);
    expect(trialDays(plan('free'))).toBeNull();
    expect(extraCompareValue(plan('starter'), 'trial')).toBe('14-day trial');
    expect(extraCompareValue(plan('free'), 'trial')).toBe('—');
    expect(extraCompareValue(plan('starter'), 'annual')).toBe('$790/yr · save $158 (2 months free)');
    expect(extraCompareValue(plan('enterprise'), 'annual')).toBe('Custom');
    expect(planCardNote(plan('business'))).toBe('14-day trial · Annual: save $798 (2 months free)');
    expect(planCardNote(plan('free'))).toBe('');
  });
  it('parses limits from plan text', () => {
    expect(parseLimit('1 seat')).toBe(1);
    expect(parseLimit('Up to 3 locations')).toBe(3);
    expect(parseLimit('Unlimited seats')).toBeNull();
  });
  it('prices: enterprise falls back to its starting price', () => {
    expect(planMonthlyPrice(plan('starter'))).toBe(79);
    expect(planMonthlyPrice(plan('enterprise'))).toBe(999);
  });
  it('findPlan returns undefined for unknown ids', () => {
    expect(findPlan('nope')).toBeUndefined();
    expect(findPlan(null)).toBeUndefined();
  });
});

describe('suggestUpgrade', () => {
  const s = (planId: string, used: number, included: number, extra: Partial<Parameters<typeof suggestUpgrade>[0]> = {}) =>
    suggestUpgrade({ planId, minutesUsed: used, minutesIncluded: included, now: MID_MONTH, ...extra });

  it('Free (blocked): suggests Starter only when the projection exceeds the allowance', () => {
    expect(s('free', 10, 50)).toMatchObject({ suggest: false, targetPlanId: 'starter' });
    expect(s('free', 25, 50).suggest).toBe(false); // projects exactly 50: not over
    expect(s('free', 30, 50)).toMatchObject({ suggest: true, reason: 'would_be_blocked', targetPlanId: 'starter', projectedMinutes: 60 });
  });

  it('Starter -> Professional at the exact break-even (79 + overage >= 199)', () => {
    expect(s('starter', 500, 400)).toMatchObject({ suggest: true, reason: 'overage_cost', targetPlanId: 'professional', projectedCostUsd: 199 });
    expect(s('starter', 499, 400).suggest).toBe(false); // $198.60 < $199
    expect(s('starter', 300, 400).suggest).toBe(false); // overage, but cheaper than upgrading: do not nag
  });

  it('Professional -> Business at break-even (199 + overage >= 399)', () => {
    expect(s('professional', 1417, 1500)).toMatchObject({ suggest: true, targetPlanId: 'business' });
    expect(s('professional', 1416, 1500).suggest).toBe(false);
  });

  it('Business -> Enterprise uses the "from" price (399 + overage >= 999)', () => {
    expect(s('business', 4500, 4000)).toMatchObject({ suggest: true, targetPlanId: 'enterprise', targetPriceUsd: 999 });
    expect(s('business', 4499, 4000).suggest).toBe(false);
  });

  it('never suggests for Enterprise, unlimited, unknown plans', () => {
    expect(s('enterprise', 99999, 0).suggest).toBe(false);
    expect(s('starter', 99999, 0).suggest).toBe(false);
    expect(s('mystery', 99999, 400).suggest).toBe(false);
    expect(s(null as unknown as string, 5, 400).suggest).toBe(false);
  });

  it('bonus minutes raise the allowance used for the projection', () => {
    expect(s('starter', 500, 400, { bonusMinutes: 100 }).suggest).toBe(false); // $179 < $199
  });

  it('ignores a noisy projection in the first days of the month, but not an exhausted Free allowance', () => {
    const day2 = new Date(2026, 10, 2);
    expect(suggestUpgrade({ planId: 'starter', minutesUsed: 100, minutesIncluded: 400, now: day2 }).suggest).toBe(false);
    expect(suggestUpgrade({ planId: 'free', minutesUsed: 20, minutesIncluded: 50, now: day2 }).suggest).toBe(false);
    expect(suggestUpgrade({ planId: 'free', minutesUsed: 55, minutesIncluded: 50, now: new Date(2026, 10, 1) })).toMatchObject({ suggest: true, reason: 'would_be_blocked' });
  });

  it('describeSuggestion is null unless suggesting, and mentions real plan data', () => {
    expect(describeSuggestion(s('starter', 100, 400))).toBeNull();
    const d = describeSuggestion(s('starter', 500, 400))!;
    expect(d.title).toContain('Professional');
    expect(d.body).toContain('$199.00');
    expect(describeSuggestion(s('free', 30, 50))!.title).toContain('Starter');
  });
});
