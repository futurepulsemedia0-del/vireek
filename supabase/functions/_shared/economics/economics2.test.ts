import { describe, it, expect } from 'vitest';
import { detectCostSpike, correlationShortfall } from './anomaly';
import { simulateOutcomeFee, breakEvenCalls, type TenantMonth } from './outcomeFeeSim';
import { parseOverrides, applyRouteOverrides } from './routeOverrides';
import { runRoutingEval, type VariantRun } from './routingEval';
import { buildLedgerRow, hasCorrelation } from './ledgerWriter';
import { pickUniqueRate } from './usageLedger';

describe('cost anomaly rules', () => {
  const hist = [100_000, 110_000, 90_000, 105_000, 95_000, 100_000];
  it('flags a spike over median ratio and floor', () => {
    expect(detectCostSpike(hist, 300_000)).toMatchObject({ spike: true, reason: 'spike' });
    expect(detectCostSpike(hist, 120_000).spike).toBe(false);
  });
  it('does not alert with short history or no data today', () => {
    expect(detectCostSpike([1, 2], 1e9).reason).toBe('insufficient_history');
    expect(detectCostSpike(hist, null).reason).toBe('no_today');
  });
  it('tiny absolute moves never alert even at high ratio', () => {
    expect(detectCostSpike([10, 10, 10, 10, 10], 100).spike).toBe(false);
  });
  it('correlation shortfall', () => {
    expect(correlationShortfall(80, 100)).toEqual({ alert: true, pct: 80 });
    expect(correlationShortfall(95, 100).alert).toBe(false);
    expect(correlationShortfall(0, 0)).toEqual({ alert: false, pct: null });
  });
});

describe('outcome-fee what-if', () => {
  const rows: TenantMonth[] = [
    { tenantId: 'a', plan: 'starter', planPriceCents: 7900, costMicro: 20_000_000, bookedJobs: 10, recoveredCents: 100_000 },
    { tenantId: 'b', plan: 'starter', planPriceCents: 7900, costMicro: 5_000_000, bookedJobs: 200, recoveredCents: 0 },
  ];
  it('computes fee, margin before/after in integer cents', () => {
    const r = simulateOutcomeFee(rows, { perBookedJobCents: 500, recoveredShareBps: 100, label: 't' });
    expect(r.perTenant[0].feeCents).toBe(5000 + 1000); // 10 jobs x 500 + 1% of 100000
    expect(r.perTenant[0].marginBeforeCents).toBe(7900 - 2000);
    expect(r.feeCents).toBe(6000 + 100_000); // tenant b: 200 jobs x 500
    expect(r.marginAfterCents).toBe(r.marginBeforeCents + r.feeCents);
    expect(r.tenantsWhereFeeExceedsPlan).toBe(1); // a: 6000/7900 < 100%; b: 100000/7900 > 100%
  });
  it('rejects invalid scenarios', () => {
    expect(() => simulateOutcomeFee(rows, { perBookedJobCents: -1, recoveredShareBps: 0, label: 'x' })).toThrow();
    expect(() => simulateOutcomeFee(rows, { perBookedJobCents: 1, recoveredShareBps: 10_001, label: 'x' })).toThrow();
  });
  it('break-even calls; unknown cost is null', () => {
    expect(breakEvenCalls(7900, 1900, 100_000)).toBe(600);
    expect(breakEvenCalls(7900, 0, null)).toBeNull();
    expect(breakEvenCalls(7900, 0, 0)).toBeNull();
  });
});

describe('route overrides (evidence gated, one switch)', () => {
  const known = ['gemini', 'groq'];
  const ev = { pass: true, n: 60, ciLow: -0.01, tolerance: 0.02, reportId: 'r1', approvedBy: 'staff@x' };
  const good = JSON.stringify([{ task: 'review_reply', entries: [{ provider: 'groq', priority: 5, model: 'm' }], evidence: ev }]);
  const base = [{ provider: 'gemini', priority: 10, model: 'g' }];
  it('applies a gated override and keeps the baseline as fallback', () => {
    const r = applyRouteOverrides('review_reply', base, good, false, known);
    expect(r.applied).toBe(true);
    expect(r.route.map((e) => e.provider)).toEqual(['groq', 'gemini']);
    expect(r.route[1].priority).toBe(1010);
  });
  it('kill switch and other tasks are untouched', () => {
    expect(applyRouteOverrides('review_reply', base, good, true, known).applied).toBe(false);
    expect(applyRouteOverrides('other', base, good, false, known).route).toEqual(base);
  });
  it('ignores overrides without passing evidence, unknown providers, bad JSON', () => {
    const noPass = good.replace('"pass":true', '"pass":false');
    const lowCi = good.replace('"ciLow":-0.01', '"ciLow":-0.5');
    const fewCases = good.replace('"n":60', '"n":5');
    const badProv = good.replace('"groq"', '"evil"');
    for (const j of [noPass, lowCi, fewCases, badProv, 'not json', '{}', undefined]) expect(parseOverrides(j as string, known)).toEqual([]);
  });
});

