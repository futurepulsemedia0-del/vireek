// node --test scripts/content/check-content-pages.test.mjs   (npm run test:scripts:content-pages)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBaseline, evaluatePage, isContentRoute, parseJsonLd, requiredTypesFor,
} from './content-pages-lib.mjs';

const SITE = 'https://vireek.com';
const URL1 = `${SITE}/blog/example-post`;
const article = (over = {}) => ({
  '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'x',
  mainEntityOfPage: { '@type': 'WebPage', '@id': URL1 }, ...over,
});

/** Build a prerendered page; every field can be overridden or removed with null. */
function page(o = {}) {
  const f = {
    title: 'Example Post | Vireek Blog',
    description: 'A description that is comfortably longer than fifty characters so it passes the length rule.',
    canonical: [URL1], robots: 'index, follow', ogTitle: 'Example', ogDescription: 'Example description',
    ogUrl: URL1, ogImage: `${SITE}/og-image.png`, jsonLd: [JSON.stringify(article())], ...o,
  };
  return [
    '<!doctype html><html lang="en"><head>',
    f.title === null ? '' : `<title>${f.title}</title>`,
    f.description === null ? '' : `<meta name="description" content="${f.description}">`,
    f.robots === null ? '' : `<meta name="robots" content="${f.robots}">`,
    f.ogTitle === null ? '' : `<meta property="og:title" content="${f.ogTitle}">`,
    f.ogDescription === null ? '' : `<meta property="og:description" content="${f.ogDescription}">`,
    f.ogUrl === null ? '' : `<meta property="og:url" content="${f.ogUrl}">`,
    f.ogImage === null ? '' : `<meta property="og:image" content="${f.ogImage}">`,
    ...(f.canonical ?? []).map((c) => `<link rel="canonical" href="${c}">`),
    ...(f.jsonLd ?? []).map((j) => `<script type="application/ld+json">${j}</script>`),
    '</head><body><div id="root"><h1>Example</h1></div></body></html>',
  ].join('\n');
}
const run = (html, extra = {}) =>
  evaluatePage({ path: '/blog/example-post', kind: 'blog', html, canonical: URL1, requiredTypes: ['BlogPosting'], ...extra });
const codes = (r) => r.problems.map((p) => p.code);

test('a complete blog page passes', () => {
  assert.deepEqual(run(page()).problems, []);
});

test('missing prerendered file is reported once', () => {
  assert.deepEqual(codes(run(null)), ['html-missing']);
});

test('title: missing and out-of-range are separate problems', () => {
  assert.deepEqual(codes(run(page({ title: null }))), ['title-missing']);
  assert.deepEqual(codes(run(page({ title: 'Short' }))), ['title-length']);
  assert.deepEqual(codes(run(page({ title: 'x'.repeat(121) }))), ['title-length']);
});

test('description: missing, too short, too long', () => {
  assert.deepEqual(codes(run(page({ description: null }))), ['description-missing']);
  assert.deepEqual(codes(run(page({ description: 'too short' }))), ['description-length']);
  assert.deepEqual(codes(run(page({ description: 'y'.repeat(351) }))), ['description-length']);
});

test('canonical: missing, duplicated, wrong host, trailing slash, query string', () => {
  assert.deepEqual(codes(run(page({ canonical: [] }))), ['canonical-missing']);
  assert.deepEqual(codes(run(page({ canonical: [URL1, URL1] }))), ['canonical-multiple']);
  for (const bad of ['https://example.com/blog/example-post', `${URL1}/`, `${URL1}?utm=a`, 'http://vireek.com/blog/example-post']) {
    assert.deepEqual(codes(run(page({ canonical: [bad] }))), ['canonical-mismatch'], bad);
  }
});

test('open graph must agree with the canonical and have an absolute image', () => {
  assert.deepEqual(codes(run(page({ ogUrl: `${URL1}/` }))), ['og-url-mismatch']);
  assert.deepEqual(codes(run(page({ ogImage: '/og-image.png' }))), ['og-image-missing']);
  assert.deepEqual(codes(run(page({ ogTitle: null, ogDescription: null }))), ['og-title-missing', 'og-description-missing']);
});

test('noindex on a published content page is a problem', () => {
  assert.deepEqual(codes(run(page({ robots: 'noindex, follow' }))), ['robots-noindex']);
});

