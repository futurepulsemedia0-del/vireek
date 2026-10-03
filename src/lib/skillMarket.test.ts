import { describe, it, expect, vi } from 'vitest';

// Pure-helper tests must not construct the real Supabase client.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  EQUIPMENT_PRESETS,
  breakdownEntries,
  clampLevel,
  describeMarketError,
  formatRate,
  formatTimeLeft,
  parseRateToCents,
  presetToRequirement,
  requirementsToWire,
  scoreTone,
  tokensFromText,
  validateSearch,
  type SearchParams,
} from '@/lib/skillMarket';

const base: SearchParams = {
  requirements: [presetToRequirement(EQUIPMENT_PRESETS[0], 3)],
  lat: 40.4,
  lng: 49.8,
  urgency: 'standard',
  trade: 'hvac',
  maxRadiusMiles: 60,
  maxHourlyRateCents: null,
  requiresInsurance: false,
  remote: false,
  includeOwnTeam: true,
};

describe('tokensFromText', () => {
  it('slugifies and de-duplicates', () => {
    expect(tokensFromText('Daikin VRV-X, daikin!')).toEqual(['daikin', 'vrv-x']);
  });
  it('drops 1-char noise and caps at 4 tokens', () => {
    expect(tokensFromText('a b cc dd ee ff gg')).toEqual(['cc', 'dd', 'ee', 'ff']);
  });
  it('returns [] for symbols only', () => {
    expect(tokensFromText('!!! ???')).toEqual([]);
  });
  it('truncates long words to 24 chars', () => {
    expect(tokensFromText('x'.repeat(40))[0]).toHaveLength(24);
  });
});

describe('levels and wire format', () => {
  it('clamps level to 1..5', () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(9)).toBe(5);
    expect(clampLevel(2.6)).toBe(3);
    expect(clampLevel(Number.NaN)).toBe(1);
  });
  it('maps requirements to the server wire shape', () => {
    expect(requirementsToWire([presetToRequirement(EQUIPMENT_PRESETS[0], 9)])).toEqual([
      { kind: 'equipment', tokens: ['daikin', 'vrv'], min_level: 5, label: 'Daikin VRV' },
    ]);
  });
  it('preset copies tokens (no shared mutable array)', () => {
    const r = presetToRequirement(EQUIPMENT_PRESETS[0], 2);
    r.tokens.push('x');
    expect(EQUIPMENT_PRESETS[0].tokens).toEqual(['daikin', 'vrv']);
  });
});

describe('validateSearch', () => {
  it('accepts a valid search', () => {
    expect(validateSearch(base)).toBeNull();
  });
  it('requires a requirement', () => {
    expect(validateSearch({ ...base, requirements: [] })).toMatch(/at least one/i);
  });
  it('requires a location unless remote', () => {
    expect(validateSearch({ ...base, lat: null, lng: null })).toMatch(/where the job is/i);
    expect(validateSearch({ ...base, lat: null, lng: null, remote: true })).toBeNull();
  });
  it('rejects out-of-range coordinates', () => {
    expect(validateSearch({ ...base, lat: 120 })).toMatch(/latitude/i);
    expect(validateSearch({ ...base, lng: -300 })).toMatch(/longitude/i);
  });
});

describe('money', () => {
  it('parses rates', () => {
    expect(parseRateToCents('85')).toBe(8500);
    expect(parseRateToCents('$85.50')).toBe(8550);
    expect(parseRateToCents('')).toBeNull();
    expect(Number.isNaN(parseRateToCents('abc'))).toBe(true);
    expect(Number.isNaN(parseRateToCents('1.234'))).toBe(true);
  });
  it('formats rates', () => {
    expect(formatRate(8500)).toBe('$85/h');
    expect(formatRate(8550)).toBe('$85.50/h');
    expect(formatRate(null)).toBe('—');
  });
});

describe('presentation helpers', () => {
  it('scoreTone thresholds', () => {
    expect(scoreTone(90)).toBe('success');
    expect(scoreTone(75)).toBe('accent');
    expect(scoreTone(10)).toBe('warning');
  });
  it('breakdownEntries keeps only applicable numeric components in order', () => {
    const e = breakdownEntries({ skill_fit: 80, price: null, proximity: 97, weights: { skill: 1 } });
    expect(e.map((x) => x.key)).toEqual(['skill_fit', 'proximity']);
  });
  it('formatTimeLeft', () => {
    const now = Date.parse('2027-03-01T12:00:00Z');
    expect(formatTimeLeft('2027-03-01T11:00:00Z', now)).toBe('expired');
    expect(formatTimeLeft('2027-03-01T12:30:00Z', now)).toBe('30m left');
    expect(formatTimeLeft('2027-03-01T16:00:00Z', now)).toBe('4h left');
  });
  it('describeMarketError maps known codes and falls back safely', () => {
    expect(describeMarketError(new Error('ALREADY_OFFERED'))).toMatch(/already/i);
    expect(describeMarketError({ message: 'x PII_IN_PUBLIC_FIELDS y' })).toMatch(/phone/i);
    expect(describeMarketError(null)).toMatch(/something went wrong/i);
  });
});
