import { describe, it, expect } from 'vitest';
import {
  activatedWithin,
  bridgeResidualCents,
  cac,
  estimateLtv,
  grossRevenueRetention,
  logoChurn,
  netRevenueRetention,
  paybackMonths,
  percentile,
  trialToPaid,
  ttfvAmongActivated,
  wilsonInterval,
  type BridgeRaw,
} from './growthMetrics';

const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);

// Fixture: 40 accounts at 10_000 cents opening. 2 churn, 3 contract to 5_000, 5 expand to 15_000. 10 new accounts at 10_000.
const bridge: BridgeRaw = {
  currency: 'usd',
  opening_mrr_cents: 400_000,
  closing_mrr_cents: 400_000 - 2 * 10_000 - 3 * 5_000 + 5 * 5_000 + 100_000,
  movements: {
    churn: { cents: 20_000, n: 2 },
    contraction: { cents: 15_000, n: 3 },
    expansion: { cents: 25_000, n: 5 },
    new: { cents: 100_000, n: 10 },
  },
  cohort_n: 40,
  cohort_opening_cents: 400_000,
  cohort_closing_cents: 400_000 - 20_000 - 15_000 + 25_000,
  cohort_retained_floor_cents: 400_000 - 20_000 - 15_000,
  cohort_churned_n: 2,
};

describe('MRR bridge & retention', () => {
  it('bridge identity holds (residual 0)', () => expect(bridgeResidualCents(bridge)).toBe(0));
  it('detects a broken bridge', () => expect(bridgeResidualCents({ ...bridge, closing_mrr_cents: bridge.closing_mrr_cents + 1 })).toBe(-1));
  it('NRR excludes new MRR', () => expect(netRevenueRetention(bridge).value).toBeCloseTo(390_000 / 400_000, 10));
  it('GRR never counts expansion', () => expect(grossRevenueRetention(bridge).value).toBeCloseTo(365_000 / 400_000, 10));
  it('GRR is capped at 1', () => expect(grossRevenueRetention({ ...bridge, cohort_retained_floor_cents: 500_000 }).value).toBe(1));
  it('logo churn = churned / opening accounts', () => expect(logoChurn(bridge).value).toBeCloseTo(2 / 40, 10));
  it('ok status at n>=30', () => expect(netRevenueRetention(bridge).status).toBe('ok'));
  it('low_sample below 30 accounts', () => {
    const r = netRevenueRetention({ ...bridge, cohort_n: 12 });
    expect(r.status).toBe('low_sample');
    expect(r.reason).toBe('sample_below_minimum');
  });
  it('insufficient with empty cohort (no division by zero)', () => {
    const r = netRevenueRetention({ ...bridge, cohort_n: 0, cohort_opening_cents: 0 });
    expect(r.status).toBe('insufficient');
    expect(r.value).toBeNull();
  });
});

describe('Wilson interval', () => {
  it('known value 8/10', () => {
    const i = wilsonInterval(8, 10);
    expect(i?.low).toBeCloseTo(0.4902, 3);
    expect(i?.high).toBeCloseTo(0.9433, 3);
  });
  it('0/n has low bound 0', () => expect(wilsonInterval(0, 20)?.low).toBe(0));
  it('rejects invalid input', () => {
    expect(wilsonInterval(1, 0)).toBeNull();
    expect(wilsonInterval(5, 4)).toBeNull();
  });
});

describe('trial to paid', () => {
  const now = d('2028-02-01T00:00:00Z');
  it('excludes running trials from the denominator', () => {
    const r = trialToPaid(
      [
        { trialEnd: d('2028-01-10T00:00:00Z'), convertedAt: d('2028-01-10T00:00:00Z') },
        { trialEnd: d('2028-01-10T00:00:00Z'), convertedAt: null },
        { trialEnd: new Date(now.getTime() + 5 * DAY), convertedAt: null },
      ],
      now,
    );
    expect(r.matured.n).toBe(2);
    expect(r.matured.k).toBe(1);
    expect(r.inFlight).toBe(1);
  });
  it('trial inside grace window is still in flight', () => {
    const r = trialToPaid([{ trialEnd: new Date(now.getTime() - 1 * DAY), convertedAt: null }], now, 3);
    expect(r.matured.n).toBe(0);
    expect(r.inFlight).toBe(1);
    expect(r.matured.status).toBe('insufficient');
  });
  it('early conversion counts as matured', () => {
    const r = trialToPaid([{ trialEnd: new Date(now.getTime() + 5 * DAY), convertedAt: new Date(now.getTime() - DAY) }], now);
    expect(r.matured.k).toBe(1);
  });
  it('conversion after grace is not a conversion', () => {
    const r = trialToPaid([{ trialEnd: d('2028-01-01T00:00:00Z'), convertedAt: d('2028-01-20T00:00:00Z') }], now);
    expect(r.matured.n).toBe(1);
    expect(r.matured.k).toBe(0);
  });
  it('flags low sample', () => {
    const r = trialToPaid([{ trialEnd: d('2028-01-01T00:00:00Z'), convertedAt: d('2028-01-01T00:00:00Z') }], now);
    expect(r.matured.status).toBe('low_sample');
    expect(r.matured.interval).not.toBeNull();
  });
});

