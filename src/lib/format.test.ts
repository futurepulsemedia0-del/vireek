import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  getActiveLocale,
  resolveLocale,
} from '@/lib/format';

const DATE = new Date(Date.UTC(2026, 9, 11, 12, 0, 0)); // 11 Oct 2026

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('resolveLocale', () => {
  it('maps every supported language to a Gregorian locale tag', () => {
    for (const lang of ['en', 'es', 'fr', 'de', 'ar', 'fa', 'hi', 'ja', 'zh']) {
      expect(resolveLocale(lang)).toContain('-u-ca-gregory');
    }
  });

  it('uses Latin digits for Arabic and Persian digits for Farsi', () => {
    expect(resolveLocale('ar')).toContain('nu-latn');
    expect(resolveLocale('fa')).toContain('nu-arabext');
  });

  it('falls back to English for unknown languages and region variants resolve by base', () => {
    expect(resolveLocale('xx')).toMatch(/^en-US/);
    expect(resolveLocale('fa-IR')).toMatch(/^fa-IR/);
  });

  it('follows the active i18n language', async () => {
    expect(getActiveLocale()).toMatch(/^en-US/);
    await i18n.changeLanguage('de');
    expect(getActiveLocale()).toMatch(/^de-DE/);
  });
});

describe('numbers', () => {
  it('formats per locale', () => {
    expect(formatNumber(1234567.891, { maximumFractionDigits: 2 }, 'en')).toBe('1,234,567.89');
    expect(formatNumber(1234567.891, { maximumFractionDigits: 2 }, 'de')).toBe('1.234.567,89');
    expect(formatNumber(1234.5, undefined, 'fa')).toMatch(/^[۰-۹٬٫]+$/);
    expect(formatNumber(1234.5, undefined, 'ar')).toMatch(/^[0-9.,٬٫]+$/);
  });

  it('formats percent from a fraction and compact numbers', () => {
    expect(formatPercent(0.684, undefined, 'en')).toBe('68%');
    expect(formatCompact(1_250_000, 'en')).toBe('1.3M');
  });

  it('returns an em dash for null, undefined and non-finite values', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('currency', () => {
  it('formats with the right symbol placement per locale', () => {
    expect(formatCurrency(1250, 'USD', undefined, 'en')).toBe('$1,250.00');
    expect(formatCurrency(1250, 'EUR', undefined, 'de').replace(/\s/g, ' ')).toBe('1.250,00 €');
    expect(formatCurrency(1250, 'USD', { maximumFractionDigits: 0 }, 'ja')).toMatch(/\$1,250|＄1,250/);
  });

  it('does not throw on an invalid currency code', () => {
    expect(() => formatCurrency(10, 'NOPE', undefined, 'en')).not.toThrow();
  });
});

describe('dates', () => {
  it('formats Gregorian dates in every locale (never Jalali by default)', () => {
    expect(formatDate(DATE, { dateStyle: 'long', timeZone: 'UTC' }, 'en')).toBe('October 11, 2026');
    const fa = formatDate(DATE, { dateStyle: 'long', timeZone: 'UTC' }, 'fa');
    expect(fa).toContain('۲۰۲۶'); // Gregorian year in Persian digits, not 1405
    expect(fa).not.toContain('۱۴۰۵');
  });

  it('accepts Date, ISO string and epoch ms; invalid input yields an em dash', () => {
    const opts = { dateStyle: 'medium', timeZone: 'UTC' } as const;
    const expected = formatDate(DATE, opts, 'en');
    expect(formatDate(DATE.toISOString(), opts, 'en')).toBe(expected);
    expect(formatDate(DATE.getTime(), opts, 'en')).toBe(expected);
    expect(formatDate('not a date')).toBe('—');
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });

  it('formats relative time with the active language', () => {
    const now = DATE.getTime();
    expect(formatRelativeTime(now - 2 * 3_600_000, now, 'en')).toBe('2 hours ago');
    expect(formatRelativeTime(now + 3 * 86_400_000, now, 'en')).toBe('in 3 days');
    expect(formatRelativeTime(now - 2 * 3_600_000, now, 'es')).toBe('hace 2 horas');
    expect(formatRelativeTime('garbage')).toBe('—');
  });
});

describe('lists', () => {
  it('joins with locale conjunctions', () => {
    expect(formatList(['A', 'B', 'C'], 'conjunction', 'en')).toBe('A, B, and C');
    expect(formatList(['A', 'B', 'C'], 'conjunction', 'de')).toBe('A, B und C');
  });
});
