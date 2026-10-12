import { describe, it, expect } from 'vitest';
import sitemapXml from '../../public/sitemap.xml?raw';
import {
  ALL_RESOURCES,
  filterResources,
  getPublishedResource,
  hubJsonLd,
  isPublishable,
  isValidEmail,
  mapCaptureError,
  parseUnlock,
  publishedResources,
  resourceJsonLd,
  resourceUrl,
  serializeUnlock,
} from './resources';
import type { Resource } from './resources';

describe('registry integrity', () => {
  const published = publishedResources();

  it('has unique, well-formed slugs', () => {
    const slugs = ALL_RESOURCES.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]{3,80}$/);
  });

  it('gives every published resource real copy', () => {
    for (const r of published) {
      expect(r.title.trim().length).toBeGreaterThan(0);
      expect(r.summary.trim().length).toBeGreaterThan(0);
      expect(r.highlights.length).toBeGreaterThan(0);
      expect(r.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('ships non-empty .txt bodies for templates and files for ebooks', () => {
    for (const r of published) {
      if (r.kind === 'template') {
        expect(r.fileName).toMatch(/\.txt$/);
        expect(r.body.trim().length).toBeGreaterThan(50);
      }
      if (r.kind === 'ebook') expect(r.fileUrl).toBeTruthy();
    }
  });

  it('hides ebooks that have no file yet', () => {
    const draft: Resource = {
      slug: 'draft-ebook',
      kind: 'ebook',
      fileUrl: null,
      title: 't',
      summary: 's',
      description: 'd',
      highlights: ['h'],
      tags: [],
      updated: '2026-10-09',
    };
    expect(isPublishable(draft)).toBe(false);
    expect(publishedResources([draft])).toEqual([]);
    expect(getPublishedResource('draft-ebook', [draft])).toBeUndefined();
  });
});

describe('sitemap sync', () => {
  it('lists the hub and every published resource', () => {
    expect(sitemapXml).toContain('<loc>https://vireek.com/resources</loc>');
    for (const r of publishedResources()) {
      expect(sitemapXml).toContain(`<loc>${resourceUrl(r.slug)}</loc>`);
    }
  });
});

describe('filterResources', () => {
  const list = publishedResources();
  it('filters by kind', () => {
    const only = filterResources(list, { kind: 'calculator', query: '' });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.kind === 'calculator')).toBe(true);
  });
  it('matches every search token across title, summary and tags', () => {
    const hits = filterResources(list, { kind: 'all', query: 'sms missed' });
    expect(hits.some((r) => r.slug === 'missed-call-text-back-scripts')).toBe(true);
  });
  it('returns nothing for a query that matches nothing', () => {
    expect(filterResources(list, { kind: 'all', query: 'zzzz-no-match' })).toEqual([]);
  });
  it('is case-insensitive and ignores extra whitespace', () => {
    const a = filterResources(list, { kind: 'all', query: '  ESTIMATE  ' });
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('isValidEmail', () => {
  it('accepts normal addresses and trims whitespace', () => {
    expect(isValidEmail('you@company.com')).toBe(true);
    expect(isValidEmail('  you@company.co.uk ')).toBe(true);
  });
  it('rejects malformed and oversized input', () => {
    for (const bad of ['', 'plain', 'a@b', '@x.com', 'a b@x.com', `${'a'.repeat(250)}@x.com`]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe('unlock storage format', () => {
  const day = 24 * 60 * 60 * 1000;
  it('is valid within 180 days and expires after', () => {
    const raw = serializeUnlock(1_000_000);
    expect(parseUnlock(raw, 1_000_000 + 179 * day)).toBe(true);
    expect(parseUnlock(raw, 1_000_000 + 181 * day)).toBe(false);
  });
  it('rejects garbage, empty and future timestamps', () => {
    expect(parseUnlock(null, 1)).toBe(false);
    expect(parseUnlock('garbage', 1)).toBe(false);
    expect(parseUnlock('null', 1)).toBe(false);
    expect(parseUnlock(JSON.stringify({ t: 'x' }), 1)).toBe(false);
    expect(parseUnlock(serializeUnlock(10 * day), 1)).toBe(false);
  });
});

describe('mapCaptureError', () => {
  it('maps database and transport errors', () => {
    expect(mapCaptureError('invalid_email')).toBe('invalid_email');
    expect(mapCaptureError('rate_limited')).toBe('rate_limited');
    expect(mapCaptureError('TypeError: Failed to fetch')).toBe('network');
    expect(mapCaptureError('boom')).toBe('unknown');
    expect(mapCaptureError(undefined)).toBe('unknown');
  });
});

describe('structured data', () => {
  it('builds CreativeWork and ItemList JSON-LD with absolute URLs', () => {
    const first = publishedResources()[0]!;
    expect(resourceJsonLd(first)).toMatchObject({ '@type': 'CreativeWork', url: resourceUrl(first.slug) });
    const hub = hubJsonLd(publishedResources()) as { mainEntity: { itemListElement: unknown[] } };
    expect(hub.mainEntity.itemListElement).toHaveLength(publishedResources().length);
  });
});
