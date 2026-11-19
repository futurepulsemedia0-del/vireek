import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/renewalDisclosure.json';
import fa from '@/locales/fa/renewalDisclosure.json';

const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();

describe('renewalDisclosure locale files', () => {
  it('fa has exactly the keys of en, no empties, same placeholders', () => {
    const E = en as Record<string, string>;
    const F = fa as Record<string, string>;
    expect(Object.keys(F).sort()).toEqual(Object.keys(E).sort());
    for (const [k, v] of Object.entries(F)) {
      expect(v.trim(), k).not.toBe('');
      expect(ph(v), k).toEqual(ph(E[k]));
    }
  });

  it('every static t() key used by RenewalDisclosure exists in en', () => {
    const src = readFileSync('src/components/billing/RenewalDisclosure.tsx', 'utf8');
    const used = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const k of used) expect(k in (en as Record<string, string>), k).toBe(true);
  });

  it('English copy states auto-renewal, the cadence, how to cancel and what happens after cancelling', () => {
    const all = Object.values(en as Record<string, string>).join(' ');
    expect(all).toMatch(/renews automatically/i);
    expect(all).toMatch(/each month/i);
    expect(all).toMatch(/cancel at any time/i);
    expect(all).toMatch(/until the end of the period/i);
  });

  it('BillingPage renders the disclosure inside the plan picker', () => {
    expect(readFileSync('src/pages/BillingPage.tsx', 'utf8')).toContain('<RenewalDisclosure');
  });
});
