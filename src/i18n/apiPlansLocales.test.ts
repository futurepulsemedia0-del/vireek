import { describe, expect, it } from 'vitest';
import en from '@/locales/en/apiPlans.json';
import fa from '@/locales/fa/apiPlans.json';

type Json = { [k: string]: string | Json };

function flatten(obj: Json, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') acc[key] = v;
    else Object.assign(acc, flatten(v, key));
    return acc;
  }, {});
}

const flatEn = flatten(en as Json);
const flatFa = flatten(fa as Json);
const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');

describe('apiPlans locale files', () => {
  it('Persian has exactly the English keys and no empty values', () => {
    expect(Object.keys(flatFa).sort()).toEqual(Object.keys(flatEn).sort());
    for (const [k, v] of Object.entries(flatFa)) expect(v.trim().length > 0, k).toBe(true);
  });
  it('placeholders match between languages', () => {
    for (const k of Object.keys(flatEn)) expect(placeholders(flatFa[k]), k).toBe(placeholders(flatEn[k]));
  });
  it('has a label for every quota state', () => {
    for (const s of ['unlimited', 'ok', 'warning', 'over_quota', 'blocked']) expect(flatEn[`state.${s}`], s).toBeTruthy();
  });
});
