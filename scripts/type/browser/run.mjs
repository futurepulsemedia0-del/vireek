#!/usr/bin/env node
// scripts/type/browser/run.mjs — `npm run type:browser`
//
// Real-browser verification of the type system. Bundles the REAL components (the /dev/design-system page and the SVG charts
// that use useSvgTextSize) with the REAL Tailwind config, serves them, and measures in Chromium:
//   • no rendered text below 12px (SVG text measured at its on-screen scale), at phone and desktop widths
//   • text-only zoom to 200% via the app's real --a11y-font-scale mechanism, and 400% reflow width (320px)
//   • compact density never reduces type, keeps targets >= 24px
//   • WCAG 1.4.12 text-spacing overrides cause no clipping and no page-level horizontal overflow
//
//   node scripts/type/browser/run.mjs [--root <checkout>] [--cases charts,design-system] [--json out.json] [--shots <dir>]
//
// Needs Chromium: `npx playwright install chromium`, or set CHROMIUM_PATH (+ optional CHROMIUM_ARGS) to an existing binary.
// The checkout needs src/styles/tokens.generated.css (run `npm run tokens:build` first if it is not committed).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { transformSync } from 'esbuild';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const HERE = fileURLToPath(new URL('.', import.meta.url));
// The audit function is the SAME code the app ships (src/lib/typeAudit.ts). Transpiled here because Node 20 cannot import .ts.
function loadFindSmallText(root) {
  const ts = readFileSync(join(root, 'src/lib/typeAudit.ts'), 'utf8');
  const { code } = transformSync(ts, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports.findSmallText;
}
const ROOT = resolve(arg('--root') ?? join(HERE, '..', '..', '..'));
const CASES = (arg('--cases') ?? 'charts,design-system').split(',');
const JSON_OUT = arg('--json');
const SHOTS = arg('--shots'); // directory for one full-page PNG per scenario
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- bundle (harness files are copied into the checkout's tree view via root override)
// Staged INSIDE the checkout so bare imports (react, …) resolve through its node_modules; removed on exit.
const stage = join(ROOT, `.type-harness-${process.pid}`);
mkdirSync(stage, { recursive: true });
for (const c of CASES) {
  cpSync(join(HERE, `${c}.html`), join(stage, `${c}.html`));
  cpSync(join(HERE, `${c}.tsx`), join(stage, `${c}.tsx`));
}
const out = join(stage, 'dist');
process.chdir(ROOT); // tailwind.config.js content globs are cwd-relative
await build({
  root: stage,
  logLevel: 'error',
  plugins: [react()],
  resolve: { alias: { '@': join(ROOT, 'src') } },
  css: { postcss: ROOT },
  server: { fs: { allow: [ROOT, stage] } },
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: Object.fromEntries(CASES.map((c) => [c, join(stage, `${c}.html`)])) } },
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: (process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) } : {}),
});

