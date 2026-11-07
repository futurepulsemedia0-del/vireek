import { describe, it, expect } from 'vitest';
import { costMicro, resolveVersionedRate, priceEvent, usdToMicro, unitCost, parseScaled, type VersionedRate } from './microDollars';
import { LoopDetector } from './loopDetector';
import { evaluateRoute, costDeltaPct, DEFAULT_GATE } from './routingGate';
import { computeRoi } from './roi';
import { reconcile, parseStatementCsv } from './reconcile';

const R = (id: string, rateUsd: string, from: string, to: string | null = null): VersionedRate =>
  ({ id, component: 'llm', provider: 'p', unit: 'per_1m_input_tokens', rateUsd, effectiveFrom: from, effectiveTo: to });

describe('micro-dollar math', () => {
  it('prices tokens exactly in integers', () => {
    expect(costMicro(1_000_000, '3.00000000', 'per_1m_input_tokens')).toBe(3_000_000);
    expect(costMicro(1, '0.80000000', 'per_1m_input_tokens')).toBe(1); // 0.8 micro rounds half-up to 1
    expect(costMicro(0, '3', 'per_1m_input_tokens')).toBe(0);
  });
  it('per-minute and per-1k-chars units', () => {
    expect(costMicro('2.5', '0.0500', 'per_minute')).toBe(125_000);
    expect(costMicro(1500, '0.03', 'per_1k_characters')).toBe(45_000);
  });
  it('rejects junk and over-precise input instead of rounding silently', () => {
    expect(() => costMicro(-1, '1', 'per_event')).toThrow();
    expect(() => costMicro('abc', '1', 'per_event')).toThrow();
    expect(() => parseScaled('0.123456789', 8)).toThrow();
    expect(parseScaled('0.12345600', 8)).toBe(12345600n);
  });
  it('property: pricing is monotonic and near-additive (<=1 micro rounding per split)', () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const a = Math.floor(rnd() * 5_000_000), b = Math.floor(rnd() * 5_000_000);
      const rate = (rnd() * 20).toFixed(8);
      const whole = costMicro(a + b, rate, 'per_1m_input_tokens');
      const parts = costMicro(a, rate, 'per_1m_input_tokens') + costMicro(b, rate, 'per_1m_input_tokens');
      expect(Math.abs(whole - parts)).toBeLessThanOrEqual(1);
      expect(costMicro(a + 1, rate, 'per_1m_input_tokens')).toBeGreaterThanOrEqual(costMicro(a, rate, 'per_1m_input_tokens'));
    }
  });
  it('usdToMicro converts legacy float USD half-up', () => {
    expect(usdToMicro(0.000001)).toBe(1);
    expect(usdToMicro(12.345678)).toBe(12_345_678);
    expect(usdToMicro('0.0000005')).toBe(1);
  });
});

describe('versioned prices', () => {
  const rates = [R('v1', '3', '2026-01-01', '2026-06-01'), R('v2', '2', '2026-06-01')];
  it('resolves by effective date; effective_to is exclusive', () => {
    expect(resolveVersionedRate(rates, 'llm', 'p', 'per_1m_input_tokens', '2026-05-31')?.id).toBe('v1');
    expect(resolveVersionedRate(rates, 'llm', 'p', 'per_1m_input_tokens', '2026-06-01')?.id).toBe('v2');
    expect(resolveVersionedRate(rates, 'llm', 'p', 'per_1m_input_tokens', '2025-12-31')).toBeNull();
  });
  it('a price change never rewrites history: old events keep pricing at the old version', () => {
    const old = priceEvent(rates, { component: 'llm', provider: 'p', unit: 'per_1m_input_tokens', quantity: 1_000_000, occurredAt: '2026-03-01T10:00:00Z' });
    const now = priceEvent(rates, { component: 'llm', provider: 'p', unit: 'per_1m_input_tokens', quantity: 1_000_000, occurredAt: '2026-07-01T10:00:00Z' });
    expect([old.costMicro, old.rateId, old.rateUsdSnapshot]).toEqual([3_000_000, 'v1', '3']);
    expect([now.costMicro, now.rateId]).toEqual([2_000_000, 'v2']);
  });
  it('missing rate is unpriced (null), never $0', () => {
    const p = priceEvent(rates, { component: 'tts', provider: 'p', unit: 'per_minute', quantity: 5, occurredAt: '2026-07-01T00:00:00Z' });
    expect(p).toEqual({ priced: false, costMicro: null, rateId: null, rateUsdSnapshot: null });
  });
});

