import { describe, expect, it } from 'vitest';
import { ABOUT_DEEP } from './about';
import { MANIFESTO_DEEP } from './manifesto';
import { FEATURES_DEEP } from './features';
import { SERVICES_DEEP } from './services';
import { PLATFORM_DEEP } from './platform';
import { FAQ_DEEP } from './faq';
import { INDUSTRY_DEEP } from './industriesDeep';

// Static public routes registered in src/App.tsx.
const ALLOWED = [
  '/about', '/manifesto', '/features', '/pricing', '/industries', '/trust', '/security', '/platform',
  '/integrations', '/docs', '/help', '/status', '/system-requirements', '/contact', '/calculator',
  '/use-cases/missed-calls', '/use-cases/emergency-dispatch', '/use-cases/after-hours', '/use-cases/estimate-follow-up',
];

describe('related links', () => {
  const pages = [ABOUT_DEEP, MANIFESTO_DEEP, FEATURES_DEEP, SERVICES_DEEP, PLATFORM_DEEP, FAQ_DEEP, ...Object.values(INDUSTRY_DEEP)];
  it('only point at registered public routes', () => {
    for (const p of pages) {
      for (const r of p.related ?? []) expect(ALLOWED).toContain(r.href);
    }
  });
  it('have no duplicate hrefs within one page', () => {
    for (const p of pages) {
      const hrefs = (p.related ?? []).map((r) => r.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });
});
