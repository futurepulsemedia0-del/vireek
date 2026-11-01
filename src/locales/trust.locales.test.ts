import { describe, expect, it } from 'vitest';
import en from './en/trust.json';
import fa from './fa/trust.json';

type Json = { [k: string]: string | Json };
const flat = (o: Json, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();

describe('trust namespace', () => {
  const e = flat(en as Json);
  const f = flat(fa as Json);
  it('fa has exactly the keys of en', () => expect(Object.keys(f).sort()).toEqual(Object.keys(e).sort()));
  it('no empty values and identical {{placeholders}}', () => {
    for (const [k, v] of Object.entries(f)) {
      expect(v.trim(), k).not.toBe('');
      expect(ph(v), k).toEqual(ph(e[k]));
    }
  });
  it('every error kind has title + body, every recovery has a label', () => {
    for (const kind of ['network', 'auth', 'permission', 'validation', 'conflict', 'rate_limit', 'server', 'unknown']) {
      expect(e[`error.${kind}.title`], kind).toBeTruthy();
      expect(e[`error.${kind}.body`], kind).toBeTruthy();
    }
    for (const r of ['retry', 'fix_field', 'sign_in', 'refresh', 'wait', 'contact_support']) expect(e[`recovery.${r}`], r).toBeTruthy();
  });
});
