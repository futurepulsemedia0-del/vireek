import { describe, expect, it } from 'vitest';
import en from '@/locales/en/voiceLog.json';
import es from '@/locales/es/voiceLog.json';
import fa from '@/locales/fa/voiceLog.json';

const base = (k: string) => k.replace(/_(one|other)$/, '');
const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
const langs = { es: es as Record<string, string>, fa: fa as Record<string, string> };
const E = en as Record<string, string>;

describe('voiceLog locales', () => {
  it('es/fa define every en key (plural suffixes normalised)', () => {
    const want = new Set(Object.keys(E).map(base));
    for (const [l, d] of Object.entries(langs)) {
      const got = new Set(Object.keys(d).map(base));
      expect([...want].filter((k) => !got.has(k)), l).toEqual([]);
      expect([...got].filter((k) => !want.has(k)), l).toEqual([]);
    }
  });
  it('interpolation variables match en in every language', () => {
    for (const [l, d] of Object.entries(langs)) {
      for (const k of Object.keys(E)) if (k in d) expect(vars(d[k]), `${l}.${k}`).toBe(vars(E[k]));
    }
  });
  it('no empty strings', () => {
    for (const d of [E, ...Object.values(langs)]) for (const v of Object.values(d)) expect(v.trim().length).toBeGreaterThan(0);
  });
});
