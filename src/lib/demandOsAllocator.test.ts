import { describe, it, expect } from 'vitest';
import { allocateBudgets, type CampaignEconomics, type AllocatorSettings } from '../../supabase/functions/_shared/ads/allocator';

const base: AllocatorSettings = { maxShiftPct: 15, cooldownDays: 7, minSpendCents: 30000, minJobs: 5, allowGrowth: false, totalDailyCapCents: null };
const camp = (o: Partial<CampaignEconomics> & { campaignId: string }): CampaignEconomics => ({
  platform: 'google_ads', name: o.campaignId, market: null, status: 'enabled', dailyBudgetCents: 10000, budgetEditable: true,
  lastBudgetChangeAt: null, spendCents: 500000, leads: 50, jobsWon: 20, revenueCents: 1200000, grossProfitCents: 600000, ...o,
});

describe('allocateBudgets', () => {
  // The brief's example: A = many leads, low profit; B = fewer leads, high profit.
  const A = camp({ campaignId: 'A', leads: 200, jobsWon: 40, revenueCents: 5_000_000, grossProfitCents: 800_000 });
  const B = camp({ campaignId: 'B', leads: 80, jobsWon: 30, revenueCents: 4_400_000, grossProfitCents: 1_700_000 });

  it('moves budget from the low-profit campaign to the high-profit one', () => {
    const { recommendations } = allocateBudgets([A, B], base);
    const a = recommendations.find((r) => r.campaignId === 'A');
    const b = recommendations.find((r) => r.campaignId === 'B');
    expect(a?.direction).toBe('decrease');
    expect(b?.direction).toBe('increase');
  });

  it('is budget-neutral unless growth is allowed', () => {
    const { recommendations } = allocateBudgets([A, B], base);
    const net = recommendations.reduce((s, r) => s + r.deltaCents, 0);
    expect(net).toBeLessThanOrEqual(0);
  });

  it('never exceeds the max shift per campaign', () => {
    for (const r of allocateBudgets([A, B], base).recommendations) {
      expect(Math.abs(r.deltaCents) / r.currentBudgetCents).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });

  it('respects cooldown and minimum evidence', () => {
    const cooling = { ...A, lastBudgetChangeAt: new Date().toISOString() };
    const thin = camp({ campaignId: 'T', spendCents: 1000, jobsWon: 0 });
    const res = allocateBudgets([cooling, B, thin], base);
    expect(res.skipped.find((s) => s.campaignId === 'A')?.reason).toBe('cooldown');
    expect(res.skipped.find((s) => s.campaignId === 'T')?.reason).toBe('insufficient_evidence');
  });

  it('flags non-editable campaigns as not applyable and does not fund growth from them', () => {
    const lsa = { ...A, budgetEditable: false, platform: 'google_lsa' as const };
    const { recommendations } = allocateBudgets([lsa, B], base);
    expect(recommendations.find((r) => r.campaignId === 'A')?.applyable).toBe(false);
    expect(recommendations.find((r) => r.campaignId === 'B')).toBeUndefined();
  });

  it('cuts a campaign that burned budget with zero jobs', () => {
    const dead = camp({ campaignId: 'Z', spendCents: 400000, jobsWon: 0, leads: 90, grossProfitCents: 0, revenueCents: 0 });
    const { recommendations } = allocateBudgets([dead, B], base);
    expect(recommendations.find((r) => r.campaignId === 'Z')?.direction).toBe('decrease');
  });

  it('does not cut a profitable campaign when no better campaign can absorb the money', () => {
    const weak = camp({ campaignId: 'W', spendCents: 500000, jobsWon: 30, grossProfitCents: 900000 });
    const same = camp({ campaignId: 'S', spendCents: 500000, jobsWon: 30, grossProfitCents: 950000 });
    expect(allocateBudgets([weak, same], base).recommendations).toEqual([]);
  });

  it('returns nothing when there is no spend', () => {
    expect(allocateBudgets([camp({ campaignId: 'X', spendCents: 0 })], base).recommendations).toEqual([]);
  });
});
