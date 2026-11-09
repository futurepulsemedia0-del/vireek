// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  affixFlags,
  analyzeLinguistic,
  internationalFit,
  normalizeAffixConfig,
  pronounceability,
  vowelShape,
} from './linguistic.mjs';

describe('vowelShape', () => {
  it('treats y as a consonant only before a vowel at the start', () => {
    expect(vowelShape('yellow')).toBe('CVCCVC');
    expect(vowelShape('lynx')).toBe('CVCC');
  });
});

describe('pronounceability', () => {
  it('scores a balanced name high', () => {
    expect(pronounceability('vireek').score).toBeGreaterThanOrEqual(90);
  });
  it('penalises missing vowels and long consonant runs', () => {
    const p = pronounceability('strkvn');
    expect(p.score).toBeLessThan(40);
    expect(p.issues.join('|')).toContain('no vowels');
    expect(pronounceability('thrive').issues.join('|')).toContain('3-consonant run');
  });
  it('penalises vowel pile-ups and triple letters', () => {
    expect(pronounceability('aeiouaei').score).toBeLessThan(80);
    expect(pronounceability('looool').issues.join('|')).toContain('repeated 3+');
  });
  it('flags silent English initials', () => {
    expect(pronounceability('knova').issues.join('|')).toContain('silent initial');
  });
  it('always stays within 0-100', () => {
    for (const n of ['bcdfgh', 'aaaaaaaa', 'vireek', 'qxzjwv']) {
      const s = pronounceability(n).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe('internationalFit', () => {
  it('flags hard letters with the affected languages', () => {
    const fit = internationalFit('qizx');
    const ids = fit.flags.map((f) => f.id);
    expect(ids).toContain('q');
    expect(ids).toContain('x');
    expect(fit.flags.find((f) => f.id === 'q').languages).toContain('Arabic');
  });
  it('flags th for most languages and lowers the score', () => {
    const th = internationalFit('thova');
    expect(th.flags.find((f) => f.id === 'th').languages).toContain('Spanish');
    expect(th.score).toBeLessThan(internationalFit('lumen').score);
  });
  it('flags l+r together for Japanese', () => {
    expect(internationalFit('lira').flags.find((f) => f.id === 'l+r').languages).toContain('Japanese');
  });
  it('reports the weakest language and per-language scores', () => {
    const fit = internationalFit('vireek');
    expect(Object.keys(fit.perLanguage)).toHaveLength(9);
    expect(fit.worst.score).toBe(Math.min(...Object.values(fit.perLanguage)));
  });
});

describe('affix saturation', () => {
  const cfg = { prefixes: ['next', 'nova', 'zen'], suffixes: ['ora', 'ly', 'hub'] };
  it('flags prefixes and suffixes', () => {
    expect(affixFlags('nexora', { prefixes: ['nex'], suffixes: ['ora'] })).toEqual([
      { kind: 'prefix', affix: 'nex', wholeName: false },
      { kind: 'suffix', affix: 'ora', wholeName: false },
    ]);
  });
  it('flags a name that is itself an affix', () => {
    expect(affixFlags('nova', cfg)).toEqual([{ kind: 'prefix', affix: 'nova', wholeName: true }]);
  });
  it('needs a 3+ letter stem for 2-letter affixes', () => {
    expect(affixFlags('tyly', cfg)).toEqual([]);
    expect(affixFlags('zenly', cfg).map((f) => `${f.kind}:${f.affix}`)).toEqual(['prefix:zen', 'suffix:ly']);
  });
  it('sanitises the config', () => {
    expect(normalizeAffixConfig({ prefixes: ['Go!', 5, 'A', 'next', 'NEXT'] })).toEqual({
      prefixes: ['go', 'next'],
      suffixes: [],
    });
  });
});

describe('analyzeLinguistic', () => {
  it('bundles the checks', () => {
    const a = analyzeLinguistic('vireek', { prefixes: [], suffixes: [] });
    expect(a.length).toBe(6);
    expect(a.pronounceability.score).toBeGreaterThan(0);
    expect(a.affixes).toEqual([]);
  });
});
