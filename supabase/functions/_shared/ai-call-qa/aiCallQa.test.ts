import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_RATES, classifyRisk, sampleCalls, unitHash, type CandidateCall } from './sampling';

const call = (id: string, o: Partial<CandidateCall> = {}): CandidateCall => ({
  id, call_datetime: '2026-11-24T10:00:00Z', is_emergency: false, sentiment: 'neutral', tags: [], intent: null,
  price_lookups_performed: 0, price_accuracy_status: null, human_transfer_requested: false, ...o,
});
const ids = (n: number, o: Partial<CandidateCall> = {}) => Array.from({ length: n }, (_, i) => call(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, o));

describe('classifyRisk', () => {
  it('flags emergency, price mismatch (+quote), complaint, transfer', () => {
    expect(classifyRisk(call('a', { is_emergency: true }))).toEqual(['emergency']);
    expect(classifyRisk(call('a', { price_accuracy_status: 'mismatch' }))).toEqual(['price_mismatch', 'price_quote']);
    expect(classifyRisk(call('a', { price_lookups_performed: 2 }))).toEqual(['price_quote']);
    expect(classifyRisk(call('a', { sentiment: 'Angry' }))).toEqual(['complaint']);
    expect(classifyRisk(call('a', { tags: ['Complaint'] }))).toEqual(['complaint']);
    expect(classifyRisk(call('a', { intent: 'billing_complaint' }))).toEqual(['complaint']);
    expect(classifyRisk(call('a', { human_transfer_requested: true }))).toEqual(['human_transfer']);
  });
  it('returns no flags for a plain call and ignores not_applicable pricing', () => {
    expect(classifyRisk(call('a', { price_accuracy_status: 'not_applicable' }))).toEqual([]);
  });
});

describe('unitHash', () => {
  it('is deterministic and in [0,1)', () => {
    expect(unitHash('x')).toBe(unitHash('x'));
    for (let i = 0; i < 500; i++) { const u = unitHash(`k${i}`); expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(1); }
  });
  it('is roughly uniform', () => {
    let below = 0; for (let i = 0; i < 4000; i++) if (unitHash(`id-${i}`) < 0.1) below++;
    expect(below).toBeGreaterThan(300); expect(below).toBeLessThan(500);
  });
});

describe('sampleCalls', () => {
  it('always picks rate-1 flagged calls (emergency) and ranks them first', () => {
    const calls = [...ids(200), call('em-1', { is_emergency: true }), call('em-2', { is_emergency: true })];
    const picks = sampleCalls(calls, { randomRate: 0.05, riskRates: DEFAULT_RISK_RATES, remainingCap: 50 });
    expect(picks.slice(0, 2).map((p) => p.callId).sort()).toEqual(['em-1', 'em-2']);
    expect(picks[0].priority).toBe(100);
  });
  it('is idempotent across runs', () => {
    const calls = ids(300);
    const a = sampleCalls(calls, { randomRate: 0.1, riskRates: {}, remainingCap: 100 });
    const b = sampleCalls([...calls].reverse(), { randomRate: 0.1, riskRates: {}, remainingCap: 100 });
    expect(b).toEqual(a);
  });
  it('respects the cap, with cap 0 and negative returning nothing', () => {
    const calls = ids(500, { is_emergency: true });
    expect(sampleCalls(calls, { randomRate: 0.5, riskRates: DEFAULT_RISK_RATES, remainingCap: 7 })).toHaveLength(7);
    expect(sampleCalls(calls, { randomRate: 0.5, riskRates: DEFAULT_RISK_RATES, remainingCap: 0 })).toEqual([]);
    expect(sampleCalls(calls, { randomRate: 0.5, riskRates: DEFAULT_RISK_RATES, remainingCap: -3 })).toEqual([]);
  });
  it('random rate 0 and no flags picks nothing; random rate ~ expected share', () => {
    expect(sampleCalls(ids(300), { randomRate: 0, riskRates: DEFAULT_RISK_RATES, remainingCap: 500 })).toEqual([]);
    const n = sampleCalls(ids(2000), { randomRate: 0.1, riskRates: {}, remainingCap: 2000 }).length;
    expect(n).toBeGreaterThan(140); expect(n).toBeLessThan(260);
  });
  it('labels a call hit by the random draw as random even if flagged', () => {
    const picks = sampleCalls(ids(50, { is_emergency: true }), { randomRate: 1, riskRates: DEFAULT_RISK_RATES, remainingCap: 100 });
    expect(picks.every((p) => p.stratum === 'random' && p.riskFlags.includes('emergency'))).toBe(true);
  });
  it('sanitises invalid rates (NaN/negative/>1) without throwing', () => {
    expect(() => sampleCalls(ids(10, { is_emergency: true }), { randomRate: Number.NaN, riskRates: { emergency: 5 }, remainingCap: 10 })).not.toThrow();
    expect(sampleCalls(ids(10, { is_emergency: true }), { randomRate: -1, riskRates: { emergency: 5 }, remainingCap: 10 })).toHaveLength(10);
  });
});
