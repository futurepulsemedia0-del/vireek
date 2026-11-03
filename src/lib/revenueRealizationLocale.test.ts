import { describe, expect, it } from 'vitest';
import en from '../locales/en/revenueRealization.json';
import fa from '../locales/fa/revenueRealization.json';
import { DETECTORS, LEDGER_RULES } from '../../supabase/functions/_shared/revenue-realization/engine';

const flat = (o: Record<string, unknown>, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
const stem = (k: string) => k.replace(/_(one|other)$/, '');

describe('revenueRealization locale', () => {
  const enKeys = new Set(flat(en).map(stem));
  it('names every detector and every ledger why-key', () => {
    for (const d of DETECTORS) expect(enKeys.has(`detector.${d}`), d).toBe(true);
    for (const r of Object.values(LEDGER_RULES)) expect(enKeys.has(`why.${r.why}`), r.why).toBe(true);
    for (const k of ['declined_safety_age', 'declined_safety', 'declined_age', 'unquoted_finding', 'unbilled_trip_fee', 'discount_over_policy', 'warranty_unfiled', 'warranty_unfiled_deadline', 'agreement_expiring', 'underpriced_job', 'no_show_gap'])
      expect(enKeys.has(`why.${k}`), k).toBe(true);
  });
  it('has copy for every fix kind', () => {
    for (const f of ['draft_followup', 'create_quote', 'invoice_correction', 'file_warranty_claim']) {
      expect(enKeys.has(`fix.${f}`)).toBe(true);
      expect(enKeys.has(`confirm.${f}`)).toBe(true);
      expect(enKeys.has(`actions.executed.${f}`)).toBe(true);
    }
  });
  it('fa has no keys that en lacks, and covers all non-plural en keys', () => {
    const faKeys = new Set(flat(fa).map(stem));
    for (const k of faKeys) expect(enKeys.has(k), `extra fa key ${k}`).toBe(true);
    for (const k of enKeys) expect(faKeys.has(k), `missing fa key ${k}`).toBe(true);
  });
  it('keeps interpolation variables identical between en and fa', () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
    const f = (o: Record<string, unknown>): Record<string, string> => Object.fromEntries(flat(o).map((k) => [stem(k), k.split('.').reduce<unknown>((a, p) => (a as Record<string, unknown>)[p], o)]).map(([k, v]) => [k, String(v)]));
    const e = f(en), a = f(fa);
    for (const k of Object.keys(a)) expect(vars(a[k]), k).toBe(vars(e[k]));
  });
});