describe('unitCost', () => {
  it('reports sample size and exclusions; no divide-by-zero', () => {
    const u = unitCost([{ costMicro: 100, hasCorrelation: true }, { costMicro: 300, hasCorrelation: true }, { costMicro: null, hasCorrelation: true }, { costMicro: 50, hasCorrelation: false }], 2);
    expect(u).toEqual({ costMicroTotal: 400, units: 2, microPerUnit: 200, excluded: { unpriced: 1, missingCorrelation: 1 } });
    expect(unitCost([], 0).microPerUnit).toBeNull();
  });
});

describe('runaway-loop detector', () => {
  it('trips after maxRepeats within the window', () => {
    const d = new LoopDetector({ maxRepeats: 3, windowMs: 60_000 });
    expect([1, 2, 3].map((i) => d.record('r', 'tool:search', i * 1000).tripped)).toEqual([false, false, false]);
    expect(d.record('r', 'tool:search', 4000)).toMatchObject({ tripped: true, count: 4, reason: 'repeat_limit' });
  });
  it('old calls fall out of the window; runs are isolated', () => {
    const d = new LoopDetector({ maxRepeats: 2, windowMs: 1000 });
    d.record('r', 'k', 0); d.record('r', 'k', 10);
    expect(d.record('r', 'k', 5000).tripped).toBe(false);
    expect(d.record('other', 'k', 5001).count).toBe(1);
  });
  it('emergency calls are never tripped', () => {
    const d = new LoopDetector({ maxRepeats: 1, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) expect(d.record('r', 'k', i, true).tripped).toBe(false);
  });
});

describe('routing quality gate', () => {
  const mk = (n: number, f: (i: number) => [number, number], crit = false) =>
    Array.from({ length: n }, (_, i) => { const [b, c] = f(i); return { caseId: `c${i}`, baseline: b, candidate: c, critical: crit }; });
  it('passes when candidate is equal/better with enough cases', () => {
    const r = evaluateRoute(mk(60, () => [1, 1]));
    expect(r.pass).toBe(true); expect(r.meanDelta).toBe(0);
  });
  it('fails on regression beyond tolerance (CI lower bound)', () => {
    const r = evaluateRoute(mk(60, (i) => [1, i % 4 === 0 ? 0 : 1]));
    expect(r.pass).toBe(false); expect(r.reasons.join()).toContain('ci_low_below_tolerance');
  });
  it('fails with too few cases and on any critical-case regression', () => {
    expect(evaluateRoute(mk(5, () => [1, 1])).reasons.join()).toContain('insufficient_cases');
    const cases = [...mk(60, () => [1, 1]), { caseId: 'emergency', baseline: 1, candidate: 0, critical: true }];
    expect(evaluateRoute(cases).criticalRegressions).toEqual(['emergency']);
    expect(evaluateRoute(cases).pass).toBe(false);
  });
  it('is deterministic for a fixed seed; empty input fails safely', () => {
    const c = mk(40, (i) => [0.8, 0.8 + (i % 3) * 0.01]);
    expect(evaluateRoute(c, DEFAULT_GATE)).toEqual(evaluateRoute(c, DEFAULT_GATE));
    expect(evaluateRoute([]).pass).toBe(false);
  });
  it('costDeltaPct', () => { expect(costDeltaPct(200, 50)).toBe(-75); expect(costDeltaPct(0, 5)).toBeNull(); });
});

describe('customer ROI', () => {
  const o = (id: string, v: number, c = 1, action = '2026-01-01T00:00:00Z', out = '2026-01-02T00:00:00Z') =>
    ({ id, actionAt: action, outcomeAt: out, valueCents: v, confidence: c, rule: 'paid_invoice_after_booking' });
  it('"not enough data" instead of a number below the minimum', () => {
    expect(computeRoi([o('a', 1000)], 9900).status).toBe('not_enough_data');
  });
  it('unknown/zero plan cost is not enough data', () => {
    const many = Array.from({ length: 6 }, (_, i) => o(`o${i}`, 5000));
    expect(computeRoi(many, null).status).toBe('not_enough_data');
    expect(computeRoi(many, 0).status).toBe('not_enough_data');
  });
  it('excludes outcomes that precede the action and low-confidence ones, and counts them', () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => o(`ok${i}`, 10000)), o('past', 99999, 1, '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'), o('weak', 99999, 0.2)];
    const r = computeRoi(rows, 20000);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.excluded).toMatchObject({ preceded_action: 1, low_confidence: 1 });
      expect(r.inputIds).toHaveLength(5);
      expect(r.valueCentsHigh).toBe(50000); expect(r.roiHigh).toBeCloseTo(1.5);
    }
  });
  it('range: low is confidence-weighted, low <= high', () => {
    const rows = Array.from({ length: 5 }, (_, i) => o(`x${i}`, 10000, 0.8));
    const r = computeRoi(rows, 10000);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.valueCentsLow).toBe(40000); expect(r.valueCentsLow).toBeLessThanOrEqual(r.valueCentsHigh);
  });
  it('invalid rows are excluded, never throw', () => {
    const bad = { id: 'b', actionAt: 'x', outcomeAt: 'y', valueCents: 1.5, confidence: 2, rule: 'r' };
    const r = computeRoi([bad, ...Array.from({ length: 5 }, (_, i) => o(`k${i}`, 100))], 100);
    expect(r.excluded.invalid).toBe(1);
  });
});

