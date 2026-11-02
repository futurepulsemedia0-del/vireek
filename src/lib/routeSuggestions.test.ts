import { describe, expect, it } from 'vitest';
import { POPULAR_LINKS, filterLinks, levenshtein, suggestSimilar } from '@/lib/routeSuggestions';

describe('suggestSimilar', () => {
  const paths = POPULAR_LINKS.map((l) => l.to);
  it('finds the typo target', () => {
    expect(suggestSimilar('/pricng', paths)[0]).toBe('/pricing');
    expect(suggestSimilar('/Feature/', paths)[0]).toBe('/features');
  });
  it('returns nothing for unrelated paths and never the same path', () => {
    expect(suggestSimilar('/zzzzzzzzzzzzzz', paths)).toEqual([]);
    expect(suggestSimilar('/pricing', paths)).not.toContain('/pricing');
  });
  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('filterLinks', () => {
  const label = (l: { fallback: string }) => l.fallback;
  it('matches keywords and requires every word', () => {
    expect(filterLinks('plans', POPULAR_LINKS, label).map((l) => l.to)).toContain('/pricing');
    expect(filterLinks('plans zzz', POPULAR_LINKS, label)).toEqual([]);
  });
  it('empty query returns all', () => expect(filterLinks('  ', POPULAR_LINKS, label)).toHaveLength(POPULAR_LINKS.length));
});
