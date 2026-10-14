#!/usr/bin/env node
// Prerenders every public marketing route into dist/<route>/index.html using the real built app in
// headless Chromium (@playwright/test is already a devDependency). Third-party requests are blocked
// so no analytics/Supabase calls fire. Dashboard & token routes are never touched (SPA-only).
//
// Env: SKIP_PRERENDER=1 (skip), PRERENDER_OPTIONAL=1 (never fail the build), PRERENDER_CONCURRENCY=4
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ROOT, canonicalFor } from './routes.mjs';
import { extractHead } from './html-meta.mjs';

const DIST = path.join(ROOT, 'dist');
const OPTIONAL = process.env.PRERENDER_OPTIONAL === '1';
const CONCURRENCY = Math.max(1, Number(process.env.PRERENDER_CONCURRENCY ?? 4));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain',
};

function bail(message) {
  if (OPTIONAL) {
    console.warn(`[prerender] WARNING (PRERENDER_OPTIONAL=1): ${message}`);
    console.warn('[prerender] Shipping the plain SPA shell — NO prerendered HTML in this build.');
    process.exit(0);
  }
  console.error(`[prerender] ${message}`);
  process.exit(1);
}

/** Static server: real files from dist/, every extension-less route -> pristine _spa.html. */
function startServer() {
  const spa = path.join(DIST, '_spa.html');
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const ext = path.extname(urlPath);
    let file = spa;
    if (ext && ext !== '.html') {
      const candidate = path.normalize(path.join(DIST, urlPath));
      if (!candidate.startsWith(DIST + path.sep) || !existsSync(candidate) || !statSync(candidate).isFile()) {
        res.writeHead(404).end();
        return;
      }
      file = candidate;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

const outputPath = (p) =>
  p === '/' ? path.join(DIST, 'index.html') : path.join(DIST, p.slice(1), 'index.html');

async function renderRoute(context, origin, route) {
  const page = await context.newPage();
  const chunks = new Set();
  const pageErrors = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.origin === origin && /^\/assets\/.+\.js$/.test(u.pathname)) chunks.add(u.pathname);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e).slice(0, 200)));
  try {
    await page.goto(origin + route.path, { waitUntil: 'load', timeout: 30000 });
    // Real content mounted (lazy chunk resolved), not just the Suspense spinner.
    await page.waitForFunction(
      () => {
        const r = document.getElementById('root');
        return !!r && (!!r.querySelector('h1') || (r.textContent ?? '').trim().length > 600);
      },
      undefined,
      { timeout: 25000 },
    );
    await page
      .waitForFunction(
        (c) => document.querySelector('link[rel="canonical"]')?.getAttribute('href') === c,
        canonicalFor(route.path),
        { timeout: 2500 },
      )
      .catch(() => {});
    await page.waitForTimeout(150);
    const html = await page.evaluate(() => {
      // Head nodes created by useSEO are tagged so the client can swap them out without duplicates.
      document.querySelectorAll('[data-seo-managed]').forEach((el) => {
        el.removeAttribute('data-seo-managed');
        el.setAttribute('data-ssg', '1');
      });
      return `<!doctype html>\n${document.documentElement.outerHTML}`;
    });
    return { html, chunks: [...chunks], pageErrors };
  } finally {
    await page.close();
  }
}

function finalize(rawHtml, route, chunks) {
  const expected = canonicalFor(route.path);
  let html = rawHtml;
  const before = extractHead(html);
  const ownSeo = before.canonicals.length === 1 && before.canonicals[0] === expected;

  if (!ownSeo) {
    // Page has no useSEO of its own: never ship the homepage canonical on another URL.
    html = html
      .replace(/(<link\b[^>]*\brel="canonical"[^>]*\bhref=")[^"]*(")/i, `$1${expected}$2`)
      .replace(/(<meta\b[^>]*\bproperty="og:url"[^>]*\bcontent=")[^"]*(")/i, `$1${expected}$2`);
  }

  // Preload the lazy route chunks so the client takes over without a spinner flash.
  const known = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]));
  const preloads = chunks
    .filter((c) => !known.has(c))
    .map((c) => `    <link rel="modulepreload" crossorigin href="${c}">`)
    .join('\n');
  if (preloads) html = html.replace('</head>', `${preloads}\n  </head>`);

  return { html, ownSeo, title: extractHead(html).title };
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

async function main() {
  if (process.env.SKIP_PRERENDER === '1') {
    console.log('[prerender] SKIP_PRERENDER=1 — skipped.');
    return;
  }
  const manifestPath = path.join(DIST, 'routes.json');
  if (!existsSync(manifestPath)) bail('dist/routes.json missing — run scripts/seo/build-seo.mjs first.');
  const { routes } = JSON.parse(await readFile(manifestPath, 'utf8'));

  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    bail('@playwright/test is not installed.');
  }
  let browser;
  try {
    browser = await chromium.launch({ args: process.env.CI ? ['--no-sandbox'] : [] });
  } catch (e) {
    bail(`Chromium failed to launch (${String(e.message).split('\n')[0]}). Run: npx playwright install chromium`);
  }

  const { server, origin } = await startServer();
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    window.__VIREEK_PRERENDER__ = true;
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')
      ? route.continue()
      : route.abort();
  });

  const started = Date.now();
  const report = [];
  const failures = [];
  await pool(routes, CONCURRENCY, async (route) => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { html, chunks, pageErrors } = await renderRoute(context, origin, route);
        const done = finalize(html, route, chunks);
        const file = outputPath(route.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, done.html);
        report.push({ path: route.path, ownSeo: done.ownSeo, title: done.title, pageErrors: pageErrors.slice(0, 3) });
        return;
      } catch (e) {
        lastError = e;
      }
    }
    failures.push({ path: route.path, error: String(lastError?.message ?? lastError).split('\n')[0] });
  });

  await context.close();
  await browser.close();
  server.close();

  report.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    path.join(DIST, '_prerender-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), failures, pages: report }, null, 2),
  );

  const gaps = report.filter((r) => !r.ownSeo).map((r) => r.path);
  console.log(`[prerender] ${report.length}/${routes.length} routes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (gaps.length) console.warn(`[prerender] ${gaps.length} page(s) have no useSEO of their own (canonical forced to self): ${gaps.join(', ')}`);
  if (failures.length) {
    for (const f of failures) console.error(`[prerender] FAILED ${f.path}: ${f.error}`);
    if (!OPTIONAL) process.exit(1);
  }
}

main().catch((e) => bail(String(e?.stack ?? e)));
