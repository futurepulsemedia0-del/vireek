import { describe, it, expect } from 'vitest';
import {
  SCORE_FACTORS,
  centsToRateInput,
  emptyRequirements,
  isCredentialActive,
  marketState,
  parseRateToCents,
  parseRegionsInput,
  requirementsActive,
  toggleInArray,
  topFactors,
} from './capacityLiquidity';

describe('score factors', () => {
  it('sum to exactly 100 points', () => {
    expect(SCORE_FACTORS.reduce((s, f) => s + f.max, 0)).toBe(100);
  });
});

describe('marketState', () => {
  it('handles empty, tight, balanced and surplus markets', () => {
    expect(marketState(0, 0)).toBe('quiet');
    expect(marketState(5, 0)).toBe('tight');
    expect(marketState(17, 3)).toBe('tight');
    expect(marketState(3, 3)).toBe('balanced');
    expect(marketState(0, 4)).toBe('surplus');
    expect(marketState(1, 4)).toBe('surplus');
  });
});

describe('parseRateToCents', () => {
  it('parses valid dollar amounts', () => {
    expect(parseRateToCents('85')).toBe(8500);
    expect(parseRateToCents('$85.5')).toBe(8550);
    expect(parseRateToCents('  ')).toBeNull();
  });
  it('rejects junk', () => {
    expect(Number.isNaN(parseRateToCents('abc'))).toBe(true);
    expect(Number.isNaN(parseRateToCents('-5'))).toBe(true);
    expect(Number.isNaN(parseRateToCents('1.234'))).toBe(true);
  });
  it('round-trips through centsToRateInput', () => {
    expect(centsToRateInput(8500)).toBe('85');
    expect(centsToRateInput(8550)).toBe('85.50');
    expect(centsToRateInput(null)).toBe('');
  });
});

describe('parseRegionsInput', () => {
  it('splits on ; and newline, lowercases and dedupes', () => {
    expect(parseRegionsInput('Austin, TX; dallas\nAUSTIN, tx ;')).toEqual(['austin, tx', 'dallas']);
    expect(parseRegionsInput('')).toEqual([]);
  });
});

describe('isCredentialActive', () => {
  const today = new Date('2027-03-10T12:00:00Z');
  it('treats rejected and expired as inactive', () => {
    expect(isCredentialActive({ status: 'rejected', expires_on: null }, today)).toBe(false);
    expect(isCredentialActive({ status: 'verified', expires_on: '2027-03-09' }, today)).toBe(false);
  });
  it('treats same-day and future expiry (or none) as active', () => {
    expect(isCredentialActive({ status: 'self_declared', expires_on: '2027-03-10' }, today)).toBe(true);
    expect(isCredentialActive({ status: 'verified', expires_on: null }, today)).toBe(true);
  });
});

describe('topFactors / requirements / toggle', () => {
  it('returns only strong factors, best first', () => {
    expect(topFactors({ geo: 20, skills: 6, quality: 9, trust: 1 })).toEqual(['Location', 'Quality']);
    expect(topFactors(null)).toEqual([]);
  });
  it('detects when any requirement is set', () => {
    expect(requirementsActive(emptyRequirements)).toBe(false);
    expect(requirementsActive({ ...emptyRequirements, requiresInsurance: true })).toBe(true);
    expect(requirementsActive({ ...emptyRequirements, maxHourlyRate: '90' })).toBe(true);
  });
  it('toggles membership immutably', () => {
    const a = ['x'];
    expect(toggleInArray(a, 'y')).toEqual(['x', 'y']);
    expect(toggleInArray(a, 'x')).toEqual([]);
    expect(a).toEqual(['x']);
  });
});
