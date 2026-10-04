import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  filterPatterns,
  formatPct,
  generatePartnerKey,
  humanizeKey,
  observedHeadline,
  patternTitle,
  productsFor,
  sha256Hex,
  summarizeUsage,
} from './evidenceMarketplace';
import type { PatternRow, ProductRow } from './evidenceMarketplace';

function pattern(over: Partial<PatternRow> = {}): PatternRow {
  return {
    id: 'p1',
    release_id: 'r1',
    scope: 'cause',
    industry: 'hvac',
    job_type_key: 'ac_repair',
    root_cause_key: 'capacitor_failure',
    make: '*',
    age_band: '*',
    observations_display: 14000,
    contributors_display: 210,
    ftf_rate: 0.712,
    callback_rate: 0.081,
    median_minutes: 85,
    top_parts: [],
    evidence_backed_pct: 60,
    grade: 'A',
    ...over,
  };
}

describe('wording', () => {
  it('states counts as "N+" because the server rounds down', () => {
    expect(observedHeadline(pattern())).toBe('Observed in 14,000+ jobs across 210+ businesses');
  });

  it('humanizes keys and titles', () => {
    expect(humanizeKey('capacitor_failure')).toBe('Capacitor failure');
    expect(humanizeKey('*')).toBe('Any');
    expect(patternTitle(pattern())).toBe('Ac repair: Capacitor failure');
    expect(patternTitle(pattern({ scope: 'equipment', make: 'carrier', age_band: '11-15' }))).toBe('Ac repair: Capacitor failure (Carrier, 11-15 yrs)');
    expect(formatPct(0.712)).toBe('71%');
  });
});

describe('filterPatterns', () => {
  const rows = [
    pattern({ id: 'a', observations_display: 500, grade: 'B' }),
    pattern({ id: 'b', observations_display: 14000, grade: 'A', root_cause_key: 'compressor_seized' }),
    pattern({ id: 'c', scope: 'equipment', make: 'carrier', age_band: '6-10' }),
    pattern({ id: 'd', industry: 'plumbing', job_type_key: 'toilet_repair', root_cause_key: 'flapper_worn', observations_display: 900, grade: 'C' }),
  ];

  it('filters by scope and sorts by observations', () => {
    expect(filterPatterns(rows, { query: '', grade: 'all', scope: 'cause' }).map((r) => r.id)).toEqual(['b', 'd', 'a']);
    expect(filterPatterns(rows, { query: '', grade: 'all', scope: 'equipment' }).map((r) => r.id)).toEqual(['c']);
  });

  it('filters by grade and text (underscores ignored)', () => {
    expect(filterPatterns(rows, { query: '', grade: 'A', scope: 'cause' }).map((r) => r.id)).toEqual(['b']);
    expect(filterPatterns(rows, { query: 'compressor seized', grade: 'all', scope: 'cause' }).map((r) => r.id)).toEqual(['b']);
    expect(filterPatterns(rows, { query: 'plumbing', grade: 'all', scope: 'cause' }).map((r) => r.id)).toEqual(['d']);
  });
});

describe('products and usage', () => {
  const products: ProductRow[] = [
    { slug: 'failure_patterns', name: 'F', description: '', partner_types: ['oem', 'contractor'], scope: 'all', fields: [], sort_order: 1 },
    { slug: 'claim_risk', name: 'C', description: '', partner_types: ['insurer'], scope: 'equipment', fields: [], sort_order: 2 },
  ];

  it('only offers products valid for the partner type', () => {
    expect(productsFor('insurer', products).map((p) => p.slug)).toEqual(['claim_risk']);
    expect(productsFor('oem', products).map((p) => p.slug)).toEqual(['failure_patterns']);
    expect(productsFor('training_provider', products)).toEqual([]);
  });

  it('summarizes usage per partner', () => {
    const u = summarizeUsage([
      { partner_id: 'x', product: 'claim_risk', rows_returned: 10, created_at: '2026-10-01T10:00:00Z' },
      { partner_id: 'x', product: 'claim_risk', rows_returned: 5, created_at: '2026-10-02T10:00:00Z' },
      { partner_id: 'y', product: 'failure_patterns', rows_returned: 1, created_at: '2026-10-01T10:00:00Z' },
    ]);
    expect(u.get('x')).toEqual({ requests: 2, rows: 15, lastAt: '2026-10-02T10:00:00Z' });
    expect(u.get('y')?.requests).toBe(1);
  });
});

describe('partner keys', () => {
  it('hashes with SHA-256 (known vector)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates a prefixed key whose hash matches', async () => {
    const k = await generatePartnerKey();
    expect(k.rawKey.startsWith('vev_live_')).toBe(true);
    expect(k.rawKey.length).toBe(9 + 48);
    expect(k.prefix).toBe(k.rawKey.slice(0, 13));
    expect(k.hash).toBe(await sha256Hex(k.rawKey));
    expect(/^[0-9a-f]{64}$/.test(k.hash)).toBe(true);
  });
});
