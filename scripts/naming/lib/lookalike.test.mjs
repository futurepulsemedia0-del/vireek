// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compareToBrand, findLookalikes, levenshtein, normalizeBrandList, phoneticKey } from './lookalike.mjs';

describe('levenshtein', () => {
  it('computes classic distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
  });
  it('is symmetric', () => {
    expect(levenshtein('stripe', 'strype')).toBe(levenshtein('strype', 'stripe'));
  });
});

describe('phoneticKey', () => {
  it('merges common spelling variants', () => {
    expect(phoneticKey('phone')).toBe(phoneticKey('fone'));
    expect(phoneticKey('cafe')).toBe(phoneticKey('kafe'));
    expect(phoneticKey('knight')).toBe(phoneticKey('nite'));
    expect(phoneticKey('xerox')).toBe(phoneticKey('zerox'));
  });
  it('is vowel-agnostic but keeps consonant structure', () => {
    expect(phoneticKey('vireek')).toBe(phoneticKey('farik'));
    expect(phoneticKey('vireek')).not.toBe(phoneticKey('vorton'));
  });
  it('ignores non-letters and case', () => {
    expect(phoneticKey('Vi-Reek')).toBe(phoneticKey('vireek'));
  });
});

describe('normalizeBrandList', () => {
  it('accepts arrays, {brands} and {name}, lowercases and dedupes', () => {
    expect(normalizeBrandList(['Stripe', 'stripe', 'Pay-Pal', 'ab', { name: 'Xero' }, 7])).toEqual([
      'stripe',
      'paypal',
      'xero',
    ]);
    expect(normalizeBrandList({ brands: ['Slack'] })).toEqual(['slack']);
    expect(normalizeBrandList(null)).toEqual([]);
  });
});

describe('compareToBrand / findLookalikes', () => {
  const brands = ['stripe', 'xero', 'twilio', 'slack', 'notion'];
  it('rates edit-distance-1 names high', () => {
    expect(compareToBrand('stripy', 'stripe').level).toBe('high');
    expect(findLookalikes('twilo', brands).level).toBe('high');
  });
  it('rates identical names at the top', () => {
    const r = findLookalikes('slack', brands);
    expect(r.level).toBe('identical');
    expect(r.riskScore).toBe(100);
  });
  it('catches sound-alikes with spelling changes', () => {
    expect(findLookalikes('zero', brands).matches[0].brand).toBe('xero');
  });
  it('flags containment of a long brand', () => {
    const m = compareToBrand('notional', 'notion');
    expect(m.contains).toBe(true);
    expect(['high', 'medium']).toContain(m.level);
  });
  it('returns none for unrelated names and sorts matches by severity', () => {
    expect(findLookalikes('quorix', brands)).toEqual({ riskScore: 0, level: 'none', matches: [] });
    const scores = findLookalikes('stripe', ['stripy', 'stripe', 'strap']).matches.map((m) => m.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
  it('caps risk at 100 and limits matches', () => {
    const r = findLookalikes('stripx', ['stripe', 'stripy', 'stripz', 'stripa'], { limit: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });
});
