import { existsSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadBlog } from '../blog/pipeline.mjs';
import { isEndorsementEnabled } from './platformFlag.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const SITE_URL = 'https://vireek.com';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Indexable marketing / legal / info pages with a fixed path. Single source for sitemap + prerender. */
export const STATIC_PUBLIC_PATHS = [
  '/', '/audit', '/privacy', '/cookies', '/terms', '/dpa', '/subprocessors', '/refund-policy', '/sla',
  '/acceptable-use-policy', '/responsible-ai', '/trademark-policy', '/vulnerability-disclosure',
  '/ccpa', '/accessibility-statement', '/gdpr-dpa', '/faq', '/help', '/about', '/manifesto',
  '/leadership', '/docs', '/blog', '/report', '/podcast', '/glossary', '/testimonials', '/contact',
  '/services', '/features', '/features/lead-qualification', '/features/sms-text-back',
  '/features/whatsapp-instagram-dm', '/features/live-escalation', '/platform', '/compare',
  '/compare/matrix', '/switch', '/ai-receptionist-vs-human-receptionist', '/open-voice-benchmark', '/industries', '/pricing',
  '/enterprise', '/marketplace', '/sdks', '/developers/changelog', '/demo', '/calculator',
  '/security', '/trust', '/integrations', '/status', '/case-studies', '/changelog', '/roadmap',
  '/accessibility', '/accessibility/conformance', '/careers', '/talent', '/culture', '/press', '/brand',
  '/partners', '/affiliate', '/referral', '/beta', '/webinars', '/roi', '/system-requirements',
  '/sitemap',
  '/call-recording-consent', '/data-retention', '/billing-terms', '/disclaimer',
  '/limitation-of-liability', '/intellectual-property', '/incident-response', '/export-control',
  '/agent-readiness', '/ai-disclosure', '/contact-sales', '/customers', '/data-request', '/dmca', '/events',
  '/fair-sale-promise', '/how-we-verify', '/impressum', '/insights', '/locations', '/msa', '/resources',
  '/security/whitepaper', '/sms-terms', '/state-of-home-service-calls', '/trust/compliance', '/trust/security',
  '/developers/api-reference', '/developers/quickstarts',
];
export const FLAG_GATED_PUBLIC_PATHS = ['/legal/company'];
/** Routes whose pages come from data modules (one URL per slug). */
export const DATA_ROUTE_PATTERNS = [
  '/blog/:slug', '/blog/category/:slug', '/industries/:slug', '/compare/:slug', '/integrations/:slug', '/switch/:slug',
  '/locations/:slug', '/alternatives/:competitor', '/use-cases/:slug', '/resources/:slug', '/help/:slug',
];
/**
 * Data patterns where EVERY valid URL is prerendered to a static file. The Cloudflare worker uses this list to turn
 * "no file for this slug" into a real 404. (Locations are excluded: they can also come from a runtime API.)
 */
export const PRERENDERED_PATTERNS = [
  '/blog/:slug', '/blog/category/:slug', '/industries/:slug', '/compare/:slug', '/integrations/:slug', '/switch/:slug',
  '/alternatives/:slug', '/use-cases/:slug', '/resources/:slug', '/help/:slug',
];
/** Public pages with dynamic segments that are NOT prerendered (SPA-rendered; careers also have their own sitemap). */
export const PUBLIC_DYNAMIC_PATTERNS = ['/careers/:slug', '/locations/:city', '/locations/:city/:trade'];

/** Same page as another route (duplicate content) — never in the sitemap or prerendered. */
export const ALIAS_PATHS = ['/solutions'];

/** SPA-only areas: never prerendered, never in the sitemap. */
export const PRIVATE_PREFIXES = ['/dashboard', '/tech', '/staff', '/partner-portal', '/onboarding'];
export const PRIVATE_EXACT = [
  '/login', '/signup', '/forgot-password', '/reset-password', '/sso-login', '/pay-result',
  '/status/unsubscribe', '/badge', '/sandbox', '/community', '/ambassador', '/onboarding-guide',
  '/academy', '/academy/certificate','/newsletter/confirm', '/newsletter/unsubscribe', '*',
  // Utility / app-adjacent pages that must never be indexed (kept out of the sitemap, not prerendered).
  '/maintenance', '/thank-you', '/error', '/offline', '/mfa', '/valuation', '/warranty/register', '/safety/sds',
  '/supplier-portal', '/supplier-portal/apply', '/talent/me', '/marketing/canvassing', '/accounting/fixed-assets',
  '/data-room', '/dev/colors', '/dev/design-system', '/dev/emails', '/dev/interpreter', '/dev/loading', '/home/*',
];

