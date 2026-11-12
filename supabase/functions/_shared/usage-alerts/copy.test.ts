import { describe, it, expect } from 'vitest';
import { PRICING_PLANS, parseOverageRate } from '../../../../src/lib/pricing';
import { buildLimitAlert, buildMinutesAlert, resolvePlanContext, type AlertAccount } from './copy';

const account = (plan: string, used: number, included: number): AlertAccount => ({
  id: 'u1', email: 'a@example.com', full_name: null, company_name: null, phone: null, plan,
  minutes_used_this_month: used, minutes_included: included,
});

describe('copy is generated from the pricing constants', () => {
  for (const plan of PRICING_PLANS.filter((p) => p.id !== 'enterprise')) {
    it(`${plan.id}: names the plan, the numbers and the real overage rate`, () => {
      const c = buildMinutesAlert('minutes_100', account(plan.id, 500, 400), '2026-11');
      const text = `${c.notification.title} ${c.notification.body}`;
      expect(text).toContain(plan.name);
      expect(text).toContain('400');
      const rate = parseOverageRate(plan.overage);
      if (rate !== null) expect(text).toContain(`$${rate.toFixed(2)}/min`);
      else expect(text).not.toContain('billed at');
    });
  }

  it('changes when the pricing constant changes (nothing is hardcoded)', () => {
    const starter = PRICING_PLANS.find((p) => p.id === 'starter')!;
    const original = starter.overage;
    try {
      starter.overage = '$0.99/min after';
      expect(buildMinutesAlert('minutes_80', account('starter', 330, 400), '2026-11').notification.body).toContain('$0.99/min');
    } finally {
      starter.overage = original;
    }
  });

  it('points to the next plan as the upgrade target, and to sales above Business', () => {
    expect(resolvePlanContext('starter').upgrade?.id).toBe('professional');
    expect(buildMinutesAlert('minutes_80', account('starter', 330, 400), '2026-11').notification.body).toContain('Professional');
    expect(buildMinutesAlert('minutes_80', account('business', 3300, 4000), '2026-11').notification.body.toLowerCase()).toContain('talk to us');
  });

  it('never claims a service pause, emergency forwarding or top-up prices (none verified in the repo)', () => {
    for (const kind of ['minutes_80', 'minutes_100'] as const) {
      const c = buildMinutesAlert(kind, account('free', 50, 50), '2026-11');
      expect(`${c.notification.title} ${c.notification.body}`).not.toMatch(/emergenc|paus|top.?up|stop/i);
    }
  });

  it('uses a period-scoped in-app title that the existing BillingPage reader still matches', () => {
    const c = buildMinutesAlert('minutes_80', account('starter', 330, 400), '2026-11');
    expect(c.insight?.title.toLowerCase()).toContain('included minutes');
    expect(c.insight?.title).toContain('2026-11');
  });

  it('is safe for unknown plans', () => {
    const c = buildMinutesAlert('minutes_80', account('legacy-gold', 330, 400), '2026-11');
    expect(c.notification.body).toContain('330');
  });

  it('builds limit alerts from the plan catalog and scopes the title to the period', () => {
    const c = buildLimitAlert('seat_limit', { plan: 'starter' }, 2, 2, '2026-11');
    expect(c.notification.body).toContain('Professional');
    expect(c.notification.body).toContain(PRICING_PLANS.find((p) => p.id === 'professional')!.seats);
    expect(c.insight?.title).toContain('2026-11');
  });
});
