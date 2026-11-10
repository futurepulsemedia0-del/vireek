import { describe, it, expect } from 'vitest';
import { normalizeRegional, formatMoney, formatCentsIn, DEFAULT_REGIONAL } from '../regional';
import { buildRegionProfile, formatAddress, formatPhoneForRegion } from './profile';

const ws = (s: string) => s.replace(/[\u00a0\u202f]/g, ' '); // ICU versions differ on which space they emit
const prof = (country: string) => buildRegionProfile(normalizeRegional({ country }));

describe('locale formatting snapshots (verified against CLDR output)', () => {
  const cases: Array<[string, string, string, string, string]> = [
    // country, date example, number example, money(1234.5) in profile currency, date order
    ['US', '01/02/2031', '1,234,567.89', '$1,234.50', 'MDY'],
    ['GB', '02/01/2031', '1,234,567.89', '£1,234.50', 'DMY'],
    ['DE', '02.01.2031', '1.234.567,89', '1.234,50 €', 'DMY'],
    ['FR', '02/01/2031', '1 234 567,89', '1 234,50 €', 'DMY'],
    ['CA', '2031-01-02', '1,234,567.89', '$1,234.50', 'YMD'],
    ['AU', '02/01/2031', '1,234,567.89', '$1,234.50', 'DMY'],
    ['JP', '2031/01/02', '1,234,567.89', '￥1,235', 'YMD'],
    ['IN', '02/01/2031', '12,34,567.89', '₹1,234.50', 'DMY'],
  ];
  for (const [country, date, num, money, order] of cases) {
    it(`${country}`, () => {
      const p = prof(country);
      expect(ws(p.formats.date.example)).toBe(date);
      expect(p.formats.date.order).toBe(order);
      expect(ws(p.formats.number.example)).toBe(num);
      expect(ws(formatMoney(1234.5, p.currency, { locale: p.locale }))).toBe(money);
    });
  }
  it('Spain groups 4-digit numbers without a separator (CLDR minimumGroupingDigits=2)', () => {
    expect(ws(formatMoney(1234.5, 'EUR', { locale: 'es-ES' }))).toBe('1234,50 €');
  });
  it('zero-decimal JPY never shows fractions; legacy cents are divided correctly', () => {
    expect(ws(formatCentsIn(100000, 'JPY', { locale: 'ja-JP' }))).toBe('￥1,000');
  });
});

describe('region profile', () => {
  it('default (US) profile is exactly today’s behaviour', () => {
    const p = buildRegionProfile(DEFAULT_REGIONAL);
    expect(p).toMatchObject({ country: 'US', currency: 'USD', locale: 'en-US', unitSystem: 'imperial', weekStart: 0, taxRegime: 'sales_tax', pricesIncludeTax: false, packCovered: true });
    expect(p.formats.address).toMatchObject({ style: 'us', postalLabel: 'ZIP code', subdivisionLabel: 'State' });
  });
  it('flags countries without a regional pack instead of pretending to validate them', () => {
    expect(prof('JP').packCovered).toBe(false);
    expect(prof('JP').formats.phone.callingCode).toBeNull();
    expect(prof('DE').packCovered).toBe(true);
    expect(prof('DE').formats.phone.callingCode).toBe('49');
  });
  it('falls back safely for garbage input (never throws)', () => {
    const p = buildRegionProfile(normalizeRegional({ country: 'zz', locale: 'not a locale', currency: 'XXX' }));
    expect(p.country).toBe('ZZ'); // syntactically valid code is kept; no pack covers it
    expect(p.packCovered).toBe(false);
    expect(p.locale).toBe('en-US');
    expect(p.currency).toBe('USD');
  });
  it('metric/imperial and week start follow the country preset', () => {
    expect(prof('DE')).toMatchObject({ unitSystem: 'metric', weekStart: 1 });
    expect(prof('GB')).toMatchObject({ unitSystem: 'imperial', weekStart: 1 });
  });
});

describe('address & phone layout', () => {
  it('US / GB / DE / CA / AU lay out the way locals write them', () => {
    expect(formatAddress({ line1: '1 Main St', city: 'Austin', subdivision: 'TX', postalCode: '78701' }, 'US')).toBe('1 Main St\nAustin, TX 78701');
    expect(formatAddress({ line1: '10 Downing St', city: 'London', postalCode: 'SW1A 2AA' }, 'GB')).toBe('10 Downing St\nLondon\nSW1A 2AA');
    expect(formatAddress({ line1: 'Hauptstr. 5', city: 'Berlin', postalCode: '10115' }, 'de')).toBe('Hauptstr. 5\n10115 Berlin');
    expect(formatAddress({ line1: '5 King St', city: 'Toronto', subdivision: 'ON', postalCode: 'M5V 2T6' }, 'CA')).toBe('5 King St\nToronto ON M5V 2T6');
    expect(formatAddress({ line1: '1 George St', city: 'Sydney', subdivision: 'NSW', postalCode: '2000' }, 'AU')).toBe('1 George St\nSydney NSW 2000');
  });
  it('drops empty parts and strips control characters / newline injection', () => {
    expect(formatAddress({ line1: 'A\u0000\nB', city: ' ', postalCode: '1' }, 'DE', ' | ')).toBe('A B | 1');
  });
  it('phones: national for same-country numbers, international otherwise, raw fallback for junk', () => {
    expect(formatPhoneForRegion('(512) 555-0147', 'US')).toBe('(512) 555-0147');
    expect(formatPhoneForRegion('+44 20 7946 0958', 'US')).toBe('+44 20 7946 0958');
    expect(formatPhoneForRegion('  12  ', 'US')).toBe('12');
  });
});
