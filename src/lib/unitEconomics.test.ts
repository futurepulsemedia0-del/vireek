import { describe, it, expect } from 'vitest';
import {
  resolveRate, estimateCost, summarizeCosts, grossMargin, percentile, maxProfitableMinutes,
  type CostRate,
} from './unitEconomics';
import { extractVapiCostLines } from '../../supabase/functions/_shared/billing/callCostCapture';

const rates: CostRate[] = [
  { component: 'asr', provider: 'p', unit: 'per_minute', rateUsd: 1, source: 'fixture', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' },
  { component: 'asr', provider: 'p', unit: 'per_minute', rateUsd: 2, source: 'fixture', effectiveFrom: '2026-06-01', effectiveTo: null },
];

describe('rates', () => {
  it('picks the rate in effect on the date (end exclusive)', () => {
    expect(resolveRate(rates, 'asr', 'p', 'per_minute', '2026-05-31')?.rateUsd).toBe(1);
    expect(resolveRate(rates, 'asr', 'p', 'per_minute', '2026-06-01')?.rateUsd).toBe(2);
  });
  it('returns null (unpriced) before any rate or for another unit', () => {
    expect(resolveRate(rates, 'asr', 'p', 'per_minute', '2025-12-31')).toBeNull();
    expect(resolveRate(rates, 'asr', 'p', 'per_segment', '2026-07-01')).toBeNull();
  });
  it('never turns a missing rate into $0 and rejects bad quantities', () => {
    expect(estimateCost(null, 5)).toEqual({ costUsd: null, unpriced: true });
    expect(estimateCost(rates[1], 3)).toEqual({ costUsd: 6, unpriced: false });
    expect(() => estimateCost(null, -1)).toThrow(RangeError);
  });
});

describe('summarizeCosts', () => {
  it('counts only the strongest basis per component (no double counting)', () => {
    const s = summarizeCosts([
      { component: 'llm', amountUsd: 1, basis: 'estimated' },
      { component: 'llm', amountUsd: 2, basis: 'provider_reported' },
      { component: 'llm', amountUsd: 3, basis: 'invoiced' },
      { component: 'tts', amountUsd: 4, basis: 'estimated' },
    ]);
    expect(s.totalUsd).toBe(7);
    expect(s.byBasisUsd).toEqual({ estimated: 4, provider_reported: 0, invoiced: 3 });
  });
});

describe('margin math', () => {
  it('margin % is null when revenue is zero (free tier)', () => {
    expect(grossMargin(0, 5).marginPct).toBeNull();
    expect(grossMargin(100, 25).marginPct).toBe(75);
  });
  it('percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 10)).toBeCloseTo(1.4);
  });
  it('max profitable minutes', () => {
    expect(maxProfitableMinutes(79, 0, 0)).toBeNull();
    expect(maxProfitableMinutes(10, 20, 1)).toBe(0);
    expect(maxProfitableMinutes(100, 0, 0.25)).toBe(400);
  });
});

describe('extractVapiCostLines', () => {
  it('maps known components and classifies carrier direction', () => {
    const l = extractVapiCostLines({
      cost: 0.1,
      costBreakdown: { transport: 0.01, stt: 0.02, llm: 0.03, tts: 0.02, vapi: 0.02 },
      call: { type: 'inboundPhoneCall' },
    });
    expect(l.map((x) => x.component)).toEqual(['carrier_inbound', 'asr', 'llm', 'tts', 'voice_platform']);
  });
  it('keeps an unbroken total, an unexplained remainder, and never guesses direction', () => {
    expect(extractVapiCostLines({ cost: 0.5 })[0].component).toBe('provider_total_unbroken');
    expect(extractVapiCostLines({ cost: 0.2, costBreakdown: { llm: 0.1 } })[1]).toEqual({ component: 'provider_other', amountUsd: 0.1 });
    expect(extractVapiCostLines({ costBreakdown: { transport: 1 }, call: {} })[0].component).toBe('carrier_unclassified');
  });
  it('ignores negative / non-numeric values', () => {
    expect(extractVapiCostLines({ cost: -1, costBreakdown: { llm: 'x' } })).toEqual([]);
  });
});
