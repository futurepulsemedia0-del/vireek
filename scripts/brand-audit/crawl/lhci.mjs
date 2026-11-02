// crawl/lhci.mjs — ingest Lighthouse CI output (.lighthouseci). Lighthouse itself runs in CI (npx @lhci/cli); this only reads results.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pure: one Lighthouse result -> numbers (0-100 category scores, ms metrics). */
export function summarizeLhr(lhr) {
  const c = (k) => (lhr.categories?.[k]?.score == null ? null : Math.round(lhr.categories[k].score * 100));
  const a = (k) => lhr.audits?.[k]?.numericValue ?? null;
  return { url: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl, performance: c('performance'), accessibility: c('accessibility'), bestPractices: c('best-practices'), seo: c('seo'), lcp: a('largest-contentful-paint'), cls: a('cumulative-layout-shift'), tbt: a('total-blocking-time') };
}

export function ingestLhci(dir) {
  const manifest = join(dir, 'manifest.json');
  if (!existsSync(manifest)) return null;
  const entries = JSON.parse(readFileSync(manifest, 'utf8'));
  const byUrl = new Map();
  for (const e of entries) {
    const prev = byUrl.get(e.url);
    if (!prev || (e.isRepresentativeRun && !prev.isRepresentativeRun)) byUrl.set(e.url, e);
  }
  const pages = [];
  for (const e of byUrl.values()) {
    try { pages.push({ ...summarizeLhr(JSON.parse(readFileSync(e.jsonPath.startsWith('/') ? e.jsonPath : join(dir, e.jsonPath.split(/[\\/]/).pop()), 'utf8'))), url: e.url }); } catch { /* skip unreadable */ }
  }
  return pages.length ? pages : null;
}
