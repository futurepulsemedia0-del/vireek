import { describe, expect, it } from 'vitest';
import en from './en/pricingDisclosure.json';
import es from './es/pricingDisclosure.json';
import fa from './fa/pricingDisclosure.json';
import { disclosablePaths, type NoticeVariant } from '@/lib/pricingPersonalization';

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [`${p}${k}`]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');

describe('pricingDisclosure locales', () => {
  for (const [name, bundle] of [['es', es], ['fa', fa]] as const) {
    const L = flat(bundle as Tree);
    it(`${name}: same keys as en`, () => {
      expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort());
    });
    it(`${name}: no empty values and identical {{placeholders}}`, () => {
      for (const k of Object.keys(E)) {
        expect(L[k]?.trim().length, k).toBeGreaterThan(0);
        expect(placeholders(L[k]), k).toBe(placeholders(E[k]));
      }
    });
  }
  it('every notice variant the registry can produce has a title and body', () => {
    const variants = new Set<NoticeVariant>(['location', 'account', 'modeled']);
    expect(variants.size).toBe(3);
    for (const v of variants) {
      expect(E[`notice.${v}.title`], v).toBeTruthy();
      expect(E[`notice.${v}.body`], v).toBeTruthy();
    }
    expect(disclosablePaths().length).toBeGreaterThan(0);
  });
});
