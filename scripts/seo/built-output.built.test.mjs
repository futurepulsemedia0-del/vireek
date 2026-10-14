// @vitest-environment node
// Verifies the REAL build output in dist/. Run after `npm run build`:  npm run test:built
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, SITE_URL, appRoutePaths, canonicalFor, classifyRoute } from './routes.mjs';
import { extractHead } from './html-meta.mjs';

const DIST = path.join(ROOT, 'dist');
if (!existsSync(path.join(DIST, 'routes.json'))) {
  throw new Error('dist/ is missing or incomplete — run `npm run build` first.');
}
const read = (rel) => readFileSync(path.join(DIST, rel), 'utf8');
const outFile = (p) => (p === '/' ? 'index.html' : `${p.slice(1)}/index.html`);

const manifest = JSON.parse(read('routes.json'));
const report = existsSync(path.join(DIST, '_prerender-report.json'))
  ? JSON.parse(read('_prerender-report.json'))
  : { pages: [], failures: [] };

// Ratchet: pages that still have no useSEO() of their own. May only shrink — fix a page, then delete it here.
const KNOWN_SEO_GAPS = [
  '/accessibility', '/accessibility/conformance', '/case-studies', '/changelog', '/demo',
  '/roadmap', '/security', '/status',
];

const locOf = (xmlText) => [...xmlText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const isDisallowed = (pathname, rules) =>
  rules.some((r) => (r.endsWith('$') ? pathname === r.slice(0, -1) : pathname.startsWith(r)));

describe('SPA shell', () => {
  it('_spa.html is the pristine, empty shell', () => {
    const shell = read('_spa.html');
    expect(shell).toContain('<div id="root"></div>');
    expect(shell).not.toContain('data-ssg');
  });

  it('vercel.json rewrites unknown routes to _spa.html, not the prerendered index', () => {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const catchAll = cfg.rewrites.find((r) => r.source === '/(.*)');
    expect(catchAll?.destination).toBe('/_spa.html');
  });

  it('dashboard / auth / token routes are NOT prerendered (SPA-only)', () => {
    const privates = appRoutePaths().filter((p) => classifyRoute(p) === 'private' && !p.includes(':') && p !== '*');
    expect(privates.length).toBeGreaterThan(100);
    for (const p of privates) expect(existsSync(path.join(DIST, outFile(p))), p).toBe(false);
    for (const dir of ['dashboard', 'tech', 'login', 'staff']) {
      expect(existsSync(path.join(DIST, dir, 'index.html')), dir).toBe(false);
    }
  });
});

describe('sitemap.xml', () => {
  const xmlText = read('sitemap.xml');
  const locs = locOf(xmlText);
  const expected = manifest.routes.filter((r) => r.kind !== 'location').map((r) => canonicalFor(r.path));

  it('is well-formed, absolute, unique and within limits', () => {
    expect(xmlText.startsWith('<?xml')).toBe(true);
    expect(xmlText.trimEnd().endsWith('</urlset>')).toBe(true);
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs.length).toBeLessThanOrEqual(50000);
    for (const l of locs) expect(l.startsWith(`${SITE_URL}/`) || l === SITE_URL).toBe(true);
    for (const m of xmlText.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the route data exactly (blog, industries, compare, integrations, switch included)', () => {
    expect([...locs].sort()).toEqual([...expected].sort());
  });

  it('contains no private / SPA-only URL', () => {
    for (const l of locs) {
      const p = new URL(l).pathname;
      expect(['static', 'data'], p).toContain(
        classifyRoute(p === '/' ? '/' : p) ?? classifyRoute(`${p.replace(/\/[^/]+$/, '')}/:slug`),
      );
      expect(p).not.toMatch(/^\/(dashboard|tech|staff|login|signup|partner-portal|onboarding)/);
    }
  });

  it('every sitemap URL has prerendered HTML', () => {
    for (const l of locs) expect(existsSync(path.join(DIST, outFile(new URL(l).pathname))), l).toBe(true);
  });
});

describe('robots.txt', () => {
  const robots = read('robots.txt');
  const rules = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
  const sitemaps = [...robots.matchAll(/^Sitemap:\s*(\S+)/gm)].map((m) => m[1]);

  it('allows crawling, never blocks the whole site or the JS/CSS bundles', () => {
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(rules).not.toContain('/');
    expect(isDisallowed('/assets/index.js', rules)).toBe(false);
  });

  it('blocks the SPA-only areas', () => {
    for (const p of ['/dashboard', '/dashboard/leads', '/tech/jobs', '/staff/partners', '/login', '/portal/abc']) {
      expect(isDisallowed(p, rules), p).toBe(true);
    }
  });

  it('every Sitemap: line is absolute and points to a file that exists in the build', () => {
    expect(sitemaps).toContain(`${SITE_URL}/sitemap.xml`);
    for (const s of sitemaps) {
      expect(s.startsWith(`${SITE_URL}/`)).toBe(true);
      expect(existsSync(path.join(DIST, new URL(s).pathname.slice(1))), s).toBe(true);
    }
  });

  it('sitemap-locations.xml exists only when there are locations and then is listed', () => {
    const hasLoc = manifest.routes.some((r) => r.kind === 'location');
    expect(existsSync(path.join(DIST, 'sitemap-locations.xml'))).toBe(hasLoc);
    expect(sitemaps.includes(`${SITE_URL}/sitemap-locations.xml`)).toBe(hasLoc);
  });

  it('no sitemap URL is disallowed', () => {
    for (const l of locOf(read('sitemap.xml'))) expect(isDisallowed(new URL(l).pathname, rules), l).toBe(false);
  });
});

describe('prerender report', () => {
  it('had no failed routes', () => expect(report.failures).toEqual([]));
  it('SEO gaps only shrink (no new page without its own useSEO)', () => {
    const gaps = report.pages.filter((p) => !p.ownSeo).map((p) => p.path);
    expect(gaps.filter((p) => !KNOWN_SEO_GAPS.includes(p)), 'New page(s) without useSEO()').toEqual([]);
  });
});

describe.each(manifest.routes.map((r) => [r.path]))('prerendered %s', (routePath) => {
  const file = outFile(routePath);
  const html = existsSync(path.join(DIST, file)) ? read(file) : '';
  const head = html ? extractHead(html) : null;
  const gap = KNOWN_SEO_GAPS.includes(routePath);

  it('exists with real content in the HTML (not an empty shell)', () => {
    expect(html.length).toBeGreaterThan(0);
    expect(head.lang).toBe('en');
    expect(head.rootTextLength).toBeGreaterThan(400);
    expect(head.h1Count).toBeGreaterThanOrEqual(1);
  });

  it('has exactly one self-referencing canonical', () => {
    expect(head.canonicals).toEqual([canonicalFor(routePath)]);
    expect(head.ogUrl).toBe(canonicalFor(routePath));
  });

  it('has title, description, Open Graph and Twitter tags', () => {
    expect(head.title.length).toBeGreaterThan(10);
    expect(head.title.length).toBeLessThan(120);
    expect(head.ogTitle).toBeTruthy();
    expect(head.ogImage).toMatch(/^https?:\/\//);
    expect(head.twitterCard).toBeTruthy();
    if (!gap) {
      expect((head.description ?? '').length).toBeGreaterThan(50);
      expect((head.description ?? '').length).toBeLessThan(350);
      expect(head.ogDescription).toBeTruthy();
      expect(head.robots).toBe('index, follow');
    }
  });

  it('has valid JSON-LD, hreflang alternates and no leftover markers', () => {
    for (const raw of head.jsonLd) expect(() => JSON.parse(raw)).not.toThrow();
    expect(head.leftoverManaged).toBe(false);
    if (!gap) {
      expect(head.hreflang).toHaveLength(10);
      expect(head.hreflang.map((h) => h.hreflang)).toContain('x-default');
      expect(head.hreflang.find((h) => h.hreflang === 'en')?.href).toBe(canonicalFor(routePath));
      for (const h of head.hreflang) expect(h.href.startsWith(SITE_URL)).toBe(true);
      expect(head.ssgTagCount).toBeGreaterThan(0);
    }
  });
});

describe('uniqueness across pages', () => {
  const pages = manifest.routes
    .filter((r) => !KNOWN_SEO_GAPS.includes(r.path))
    .map((r) => ({ path: r.path, head: extractHead(read(outFile(r.path))) }));
  const dupes = (pick) => {
    const seen = new Map();
    const out = [];
    for (const p of pages) {
      const v = pick(p.head);
      if (!v) continue;
      if (seen.has(v)) out.push(`${seen.get(v)} == ${p.path}`);
      else seen.set(v, p.path);
    }
    return out;
  };
  it('titles are unique', () => expect(dupes((h) => h.title)).toEqual([]));
  it('descriptions are unique', () => expect(dupes((h) => h.description)).toEqual([]));
});
