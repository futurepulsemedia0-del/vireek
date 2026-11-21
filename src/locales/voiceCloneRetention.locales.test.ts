import { describe, expect, it } from 'vitest';
import en from './en/voiceCloneRetention.json';
import es from './es/voiceCloneRetention.json';
import fa from './fa/voiceCloneRetention.json';

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [`${p}${k}`]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');

describe('voiceCloneRetention locales', () => {
  for (const [name, bundle] of [['es', es], ['fa', fa]] as const) {
    const L = flat(bundle as Tree);
    it(`${name}: same keys as en`, () => { expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort()); });
    it(`${name}: no empty values and identical {{placeholders}}`, () => {
      for (const k of Object.keys(E)) {
        expect(L[k]?.trim().length, k).toBeGreaterThan(0);
        expect(placeholders(L[k]), k).toBe(placeholders(E[k]));
      }
    });
  }
});
