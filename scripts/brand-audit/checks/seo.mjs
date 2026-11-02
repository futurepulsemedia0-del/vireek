// checks/seo.mjs — static SEO/metadata checks (index.html, robots, sitemap, OG image). Per-route metadata comes from the crawler.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tryRead, exists, finding, round1 } from '../lib/util.mjs';

/** Pure: PNG width/height from the IHDR chunk, or null. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function checkHead(html) {
  const has = (re) => re.test(html);
  return [
    ['<html lang>', has(/<html[^>]*\blang="[a-z-]+"/i)],
    ['<title> 15–70 chars', (() => { const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''; return t.length >= 15 && t.length <= 70; })()],
    ['meta description 50–170 chars', (() => { const d = /name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? ''; return d.length >= 50 && d.length <= 170; })()],
    ['viewport', has(/name="viewport"/i)],
    ['canonical', has(/rel="canonical"/i)],
    ['og:title/description/image/url', ['og:title', 'og:description', 'og:image', 'og:url'].every((p) => has(new RegExp(`property="${p}"`)))],
    ['og:image dimensions declared', has(/og:image:width/) && has(/og:image:height/)],
    ['twitter:card', has(/name="twitter:card"/)],
    ['theme-color', has(/name="theme-color"/)],
    ['web manifest link', has(/rel="manifest"/)],
    ['apple-touch-icon', has(/rel="apple-touch-icon"/)],
    ['JSON-LD structured data', has(/application\/ld\+json/)],
  ];
}

export async function run() {
  const findings = [];
  const components = [];
  const metrics = {};
  const html = tryRead('index.html') ?? '';
  const head = checkHead(html);
  const ok = head.filter(([, p]) => p).length;
  components.push({ name: 'index.html head completeness', weight: 40, score: round1((100 * ok) / head.length), detail: `${ok}/${head.length}` });
  for (const [n, p] of head) if (!p) findings.push(finding({ id: 'seo/index-head', category: 'seo', severity: 'medium', title: `index.html: missing/invalid ${n}`, refs: [{ file: 'index.html' }], count: 1 }));

  const robots = tryRead('public/robots.txt') ?? '';
  const sitemapSrc = tryRead('public/sitemap.xml') ?? '';
  const locs = [...sitemapSrc.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => (m[1].length > 1 ? m[1].replace(/\/$/, '') : m[1]));
  let publicList = [];
  try { publicList = (await import('../../seo/routes.mjs')).STATIC_PUBLIC_PATHS; } catch { /* needs esbuild */ }
  const missingInSitemap = publicList.filter((p) => !locs.includes(p));
  const rb = [
    ['robots.txt exists', Boolean(robots)],
    ['robots.txt declares Sitemap', /^Sitemap:/mi.test(robots)],
    ['robots.txt does not block the whole site', !/^Disallow:\s*\/\s*$/mi.test(robots)],
  ];
  const rbScore = (100 * rb.filter(([, p]) => p).length) / rb.length;
  components.push({ name: 'robots.txt', weight: 15, score: round1(rbScore), detail: rb.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
  for (const [n, p] of rb) if (!p) findings.push(finding({ id: 'seo/robots', category: 'seo', severity: 'high', title: `robots.txt: ${n} failed`, refs: [{ file: 'public/robots.txt' }], count: 1 }));
  if (publicList.length) {
    metrics.sitemapSource = { urls: locs.length, publicPaths: publicList.length, missing: missingInSitemap.length };
    // The build regenerates the sitemap (scripts/seo/build-seo.mjs), so drift here is informational.
    components.push({ name: 'Committed sitemap covers STATIC_PUBLIC_PATHS (build regenerates; informational)', weight: 10, score: round1(100 * (1 - missingInSitemap.length / publicList.length)), detail: `${missingInSitemap.length} of ${publicList.length} public paths absent from public/sitemap.xml` });
    if (missingInSitemap.length) findings.push(finding({ id: 'seo/sitemap-drift', category: 'seo', severity: 'low', title: `public/sitemap.xml lacks ${missingInSitemap.length} public paths (regenerated at build; stale source file)`, refs: missingInSitemap.slice(0, 40).map((p) => ({ route: p })), count: missingInSitemap.length }));
  }

  let og = null;
  if (exists('public/og-image.png')) og = pngSize(readFileSync(join(ROOT, 'public/og-image.png')));
  const declW = Number(/og:image:width"\s+content="(\d+)"/.exec(html)?.[1] ?? NaN);
  const declH = Number(/og:image:height"\s+content="(\d+)"/.exec(html)?.[1] ?? NaN);
  const ratioOk = og && Math.abs(og.width / og.height - 1.91) < 0.08 && og.width >= 1200;
  const declOk = og && declW === og.width && declH === og.height;
  components.push({ name: 'OG image: ≥1200px wide, ~1.91:1, declared size matches the file', weight: 15, score: og ? (ratioOk ? 50 : 0) + (declOk ? 50 : 0) : 0, detail: og ? `file ${og.width}×${og.height}, declared ${declW}×${declH}` : 'missing' });
  if (og && !declOk) findings.push(finding({ id: 'seo/og-image-declared', category: 'seo', severity: 'medium', title: `og:image:width/height (${declW}×${declH}) do not match public/og-image.png (${og.width}×${og.height})`, detail: 'Crawlers use the declared size to pick a card layout; mismatches can crop or skip the image.', refs: [{ file: 'index.html' }, { file: 'public/og-image.png' }], count: 1 }));
  if (!og || !ratioOk) findings.push(finding({ id: 'seo/og-image', category: 'seo', severity: 'medium', title: `OG image is ${og ? `${og.width}×${og.height}` : 'missing'} (want ≥1200 wide at ~1.91:1)`, refs: [{ file: 'public/og-image.png' }], count: 1 }));
  metrics.ogImage = og;
  return { category: 'seo', components, metrics, findings };
}
