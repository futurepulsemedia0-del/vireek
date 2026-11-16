import { describe, expect, it } from 'vitest';
import { USE_CASES } from '@/lib/useCases';
import { SWITCH_GUIDES } from '@/lib/switchGuides';
import { INTEGRATIONS } from '@/lib/integrations';
import { COMPETITORS } from '@/lib/competitors';
import { USE_CASE_DEEP } from './useCasesDeep';
import { SWITCH_GUIDE_DEEP } from './switchGuidesDeep';
import { buildIntegrationDeep } from './integrationsDeep';
import { buildCompareDeep } from './compareDeep';
import { BANNED_CLAIMS, deepText } from './guards';
import type { DeepContentData } from './types';

const ROUTES = [
  '/features', '/pricing', '/calculator', '/industries', '/use-cases/missed-calls', '/use-cases/emergency-dispatch',
  '/use-cases/after-hours', '/use-cases/estimate-follow-up', '/switch', '/compare', '/compare/matrix', '/integrations', '/platform',
];

function check(data: DeepContentData, minWords: number) {
  const text = deepText(data);
  expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(minWords);
  for (const re of BANNED_CLAIMS) expect(text).not.toMatch(re);
  const ids = data.sections.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const s of data.sections) for (const b of s.blocks) if (b.kind === 'table') for (const r of b.rows) expect(r.length).toBe(b.headers.length);
  for (const r of data.related ?? []) expect(ROUTES).toContain(r.href);
  expect(text).not.toContain('${');
}

describe('part 3 deep content', () => {
  it('covers every use case and switch guide exactly once', () => {
    expect(Object.keys(USE_CASE_DEEP).sort()).toEqual(USE_CASES.map((u) => u.slug).sort());
    expect(Object.keys(SWITCH_GUIDE_DEEP).sort()).toEqual(SWITCH_GUIDES.map((g) => g.slug).sort());
  });
  for (const [slug, d] of Object.entries(USE_CASE_DEEP)) it(`use case ${slug}`, () => check(d, 450));
  for (const [slug, d] of Object.entries(SWITCH_GUIDE_DEEP)) it(`switch guide ${slug}`, () => check(d, 450));
  for (const i of INTEGRATIONS) it(`integration ${i.slug}`, () => check(buildIntegrationDeep(i), 350));
  for (const c of COMPETITORS) it(`compare ${c.slug}`, () => check(buildCompareDeep(c), 350));
  it('marks coming-soon integrations honestly', () => {
    const d = buildIntegrationDeep({ name: 'X', category: 'CRM', status: 'coming_soon' });
    expect(deepText(d)).toContain('coming soon');
  });
});
