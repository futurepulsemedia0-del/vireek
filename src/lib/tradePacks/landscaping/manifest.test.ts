import { describe, it, expect } from 'vitest';
import { LANDSCAPING_PACK, LANDSCAPING_FLAG, LANDSCAPING_ENTITLEMENT, DEFAULT_CHECKLIST, DEFAULT_WEATHER_POLICY, ADDON_TEMPLATES } from './manifest.ts';
import { validateWeatherPolicy } from './weather.ts';
import { TRADE_PACKS, GATED_TRADE_PACKS, isPackKey } from '../index';
import { INDUSTRIES } from '@/lib/industries';
import { quote } from '../framework';

describe('landscaping pack manifest', () => {
  it('is gated: not in the default registry, present in the gated one', () => {
    expect(TRADE_PACKS.some((p) => p.key === 'landscaping')).toBe(false);
    expect(GATED_TRADE_PACKS.map((p) => p.key)).toEqual(['landscaping']);
    expect(isPackKey('landscaping')).toBe(true);
    expect(LANDSCAPING_FLAG).toBe('landscaping_pack');
    expect(LANDSCAPING_ENTITLEMENT).toBe('packs:landscaping');
  });
  it('seeded keys / slugs carry the pack prefix the install RPC enforces', () => {
    for (const f of LANDSCAPING_PACK.customFields) expect(f.key.startsWith('landscaping_')).toBe(true);
    for (const f of LANDSCAPING_PACK.forms) expect(f.slug.startsWith('landscaping_')).toBe(true);
  });
  it('points at an existing industry page and every plan references a real pricing model', () => {
    expect(INDUSTRIES.some((i) => i.slug === LANDSCAPING_PACK.industrySlug)).toBe(true);
    const models = new Set(LANDSCAPING_PACK.pricingModels.map((m) => m.key));
    for (const p of LANDSCAPING_PACK.plans) expect(models.has(p.pricingModel as string)).toBe(true);
  });
  it('quotes a typical lawn from the pricing model', () => {
    const m = LANDSCAPING_PACK.pricingModels[0];
    const q = quote(m, { turf_sqft: 6000, edge_ft: 200 }, 28);
    expect(q.lines.find((l) => l.key === 'visit')?.amount).toBe(55);
    expect(q.lines.find((l) => l.key === 'edging')?.amount).toBe(10);
  });
  it('defaults are valid: unique checklist keys, weather policy, add-on seasons', () => {
    expect(new Set(DEFAULT_CHECKLIST.map((t) => t.key)).size).toBe(DEFAULT_CHECKLIST.length);
    expect(validateWeatherPolicy(DEFAULT_WEATHER_POLICY)).toEqual([]);
    for (const a of ADDON_TEMPLATES) {
      expect(a.seasonFromMonth >= 1 && a.seasonFromMonth <= 12).toBe(true);
      expect(a.defaultPriceCents).toBeGreaterThan(0);
    }
  });
  it('carries the counsel notice instead of asserting compliance', () => {
    expect(LANDSCAPING_PACK.complianceNote).toMatch(/REQUIRES COUNSEL/);
  });
});
