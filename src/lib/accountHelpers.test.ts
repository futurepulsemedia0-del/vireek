import { describe, it, expect } from 'vitest';
import { checkPassword, formatDate, initialsFor, isValidEmail, isValidPhone, providerLabel, timeAgo } from './accountHelpers';

describe('accountHelpers', () => {
  it('builds initials from first + last word, unicode-safe, with fallbacks', () => {
    expect(initialsFor('Ali Reza Khan', 'a@b.co')).toBe('AK');
    expect(initialsFor('  ali ', null)).toBe('A');
    expect(initialsFor(null, 'zed@x.io')).toBe('Z');
    expect(initialsFor('', '')).toBe('?');
  });

  it('validates email and optional phone', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.d')).toBe(false);
    expect(isValidPhone('')).toBe(true);
    expect(isValidPhone('+1 (650) 910-6703')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('abc1234567')).toBe(false);
    expect(isValidPhone('+1234567890123456')).toBe(false);
  });

  it('scores passwords', () => {
    expect(checkPassword('abc').score).toBe(0);
    expect(checkPassword('abcdefgh').score).toBe(1);
    expect(checkPassword('abcdefG1').score).toBe(3);
    expect(checkPassword('Abcdefg1!xyz').score).toBe(4);
    expect(checkPassword('alicepassword99', 'alice@x.io').score).toBe(1);
  });

  it('formats dates and relative times', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(timeAgo('2026-11-20T11:15:00Z', 'en', now)).toBe('45 minutes ago');
    expect(timeAgo('2026-11-19T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(timeAgo('not-a-date', 'en', now)).toBe('');
    expect(formatDate('2026-01-02T12:00:00Z', 'en')).toBe('Jan 2, 2026');
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('foo')).toBe('Foo');
  });
});
