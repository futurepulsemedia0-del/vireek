import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { formatDateTime, formatDuration, formatPhone, formatRelative } from '@/lib/format';
import { DEFAULT_REGIONAL, normalizeRegional, setActiveRegional } from '@/lib/regional';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

afterEach(async () => {
  setActiveRegional(DEFAULT_REGIONAL);
  await i18n.changeLanguage('en');
});

describe('formatRelative', () => {
  it('says "now" under 45 seconds and relative text up to the cutoff', () => {
    expect(formatRelative(NOW - 10_000, { now: NOW, lang: 'en' })).toBe('now');
    expect(formatRelative(NOW - 5 * 60_000, { now: NOW, lang: 'en' })).toBe('5 minutes ago');
    expect(formatRelative(NOW + 3 * 3_600_000, { now: NOW, lang: 'en' })).toBe('in 3 hours');
  });

  it('switches to an absolute date at the threshold (default 7 days)', () => {
    expect(formatRelative(NOW - 6 * 86_400_000, { now: NOW, lang: 'en' })).toBe('6 days ago');
    expect(formatRelative(NOW - 8 * 86_400_000, { now: NOW, lang: 'en' })).toBe('Oct 21, 2026');
    expect(formatRelative(NOW - 2 * 86_400_000, { now: NOW, lang: 'en', absoluteAfterMs: 86_400_000 })).toBe('Oct 27, 2026');
  });

  it('returns the empty marker for empty or invalid input', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative('not a date')).toBe('—');
  });

  it('localizes (German)', () => {
    expect(formatRelative(NOW - 5 * 60_000, { now: NOW, lang: 'de' })).toBe('vor 5 Minuten');
  });
});

describe('formatDuration', () => {
  it('formats the two largest units and clamps negatives', () => {
    expect(formatDuration(4500, { lang: 'en' })).toBe('1 hr, 15 min');
    expect(formatDuration(90_061, { lang: 'en' })).toBe('1 day, 1 hr');
    expect(formatDuration(0, { lang: 'en' })).toBe('0 sec');
    expect(formatDuration(-30, { lang: 'en' })).toBe('0 sec');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatPhone', () => {
  it('formats NANP numbers and leaves others normalized', () => {
    expect(formatPhone('+14155550132')).toBe('(415) 555-0132');
    expect(formatPhone('415.555.0132')).toBe('(415) 555-0132');
    expect(formatPhone('+49 30 1234567')).toBe('+49301234567');
    expect(formatPhone('555-0132 ext 4')).toBe('555-0132 ext 4');
    expect(formatPhone('')).toBe('—');
  });
});

describe('organization clock style', () => {
  const at = new Date(Date.UTC(2026, 9, 29, 15, 0, 0));
  const opts = { timeStyle: 'short', timeZone: 'UTC' } as const;

  it('forces 24h or 12h when the organization chose one, otherwise follows the locale', () => {
    expect(formatDateTime(at, opts, 'en')).toContain('PM');
    setActiveRegional({ ...DEFAULT_REGIONAL, hourCycle: '24h' });
    expect(formatDateTime(at, opts, 'en')).toBe('15:00');
    setActiveRegional({ ...DEFAULT_REGIONAL, hourCycle: '12h' });
    expect(formatDateTime(at, opts, 'de')).toContain('PM');
  });
});

describe('normalizeRegional — time zone and clock style', () => {
  it('accepts valid values and rejects invalid ones', () => {
    const ok = normalizeRegional({ time_zone: 'America/Chicago', hour_cycle: '24h' });
    expect(ok.timeZone).toBe('America/Chicago');
    expect(ok.hourCycle).toBe('24h');
    const bad = normalizeRegional({ time_zone: 'Mars/Base', hour_cycle: 'weird' });
    expect(bad.timeZone).toBeNull();
    expect(bad.hourCycle).toBe('auto');
  });
});

describe('graceful fallback for missing translations', () => {
  it('uses defaultValue for an unknown key and English for an unknown language', () => {
    expect(i18n.t('does.not.exist', { defaultValue: 'Fallback text' })).toBe('Fallback text');
    expect(i18n.t('nav.features', { lng: 'xx' })).toBe(i18n.t('nav.features', { lng: 'en' }));
  });
});
