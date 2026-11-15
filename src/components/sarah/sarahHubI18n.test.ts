import { describe, it, expect } from 'vitest';
import en from '@/locales/en/sarahHub.json';
import es from '@/locales/es/sarahHub.json';
import { FIELD_WEIGHTS } from '@/lib/sarahKnowledge';

function flat(o: Record<string, unknown>, p = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${p}${k}.`));
    else out[`${p}${k}`] = String(v);
  }
  return out;
}

describe('sarahHub locales', () => {
  const fe = flat(en);
  const fs = flat(es);
  it('en and es have identical keys', () => {
    expect(Object.keys(fe).sort()).toEqual(Object.keys(fs).sort());
  });
  it('interpolation variables match between languages', () => {
    for (const k of Object.keys(fe)) {
      const vars = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');
      expect(vars(fs[k])).toBe(vars(fe[k]));
    }
  });
  it('every weighted field has a label in both languages', () => {
    for (const key of Object.keys(FIELD_WEIGHTS)) {
      expect(typeof fe[`field.${key}`]).toBe('string');
      expect(typeof fs[`field.${key}`]).toBe('string');
    }
  });
});
