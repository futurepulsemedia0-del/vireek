import { describe, it, expect } from 'vitest';
import { parseAiUsage, priceAiRow, priceAiRows, aiCostByAccount, applyAiRepricing, aiCoverageByModel, aiPricingSummary, type AiUsageRow } from './aiRepricing';
import type { UeTenantRow } from './marginDashboard';
import type { CostRate } from './unitEconomics';

const row = (o: Partial<AiUsageRow>): AiUsageRow => ({ account_id: 'a', provider: 'gemini', model: 'm', input_tokens: 1_000_000, output_tokens: 500_000, calls: 10, estimated_calls: 0, logged_cost_usd: 1.55, ...o });
const rate = (provider: string, unit: string, rateUsd: number): CostRate => ({ component: 'llm', provider, unit, rateUsd, source: 'fixture', effectiveFrom: '2026-01-01', effectiveTo: null });
const D = '2026-11-01';

describe('parseAiUsage', () => {
  it('is defensive', () => {
    expect(parseAiUsage(null)).toEqual({ rows: [], truncated: false });
    const r = parseAiUsage({ rows: [{ provider: 'g', model: 'm', input_tokens: 5, account_id: null }, { nope: 1 }, 'x'], truncated: true });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].account_id).toBeNull();
    expect(r.truncated).toBe(true);
  });
});

describe('priceAiRow', () => {
  it('re-prices from the rate table when both token rates exist', () => {
    const p = priceAiRow(row({}), [rate('gemini', 'per_1m_input_tokens', 0.5), rate('gemini', 'per_1m_output_tokens', 2)], D);
    expect(p.basis).toBe('rate_table');
    expect(p.costUsd).toBeCloseTo(0.5 + 1);
  });
  it('one missing rate falls back to the logged code price (never half-priced)', () => {
    const p = priceAiRow(row({}), [rate('gemini', 'per_1m_input_tokens', 0.5)], D);
    expect(p.basis).toBe('code_list_price');
    expect(p.costUsd).toBe(1.55);
  });
  it('tokens used but logged $0 and no rate -> unpriced (Cloudflare case), not silently free', () => {
    const p = priceAiRow(row({ provider: 'cloudflare', logged_cost_usd: 0 }), [], D);
    expect(p.basis).toBe('unpriced');
    expect(p.costUsd).toBe(0);
  });
  it('respects effective dates', () => {
    const rates = [{ ...rate('gemini', 'per_1m_input_tokens', 1), effectiveTo: '2026-06-01' }, { ...rate('gemini', 'per_1m_output_tokens', 1), effectiveTo: '2026-06-01' }];
    expect(priceAiRow(row({}), rates, D).basis).toBe('code_list_price');
  });
});

describe('aggregation', () => {
  const rates = [rate('gemini', 'per_1m_input_tokens', 1), rate('gemini', 'per_1m_output_tokens', 1)];
  const priced = priceAiRows([row({ account_id: 'a' }), row({ account_id: 'a', model: 'm2', provider: 'groq', logged_cost_usd: 2 }), row({ account_id: null, provider: 'cloudflare', logged_cost_usd: 0, calls: 4, estimated_calls: 2 })], rates, D);
  it('per-account cost ignores platform rows', () => {
    const m = aiCostByAccount(priced);
    expect(m.get('a')).toBeCloseTo(1.5 + 2);
    expect(m.size).toBe(1);
  });
  it('summary splits bases and counts unpriced calls', () => {
    const s = aiPricingSummary(priced);
    expect(s.rateTableUsd).toBeCloseTo(1.5);
    expect(s.codeListUsd).toBeCloseTo(2);
    expect(s.unpricedCalls).toBe(4);
    expect(s.estimatedTokenCalls).toBe(2);
    expect(s.totalCalls).toBe(24);
  });
  it('coverage by model sorts by cost and reports the estimated-token share', () => {
    const c = aiCoverageByModel(priced);
    expect(c[0].provider).toBe('groq');
    expect(c.find((x) => x.provider === 'cloudflare')?.estimatedTokenShare).toBeCloseTo(0.5);
  });
});

describe('applyAiRepricing', () => {
  const t = (id: string, ai: number): UeTenantRow => ({ account_id: id, email: null, company_name: null, plan: 'starter', voice_seconds: 0, voice_calls: 0, reported_voice_cost_usd: 0, calls_with_cost: 0, ai_cost_usd: ai });
  const m = new Map([['a', 7]]);
  it('overrides present accounts; absent ones are zero unless truncated', () => {
    expect(applyAiRepricing([t('a', 1), t('b', 5)], m, false).map((x) => x.ai_cost_usd)).toEqual([7, 0]);
    expect(applyAiRepricing([t('a', 1), t('b', 5)], m, true).map((x) => x.ai_cost_usd)).toEqual([7, 5]);
  });
});
