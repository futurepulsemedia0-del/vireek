import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '@/locales/en/sarahLearn.json';
import es from '@/locales/es/sarahLearn.json';

function flat(o: Record<string, unknown>, p = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${p}${k}.`));
    else out[`${p}${k}`] = String(v);
  }
  return out;
}

describe('sarahLearn locales', () => {
  const fe = flat(en);
  const fs = flat(es);
  it('en and es have identical keys', () => {
    expect(Object.keys(fe).sort()).toEqual(Object.keys(fs).sort());
  });
  it('es values are translated (differ from en) except proper nouns', () => {
    const same = Object.keys(fe).filter((k) => fe[k] === fs[k] && /[a-z]{4,}/i.test(fe[k]));
    expect(same.filter((k) => !/^(sources\.websitePlaceholder|readiness\.sarah)$/.test(k))).toEqual([]);
  });
  it('interpolation variables match between languages', () => {
    for (const k of Object.keys(fe)) {
      const vars = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');
      expect(vars(fs[k])).toBe(vars(fe[k]));
    }
  });
  it('every literal t("…") key used by the UI exists', () => {
    const dir = join(fileURLToPath(new URL('.', import.meta.url)));
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) if (!(m[1] in fe)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
  it('every dynamic key family resolves', () => {
    for (const g of ['basics', 'services', 'hours_area', 'pricing', 'trust', 'voice', 'faq']) expect(fe[`review.groups.${g}`]).toBeTruthy();
    for (const s of ['pending', 'approved', 'edited', 'rejected']) expect(fe[`review.${s}`]).toBeTruthy();
    for (const b of ['required_missing', 'sensitive_pending', 'readiness', 'test_call']) expect(fe[`readiness.blockers.${b}`]).toBeTruthy();
    for (const k of ['business_name', 'trade', 'services_offered', 'faqs', 'emergency_policy', 'diagnostic_fee']) expect(fe[`fields.${k}`]).toBeTruthy();
  });
});
