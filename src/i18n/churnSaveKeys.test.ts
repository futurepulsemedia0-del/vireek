import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/churnSave.json';
import fa from '@/locales/fa/churnSave.json';

type Json = { [k: string]: string | Json };
const flat = (o: Json, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const F = flat(fa as Json);
const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();

describe('churnSave locale files', () => {
  it('fa has exactly the keys of en, no empties, same placeholders', () => {
    expect(Object.keys(F).sort()).toEqual(Object.keys(E).sort());
    for (const [k, v] of Object.entries(F)) {
      expect(v.trim(), k).not.toBe('');
      expect(ph(v), k).toEqual(ph(E[k]));
    }
  });
  it('every static t() key used by the new UI exists', () => {
    const files = ['src/components/billing/SaveOffersStep.tsx', 'src/pages/StaffChurnSavePage.tsx', 'src/pages/CancelSubscriptionPage.tsx'];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !(k in E) && ![...Object.keys(E)].some((e) => e.startsWith(`${k}.`)));
    expect(missing).toEqual([]);
    expect(statSync('src/pages/StaffChurnSavePage.tsx').isFile() && readdirSync('src/locales/en').includes('churnSave.json')).toBe(true);
    void join;
  });
});