describe('reconciliation', () => {
  it('match / within tolerance / over threshold with offsetting proposal', () => {
    expect(reconcile({ provider: 'vapi', month: '2026-10-01', ledgerMicro: 1_000_000, providerMicro: 1_000_000 }).status).toBe('match');
    expect(reconcile({ provider: 'vapi', month: '2026-10-01', ledgerMicro: 1_030_000, providerMicro: 1_000_000 }).status).toBe('within_tolerance');
    const r = reconcile({ provider: 'vapi', month: '2026-10-01', ledgerMicro: 800_000, providerMicro: 1_000_000 });
    expect(r.status).toBe('over_threshold'); expect(r.variancePct).toBeCloseTo(-20); expect(r.proposedCorrectionMicro).toBe(200_000);
  });
  it('provider total 0 with ledger spend is over_threshold (pct undefined)', () => {
    expect(reconcile({ provider: 'x', month: '2026-10-01', ledgerMicro: 5, providerMicro: 0 }).status).toBe('over_threshold');
  });
  it('parses statement CSV (quotes, CRLF) and rejects malformed rows', () => {
    const csv = 'provider,period_month,amount_usd,ref\r\nVapi,2026-10-01,"123.45","INV, 7"\r\nbad,2026-10-15,1,x\r\n';
    const p = parseStatementCsv(csv);
    expect(p.lines).toEqual([{ provider: 'vapi', month: '2026-10-01', amountMicro: 123_450_000, ref: 'INV, 7' }]);
    expect(p.errors).toEqual(['row 3: invalid']);
    expect(parseStatementCsv('a,b\n1,2').errors[0]).toContain('header');
  });
});
