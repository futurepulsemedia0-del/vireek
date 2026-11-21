// scripts/content/content-pages-lib.mjs
//
// Pure rules for "does a published content page have metadata, a canonical URL and structured data?".
// No file-system, no network, no repo imports: the CLI (check-content-pages.mjs) injects canonicalFor() and the
// per-page expectations, so these rules are unit-testable with plain HTML strings.
import { extractHead } from '../seo/html-meta.mjs';

/** Route kinds (from dist/routes.json, produced by scripts/seo/routes.mjs) that are editorial content pages. */
export const CONTENT_KINDS = [
  'blog', 'blog-category', 'industry', 'compare', 'integration', 'switch', 'alternative', 'use-case', 'resource', 'help',
];
/** Static routes that are content hubs and must carry structured data too. */
export const CONTENT_STATIC_PATHS = ['/blog'];

export const TITLE_MIN = 10;
export const TITLE_MAX = 120; // same bounds as scripts/seo/built-output.built.test.mjs
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 350;

/** JSON-LD @type values every page of a kind must emit (only what the code is known to generate). */
export const REQUIRED_TYPES_BY_KIND = {
  blog: ['BlogPosting'],
  'blog-category': ['CollectionPage'],
};
export const REQUIRED_TYPES_BY_PATH = { '/blog': ['Blog'] };

export const isContentRoute = (r) => CONTENT_KINDS.includes(r.kind) || CONTENT_STATIC_PATHS.includes(r.path);

/** Flatten JSON-LD text blocks into nodes, following arrays and @graph. */
export function parseJsonLd(blocks) {
  const nodes = [];
  const errors = [];
  const visit = (n) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    nodes.push(n);
    if (Array.isArray(n['@graph'])) n['@graph'].forEach(visit);
  };
  blocks.forEach((raw, i) => {
    try {
      visit(JSON.parse(raw));
    } catch (e) {
      errors.push(`block ${i + 1}: ${String(e.message).slice(0, 80)}`);
    }
  });
  return { nodes, errors };
}

const typesOf = (node) => [].concat(node['@type'] ?? []).map(String);
const hasSchemaContext = (node) =>
  typeof node['@context'] === 'string' ? /^https?:\/\/schema\.org\/?$/.test(node['@context']) : false;

/**
 * Evaluate one prerendered page.
 * @param {{ path: string, kind: string, html: string|null, canonical: string, requiredTypes?: string[] }} page
 * @returns {{ path: string, kind: string, problems: { code: string, message: string }[] }}
 */
export function evaluatePage({ path, kind, html, canonical, requiredTypes = [] }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (!html) {
    add('html-missing', 'prerendered HTML file not found in dist/');
    return { path, kind, problems };
  }
  const head = extractHead(html);

  // --- metadata ---------------------------------------------------------------------------------------------
  if (!head.title) add('title-missing', 'no <title>');
  else if (head.title.length < TITLE_MIN || head.title.length > TITLE_MAX) {
    add('title-length', `title is ${head.title.length} characters (allowed ${TITLE_MIN}-${TITLE_MAX})`);
  }
  const d = head.description ?? '';
  if (!d) add('description-missing', 'no meta description');
  else if (d.length < DESCRIPTION_MIN || d.length > DESCRIPTION_MAX) {
    add('description-length', `description is ${d.length} characters (allowed ${DESCRIPTION_MIN}-${DESCRIPTION_MAX})`);
  }
  if (/noindex/i.test(head.robots ?? '')) add('robots-noindex', `robots meta is "${head.robots}" on a published content page`);

  // --- canonical --------------------------------------------------------------------------------------------
  if (head.canonicals.length === 0) add('canonical-missing', 'no <link rel="canonical">');
  else if (head.canonicals.length > 1) add('canonical-multiple', `${head.canonicals.length} canonical links: ${head.canonicals.join(', ')}`);
  else if (head.canonicals[0] !== canonical) add('canonical-mismatch', `canonical is ${head.canonicals[0]}, expected ${canonical}`);

  // --- social metadata that must agree with the canonical ---------------------------------------------------
  if (!head.ogTitle) add('og-title-missing', 'no og:title');
  if (!head.ogDescription) add('og-description-missing', 'no og:description');
  if (head.ogUrl !== canonical) add('og-url-mismatch', `og:url is ${head.ogUrl ?? '(missing)'}, expected ${canonical}`);
  if (!/^https?:\/\//.test(head.ogImage ?? '')) add('og-image-missing', 'og:image missing or not an absolute URL');

  // --- structured data --------------------------------------------------------------------------------------
  if (head.jsonLd.length === 0) {
    add('jsonld-missing', 'no application/ld+json block');
  } else {
    const { nodes, errors } = parseJsonLd(head.jsonLd);
    for (const e of errors) add('jsonld-invalid', `invalid JSON-LD (${e})`);
    if (nodes.length) {
      for (const n of nodes.filter((x) => x['@context'] !== undefined && !hasSchemaContext(x))) {
        add('jsonld-context', `unexpected @context ${JSON.stringify(n['@context'])} on ${typesOf(n).join('/') || 'node'}`);
      }
      const present = new Set(nodes.flatMap(typesOf));
      for (const t of requiredTypes) if (!present.has(t)) add('jsonld-type-missing', `no ${t} node (found: ${[...present].join(', ') || 'none'})`);
      for (const n of nodes) {
        const t = typesOf(n);
        const mep = n.mainEntityOfPage?.['@id'];
        if (t.includes('BlogPosting') && mep !== undefined && mep !== canonical) {
          add('jsonld-url-mismatch', `BlogPosting.mainEntityOfPage is ${mep}, expected ${canonical}`);
        }
        if (t.includes('CollectionPage') && n.url !== undefined && n.url !== canonical) {
          add('jsonld-url-mismatch', `CollectionPage.url is ${n.url}, expected ${canonical}`);
        }
      }
    } else if (!errors.length) {
      add('jsonld-missing', 'JSON-LD blocks contain no objects');
    }
  }
  return { path, kind, problems };
}

/** Types a page must emit, given its route and (for blog posts) its source data. */
export function requiredTypesFor(route, post) {
  const out = [...(REQUIRED_TYPES_BY_KIND[route.kind] ?? []), ...(REQUIRED_TYPES_BY_PATH[route.path] ?? [])];
  if (route.kind === 'blog' && post?.faq?.length) out.push('FAQPage');
  return out;
}

/**
 * Ratchet (same idea as KNOWN_SEO_GAPS in the built-output test): problems recorded in the baseline are tolerated,
 * new problems fail, and baseline entries that no longer occur fail too so the baseline can only shrink.
 * Keys are "<path> <code>".
 */
export function applyBaseline(results, baselineKeys = []) {
  const base = new Set(baselineKeys);
  const seen = new Set();
  const failing = [];
  for (const r of results) {
    for (const p of r.problems) {
      const key = `${r.path} ${p.code}`;
      seen.add(key);
      if (!base.has(key)) failing.push({ path: r.path, kind: r.kind, ...p });
    }
  }
  const stale = [...base].filter((k) => !seen.has(k));
  return { failing, stale, tolerated: [...seen].filter((k) => base.has(k)) };
}
