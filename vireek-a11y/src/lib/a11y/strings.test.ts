import { describe, expect, it } from 'vitest';
import { ALL_KEYS, AR_STRINGS, EN_STRINGS, FA_STRINGS, translate } from './strings';
import { CENTER_TABS, REGISTRY, SECTIONS, matchesQuery, normalizeSearch } from './registry';
import { PROFILE_DEFS } from './profiles';

const vars = (s: string): string => (s.match(/\{\w+\}/g) ?? []).sort().join(',');

describe('i18n completeness', () => {
  it('fa and ar have every key with identical placeholders and no empty strings', () => {
    for (const k of ALL_KEYS) {
      expect(FA_STRINGS[k].length > 0).toBe(true);
      expect(AR_STRINGS[k].length > 0).toBe(true);
      expect(vars(FA_STRINGS[k])).toBe(vars(EN_STRINGS[k]));
      expect(vars(AR_STRINGS[k])).toBe(vars(EN_STRINGS[k]));
    }
  });
  it('translate: language, fallback and interpolation', () => {
    expect(translate('fa', 'tabVision')).toBe('بینایی');
    expect(translate('ja', 'tabVision')).toBe('Vision'); // no ja yet → English fallback
    expect(translate('en', 'resultsCount', { n: 3 })).toBe('3 settings found');
    expect(translate('ar', 'resultsCount', { n: 3 })).toContain('3');
  });
  it('registry/profile/section keys all exist in the dictionary', () => {
    const keys = new Set<string>(ALL_KEYS);
    REGISTRY.forEach((i) => { expect(keys.has(i.labelKey)).toBe(true); expect(keys.has(i.descKey)).toBe(true); });
    CENTER_TABS.forEach((c) => expect(keys.has(c.labelKey)).toBe(true));
    SECTIONS.forEach((s) => expect(keys.has(s.titleKey)).toBe(true));
    PROFILE_DEFS.forEach((p) => { expect(keys.has(p.nameKey)).toBe(true); expect(keys.has(p.descKey)).toBe(true); });
    ['cb_none', 'cb_protanopia', 'cb_deuteranopia', 'cb_tritanopia'].forEach((k) => expect(keys.has(k)).toBe(true));
    ALL_KEYS.filter((k) => k.startsWith('sc_')).forEach(() => undefined);
    expect(ALL_KEYS.filter((k) => k.startsWith('sc_')).length).toBe(9);
  });
});

describe('search', () => {
  it('normalizes Arabic/Persian variants and digits', () => {
    expect(normalizeSearch('كتاب')).toBe(normalizeSearch('کتاب'));
    expect(normalizeSearch('علي')).toBe(normalizeSearch('علی'));
    expect(normalizeSearch('٣')).toBe('3');
    expect(normalizeSearch('۳')).toBe('3');
  });
  it('matches in the UI language and by English keywords', () => {
    const fa = (k: Parameters<typeof translate>[1]) => translate('fa', k);
    expect(matchesQuery([fa('lbl_textSize'), fa('dsc_textSize'), 'font size'], 'اندازه متن')).toBe(true);
    expect(matchesQuery([fa('lbl_textSize'), fa('dsc_textSize'), 'font size'], 'font')).toBe(true);
    expect(matchesQuery([fa('lbl_textSize')], 'zzz')).toBe(false);
  });
});
