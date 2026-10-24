import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_REGIONAL, centsToStripeMinor, convertCents, currencyDecimals, formatArea, formatCentsIn,
  formatDistance, formatMoney, formatTemperature, formatWeight, isFxStale, normalizeRegional,
  parseLocalizedNumber, presetForCountry, rateBetween, roundCents, setActiveRegional, splitTax,
  stripeMinorToCents, sumInReportingCurrency, type FxTable,
} from './regional';

const fx: FxTable = { base: 'USD', asOf: '2027-04-15', rates: { EUR: 0.9, GBP: 0.8, JPY: 150, USD: 1 } };

beforeEach(() => setActiveRegional(DEFAULT_REGIONAL));

describe('currency decimals & rounding', () => {
  it('knows zero-decimal currencies', () => {
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('usd')).toBe(2);
  });
  it('rounds stored cents to what the currency can express', () => {
    expect(roundCents(123456, 'JPY')).toBe(123500);
    expect(roundCents(123456, 'USD')).toBe(123456);
    expect(roundCents(Number.NaN, 'USD')).toBe(0);
  });
  it('converts to/from Stripe minor units', () => {
    expect(centsToStripeMinor(150000, 'JPY')).toBe(1500);
    expect(centsToStripeMinor(1999, 'EUR')).toBe(1999);
    expect(stripeMinorToCents(1500, 'JPY')).toBe(150000);
  });
});

describe('formatMoney / formatCentsIn', () => {
  it('keeps the legacy USD look under defaults', () => {
    expect(formatCentsIn(123456)).toBe('$1,234.56');
    expect(formatCentsIn(500, 'USD', { trimZeros: true })).toBe('$5');
  });
  it('formats per currency and locale', () => {
    expect(formatMoney(1234.5, 'EUR', { locale: 'de-DE' })).toMatch(/^1\.234,50\s€$/);
    expect(formatMoney(1500, 'JPY', { locale: 'ja-JP' })).toMatch(/1,500/);
    expect(formatMoney(1500, 'JPY', { locale: 'ja-JP' })).not.toMatch(/\./);
  });
  it('uses the active business region by default', () => {
    setActiveRegional(normalizeRegional({ country: 'DE' }));
    expect(formatCentsIn(123450)).toMatch(/^1\.234,50\s€$/);
  });
  it('falls back safely for null, NaN and unknown currency', () => {
    expect(formatCentsIn(null)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(5, 'ZZZ')).toBe('$5.00');
  });
  it('code display is unambiguous for mixed tables', () => {
    expect(formatMoney(10, 'CAD', { display: 'code', locale: 'en-US' })).toMatch(/CAD/);
  });
});