// Browser-side helpers (serialised into the page, so they must be self-contained).
const clippedFn = () => {
  const bad = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!(el.textContent ?? '').trim()) continue;
    const clipsX = ['hidden', 'clip'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis';
    const clipsY = ['hidden', 'clip'].includes(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (clipsX || clipsY) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`);
  }
  return bad.slice(0, 8);
};
const SPACING_CSS = '*{line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important} p{margin-bottom:2em !important}';

// ONE browser context for the whole run; a fresh page per scenario (single-process Chromium builds die when a context closes).
const shared = await browser.newContext();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function open(page, c, qs = '') {
  await page.goto(`${base}/${c}.html${qs}`);
  await page.waitForSelector('#root > *');
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250); // ResizeObserver → state → re-render
}
const findSmallText = existsSync(join(ROOT, 'src/lib/typeAudit.ts')) ? loadFindSmallText(ROOT) : loadFindSmallText(join(HERE, '..', '..', '..'));
const small = (page) => page.evaluate(`(${findSmallText.toString()})(document, 12)`);
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const c of CASES) {
  const widths = c === 'charts' ? [320, 360, 720] : [390, 1280];
  for (const w of widths) {
    for (const mode of ['default', 'text200', 'spacing']) {
      const page = await shared.newPage({ viewport: { width: c === 'charts' ? Math.max(w + 24, 360) : w, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await open(page, c, c === 'charts' ? `?w=${w}` : '');
      // 200% via the app's real mechanism: lib/a11y/apply.ts sets --a11y-font-scale on <html>; index.css scales the root from it.
      if (mode === 'text200') { await page.evaluate(() => document.documentElement.style.setProperty('--a11y-font-scale', '2')); await page.waitForTimeout(400); }
      if (mode === 'spacing') { await page.addStyleTag({ content: SPACING_CSS }); await page.waitForTimeout(300); }
      const hits = await small(page);
      check(`${c} @${w}px [${mode}]: no text below 12px`, hits.length === 0, hits.length ? `${hits.length} hit(s), e.g. ${hits.slice(0, 3).map((h) => `${h.selector} ${h.px}px "${h.text}"`).join('; ')}` : '');
      if (c === 'design-system') {
        const ov = await overflowX(page);
        check(`${c} @${w}px [${mode}]: no page-level horizontal overflow`, ov <= 1, ov > 1 ? `${ov}px` : '');
        const clipped = await page.evaluate(clippedFn);
        check(`${c} @${w}px [${mode}]: no clipped text`, clipped.length === 0, clipped.join(', '));
      }
      check(`${c} @${w}px [${mode}]: no runtime errors`, errors.length === 0, errors[0] ?? '');
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${c}-${w}-${mode}.png`), fullPage: true });
      await page.close();
    }
  }
}

if (CASES.includes('design-system')) {
  const page = await shared.newPage({ viewport: { width: 1280, height: 900 } });
  await open(page, 'design-system');
  const rendered = await page.$$eval('[data-testid^="rendered-"]', (els) => els.map((e) => [e.getAttribute('data-testid'), parseFloat(e.textContent)]));
  check('design-system: every token reports a rendered size and all are >= 12px', rendered.length === 11 && rendered.every(([, px]) => px >= 12), rendered.map(([k, v]) => `${k.replace('rendered-', '')}=${v}`).join(' '));
  const before = await page.$eval('[data-testid="rendered-caption"]', (e) => parseFloat(e.textContent));
  await page.evaluate(() => document.documentElement.style.setProperty('--a11y-font-scale', '2'));
  await page.getByRole('button', { name: /compact/i }).click();
  await page.waitForTimeout(300);
  const after = await page.$eval('[data-testid="rendered-caption"]', (e) => parseFloat(e.textContent));
  check('design-system: 200% text size doubles caption (rem follows the root) and compact density does not shrink it', after === before * 2, `${before}px → ${after}px`);
  const targets = await page.$$eval('button.min-h-target', (els) => els.map((e) => e.getBoundingClientRect().height));
  check('design-system: compact targets stay >= 24px (WCAG 2.5.8)', targets.length > 0 && targets.every((h) => h >= 24), targets.map((h) => h.toFixed(1)).join(','));
  const id = await page.evaluate(() => { const e = document.querySelector('.type-id'); const cs = getComputedStyle(e); return [cs.direction, cs.unicodeBidi, cs.fontFamily.includes('mono') || cs.fontFamily.toLowerCase().includes('menlo')]; });
  check('design-system: .type-id is LTR-isolated monospace', id[0] === 'ltr' && id[1] === 'isolate' && id[2], id.join(' / '));
  await page.evaluate(() => { document.documentElement.lang = 'fa'; });
  const tracking = await page.evaluate(() => getComputedStyle(document.querySelector('[dir="rtl"] p.tracking-wider')).letterSpacing);
  check('design-system: letter-spacing is reset under lang=fa despite tracking-wider', tracking === '0px' || tracking === 'normal', tracking);
  await page.close();
}

await browser.close();
server.close();
rmSync(stage, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
