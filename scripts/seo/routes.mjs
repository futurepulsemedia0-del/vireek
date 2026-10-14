import { existsSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const SITE_URL = 'https://vireek.com';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Indexable marketing / legal / info pages with a fixed path. Single source for sitemap + prerender. */
export const STATIC_PUBLIC_PATHS = [
  '/', '/privacy', '/cookies', '/terms', '/dpa', '/subprocessors', '/refund-policy', '/sla',
  '/acceptable-use-policy', '/responsible-ai', '/trademark-policy', '/vulnerability-disclosure',
  '/ccpa', '/accessibility-statement', '/gdpr-dpa', '/faq', '/help', '/about', '/manifesto',
  '/leadership', '/docs', '/blog', '/report', '/podcast', '/glossary', '/testimonials', '/contact',
  '/services', '/features', '/features/lead-qualification', '/features/sms-text-back',
  '/features/whatsapp-instagram-dm', '/features/live-escalation', '/platform', '/compare',
  '/compare/matrix', '/switch', '/ai-receptionist-vs-human-receptionist', '/industries', '/pricing',
  '/enterprise', '/marketplace', '/sdks', '/developers/changelog', '/demo', '/calculator',
  '/security', '/trust', '/integrations', '/status', '/case-studies', '/changelog', '/roadmap',
  '/accessibility', '/accessibility/conformance', '/careers', '/culture', '/press', '/brand',
  '/partners', '/affiliate', '/referral', '/beta', '/webinars', '/roi', '/system-requirements',
  '/sitemap',
];

/** Routes whose pages come from data modules (one URL per slug). */
export const DATA_ROUTE_PATTERNS = [
  '/blog/:slug', '/industries/:slug', '/compare/:slug', '/integrations/:slug', '/switch/:slug',
  '/locations/:slug',
];

/** Same page as another route (duplicate content) — never in the sitemap or prerendered. */
export const ALIAS_PATHS = ['/solutions'];

/** SPA-only areas: never prerendered, never in the sitemap. */
export const PRIVATE_PREFIXES = ['/dashboard', '/tech', '/staff', '/partner-portal', '/onboarding'];
export const PRIVATE_EXACT = [
  '/login', '/signup', '/forgot-password', '/reset-password', '/sso-login', '/pay-result',
  '/status/unsubscribe', '/badge', '/sandbox', '/community', '/ambassador', '/onboarding-guide',
  '/academy', '/academy/certificate', '*',
];

/** Exact private pages that robots.txt should also disallow (the rest are just kept out of the sitemap). */
export const ROBOTS_DISALLOW_EXACT = [
  '/login', '/signup', '/forgot-password', '/reset-password', '/sso-login', '/pay-result',
  '/status/unsubscribe',
];
/** Token routes we deliberately do NOT disallow in robots.txt. */
export const ROBOTS_ALLOWED_TOKEN_PREFIXES = ['/book/'];

const matchesPrefix = (p, prefix) => p === prefix || p.startsWith(`${prefix}/`);

/** 'static' | 'data' | 'alias' | 'private' | null (null = unclassified -> test fails). */
export function classifyRoute(p) {
  if (STATIC_PUBLIC_PATHS.includes(p)) return 'static';
  if (DATA_ROUTE_PATTERNS.includes(p)) return 'data';
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
    if (!p.includes(':') || DATA_ROUTE_PATTERNS.includes(p)) continue;
    const prefix = p.slice(0, p.indexOf(':'));
    if (ROBOTS_ALLOWED_TOKEN_PREFIXES.includes(prefix)) continue;
    if (PRIVATE_PREFIXES.some((x) => prefix.startsWith(`${x}/`))) continue;
    rules.add(prefix);
  }
  return [...rules].sort();
}

/** Bundles a TS data module with esbuild so we read the exact data the site renders. UI deps are stubbed. */
async function loadTsModule(relativePath) {
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
  const [blog, industries, competitors, integrations, switchGuides] = await Promise.all(
    ['blog', 'industries', 'competitors', 'integrations', 'switchGuides'].map((n) =>
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
  const newestPost = newest(blog.BLOG_POSTS.map((p) => toIsoDate(p.publishedDate)));

  for (const p of STATIC_PUBLIC_PATHS) {
    add(p, 'static', p === '/blog' ? newestPost : p === '/changelog' ? changelogDate : undefined);
  }
  const dynamic = (items, base, kind, lastmodOf) => {
    for (const item of items) {
      if (typeof item.slug !== 'string' || !SLUG_RE.test(item.slug)) {
        throw new Error(`[seo] invalid slug "${item.slug}" under ${base}`);
      }
      add(`${base}/${item.slug}`, kind, lastmodOf?.(item));
    }
  };
  dynamic(blog.BLOG_POSTS, '/blog', 'blog', (p) => toIsoDate(p.publishedDate));
  dynamic(industries.INDUSTRIES, '/industries', 'industry');
  dynamic(competitors.COMPETITORS, '/compare', 'compare');
  dynamic(integrations.INTEGRATIONS, '/integrations', 'integration');
  dynamic(switchGuides.SWITCH_GUIDES, '/switch', 'switch');
  dynamic(locations, '/locations', 'location');
  return [...entries.values()];
}