describe('parseLocalizedNumber', () => {
  it('reads each locale convention', () => {
    expect(parseLocalizedNumber('1,234.56', 'en-US')).toBe(1234.56);
    expect(parseLocalizedNumber('1.234,56', 'de-DE')).toBe(1234.56);
    expect(parseLocalizedNumber('  42 ', 'en-US')).toBe(42);
  });
  it('rejects junk', () => {
    expect(parseLocalizedNumber('', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('abc', 'en-US')).toBeNull();
  });
});

describe('normalizeRegional', () => {
  it('applies the country preset when fields are missing', () => {
    const r = normalizeRegional({ country: 'de' });
    expect(r).toMatchObject({ country: 'DE', currency: 'EUR', locale: 'de-DE', taxRegime: 'vat', defaultTaxRate: 19, unitSystem: 'metric', pricesIncludeTax: true });
  });
  it('reads snake_case DB rows and honours explicit overrides', () => {
    const r = normalizeRegional({ country: 'GB', currency: 'usd', reporting_currency: 'EUR', unit_system: 'metric', prices_include_tax: false });
    expect(r).toMatchObject({ currency: 'USD', reportingCurrency: 'EUR', unitSystem: 'metric', pricesIncludeTax: false });
  });
  it('rejects invalid input instead of trusting it', () => {
    const r = normalizeRegional({ currency: 'XXX', locale: 'not a locale!!', tax_regime: 'weird', default_tax_rate: 999, country: 'USA' });
    expect(r.currency).toBe('USD');
    expect(r.locale).toBe('en-US');
    expect(r.taxRegime).toBe('sales_tax');
    expect(r.defaultTaxRate).toBe(30);
    expect(r.country).toBe('US');
  });
  it('uses profile fallbacks when no row exists', () => {
    expect(normalizeRegional(null, { currency: 'AUD', country: 'AU' })).toMatchObject({ currency: 'AUD', taxLabel: 'GST' });
  });
  it('presetForCountry is null for unknown countries', () => {
    expect(presetForCountry('ZZ')).toBeNull();
  });
});

describe('splitTax', () => {
  it('adds tax on a net amount (US style)', () => {
    expect(splitTax(10000, 8.25, false, 'USD')).toEqual({ netCents: 10000, taxCents: 825, grossCents: 10825 });
  });
  it('extracts tax from a gross amount (VAT style) and always balances', () => {
    const s = splitTax(11900, 19, true, 'EUR');
    expect(s).toEqual({ netCents: 10000, taxCents: 1900, grossCents: 11900 });
    const odd = splitTax(9999, 19, true, 'EUR');
    expect(odd.netCents + odd.taxCents).toBe(odd.grossCents);
  });
  it('rounds to whole units for zero-decimal currencies', () => {
    const s = splitTax(110000, 10, true, 'JPY');
    expect(s.netCents % 100).toBe(0);
    expect(s.taxCents % 100).toBe(0);
    expect(s.netCents + s.taxCents).toBe(s.grossCents);
  });
  it('treats bad rates as zero', () => {
    expect(splitTax(1000, -5, false, 'USD').taxCents).toBe(0);
    expect(splitTax(1000, Number.NaN, true, 'USD').netCents).toBe(1000);
  });
});

describe('exchange rates', () => {
  it('computes direct and cross rates', () => {
    expect(rateBetween('USD', 'EUR', fx)).toBeCloseTo(0.9);
    expect(rateBetween('EUR', 'USD', fx)).toBeCloseTo(1 / 0.9);
    expect(rateBetween('EUR', 'GBP', fx)).toBeCloseTo(0.8 / 0.9);
    expect(rateBetween('USD', 'USD', null)).toBe(1);
  });
  it('returns null for unknown currencies instead of guessing', () => {
    expect(rateBetween('USD', 'AUD', fx)).toBeNull();
    expect(rateBetween('USD', 'EUR', null)).toBeNull();
  });
  it('converts cents and prefers a locked rate', () => {
    expect(convertCents(10000, 'USD', 'EUR', fx)).toBe(9000);
    expect(convertCents(10000, 'USD', 'EUR', fx, 0.5)).toBe(5000);
    expect(convertCents(10000, 'USD', 'JPY', fx)).toBe(1500000);
  });
  it('flags stale tables', () => {
    expect(isFxStale('2027-04-15', new Date('2027-04-16T00:00:00Z'))).toBe(false);
    expect(isFxStale('2027-04-01', new Date('2027-04-16T00:00:00Z'))).toBe(true);
    expect(isFxStale(null)).toBe(true);
  });
  it('sums mixed currencies and never treats a missing rate as 1:1', () => {
    const r = sumInReportingCurrency(
      [{ cents: 10000, currency: 'USD' }, { cents: 9000, currency: 'EUR' }, { cents: 5000, currency: 'AUD' }, { cents: 8000, currency: 'GBP', lockedRate: 1.25 }],
      'USD', fx,
    );
    expect(r.totalCents).toBe(10000 + 10000 + 10000);
    expect(r.missing).toEqual(['AUD']);
    expect(r.converted).toBe(true);
  });
  it('same-currency totals are untouched even with no rate table', () => {
    const r = sumInReportingCurrency([{ cents: 100, currency: 'USD' }, { cents: 250, currency: 'usd' }], 'USD', null);
    expect(r).toEqual({ totalCents: 350, missing: [], converted: false });
  });
});

describe('units', () => {
  it('imperial stays imperial, metric converts', () => {
    expect(formatDistance(10, 'imperial', 'en-US')).toMatch(/10 mi/);
    expect(formatDistance(10, 'metric', 'en-US')).toMatch(/16\.1 km/);
    expect(formatWeight(10, 'metric', 'en-US')).toMatch(/4\.54 kg/);
    expect(formatTemperature(212, 'metric', 'en-US')).toMatch(/100/);
    expect(formatArea(1000, 'metric', 'en-US')).toBe('92.9 m²');
    expect(formatArea(1000, 'imperial', 'en-US')).toBe('1,000 sq ft');
  });
  it('follows the active region when no system is passed', () => {
    setActiveRegional(normalizeRegional({ country: 'DE' }));
    expect(formatDistance(1, undefined, 'en-US')).toMatch(/km/);
  });
  it('handles empty values', () => {
    expect(formatDistance(null)).toBe('—');
    expect(formatWeight(undefined)).toBe('—');
  });
});
