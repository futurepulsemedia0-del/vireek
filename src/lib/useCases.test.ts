import { describe, it, expect } from 'vitest';
import sitemapXml from '../../public/sitemap.xml?raw';
import { USE_CASES, getUseCaseBySlug, useCasePath } from './useCases';

describe('USE_CASES', () => {
  it('ships the four launch scenarios with unique slugs', () => {
    const slugs = USE_CASES.map((u) => u.slug);
    expect(slugs).toEqual(['missed-calls', 'emergency-dispatch', 'after-hours', 'estimate-follow-up']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has complete, non-empty content for every scenario', () => {
    for (const u of USE_CASES) {
      expect(u.headline.length).toBeGreaterThan(10);
      expect(u.metaTitle.endsWith('| Vireek')).toBe(true);
      expect(u.metaDescription.length).toBeLessThanOrEqual(160);
      expect(u.steps.length).toBeGreaterThanOrEqual(3);
      expect(u.faq.length).toBeGreaterThanOrEqual(3);
      expect(u.related.every((l) => l.href.startsWith('/'))).toBe(true);
    }
  });

  it('looks scenarios up by slug and builds canonical paths', () => {
    expect(getUseCaseBySlug('after-hours')?.name).toBe('After-Hours Calls');
    expect(getUseCaseBySlug('nope')).toBeUndefined();
    expect(getUseCaseBySlug(undefined)).toBeUndefined();
    expect(useCasePath('missed-calls')).toBe('/use-cases/missed-calls');
  });

  it('is registered in public/sitemap.xml so crawlers can discover every page', () => {
    for (const u of USE_CASES) {
      expect(sitemapXml).toContain(`<loc>https://vireek.com${useCasePath(u.slug)}</loc>`);
    }
  });
});
