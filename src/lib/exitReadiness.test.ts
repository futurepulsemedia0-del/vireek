import { describe, expect, it } from 'vitest';
import {
  buildActionPlan,
  buildValuationSummary,
  computeEarnings,
  computeReadiness,
  computeValuation,
  confidenceFor,
  DEFAULT_SETTINGS,
  evaluate,
  fmtMoney,
  gradeFor,
  lin,
  linkState,
  previousSnapshot,
  resolveMultiples,
  scoreDrivers,
  signedAmountCents,
  trendFor,
  validateAddBack,
  validateMultiple,
  validateShare,
  type AddBack,
  type ExitMetrics,
  type ModelInput,
} from './exitReadiness';

const metrics = (o: Partial<ExitMetrics> = {}): ExitMetrics => ({
  generatedAt: '2027-11-21T00:00:00Z',
  ledgerMonths: 12,
  financials: { revenueCents: 200_000_000, expensesCents: 170_000_000, interestCents: 1_000_000, taxCents: 0, daCents: 2_000_000, monthly: [] },
  recurringShare: 0.1,
  recurringAnnualCents: 20_000_000,
  concentration: { top1: 0.25, top5: 0.6, customers: 80 },
  workforce: { headcount: 8, avgTenureYears: 2, turnoverRate: 0.25 },
  ownerDependence: { revenueShare: 0.6 },
  dso: 50,
  arOpenCents: 27_000_000,
  margin: { overall: 0.35, coveragePct: 0.8, byService: [] },
  documentation: { published: 3, categories: 2, ackRate: 0.5 },
  compliance: { credentialsTotal: 10, credentialsValid: 8, credentialsExpiring: 2, credentialsExpired: 2, insuranceTotal: 2, insuranceValid: 2, hasGeneralLiability: true },
  ...o,
});
const addBack = (o: Partial<AddBack> = {}): AddBack => ({
  id: 'a1', kind: 'owner_compensation', label: 'Owner pay', amountCents: 8_000_000, justification: 'Owner draws 80k', evidenceRef: null, active: true, ...o,
});
const model = (o: Partial<ModelInput> = {}): ModelInput => ({
  metrics: metrics(), settings: { ...DEFAULT_SETTINGS, ownerMarketSalaryCents: 6_000_000 }, addBacks: [addBack()], dataQuality: 70, ...o,
});

describe('lin', () => {
  it('scales in both directions and clamps', () => {
    expect(lin(0.125, 0, 0.25)).toBeCloseTo(50);
    expect(lin(0.5, 0, 0.25)).toBe(100);
    expect(lin(0.3, 0.3, 0.05)).toBe(0);
    expect(lin(0.05, 0.3, 0.05)).toBe(100);
    expect(lin(10, 5, 5)).toBe(100);
  });
});

describe('computeEarnings', () => {
  it('builds SDE and adjusted EBITDA from ledger + documented add-backs', () => {
    const e = computeEarnings(model());
    expect(e.netIncomeCents).toBe(30_000_000);
    expect(e.autoAddBacksCents).toBe(3_000_000);
    expect(e.manualAddBacksCents).toBe(8_000_000);
    expect(e.sdeCents).toBe(41_000_000);
    expect(e.ebitdaCents).toBe(35_000_000);
  });
  it('ignores inactive add-backs and applies deductions', () => {
    const e = computeEarnings(model({ addBacks: [addBack({ active: false }), addBack({ id: 'd', kind: 'deduction', amountCents: -1_000_000 })] }));
    expect(e.manualAddBacksCents).toBe(-1_000_000);
  });
  it('scenario growth uses the current positive margin only', () => {
    const base = computeEarnings(model());
    const grown = computeEarnings(model(), { revenueGrowth: 0.1 });
    expect(grown.netIncomeCents - base.netIncomeCents).toBe(3_000_000);
    const loss = model({ metrics: metrics({ financials: { revenueCents: 100, expensesCents: 200, interestCents: 0, taxCents: 0, daCents: 0, monthly: [] } }) });
    expect(computeEarnings(loss, { revenueGrowth: 0.5 }).netIncomeCents).toBe(-100);
  });
});

