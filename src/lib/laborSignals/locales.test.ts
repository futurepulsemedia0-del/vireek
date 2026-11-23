import { describe, expect, it } from 'vitest';
import en from '../../locales/en/laborSignals.json';
import fa from '../../locales/fa/laborSignals.json';

type Json = { [k: string]: Json | string | string[] };

function flatten(o: Json, p = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[p + k] = v;
    else if (Array.isArray(v)) v.forEach((s, i) => (out[`${p}${k}.${i}`] = s));
    else Object.assign(out, flatten(v, `${p}${k}.`));
  }
  return out;
}
const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');
const E = flatten(en as Json);
const F = flatten(fa as Json);

describe('laborSignals locales', () => {
  it('fa has exactly the keys en has, with the same placeholders', () => {
    expect(Object.keys(F).sort()).toEqual(Object.keys(E).sort());
    for (const k of Object.keys(E)) expect(placeholders(F[k])).toBe(placeholders(E[k]));
  });
  it('signal and status texts never state a legal conclusion', () => {
    const banned = /\b(violat\w*|illegal|unlawful|owed|non-?complian\w*|breach\w*|must|required to|fine|penalt\w*|liab\w*)\b/i;
    for (const [k, v] of Object.entries(E)) {
      if (k.startsWith('signals.') || k.startsWith('status.') || k.startsWith('card.')) expect(banned.test(v)).toBe(false);
    }
  });
  it('the disclaimer carries both markers in every language', () => {
    for (const d of [E, F]) {
      expect(d['disclaimer.text']).toContain('[COUNSEL]');
      expect(d['disclaimer.text']).toContain('[VERIFY]');
    }
  });
  it('has seven day names so the workweek picker maps 0..6', () => {
    for (let i = 0; i < 7; i += 1) expect(E[`rules.overtime.days.${i}`]).toBeDefined();
    expect(E['rules.overtime.days.7']).toBeUndefined();
  });
});
