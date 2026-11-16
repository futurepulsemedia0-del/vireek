import { describe, expect, it } from 'vitest';
import { DEFAULT_HOURS, defaultServiceNames, formatSeedPrice, previewSeeds, tradeSlugFor } from './onboardingTradeDefaults';

describe('tradeSlugFor', () => {
  it.each([['hvac', 'hvac'], [' Plumbing ', 'plumbing'], ['electrical', 'electrical'], ['roofing', null], ['', null], [null, null]])('%s → %s', (i, o) => {
    expect(tradeSlugFor(i as string | null)).toBe(o);
  });
});

describe('previewSeeds', () => {
  it('returns one row per job type for supported trades', () => {
    for (const t of ['hvac', 'plumbing', 'electrical'] as const) {
      const rows = previewSeeds(t, 1);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.priceCents > 0 && r.priceCents % 100 === 0)).toBe(true);
    }
  });
  it('scales monotonically with the price level and falls back to 1 on bad input', () => {
    const base = previewSeeds('hvac', 1), high = previewSeeds('hvac', 1.5);
    expect(high.every((r, i) => r.priceCents >= base[i].priceCents)).toBe(true);
    expect(previewSeeds('hvac', Number.NaN)).toEqual(base);
    expect(previewSeeds('hvac', -3)).toEqual(base);
  });
  it('is empty for unsupported or missing trades', () => {
    expect(previewSeeds(null, 1)).toEqual([]);
    expect(defaultServiceNames(null)).toEqual([]);
  });
});

describe('formatSeedPrice', () => {
  it('formats flat and range prices', () => {
    expect(formatSeedPrice({ priceCents: 12900, priceMaxCents: null })).toBe('$129');
    expect(formatSeedPrice({ priceCents: 24900, priceMaxCents: 64900 })).toBe('$249–$649');
  });
});

describe('DEFAULT_HOURS', () => { it('is Mon–Fri 08:00–17:00', () => { expect(Object.keys(DEFAULT_HOURS)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']); }); });