/** Exact private pages that robots.txt should also disallow (the rest are just kept out of the sitemap). */
export const ROBOTS_DISALLOW_EXACT = [
  '/login', '/signup', '/forgot-password', '/reset-password', '/sso-login', '/pay-result',
  '/status/unsubscribe', '/newsletter/confirm', '/newsletter/unsubscribe',
];
/** Token routes we deliberately do NOT disallow in robots.txt. */
export const ROBOTS_ALLOWED_TOKEN_PREFIXES = ['/book/'];

const matchesPrefix = (p, prefix) => p === prefix || p.startsWith(`${prefix}/`);

/** 'static' | 'data' | 'alias' | 'private' | null (null = unclassified -> test fails). */
export function classifyRoute(p) {
  if (STATIC_PUBLIC_PATHS.includes(p) || FLAG_GATED_PUBLIC_PATHS.includes(p)) return 'static';
  if (DATA_ROUTE_PATTERNS.includes(p) || PUBLIC_DYNAMIC_PATTERNS.includes(p)) return 'data';
  if (ALIAS_PATHS.includes(p)) return 'alias';
  if (
    PRIVATE_EXACT.includes(p) ||
    PRIVATE_PREFIXES.some((x) => matchesPrefix(p, x)) ||
    p.includes(':')
  ) {
    return 'private';
  }
  return null;
}

