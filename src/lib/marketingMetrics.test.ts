import { describe, it, expect, vi } from 'vitest';

// marketingMetrics imports the Supabase client; the pure builder doesn't need it.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { buildMarketingKpis, type MarketingPeriodCounts } from './marketingMetrics';

const counts = (over: Partial<MarketingPeriodCounts> = {}): MarketingPeriodCounts => ({
  leads: 0,
  touches: 0,
  enrollments: 0,
  conversions: 0,
  referralCodes: 0,
  referralConversions: 0,
  ...over,
});

describe('buildMarketingKpis', () => {
  it('returns one KPI per metric, in a stable order', () => {
    const kpis = buildMarketingKpis(counts(), counts(), true);
    expect(kpis.map((k) => k.key)).toEqual([
      'leads',
      'touches',
      'enrollments',
      'conversions',
      'referralCodes',
      'referralConversions',
    ]);
  });

  it('attaches a delta to every KPI when comparing', () => {
    const kpis = buildMarketingKpis(
      counts({ leads: 12, enrollments: 3 }),
      counts({ leads: 10, enrollments: 0 }),
      true,
    );
    expect(kpis.every((k) => k.delta !== null)).toBe(true);
    expect(kpis.find((k) => k.key === 'leads')?.delta).toMatchObject({
      direction: 'up',
      value: 20,
    });
    expect(kpis.find((k) => k.key === 'enrollments')?.delta).toMatchObject({ direction: 'new' });
    expect(kpis.find((k) => k.key === 'touches')?.delta).toMatchObject({ direction: 'flat' });
  });

  it('omits deltas when comparison is off or the previous period is unavailable', () => {
    expect(
      buildMarketingKpis(counts({ leads: 5 }), counts(), false).every((k) => k.delta === null),
    ).toBe(true);
    expect(
      buildMarketingKpis(counts({ leads: 5 }), null, true).every((k) => k.delta === null),
    ).toBe(true);
  });
});
