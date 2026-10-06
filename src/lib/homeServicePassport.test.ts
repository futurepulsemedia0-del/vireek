import { describe, expect, it } from 'vitest';
import type { HomeBudget } from '@/lib/homeBudget';
import { buildProjections, formatAddress, formatPassportDate, formatUsd, formatYears } from '@/lib/homeServicePassport';

describe('home service passport helpers', () => {
  it('returns null projections when there is no budget', () => {
    expect(buildProjections(null)).toBeNull();
  });

  it('maps only whitelisted budget fields', () => {
    const budget = {
      annual: 1200,
      annualLow: 900,
      annualHigh: 1700,
      fiveYear: 9000,
      fiveYearLow: 7000,
      fiveYearHigh: 12000,
      suggestedMonthlyReserve: 80,
      confidence: 'medium',
      years: [{ year: 1, maintenance: 300, expectedFailure: 900, total: 1200 }],
      categories: [{ key: 'hvac', label: 'HVAC', annual: 700, fiveYear: 5000, equipmentCount: 1 }],
      assumptions: ['Default US planning costs.'],
      drivers: [{ secret: true }],
    } as unknown as HomeBudget;
    const out = buildProjections(budget);
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('drivers');
    expect(out?.years[0].total).toBe(1200);
    expect(out?.categories[0].key).toBe('hvac');
  });

  it('formats values defensively', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(7500)).toBe('$7,500');
    expect(formatYears(1)).toBe('1 yr');
    expect(formatYears(4.5)).toBe('4.5 yrs');
    expect(formatPassportDate(null)).toBe('—');
    expect(formatPassportDate('not-a-date')).toBe('—');
    expect(formatAddress({ address: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', property_kind: 'residential' })).toBe(
      '1 Main St · Austin, TX 78701',
    );
    expect(formatAddress({ address: null, city: null, state: null, postal_code: null, property_kind: 'residential' })).toBe(
      'Address not on file',
    );
  });
});