describe('activation & TTFV', () => {
  const now = d('2028-02-15T00:00:00Z');
  const recs = [
    { signupAt: d('2028-02-01T00:00:00Z'), activatedAt: d('2028-02-01T12:00:00Z') }, // 12h
    { signupAt: d('2028-02-01T00:00:00Z'), activatedAt: d('2028-02-09T00:00:00Z') }, // 8d
    { signupAt: d('2028-02-01T00:00:00Z'), activatedAt: null },
    { signupAt: d('2028-02-14T00:00:00Z'), activatedAt: null }, // too young for 7d window
  ];
  it('right-censored signups are excluded, not failures', () => {
    const r = activatedWithin(recs, 7, now);
    expect(r.n).toBe(3);
    expect(r.k).toBe(1);
  });
  it('7d window excludes the 8-day activation', () => expect(activatedWithin(recs, 7, now).value).toBeCloseTo(1 / 3, 10));
  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
  });
  it('TTFV summary only uses activated accounts and says so by name', () => {
    const t = ttfvAmongActivated(recs);
    expect(t.n).toBe(2);
    expect(t.medianHoursAmongActivated).toBeCloseTo((12 + 192) / 2, 10);
    expect(t.status).toBe('low_sample');
  });
  it('TTFV ignores activation before signup (bad data)', () => {
    expect(ttfvAmongActivated([{ signupAt: d('2028-02-02T00:00:00Z'), activatedAt: d('2028-02-01T00:00:00Z') }]).status).toBe('insufficient');
  });
});

describe('unit economics (estimated)', () => {
  const base = { arpaCents: 10_000, grossMargin: 0.8, monthlyChurn: 0.04, payingCustomers: 50, monthsOfData: 8 };
  it('LTV = ARPA*margin/churn, labelled estimated', () => {
    const r = estimateLtv(base);
    expect(r.value).toBe(200_000);
    expect(r.label).toBe('estimated');
  });
  it('LTV refuses short history', () => expect(estimateLtv({ ...base, monthsOfData: 3 }).reason).toBe('history_too_short'));
  it('LTV refuses small samples', () => expect(estimateLtv({ ...base, payingCustomers: 10 }).status).toBe('insufficient'));
  it('LTV refuses zero observed churn (no infinite LTV)', () => expect(estimateLtv({ ...base, monthlyChurn: 0 }).reason).toBe('zero_observed_churn'));
  it('LTV refuses margin outside (0,1]', () => expect(estimateLtv({ ...base, grossMargin: 1.4 }).reason).toBe('invalid_margin'));
  it('CAC = spend / new customers (measured)', () => {
    const r = cac(300_000, 12);
    expect(r.value).toBe(25_000);
    expect(r.label).toBe('measured');
    expect(r.status).toBe('low_sample');
  });
  it('CAC with no customers is insufficient', () => expect(cac(1000, 0).status).toBe('insufficient'));
  it('payback = CAC/(ARPA*margin), estimated', () => {
    const r = paybackMonths(24_000, 10_000, 0.8, 40);
    expect(r.value).toBeCloseTo(3, 10);
    expect(r.label).toBe('estimated');
    expect(r.status).toBe('ok');
  });
  it('payback with missing CAC is insufficient', () => expect(paybackMonths(null, 10_000, 0.8, 40).status).toBe('insufficient'));
});

import { channelEconomics, monthlyChurnFromPeriod } from './growthMetrics';

describe('period conversion and channel economics', () => {
  it('30 days is identity', () => expect(monthlyChurnFromPeriod(0.1, 30)).toBeCloseTo(0.1, 10));
  it('90-day churn 0.271 ~ 0.1 monthly', () => expect(monthlyChurnFromPeriod(1 - 0.9 ** 3, 90)).toBeCloseTo(0.1, 10));
  it('rejects invalid input', () => {
    expect(monthlyChurnFromPeriod(1.2, 30)).toBeNull();
    expect(monthlyChurnFromPeriod(0.1, 0)).toBeNull();
  });
  it('channel without recorded spend has NO cac (never 0)', () => {
    const r = channelEconomics({ spendCents: null, newCustomers: 10, newMrrCents: 100_000, grossMargin: 0.8 });
    expect(r.cac.value).toBeNull();
    expect(r.cac.reason).toBe('no_spend_recorded');
    expect(r.arpaCents).toBe(10_000);
  });
  it('channel economics: cac 24_000, arpa 10_000, margin .8 => payback 3', () => {
    const r = channelEconomics({ spendCents: 720_000, newCustomers: 30, newMrrCents: 300_000, grossMargin: 0.8 });
    expect(r.cac.value).toBe(24_000);
    expect(r.payback.value).toBeCloseTo(3, 10);
    expect(r.payback.label).toBe('estimated');
  });
});
