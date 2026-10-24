import { describe, it, expect } from 'vitest';
import { DEFAULT_REGIONAL, buildRegionalVoiceContext, formatCents, loadRegional, milesToKm, normalizeRegional, spokenMoney } from './regional';

describe('normalizeRegional', () => {
  it('defaults to the US setup', () => {
    expect(normalizeRegional(null)).toMatchObject({ currency: 'USD', unitSystem: 'imperial', isDefault: true });
  });
  it('applies country presets and DB overrides', () => {
    expect(normalizeRegional({ country: 'DE' })).toMatchObject({ currency: 'EUR', locale: 'de-DE', pricesIncludeTax: true, defaultTaxRate: 19, isDefault: false });
    expect(normalizeRegional({ country: 'DE', currency: 'USD', unit_system: 'imperial', prices_include_tax: false, locale: 'en-US' }).isDefault).toBe(true);
  });
  it('rejects garbage', () => {
    expect(normalizeRegional({ currency: 'x', country: 'zzz', locale: '??' })).toMatchObject({ currency: 'USD', country: 'US', locale: 'en-US' });
  });
});

describe('money', () => {
  it('formats stored cents per currency', () => {
    expect(formatCents(123456, 'USD', 'en-US')).toBe('$1,234.56');
    expect(formatCents(123450, 'EUR', 'de-DE')).toMatch(/^1\.234,50\s€$/);
    expect(formatCents(150000, 'JPY', 'ja-JP')).toMatch(/1,500/);
    expect(formatCents(Number.NaN)).toBe('');
  });
  it('speaks money for text-to-speech', () => {
    expect(spokenMoney(4950, 'EUR', 'en-IE')).toBe('49.50 euros');
    expect(spokenMoney(5000, 'USD', 'en-US')).toBe('50 US dollars');
  });
  it('converts units', () => expect(milesToKm(10)).toBeCloseTo(16.09, 1));
});

describe('buildRegionalVoiceContext', () => {
  it('is empty for default US businesses (prompt unchanged)', () => {
    expect(buildRegionalVoiceContext(DEFAULT_REGIONAL)).toBe('');
  });
  it('tells the agent currency, tax and units for a German business', () => {
    const t = buildRegionalVoiceContext(normalizeRegional({ country: 'DE' }));
    expect(t).toContain('EUR');
    expect(t).toContain('never say or assume dollars');
    expect(t).toContain('already include VAT (19%)');
    expect(t).toContain('kilometers');
  });
});

describe('loadRegional', () => {
  const mk = (rows: Record<string, unknown>) => ({
    from: (t: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[t] ?? null }) }) }) }),
  });
  it('reads the settings row', async () => {
    expect((await loadRegional(mk({ business_regional_settings: { country: 'GB' } }), 'u')).currency).toBe('GBP');
  });
  it('falls back to the legacy profile columns', async () => {
    expect((await loadRegional(mk({ profiles: { invoice_currency: 'AUD', business_country: 'AU' } }), 'u')).currency).toBe('AUD');
  });
  it('never throws', async () => {
    const broken = { from: () => { throw new Error('db down'); } };
    expect(await loadRegional(broken, 'u')).toEqual(DEFAULT_REGIONAL);
  });
});
