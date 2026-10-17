import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CASE_STUDIES, type CaseStudy } from '@/components/sections/CaseStudies';
import {
  PROVENANCE,
  TRADES,
  buildHubJsonLd,
  disclosure,
  filterStories,
  getStories,
  hubSeo,
  isVerified,
  parseTradeParam,
  provenanceLabel,
  storyHref,
  storyMetrics,
  tradeCounts,
} from './customerStories';

const sample = (over: Partial<CaseStudy> = {}): CaseStudy => ({ ...CASE_STUDIES[0], ...over });

describe('stories', () => {
  it('derives one story per case study with a trade and deep link', () => {
    const stories = getStories();
    expect(stories).toHaveLength(CASE_STUDIES.length);
    for (const s of stories) {
      expect(TRADES.some((t) => t.slug === s.tradeSlug)).toBe(true);
      expect(s.href).toBe(storyHref(s.slug));
    }
  });

  it('keeps story slugs unique and every PROVENANCE key pointing at a real story', () => {
    const slugs = CASE_STUDIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const k of Object.keys(PROVENANCE)) expect(slugs).toContain(k);
  });

  it('defaults to illustrative and never trusts "verified" without a consent date', () => {
    expect(getStories().every((s) => s.provenance === 'illustrative' || !!s.consentOn)).toBe(true);
    PROVENANCE['__tmp'] = { provenance: 'verified' };
    expect(getStories([sample({ slug: '__tmp' })])[0].provenance).toBe('illustrative');
    PROVENANCE['__tmp'] = { provenance: 'verified', consentOn: '2026-10-01' };
    const v = getStories([sample({ slug: '__tmp' })])[0];
    expect(isVerified(v)).toBe(true);
    expect(provenanceLabel(v)).toBe('Verified customer');
    delete PROVENANCE['__tmp'];
  });

  it('handles unknown industries without crashing', () => {
    expect(getStories([sample({ slug: 'x', industry: 'Pool Cleaning' })])[0].tradeSlug).toBe('other');
  });
});

describe('filtering', () => {
  const stories = getStories();
  it('accepts only known trade slugs', () => {
    expect(parseTradeParam('HVAC')).toBe('hvac');
    expect(parseTradeParam(' plumbing ')).toBe('plumbing');
    expect(parseTradeParam('<script>')).toBeNull();
    expect(parseTradeParam(null)).toBeNull();
  });
  it('filters by trade and counts per trade (including zero)', () => {
    expect(filterStories(stories, null)).toHaveLength(stories.length);
    expect(filterStories(stories, 'plumbing').every((s) => s.tradeSlug === 'plumbing')).toBe(true);
    expect(filterStories(stories, 'locksmith')).toEqual([]);
    const counts = tradeCounts(stories);
    expect(Object.keys(counts)).toHaveLength(TRADES.length);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(stories.length);
  });
});

describe('metrics', () => {
  it('pairs before/after for each metric', () => {
    const m = storyMetrics(CASE_STUDIES[0]);
    expect(m.map((x) => x.label)).toEqual(['Missed calls', 'Response time', 'Revenue']);
    expect(m[2].before).toContain('lost');
    expect(m[2].after).toContain('recovered');
  });
});

describe('honesty guards', () => {
  it('shows a disclosure whenever any story is illustrative, and none when all are verified', () => {
    expect(disclosure([{ provenance: 'illustrative' }])).toMatch(/illustrative/i);
    expect(disclosure([{ provenance: 'illustrative' }, { provenance: 'verified' }])).toMatch(/Verified customer/);
    expect(disclosure([{ provenance: 'verified' }])).toBeNull();
  });
  it('never emits review or rating markup', () => {
    const ld = JSON.stringify(buildHubJsonLd(getStories()));
    expect(ld).not.toMatch(/Review|AggregateRating|ratingValue/);
  });
  it('makes no aggregate or customer-count claims in hub copy', () => {
    const seo = hubSeo();
    expect(`${seo.title} ${seo.description}`).not.toMatch(/\d[\d,]*\s?(customers|businesses|companies)|\$\s?\d|\d\s?%|trusted by/i);
  });
});

describe('seo + structured data', () => {
  it('canonicalises to /customers and stays within SEO sizes', () => {
    const seo = hubSeo();
    expect(seo.canonical).toBe('https://vireek.com/customers');
    expect(seo.title.length).toBeLessThanOrEqual(65);
    expect(seo.description.length).toBeGreaterThanOrEqual(110);
    expect(seo.description.length).toBeLessThanOrEqual(175);
  });
  it('builds an ItemList and breadcrumbs', () => {
    type N = { '@type': string; mainEntity: { numberOfItems: number; itemListElement: { position: number; url: string }[] }; itemListElement: { position: number }[] };
    const [col, crumbs] = buildHubJsonLd(getStories()) as unknown as N[];
    expect(col['@type']).toBe('CollectionPage');
    expect(col.mainEntity.numberOfItems).toBe(CASE_STUDIES.length);
    expect(col.mainEntity.itemListElement[0].url).toContain('/case-studies#');
    expect(crumbs.itemListElement.map((i) => i.position)).toEqual([1, 2]);
  });
  it('is listed in the sitemap', () => {
    const sitemap = readFileSync(resolve(__dirname, '../../public/sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<loc>https://vireek.com/customers</loc>');
  });
});