export const canonicalFor = (p) => (p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p}`);

export function appRoutePaths() {
  const src = readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  return [...new Set([...src.matchAll(/\bpath="([^"]+)"/g)].map((m) => m[1]))];
}

export function robotsDisallowRules() {
  const rules = new Set();
  for (const p of PRIVATE_PREFIXES) {
    rules.add(`${p}/`);
    rules.add(`${p}$`);
  }
  for (const p of ROBOTS_DISALLOW_EXACT) rules.add(`${p}$`);
  for (const p of appRoutePaths()) {
    if (!p.includes(':') || DATA_ROUTE_PATTERNS.includes(p) || PUBLIC_DYNAMIC_PATTERNS.includes(p)) continue;
    const prefix = p.slice(0, p.indexOf(':'));
    if (ROBOTS_ALLOWED_TOKEN_PREFIXES.includes(prefix)) continue;
    if (PRIVATE_PREFIXES.some((x) => prefix.startsWith(`${x}/`))) continue;
    rules.add(prefix);
  }
  return [...rules].sort();
}

/** Bundles a TS data module with esbuild so we read the exact data the site renders. UI deps are stubbed. */
export async function loadTsModule(relativePath) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    alias: { '@': path.join(ROOT, 'src') },
    define: { 'import.meta.env': '{}' },
    plugins: [
      {
        name: 'stub-ui-deps',
        setup(build) {
          build.onResolve(
            { filter: /^(lucide-react|react|react-dom|framer-motion|react-router-dom)(\/.*)?$/ },
            (args) => ({ path: args.path, namespace: 'stub-ns' }),
          );
          build.onLoad({ filter: /.*/, namespace: 'stub-ns' }, () => ({
            contents:
              'module.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : () => null) });',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const toIsoDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};
const newest = (dates) => dates.filter(Boolean).sort().at(-1);

/** Every indexable URL: [{ path, kind, lastmod? }]. lastmod only where a real date exists. */
export async function collectRoutes() {
  const blog = loadBlog({ root: ROOT });
  const [industries, competitors, integrations, switchGuides] = await Promise.all(
    ['industries', 'competitors', 'integrations', 'switchGuides'].map((n) =>
      loadTsModule(`src/lib/${n}.ts`),
    ),
  );

  let changelogDate;
  try {
    const cl = await loadTsModule('src/lib/changelog.ts');
    changelogDate = newest(cl.CHANGELOG_RELEASES.map((r) => toIsoDate(r.date)));
  } catch {
    /* no lastmod for /changelog */
  }

  let locations = [];
  if (existsSync(path.join(ROOT, 'src/lib/locations.ts'))) {
    const mod = await loadTsModule('src/lib/locations.ts');
    locations = mod.LOCATIONS ?? [];
  }

  const entries = new Map();
  const add = (p, kind, lastmod) => {
    if (entries.has(p)) throw new Error(`[seo] duplicate route: ${p}`);
    entries.set(p, { path: p, kind, ...(lastmod ? { lastmod } : {}) });
  };
  const newestPost = newest(blog.posts.map((p) => toIsoDate(p.updatedAt)));

  for (const p of STATIC_PUBLIC_PATHS) {
    add(p, 'static', p === '/blog' ? newestPost : p === '/changelog' ? changelogDate : undefined);
  }
  if (isEndorsementEnabled(ROOT)) add('/legal/company', 'static');
  const dynamic = (items, base, kind, lastmodOf) => {
    for (const item of items) {
      if (typeof item.slug !== 'string' || !SLUG_RE.test(item.slug)) {
        throw new Error(`[seo] invalid slug "${item.slug}" under ${base}`);
      }
      add(`${base}/${item.slug}`, kind, lastmodOf?.(item));
    }
  };
dynamic(blog.posts, '/blog', 'blog', (p) => toIsoDate(p.updatedAt));
const usedCategories = blog.categories.filter((c) => blog.posts.some((p) => p.category === c.slug));
dynamic(usedCategories, '/blog/category', 'blog-category', (c) =>
  newest(blog.posts.filter((p) => p.category === c.slug).map((p) => toIsoDate(p.updatedAt))),
);
  dynamic(industries.INDUSTRIES, '/industries', 'industry');
  dynamic(competitors.COMPETITORS, '/compare', 'compare');
  dynamic(integrations.INTEGRATIONS, '/integrations', 'integration');
  dynamic(switchGuides.SWITCH_GUIDES, '/switch', 'switch');
  dynamic(locations, '/locations', 'location');

  // Data-driven public pages (alternatives, use cases, resources, help articles). Loaded defensively: a broken data
  // module must never fail the whole build, but a skipped section is logged and caught by assert-prerendered.
  const safe = async (label, fn) => {
    try {
      return (await fn()) ?? [];
    } catch (e) {
      console.warn(`[seo] ${label} skipped: ${String(e?.message ?? e).split('\n')[0]}`);
      return [];
    }
  };
  const lenient = (items, base, kind, lastmodOf) => {
    for (const item of items) {
      if (typeof item.slug !== 'string' || !SLUG_RE.test(item.slug) || entries.has(`${base}/${item.slug}`)) {
        console.warn(`[seo] skipped ${base}/${item.slug} (invalid or duplicate slug)`);
        continue;
      }
      add(`${base}/${item.slug}`, kind, lastmodOf?.(item));
    }
  };
  lenient(await safe('alternatives', async () => (await loadTsModule('src/lib/alternatives.ts')).ALTERNATIVES), '/alternatives', 'alternative');
  lenient(await safe('use-cases', async () => (await loadTsModule('src/lib/useCases.ts')).USE_CASES), '/use-cases', 'use-case');
  lenient(await safe('resources', async () => (await loadTsModule('src/lib/resources.ts')).publishedResources()), '/resources', 'resource');
  lenient(
    await safe('help articles', async () => (await loadTsModule('src/lib/helpArticles.ts')).HELP_ARTICLES),
    '/help', 'help', (a) => toIsoDate(a.updated),
  );
  return [...entries.values()];
}
/** Written to dist/app-routes.json; the Cloudflare worker uses it to answer unknown URLs with a real 404. */
export function appRoutesManifest() {
  return {
    patterns: appRoutePaths().filter((x) => x !== '*'),
    passthroughPrefixes: PRIVATE_PREFIXES,
    prerenderedPatterns: PRERENDERED_PATTERNS,
  };
}