describe('routing eval orchestration', () => {
  const cases = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, critical: i === 0 }));
  const mk = (score: (v: string, i: number) => number, cost: (v: string) => number | null) =>
    async (c: { id: string }, v: { provider: string }): Promise<VariantRun> => ({ score: score(v.provider, Number(c.id.slice(1))), costMicro: cost(v.provider), latencyMs: v.provider === 'cheap' ? 50 : 100 });
  const B = { provider: 'big', model: 'b' }, C = { provider: 'cheap', model: 'c' };
  it('recommends enable only when quality passes AND cost is measurably lower', async () => {
    const r = await runRoutingEval({ task: 't', cases, baseline: B, candidate: C, run: mk(() => 1, (v) => (v === 'big' ? 1000 : 200)) });
    expect(r.recommendation).toBe('enable');
    expect(r.cost.deltaPct).toBe(-80);
    expect(r.overrideEntries).toEqual([{ provider: 'cheap', model: 'c', priority: 1 }]);
  });
  it('keeps baseline on quality regression', async () => {
    const r = await runRoutingEval({ task: 't', cases, baseline: B, candidate: C, run: mk((v, i) => (v === 'cheap' && i % 3 === 0 ? 0 : 1), (v) => (v === 'big' ? 1000 : 200)) });
    expect(r.recommendation).toBe('keep_baseline'); expect(r.overrideEntries).toBeNull();
  });
  it('keeps baseline when cost is unpriced (no invented savings)', async () => {
    const r = await runRoutingEval({ task: 't', cases, baseline: B, candidate: C, run: mk(() => 1, (v) => (v === 'big' ? 1000 : null)) });
    expect(r.recommendation).toBe('keep_baseline'); expect(r.cost.deltaPct).toBeNull(); expect(r.cost.unpricedRuns).toBe(40);
  });
  it('a throwing candidate scores 0 and is counted as errors', async () => {
    const run = async (_c: { id: string }, v: { provider: string }): Promise<VariantRun> => { if (v.provider === 'cheap') throw new Error('boom'); return { score: 1, costMicro: 10, latencyMs: 1 }; };
    const r = await runRoutingEval({ task: 't', cases, baseline: B, candidate: C, run });
    expect(r.errors.candidate).toBe(40); expect(r.recommendation).toBe('keep_baseline');
  });
});

describe('ledger marketplace correlation', () => {
  it('marketplace run id counts as correlation and is written', () => {
    expect(hasCorrelation({ marketplaceRunId: 'r' })).toBe(true);
    const row = buildLedgerRow({ accountId: 'a', provider: 'x', resourceType: 'llm_tokens', costMicro: 1, basis: 'estimated', source: 's', marketplaceRunId: 'r' });
    expect(row.marketplace_run_id).toBe('r');
  });
});

describe('usage pricing rule', () => {
  const r = (id: string, provider: string, from: string, to: string | null = null) =>
    ({ id, component: 'sms_segment', provider, unit: 'per_segment' as const, rateUsd: '0.0079', effectiveFrom: from, effectiveTo: to });
  it('uses a rate only when exactly one provider is in effect', () => {
    expect(pickUniqueRate([r('a', 'twilio', '2026-01-01')], 'sms_segment', 'per_segment', '2026-05-01')?.id).toBe('a');
    expect(pickUniqueRate([r('a', 'twilio', '2026-01-01'), r('b', 'telnyx', '2026-01-01')], 'sms_segment', 'per_segment', '2026-05-01')).toBeNull();
    expect(pickUniqueRate([], 'sms_segment', 'per_segment', '2026-05-01')).toBeNull();
  });
  it('an expired rate does not count', () => {
    expect(pickUniqueRate([r('a', 'twilio', '2026-01-01', '2026-03-01')], 'sms_segment', 'per_segment', '2026-05-01')).toBeNull();
  });
});
