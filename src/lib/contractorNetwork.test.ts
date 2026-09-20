import { describe, it, expect } from 'vitest';
import {
  calcReferralFeeCents,
  compareFeed,
  describeNetworkError,
  formatMoney,
  formatTimeLeft,
  isUrgent,
  parseDollarsToCents,
  type NetworkHandoff,
} from './contractorNetwork';

const NOW = new Date('2026-11-01T12:00:00Z').getTime();
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

const make = (over: Partial<NetworkHandoff>): NetworkHandoff =>
  ({
    id: 'x',
    kind: 'capacity_overflow',
    status: 'open',
    expires_at: inMinutes(120),
    created_at: inMinutes(-10),
    ...over,
  }) as NetworkHandoff;

describe('parseDollarsToCents', () => {
  it('parses plain, decimal, currency-formatted and comma input without float drift', () => {
    expect(parseDollarsToCents('450')).toBe(45000);
    expect(parseDollarsToCents('450.5')).toBe(45050);
    expect(parseDollarsToCents('$1,234.56')).toBe(123456);
    expect(parseDollarsToCents('19.99')).toBe(1999); // 19.99 * 100 === 1998.9999999999998 in floats
  });

  it('rejects empty, negative, malformed and overflowing input', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
    expect(parseDollarsToCents('99999999999')).toBeNull();
  });
});

describe('money helpers', () => {
  it('formats cents', () => {
    expect(formatMoney(6250)).toBe('$62.50');
    expect(formatMoney(null)).toBe('—');
  });

  it('matches the SQL referral-fee math (500.00 @ 12.5% = 62.50)', () => {
    expect(calcReferralFeeCents(50000, 12.5)).toBe(6250);
    expect(calcReferralFeeCents(0, 10)).toBe(0);
  });
});

describe('formatTimeLeft / isUrgent', () => {
  it('formats minutes, hours, days and expiry', () => {
    expect(formatTimeLeft(inMinutes(42), NOW)).toBe('42m left');
    expect(formatTimeLeft(inMinutes(130), NOW)).toBe('2h 10m left');
    expect(formatTimeLeft(inMinutes(120), NOW)).toBe('2h left');
    expect(formatTimeLeft(inMinutes(60 * 24 * 3 + 5), NOW)).toBe('3d left');
    expect(formatTimeLeft(inMinutes(-1), NOW)).toBe('Expired');
    expect(formatTimeLeft('not-a-date', NOW)).toBe('Expired');
  });

  it('flags only open emergencies with under an hour left', () => {
    expect(isUrgent(make({ kind: 'emergency', expires_at: inMinutes(30) }), NOW)).toBe(true);
    expect(isUrgent(make({ kind: 'emergency', expires_at: inMinutes(90) }), NOW)).toBe(false);
    expect(isUrgent(make({ kind: 'capacity_overflow', expires_at: inMinutes(30) }), NOW)).toBe(
      false,
    );
    expect(
      isUrgent(make({ kind: 'emergency', status: 'claimed', expires_at: inMinutes(30) }), NOW),
    ).toBe(false);
  });
});

describe('compareFeed', () => {
  it('puts emergencies first, then soonest-expiring', () => {
    const list = [
      make({ id: 'late', expires_at: inMinutes(600) }),
      make({ id: 'soon', expires_at: inMinutes(60) }),
      make({ id: 'emerg', kind: 'emergency', expires_at: inMinutes(170) }),
    ].sort(compareFeed);
    expect(list.map((h) => h.id)).toEqual(['emerg', 'soon', 'late']);
  });
});

describe('describeNetworkError', () => {
  it('maps RPC codes to friendly copy', () => {
    expect(describeNetworkError(new Error('HANDOFF_UNAVAILABLE'))).toMatch(/no longer available/);
    expect(describeNetworkError({ message: 'PII_IN_PUBLIC_FIELDS' })).toMatch(/phone numbers/);
  });

  it('falls back safely for unknown errors', () => {
    expect(describeNetworkError(new Error('boom'))).toBe('Something went wrong. Please try again.');
    expect(describeNetworkError(null)).toBe('Something went wrong. Please try again.');
  });
});