test('structured data: none, invalid, wrong context, missing required type', () => {
  assert.deepEqual(codes(run(page({ jsonLd: [] }))), ['jsonld-missing']);
  assert.deepEqual(codes(run(page({ jsonLd: ['{not json'] }))), ['jsonld-invalid']);
  assert.deepEqual(codes(run(page({ jsonLd: [JSON.stringify(article({ '@context': 'https://example.com' }))] }))), ['jsonld-context']);
  const crumbs = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] });
  assert.deepEqual(codes(run(page({ jsonLd: [crumbs] }))), ['jsonld-type-missing']);
});

test('structured data: one valid block does not hide a second invalid one', () => {
  assert.deepEqual(codes(run(page({ jsonLd: [JSON.stringify(article()), '{oops'] }))), ['jsonld-invalid']);
});

test('@graph and array JSON-LD are flattened', () => {
  const graph = JSON.stringify({ '@context': 'https://schema.org', '@graph': [article(), { '@type': 'FAQPage' }] });
  const { nodes, errors } = parseJsonLd([graph, JSON.stringify([article()])]);
  assert.equal(errors.length, 0);
  assert.ok(nodes.some((n) => n['@type'] === 'FAQPage'));
  assert.deepEqual(run(page({ jsonLd: [graph] }), { requiredTypes: ['BlogPosting', 'FAQPage'] }).problems, []);
});

test('BlogPosting and CollectionPage URLs must match the canonical', () => {
  const wrong = JSON.stringify(article({ mainEntityOfPage: { '@id': `${SITE}/blog/other` } }));
  assert.deepEqual(codes(run(page({ jsonLd: [wrong] }))), ['jsonld-url-mismatch']);
  const cat = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', url: `${SITE}/blog/category/nope` });
  const r = evaluatePage({ path: '/blog/category/missed-calls', kind: 'blog-category', canonical: `${SITE}/blog/category/missed-calls`,
    requiredTypes: ['CollectionPage'],
    html: page({ canonical: [`${SITE}/blog/category/missed-calls`], ogUrl: `${SITE}/blog/category/missed-calls`, jsonLd: [cat] }) });
  assert.deepEqual(codes(r), ['jsonld-url-mismatch']);
});

test('requiredTypesFor: FAQPage only when the post has FAQ entries', () => {
  assert.deepEqual(requiredTypesFor({ kind: 'blog', path: '/blog/a' }, { faq: [{ q: 'q' }] }), ['BlogPosting', 'FAQPage']);
  assert.deepEqual(requiredTypesFor({ kind: 'blog', path: '/blog/a' }, { faq: [] }), ['BlogPosting']);
  assert.deepEqual(requiredTypesFor({ kind: 'blog-category', path: '/blog/category/a' }), ['CollectionPage']);
  assert.deepEqual(requiredTypesFor({ kind: 'static', path: '/blog' }), ['Blog']);
  assert.deepEqual(requiredTypesFor({ kind: 'industry', path: '/industries/hvac' }), []);
});

test('isContentRoute selects editorial kinds and the blog hub only', () => {
  for (const kind of ['blog', 'blog-category', 'industry', 'compare', 'integration', 'switch', 'alternative', 'use-case', 'resource', 'help']) {
    assert.equal(isContentRoute({ kind, path: `/x/${kind}` }), true, kind);
  }
  assert.equal(isContentRoute({ kind: 'static', path: '/blog' }), true);
  assert.equal(isContentRoute({ kind: 'static', path: '/pricing' }), false);
  assert.equal(isContentRoute({ kind: 'location', path: '/locations/austin' }), false);
});

test('baseline ratchet: tolerates known, fails new, flags stale entries', () => {
  const results = [
    { path: '/a', kind: 'help', problems: [{ code: 'jsonld-missing', message: 'm' }] },
    { path: '/b', kind: 'help', problems: [{ code: 'title-missing', message: 'm' }] },
    { path: '/c', kind: 'help', problems: [] },
  ];
  const r = applyBaseline(results, ['/a jsonld-missing', '/c jsonld-missing']);
  assert.deepEqual(r.failing.map((f) => `${f.path} ${f.code}`), ['/b title-missing']);
  assert.deepEqual(r.stale, ['/c jsonld-missing']);
  assert.deepEqual(r.tolerated, ['/a jsonld-missing']);
  assert.deepEqual(applyBaseline([results[2]], []).failing, []);
});
