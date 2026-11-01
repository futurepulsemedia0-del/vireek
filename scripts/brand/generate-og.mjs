#!/usr/bin/env node
// Build step (after prerender): renders one branded 1200x630 card per indexable page (+ help articles) into dist/og/.
// Titles/descriptions come from the prerendered HTML, i.e. exactly what the page shows. A card that fails to render
// is replaced by the default card (never a missing file). Env: SKIP_OG=1 skips.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ROOT, fail, loadBrand, loadFonts, renderSymbolDataUri } from './lib.mjs';
import { buildCardTree, createRenderer } from './og-layout.mjs';
import { extractHead } from '../seo/html-meta.mjs';
import { loadTsModule } from '../seo/routes.mjs';

const DIST = path.join(ROOT, 'dist');
const htmlFile = (p) => (p === '/' ? path.join(DIST, 'index.html') : path.join(DIST, p.slice(1), 'index.html'));
const humanize = (p) => {
  const w = (p.split('/').filter(Boolean).pop() ?? '').replace(/-/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};

async function main() {
  if (process.env.SKIP_OG === '1') return console.log('[og] SKIP_OG=1 - skipped.');
  const routesPath = path.join(DIST, 'routes.json');
  if (!existsSync(routesPath)) fail('dist/routes.json missing - run scripts/seo/build-seo.mjs first.');
  const fallback = path.join(DIST, 'og-image.png');
  if (!existsSync(fallback)) fail('dist/og-image.png (default card) missing.');

  const brand = await loadBrand();
  const { BRAND, OG_KIND_LABEL, ogKindFor, ogPathFor } = brand;
  let render;
  let symbolUri;
  let fonts;
  try {
    fonts = loadFonts();
    render = await createRenderer({ fonts });
    symbolUri = await renderSymbolDataUri(256);
  } catch (e) {
    fail(`OG toolchain unavailable (${e.message}). Run: npm i -D satori @resvg/resvg-js @fontsource/sora @fontsource/inter`);
  }

  const { routes } = JSON.parse(await readFile(routesPath, 'utf8'));
  const report = existsSync(path.join(DIST, '_prerender-report.json'))
    ? JSON.parse(await readFile(path.join(DIST, '_prerender-report.json'), 'utf8'))
    : { pages: [] };
  const ownSeo = new Map(report.pages.map((p) => [p.path, p.ownSeo]));

  const items = [];
  for (const r of routes) {
    const file = htmlFile(r.path);
    const head = existsSync(file) ? extractHead(await readFile(file, 'utf8')) : null;
    const own = ownSeo.get(r.path) !== false && head?.ogTitle;
    items.push({
      path: r.path,
      title: own ? brand.stripBrandSuffix(head.ogTitle) : humanize(r.path),
      description: own ? head.ogDescription : '',
    });
  }
  try {
    // Help articles are SPA-only (not in routes.json) but their pages still point og:image at /og/help--<slug>.png.
    const { HELP_ARTICLES } = await loadTsModule('src/lib/helpArticles.ts');
    for (const a of HELP_ARTICLES) items.push({ path: `/help/${a.slug}`, title: a.title, description: a.excerpt });
  } catch (e) {
    console.warn(`[og] help articles skipped (${String(e.message).split('\n')[0]}); they use the default card.`);
  }

  await mkdir(path.join(DIST, 'og'), { recursive: true });
  const manifest = [];
  const failures = [];
  for (const it of items) {
    const ogPath = ogPathFor(it.path);
    if (!ogPath) continue; // not a clean slug: useSEO points these at the default card too
    const kind = ogKindFor(it.path);
    const home = kind === 'home';
    const out = path.join(DIST, ogPath);
    try {
      const png = await render(
        buildCardTree({
          brand,
          title: home ? BRAND.tagline : it.title,
          tagline: home ? `${BRAND.descriptor.charAt(0).toUpperCase()}${BRAND.descriptor.slice(1)}.` : it.description,
          kindLabel: home || kind === 'page' ? null : OG_KIND_LABEL[kind],
          host: BRAND.domain,
          symbolUri,
        }),
        1200,
        630,
      );
      await writeFile(out, png);
      manifest.push({ path: it.path, og: ogPath, kind, title: it.title });
    } catch (e) {
      await copyFile(fallback, out);
      failures.push({ path: it.path, error: String(e.message).split('\n')[0] });
    }
  }
  await writeFile(path.join(DIST, 'og', '_manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), cards: manifest, failures }, null, 2));
  console.log(`[og] ${manifest.length}/${items.length} cards rendered${failures.length ? `, ${failures.length} fell back to the default card` : ''}.`);
  for (const f of failures.slice(0, 10)) console.warn(`[og] fallback ${f.path}: ${f.error}`);
  if (failures.length > Math.max(3, items.length * 0.1)) fail('too many cards failed to render - the toolchain is broken, not individual pages.');
}

main().catch((e) => fail(String(e?.stack ?? e)));
