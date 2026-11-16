import { describe, expect, it } from 'vitest';
import { ALL_RESOURCES } from '@/lib/resources';
import { SECURITY_DEEP, TRUST_DEEP } from './securityDeep';
import { GLOSSARY_DEEP } from './glossaryDeep';
import { RESOURCE_DEEP } from './resourcesDeep';
import { ENTERPRISE_DEEP, PRICING_DEEP } from './enterprisePricingDeep';
import { BANNED_CLAIMS, deepText } from './guards';
import type { DeepContentData } from './types';

const ROUTES = [
  '/features', '/platform', '/security', '/pricing', '/trust', '/trust/security', '/trust/compliance',
  '/security/whitepaper', '/status', '/demo', '/enterprise', '/calculator', '/resources',
  '/use-cases/missed-calls', '/use-cases/estimate-follow-up',
];

function check(d: DeepContentData, min: number) {
  const text = deepText(d);
  expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(min);
  for (const re of BANNED_CLAIMS) expect(text).not.toMatch(re);
  const ids = d.sections.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain('faq');
  for (const s of d.sections) for (const b of s.blocks) if (b.kind === 'table') for (const r of b.rows) expect(r.length).toBe(b.headers.length);
  for (const r of d.related ?? []) expect(ROUTES).toContain(r.href);
}

describe('part 4 deep content', () => {
  it('security', () => check(SECURITY_DEEP, 450));
  it('trust', () => check(TRUST_DEEP, 350));
  it('glossary', () => check(GLOSSARY_DEEP, 450));
  it('enterprise', () => check(ENTERPRISE_DEEP, 450));
  it('pricing', () => check(PRICING_DEEP, 450));
  for (const [slug, d] of Object.entries(RESOURCE_DEEP)) {
    it(`resource ${slug}`, () => check(d, 350));
  }
  it('resource keys exist in the registry', () => {
    const slugs = new Set(ALL_RESOURCES.map((r) => r.slug));
    for (const k of Object.keys(RESOURCE_DEEP)) expect(slugs.has(k)).toBe(true);
  });
});
