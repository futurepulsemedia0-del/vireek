import { describe, expect, it } from 'vitest';
import en from './en/salesPipeline.json';
import fa from './fa/salesPipeline.json';

const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
    : [p];
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
const flat = (o: unknown, p = ''): Record<string, string> =>
  o && typeof o === 'object'
    ? Object.assign({}, ...Object.entries(o as Record<string, unknown>).map(([k, v]) => flat(v, p ? `${p}.${k}` : k)))
    : { [p]: String(o) };

describe('salesPipeline locales', () => {
  it('fa has exactly the keys of en', () => {
    expect(keys(fa).sort()).toEqual(keys(en).sort());
  });
  it('fa keeps every {{placeholder}} of en', () => {
    const e = flat(en); const f = flat(fa);
    for (const k of Object.keys(e)) expect(placeholders(f[k])).toBe(placeholders(e[k]));
  });
});
