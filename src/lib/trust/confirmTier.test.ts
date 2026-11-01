import { describe, expect, it } from 'vitest';
import { consequenceLines, decideTier, normalizePhrase, phraseMatches, requiredPhrase } from './confirmTier';

describe('decideTier', () => {
  it('reversible + small => none', () => expect(decideTier({ reversible: true, count: 1 })).toBe('none'));
  it('reversible bulk => light, then typed at 50+', () => {
    expect(decideTier({ reversible: true, count: 10 })).toBe('light');
    expect(decideTier({ reversible: true, count: 49 })).toBe('light');
    expect(decideTier({ reversible: true, count: 50 })).toBe('typed');
  });
  it('irreversible / cascade / high impact => typed regardless of count', () => {
    expect(decideTier({ reversible: false, count: 1 })).toBe('typed');
    expect(decideTier({ reversible: true, count: 1, cascades: true })).toBe('typed');
    expect(decideTier({ reversible: true, count: 1, highImpact: true })).toBe('typed');
  });
});

describe('consequences + phrase', () => {
  it('drops zero-count dependents', () => {
    expect(consequenceLines({ count: 12, nounKey: 'j' }, [{ count: 0, nounKey: 'i' }, { count: 4, nounKey: 'p' }]).map((l) => l.count)).toEqual([12, 4]);
  });
  it('requires the name for one item and DELETE n for many', () => {
    expect(requiredPhrase({ count: 1, name: ' Acme HVAC ' })).toBe('Acme HVAC');
    expect(requiredPhrase({ count: 1 })).toBe('DELETE 1');
    expect(requiredPhrase({ count: 12, name: 'x' })).toBe('DELETE 12');
  });
  it('matches case/space-insensitively', () => expect(phraseMatches('  acme   hvac ', 'Acme HVAC')).toBe(true));
  it('matches Persian names across Arabic letter variants, digits and invisible chars', () => {
    expect(phraseMatches('علي', 'علی')).toBe(true); // Arabic yeh vs Persian yeh
    expect(phraseMatches('كار', 'کار')).toBe(true);
    expect(phraseMatches('کار‌ ۱۲', 'کار 12')).toBe(true); // ZWNJ removed, Persian digits
  });
  it('never matches empty or different text', () => {
    expect(phraseMatches('', '')).toBe(false);
    expect(phraseMatches('acme', 'acme hvac')).toBe(false);
    expect(normalizePhrase('ＡＢＣ')).toBe('abc');
  });
});
