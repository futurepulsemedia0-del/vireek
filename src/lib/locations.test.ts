import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { INDUSTRIES } from '@/lib/industries';
import { TRADE_SIGNALS, type ClimateTag } from '@/lib/locationSignals';
import { CITIES, allLocationPaths, buildLocalJsonLd, buildLocalPage, getCityBySlug } from '@/lib/locations';

const TAGS: ClimateTag[] = ['extreme-heat', 'humid-heat', 'hurricane', 'severe-storm', 'hard-freeze', 'monsoon', 'wet-mild'];
const pages = INDUSTRIES.flatMap((i) => CITIES.map((c) => ({ i, c, p: buildLocalPage(i, c) })));
const words = (p: ReturnType<typeof buildLocalPage>, c: (typeof CITIES)[number]) =>
  [p.intro, c.seasonNote, c.housingNote, ...p.drivers.map((d) => d.text), ...p.faq.flatMap((f) => [f.q, f.a])].join(' ').split(/\s+/).length;

describe('locations data', () => {
  it('has unique city slugs with valid tags and suburbs', () => {
    expect(new Set(CITIES.map((c) => c.slug)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(c.tags.length).toBeGreaterThan(0);
      expect(c.suburbs.length).toBeGreaterThanOrEqual(5);
      expect(getCityBySlug(c.slug)).toBe(c);
    }
  });
  it('defines every climate signal for every trade', () => {
    for (const i of INDUSTRIES) for (const t of TAGS) expect(TRADE_SIGNALS[i.slug]?.[t], `${i.slug}/${t}`).toBeTruthy();
  });
});

describe('programmatic pages', () => {
  it('generates one page per city x trade with unique SEO fields and content', () => {
    expect(pages).toHaveLength(CITIES.length * INDUSTRIES.length);
    for (const key of ['title', 'description', 'canonical', 'intro'] as const) {
      expect(new Set(pages.map((x) => x.p[key])).size, key).toBe(pages.length);
    }
  });
  it('keeps meta lengths sane and content substantial', () => {
    for (const { p, c } of pages) {
      expect(p.description.length, p.path).toBeLessThanOrEqual(165);
      expect(p.title.length, p.path).toBeLessThanOrEqual(75);
      expect(words(p, c), p.path).toBeGreaterThanOrEqual(220);
    }
  });
  it('emits valid schema.org markup', () => {
    const { i, c, p } = pages[0];
    const ld = buildLocalJsonLd(i, c, p);
    expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'Service', 'FAQPage']);
    expect(ld.every((x) => x['@context'] === 'https://schema.org')).toBe(true);
    expect((ld[1].areaServed as { name: string }).name).toBe(c.name);
    expect(JSON.parse(JSON.stringify(ld))).toEqual(ld);
  });
});

describe('sitemap registration', () => {
  it('lists every /locations URL (run `npm run sitemap:locations` if this fails)', () => {
    const xml = readFileSync(join(process.cwd(), 'public/sitemap.xml'), 'utf8');
    const missing = allLocationPaths().filter((p) => !xml.includes(`<loc>https://vireek.com${p}</loc>`));
    expect(missing).toEqual([]);
  });
});
