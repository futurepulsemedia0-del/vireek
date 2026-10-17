import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { COMPETITORS } from './competitors';
import {
  ALTERNATIVES,
  alternativePath,
  alternativeUrl,
  allCompetitorsResolve,
  buildAlternativeJsonLd,
  getAlternativeByCompetitorSlug,
  getAlternativeBySlug,
  resolveAlternative,
} from './alternatives';

const REQUIRED = ['servicetitan', 'jobber', 'housecall-pro', 'smith-ai', 'ruby'];

describe('alternatives data', () => {
  it('covers every requested competitor with unique slugs', () => {
    expect(ALTERNATIVES.map((a) => a.slug).sort()).toEqual([...REQUIRED].sort());
    const all = ALTERNATIVES.flatMap((a) => [a.slug, ...(a.aliases ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('points every alternative at an existing competitor (no drift)', () => {
    expect(allCompetitorsResolve()).toBe(true);
    for (const a of ALTERNATIVES) expect(COMPETITORS.some((c) => c.slug === a.competitorSlug)).toBe(true);
  });

  it('resolves canonical slugs, aliases and competitor slugs', () => {
    expect(getAlternativeBySlug('ruby')?.slug).toBe('ruby');
    expect(getAlternativeBySlug('ruby-receptionists')?.slug).toBe('ruby');
    expect(getAlternativeBySlug('JOBBER')?.slug).toBe('jobber');
    expect(getAlternativeBySlug('nope')).toBeUndefined();
    expect(getAlternativeBySlug(undefined)).toBeUndefined();
    expect(getAlternativeByCompetitorSlug('ruby-receptionists')?.slug).toBe('ruby');
    expect(resolveAlternative('smith-ai')?.competitor.name).toBe('Smith.ai');
  });

  it('has complete, SEO-sized content for every page', () => {
    for (const a of ALTERNATIVES) {
      expect(a.seoTitle.length).toBeGreaterThan(30);
      expect(a.seoTitle.length).toBeLessThanOrEqual(65);
      expect(a.seoDescription.length).toBeGreaterThanOrEqual(110);
      expect(a.seoDescription.length).toBeLessThanOrEqual(175);
      expect(a.reasons.length).toBeGreaterThanOrEqual(3);
      expect(a.stayIf.length).toBeGreaterThanOrEqual(2);
      expect(a.switchIf.length).toBeGreaterThanOrEqual(2);
      expect(a.steps.length).toBeGreaterThanOrEqual(3);
      expect(a.faq.length).toBeGreaterThanOrEqual(3);
      expect(a.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const titles = ALTERNATIVES.map((a) => a.seoTitle);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('never states unverifiable numbers (prices, percentages, counts)', () => {
    const text = (a: (typeof ALTERNATIVES)[number]) =>
      [a.intro, a.headline, a.seoDescription, ...a.reasons.map((r) => r.body), ...a.stayIf, ...a.switchIf, ...a.steps.map((s) => s.body), ...a.faq.map((f) => f.a)].join(' ');
    for (const a of ALTERNATIVES) {
      expect(text(a)).not.toMatch(/\$\s?\d|\d\s?%|\b\d[\d,]*\s?(customers|companies|reviews)\b/i);
    }
  });

  it('gives every page a way to compare: feature rows or positioning', () => {
    for (const a of ALTERNATIVES) {
      const c = resolveAlternative(a.slug)!.competitor;
      expect(c.isVoiceAICompetitor ? (c.positioning?.length ?? 0) : (c.featureRows?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe('JSON-LD', () => {
  it('builds a FAQPage and an ordered BreadcrumbList', () => {
    const r = resolveAlternative('jobber')!;
    type Node = { '@type': string; mainEntity: { acceptedAnswer: { text: string } }[]; itemListElement: { position: number; item: string }[] };
    const [faq, crumbs] = buildAlternativeJsonLd(r) as unknown as Node[];
    expect(faq['@type']).toBe('FAQPage');
    expect(faq.mainEntity).toHaveLength(r.alternative.faq.length);
    expect(faq.mainEntity[0].acceptedAnswer.text).toBe(r.alternative.faq[0].a);
    expect(crumbs['@type']).toBe('BreadcrumbList');
    expect(crumbs.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(crumbs.itemListElement[2].item).toBe('https://vireek.com/alternatives/jobber');
  });
});

describe('sitemap', () => {
  const sitemap = readFileSync(resolve(__dirname, '../../public/sitemap.xml'), 'utf8');
  it('lists every alternatives URL', () => {
    for (const a of ALTERNATIVES) expect(sitemap).toContain(`<loc>${alternativeUrl(a.slug)}</loc>`);
  });
  it('does not list alias URLs', () => {
    expect(sitemap).not.toContain(alternativeUrl('ruby-receptionists'));
  });
  it('builds paths', () => {
    expect(alternativePath('ruby')).toBe('/alternatives/ruby');
  });
});
