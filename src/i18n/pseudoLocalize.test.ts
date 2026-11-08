import { describe, expect, it } from 'vitest';
import { pseudoLocalize, pseudoLocalizeResource } from './pseudoLocalize';

describe('pseudoLocalize', () => {
  it('accents letters, brackets the string and expands ~40%', () => {
    const out = pseudoLocalize('Save changes');
    expect(out.startsWith('[') && out.endsWith(']')).toBe(true);
    expect(out).toContain('Šàṽé');
    expect(out.length).toBeGreaterThan('Save changes'.length * 1.4);
  });
  it('preserves {{i18next}}, {icu} placeholders and tags exactly', () => {
    const out = pseudoLocalize('Hello {{name}}, you have {count, plural, one {# job} other {# jobs}} <b>now</b>');
    expect(out).toContain('{{name}}');
    expect(out).toContain('{count, plural, one {# job} other {# jobs}}');
    expect(out).toContain('<b>');
    expect(out).toContain('</b>');
  });
  it('wraps in RLO/PDF when rtl is requested', () => {
    expect(pseudoLocalize('Hi', { rtl: true })).toMatch(/^\u202E\[.*\]\u202C$/);
  });
  it('returns empty input unchanged and maps resources deeply', () => {
    expect(pseudoLocalize('')).toBe('');
    const r = pseudoLocalizeResource({ a: { b: 'Go' }, n: 3, arr: ['x'] });
    expect(r.a.b).toContain('Ĝô');
    expect(r.n).toBe(3);
    expect(r.arr[0]).toContain('ẋ');
  });
});
