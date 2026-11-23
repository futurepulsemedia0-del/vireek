import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/legalAcceptance.json';

type Json = { [k: string]: string | Json };
const flat = (o: Json, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();
const E = flat(en as Json);
const LANGS = ['ar', 'de', 'es', 'fa', 'fr', 'hi', 'ja', 'zh'];

describe('legalAcceptance locale files', () => {
  for (const lng of LANGS) {
    it(`${lng} has exactly the keys of en, no empties, same placeholders`, () => {
      const L = flat(JSON.parse(readFileSync(join(process.cwd(), 'src/locales', lng, 'legalAcceptance.json'), 'utf8')) as Json);
      expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort());
      for (const [k, v] of Object.entries(L)) {
        expect(v.trim(), `${lng}.${k}`).not.toBe('');
        expect(ph(v), `${lng}.${k}`).toEqual(ph(E[k]));
      }
    });
  }
  it('every static t() key used by the acceptance page exists in en', () => {
    const src = readFileSync(join(process.cwd(), 'src/pages/LegalReacceptancePage.tsx'), 'utf8');
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) expect(E[m[1]], m[1]).toBeTruthy();
    for (const kind of ['added', 'changed', 'removed']) expect(E[`kind.${kind}`]).toBeTruthy();
  });
});