describe('valuation', () => {
  it('uses SDE below the threshold and EBITDA above it', () => {
    const small = computeValuation(DEFAULT_SETTINGS, computeEarnings(model()), 50);
    expect(small.method).toBe('sde');
    const big = computeValuation(DEFAULT_SETTINGS, { ...computeEarnings(model()), sdeCents: 90_000_000, ebitdaCents: 80_000_000 }, 50);
    expect(big.method).toBe('ebitda');
  });
  it('positions the point estimate inside the range by readiness', () => {
    const e = computeEarnings(model());
    const lo = computeValuation(DEFAULT_SETTINGS, e, 0);
    const hi = computeValuation(DEFAULT_SETTINGS, e, 100);
    expect(lo.pointCents).toBe(lo.lowCents);
    expect(hi.pointCents).toBe(hi.highCents);
    expect(lo.lowCents).toBeLessThan(lo.midCents);
    expect(lo.midCents).toBeLessThan(lo.highCents);
  });
  it('uses the mid multiple when readiness adjustment is off or the score is unknown', () => {
    const e = computeEarnings(model());
    expect(computeValuation({ ...DEFAULT_SETTINGS, readinessAdjusts: false }, e, 90).pointCents).toBe(computeValuation(DEFAULT_SETTINGS, e, null).midCents);
    expect(computeValuation(DEFAULT_SETTINGS, e, null).pointCents).toBe(computeValuation(DEFAULT_SETTINGS, e, null).midCents);
  });
  it('refuses to value non-positive earnings', () => {
    const v = computeValuation(DEFAULT_SETTINGS, { ...computeEarnings(model()), sdeCents: -5, ebitdaCents: -5 }, 60);
    expect(v.reason).toMatch(/zero or negative/);
    expect(v.pointCents).toBe(0);
  });
  it('honours valid custom multiples and ignores invalid ones', () => {
    const custom = { low: 1, mid: 2, high: 3 };
    expect(resolveMultiples({ ...DEFAULT_SETTINGS, sdeMultiple: custom }).sde).toEqual(custom);
    expect(resolveMultiples({ ...DEFAULT_SETTINGS, sdeMultiple: { low: 3, mid: 2, high: 1 } }).sde.low).toBe(2.0);
    expect(validateMultiple({ low: 0, mid: 1, high: 2 })).not.toBeNull();
    expect(validateMultiple({ low: 1, mid: 2, high: 21 })).not.toBeNull();
    expect(validateMultiple(null)).toBeNull();
  });
});

describe('drivers and readiness', () => {
  it('scores every driver and weights sum to 100', () => {
    const d = scoreDrivers(metrics(), null, 70);
    expect(d).toHaveLength(9);
    expect(d.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(d.find((x) => x.key === 'recurring_revenue')?.score).toBe(40);
  });
  it('marks missing data as nodata and re-normalises weights', () => {
    const d = scoreDrivers(metrics({ recurringShare: null, dso: null, concentration: { top1: null, top5: null, customers: 0 } }), null, null);
    expect(d.find((x) => x.key === 'dso')?.status).toBe('nodata');
    const r = computeReadiness(d);
    expect(r.coverage).toBeLessThan(1);
    expect(r.score).not.toBeNull();
  });
  it('returns an unknown readiness when nothing can be scored', () => {
    expect(computeReadiness([]).grade).toBe('unknown');
  });
  it('blends owner hours into owner dependence', () => {
    const without = scoreDrivers(metrics(), null, 70).find((x) => x.key === 'owner_dependence')?.score as number;
    const withHours = scoreDrivers(metrics(), 10, 70).find((x) => x.key === 'owner_dependence')?.score as number;
    expect(withHours).toBeGreaterThan(without);
  });
  it('caps the insurance score when general liability is missing', () => {
    const a = scoreDrivers(metrics({ compliance: { credentialsTotal: 0, credentialsValid: 0, credentialsExpiring: 0, credentialsExpired: 0, insuranceTotal: 2, insuranceValid: 2, hasGeneralLiability: false } }), null, 70);
    expect(a.find((x) => x.key === 'compliance')?.score).toBe(40);
  });
  it('grades and confidence', () => {
    expect(gradeFor(85)).toBe('sale_ready');
    expect(gradeFor(66)).toBe('nearly_ready');
    expect(gradeFor(50)).toBe('needs_work');
    expect(gradeFor(10)).toBe('early_stage');
    expect(confidenceFor({ score: 80, coverage: 0.9, grade: 'sale_ready' }, 12)).toBe('high');
    expect(confidenceFor({ score: 80, coverage: 0.7, grade: 'sale_ready' }, 8)).toBe('medium');
    expect(confidenceFor({ score: 80, coverage: 0.3, grade: 'sale_ready' }, 12)).toBe('low');
  });
});

describe('what-if and action plan', () => {
  it('improving a driver never lowers the point estimate', () => {
    const base = evaluate(model());
    const better = evaluate(model(), { recurringShare: 0.25, dso: 30, dataQuality: 95 });
    expect(better.readiness.score as number).toBeGreaterThan(base.readiness.score as number);
    expect(better.valuation.pointCents).toBeGreaterThan(base.valuation.pointCents);
  });
  it('does not mutate the input', () => {
    const m = model();
    const copy = JSON.stringify(m);
    evaluate(m, { recurringShare: 0.2, top1: 0.05, credentialsValidPct: 1 });
    expect(JSON.stringify(m)).toBe(copy);
  });
  it('ranks quantified actions by value impact, unquantified last', () => {
    const plan = buildActionPlan(model({ addBacks: [] }));
    expect(plan.length).toBeGreaterThan(3);
    const impacts = plan.map((a) => a.impact?.pointCents ?? -Infinity);
    expect([...impacts].sort((x, y) => y - x)).toEqual(impacts);
    expect(plan[plan.length - 1].key).toBe('document_owner_comp');
    expect(plan[plan.length - 1].impact).toBeNull();
  });
  it('reports cash released by faster collection separately from value', () => {
    const cut = buildActionPlan(model()).find((a) => a.key === 'cut_dso');
    expect(cut?.cashImpactCents).toBeGreaterThan(0);
  });
  it('quantifies nothing when earnings are not positive', () => {
    const loss = model({ metrics: metrics({ financials: { revenueCents: 100, expensesCents: 900, interestCents: 0, taxCents: 0, daCents: 0, monthly: [] } }), addBacks: [] });
    expect(buildActionPlan(loss).every((a) => a.impact === null)).toBe(true);
  });
  it('skips actions for strong drivers', () => {
    const strong = model({ metrics: metrics({ recurringShare: 0.3 }) });
    expect(buildActionPlan(strong).some((a) => a.key === 'grow_memberships')).toBe(false);
  });
});

describe('trends and validation', () => {
  it('detects direction with a 2-point dead band', () => {
    expect(trendFor(60, 50).direction).toBe('up');
    expect(trendFor(50, 60).direction).toBe('down');
    expect(trendFor(60, 59).direction).toBe('flat');
    expect(trendFor(60, null).direction).toBe('none');
  });
  it('picks the latest snapshot from an earlier month', () => {
    const snaps = [
      { periodMonth: '2027-09-01', readinessScore: 40, driverScores: {}, valuePointCents: 1 },
      { periodMonth: '2027-10-01', readinessScore: 50, driverScores: {}, valuePointCents: 2 },
      { periodMonth: '2027-11-01', readinessScore: 55, driverScores: {}, valuePointCents: 3 },
    ];
    expect(previousSnapshot(snaps, new Date('2027-11-21T00:00:00Z'))?.periodMonth).toBe('2027-10-01');
    expect(previousSnapshot([], new Date())).toBeNull();
  });
  it('requires a documented justification for add-backs', () => {
    const ok = { kind: 'one_time' as const, label: 'Lawsuit', amountDollars: '5000', justification: 'Settled in 2027, will not recur', evidenceRef: '' };
    expect(validateAddBack(ok)).toEqual({});
    expect(validateAddBack({ ...ok, justification: 'x' }).justification).toBeDefined();
    expect(validateAddBack({ ...ok, amountDollars: '-3' }).amountDollars).toBeDefined();
  });
  it('stores deductions as negative cents', () => {
    expect(signedAmountCents('deduction', '10.50')).toBe(-1050);
    expect(signedAmountCents('one_time', '10.50')).toBe(1050);
  });
  it('validates data-room sharing limits', () => {
    const ok = { label: 'Buyer A', recipient: '', expiresHours: 72, maxViews: 10, sections: ['financials'] };
    expect(validateShare(ok)).toEqual({});
    expect(validateShare({ ...ok, expiresHours: 721 }).expiresHours).toBeDefined();
    expect(validateShare({ ...ok, maxViews: 0 }).maxViews).toBeDefined();
    expect(validateShare({ ...ok, sections: [] }).sections).toBeDefined();
    expect(validateShare({ ...ok, sections: ['passwords'] }).sections).toBeDefined();
  });
  it('derives link state', () => {
    const now = new Date('2027-11-21T12:00:00Z');
    const base = { expiresAt: '2027-11-22T12:00:00Z', revokedAt: null, viewCount: 0, maxViews: 2 };
    expect(linkState(base, now)).toBe('active');
    expect(linkState({ ...base, expiresAt: '2027-11-21T11:00:00Z' }, now)).toBe('expired');
    expect(linkState({ ...base, revokedAt: '2027-11-21T10:00:00Z' }, now)).toBe('revoked');
    expect(linkState({ ...base, viewCount: 2 }, now)).toBe('exhausted');
  });
  it('formats money compactly', () => {
    expect(fmtMoney(123_456_789)).toBe('$1.23M');
    expect(fmtMoney(4_500_000)).toBe('$45K');
    expect(fmtMoney(null)).toBe('—');
  });
});

describe('buildValuationSummary', () => {
  it('labels the summary as an estimate and lists only active add-backs', () => {
    const m = model({ addBacks: [addBack(), addBack({ id: 'x', active: false, label: 'Hidden' })] });
    const s = buildValuationSummary(m, evaluate(m)) as { label: string; disclaimer: string; documentedAddBacks: unknown[]; drivers: unknown[] };
    expect(s.label).toMatch(/ESTIMATE/);
    expect(s.disclaimer).toMatch(/not a valuation/i);
    expect(s.documentedAddBacks).toHaveLength(1);
    expect(s.drivers).toHaveLength(9);
  });
});
