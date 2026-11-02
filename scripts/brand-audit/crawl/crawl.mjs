// crawl/crawl.mjs — Playwright crawler. NAVIGATES ONLY: it never clicks or types except on the login form.
// Safety: credentials come from env and live only in memory (no storageState on disk). After login, every
// non-GET request is aborted (except auth + rpc reads) unless allowWrites is set; blocked requests are reported.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, VIEWPORTS, THEME_STORAGE_KEY, LANG_STORAGE_KEY, ALLOWED_FONTS, KEY_ROUTES, RTL_LANGS } from '../config.mjs';
import { slug } from '../lib/util.mjs';
import { internalPath } from '../lib/routes.mjs';
import { pageProbe, perfInit, focusProbe, RAW_KEY_SOURCE, NOT_KEY_SOURCE, LEAK_SOURCE } from './probes.mjs';
import { loadAxe, runAxe } from './axe.mjs';

const GOOGLE = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net/i;
const WRITE_ALLOW = [/\/auth\/v1\//, /\/rest\/v1\/rpc\//];
const NOISE = /favicon|ResizeObserver loop|net::ERR_BLOCKED_BY_CLIENT|Failed to load resource.*(googletagmanager|google-analytics)/i;
const strip = (u) => String(u).split('?')[0].split('#')[0];

export async function loadChromium() {
  for (const m of ['@playwright/test', 'playwright']) {
    try { const mod = await import(m); if (mod.chromium) return mod.chromium; } catch { /* try next */ }
  }
  throw new Error('Playwright is not installed (npm i -D @playwright/test; npx playwright install chromium).');
}

/** Pure: pick which routes get the full matrix vs the light pass for a depth. */
export function planRoutes({ depth, table, shard, maxRoutes }) {
  const inRouter = (p) => table.all.includes(p);
  const missingKey = [...KEY_ROUTES.public, ...KEY_ROUTES.auth].filter((p) => !inRouter(p));
  const keyPub = KEY_ROUTES.public.filter(inRouter);
  const keyAuth = KEY_ROUTES.auth.filter(inRouter);
  const smoke = depth === 'smoke';
  const matrix = [...keyPub.slice(0, smoke ? 6 : keyPub.length).map((route) => ({ route, kind: 'public', matrix: true })), ...keyAuth.slice(0, smoke ? 3 : keyAuth.length).map((route) => ({ route, kind: 'auth', matrix: true }))];
  const have = new Set(matrix.map((m) => m.route));
  let light = [];
  if (!smoke) light = table.publicStatic.filter((p) => !have.has(p)).map((route) => ({ route, kind: 'public', matrix: false }));
  if (depth === 'full') {
    light.push(...table.authRoutes.filter((p) => !have.has(p)).map((route) => ({ route, kind: 'auth', matrix: false })));
    light.push(...table.staffRoutes.map((route) => ({ route, kind: 'staff', matrix: false })));
  }
  if (shard) light = light.filter((_, i) => i % shard.of === shard.index);
  if (maxRoutes) light = light.slice(0, maxRoutes);
  return { matrix: shard && shard.index !== 0 ? [] : matrix, light, missingKey };
}

export async function crawl(opts) {
  const { baseUrl, outDir, table, routes, shots = true, allowWrites = false, rtl = true, creds = {}, log = console.log, knownPath, writeAllow = [] } = opts;
  const chromium = await loadChromium();
  const AxeBuilder = await loadAxe();
  const origin = new URL(baseUrl).origin;
  const shotDir = join(outDir, 'screenshots');
  if (shots) mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const out = { baseUrl, axe: AxeBuilder ? 'available' : 'unavailable', auth: {}, routes: [], blockedWrites: [], trackerHitsBeforeConsent: [], headers: null, startedAt: new Date().toISOString() };

  const newContext = async (theme, { lang } = {}) => {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[2], colorScheme: theme, reducedMotion: 'reduce' });
    await ctx.addInitScript(perfInit);
    await ctx.addInitScript(([k, t, lk, lv]) => { try { localStorage.setItem(k, t); if (lv) localStorage.setItem(lk, lv); } catch { /* storage blocked */ } }, [THEME_STORAGE_KEY, theme, LANG_STORAGE_KEY, lang ?? null]);
    return ctx;
  };
  const guard = async (ctx) => {
    if (allowWrites) return;
    await ctx.route('**/*', (route) => {
      const r = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || [...WRITE_ALLOW, ...writeAllow].some((re) => re.test(r.url()))) return route.continue();
      out.blockedWrites.push({ method: r.method(), url: strip(r.url()) });
      return route.abort('blockedbyclient');
    });
  };
  const blockTrackers = (ctx) => ctx.route(GOOGLE, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));

  async function login(ctx, who) {
    if (!who.email || !who.password) return { status: 'no-credentials' };
    const page = await ctx.newPage();
    try {
      await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email address').fill(who.email);
      await page.getByLabel('Password').fill(who.password);
      await page.getByRole('button', { name: 'Sign In' }).click();
      await page.waitForURL(/\/(dashboard|tech|staff|onboarding|mfa)/, { timeout: 20_000 });
      // Let the first post-login page load finish while the page (and the read-only guard's handlers) are still alive.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (/\/mfa/.test(page.url())) return { status: 'mfa-required' };
      return { status: 'ok' };
    } catch (e) {
      return { status: 'login-failed', reason: String(e.message).split('\n')[0].replace(who.password, '***').slice(0, 120) };
    } finally { await page.close(); }
  }

  async function settle(page) {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('#vrk-boot', { state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  async function visit(ctx, item, role) {
    const rec = { route: item.route, kind: item.kind, matrix: item.matrix, role, status: null, finalPath: null, skipped: null, combos: {}, console: [], pageErrors: [], failed: [], shots: [], links: [] };
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) rec.console.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => rec.pageErrors.push(String(e.message).slice(0, 160)));
    page.on('response', (r) => { const u = r.url(); if (r.status() >= 400 && (u.startsWith(origin) || /supabase\.co/.test(u)) && !NOISE.test(u)) rec.failed.push(`${r.status()} ${strip(u).slice(0, 120)}`); });
    try {
      const themes = item.matrix ? THEMES : ['light'];
      for (const theme of themes) {
        const vps = item.matrix ? VIEWPORTS : [VIEWPORTS[2]];
        await page.setViewportSize(vps[vps.length - 1]);
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* */ } }, [THEME_STORAGE_KEY, theme]);
        const resp = await page.goto(`${origin}${item.route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        rec.status = resp?.status() ?? null;
        await settle(page);
        rec.finalPath = new URL(page.url()).pathname;
        if (item.kind !== 'public' && /^\/(login|signup|sso-login)/.test(rec.finalPath)) { rec.skipped = 'redirected-to-login'; break; }
        for (const vp of vps) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(200);
          const probe = await page.evaluate(pageProbe, { allowedFonts: ALLOWED_FONTS, rawKeySrc: RAW_KEY_SOURCE, notKeySrc: NOT_KEY_SOURCE, leakSrc: LEAK_SOURCE, maxEls: 4000 });
          const key = `${theme}@${vp.name}`;
          const combo = { ...probe, theme, vp: vp.name };
          if (AxeBuilder && (!item.matrix || vp.name !== '768')) {
            try { combo.axe = await runAxe(AxeBuilder, page); } catch (e) { combo.axeError = String(e.message).slice(0, 100); }
          }
          if (shots && item.matrix) {
            const file = join(shotDir, `${slug(item.route)}__${role}__${theme}-${vp.name}.jpg`);
            await page.screenshot({ path: file, type: 'jpeg', quality: 60, fullPage: true, animations: 'disabled' }).then(() => rec.shots.push(file.replace(`${outDir}/`, ''))).catch(() => {});
          }
          if (theme === 'light' && vp.name === '1280') {
            await page.keyboard.press('Tab');
            combo.focus = await page.evaluate(focusProbe);
          }
          if (!rec.links.length) rec.links = probe.links ?? [];
          rec.combos[key] = combo;
          delete combo.links;
        }
      }
    } catch (e) {
      rec.skipped = `error: ${String(e.message).split('\n')[0].slice(0, 120)}`;
    } finally { await page.close(); }
    return rec;
  }

  try {
    // ---- public pass (no consent given: also proves "no trackers before consent")
    const pubCtx = await newContext('light');
    await blockTrackers(pubCtx);
    pubCtx.on('request', (r) => { if (GOOGLE.test(r.url())) out.trackerHitsBeforeConsent.push(strip(r.url())); });
    const pubRoutes = routes.filter((r) => r.kind === 'public');
    for (const [i, item] of pubRoutes.entries()) { log(`[public ${i + 1}/${pubRoutes.length}] ${item.route}${item.matrix ? ' (matrix)' : ''}`); out.routes.push(await visit(pubCtx, item, 'anon')); }
    // live headers of the crawled origin (meaningful only for deployed origins; the Vite preview server ignores vercel.json)
    try { const p = await pubCtx.request.get(`${origin}/`); out.headers = Object.fromEntries(Object.entries(p.headers()).filter(([k]) => /^(strict-transport|x-content-type|referrer-policy|content-security|permissions-policy|x-frame)/.test(k))); } catch { /* offline */ }
    await pubCtx.close();

    // ---- discovered data-route samples (one per pattern), light pass
    if (opts.depth !== 'smoke' && table?.dataPatterns?.length) {
      const have = new Set(out.routes.map((r) => r.route));
      const samples = [];
      for (const pat of table.dataPatterns) {
        const prefix = pat.slice(0, pat.indexOf(':'));
        for (const r of out.routes) {
          const hit = (r.links ?? []).map((h) => internalPath(h, origin)).find((p) => p && p.startsWith(prefix) && p !== prefix.replace(/\/$/, '') && !have.has(p));
          if (hit) { samples.push({ route: hit, kind: 'public', matrix: false }); have.add(hit); break; }
        }
      }
      if (samples.length) { const c = await newContext('light'); await blockTrackers(c); for (const s of samples) { log(`[sample] ${s.route}`); out.routes.push(await visit(c, s, 'anon')); } await c.close(); }
    }

    // ---- authenticated passes (user, then staff)
    for (const role of ['user', 'staff']) {
      const who = creds[role];
      const items = routes.filter((r) => (role === 'staff' ? r.kind === 'staff' : r.kind === 'auth'));
      if (!items.length) continue;
      if (!who?.email) { out.auth[role] = { status: 'no-credentials', routes: items.length }; continue; }
      const ctx = await newContext('light');
      await blockTrackers(ctx);
      await guard(ctx); // BEFORE login: the first page load after sign-in must not be able to write either
      const res = await login(ctx, who);
      out.auth[role] = { ...res, routes: items.length };
      if (res.status === 'ok') {
        for (const [i, item] of items.entries()) { log(`[${role} ${i + 1}/${items.length}] ${item.route}${item.matrix ? ' (matrix)' : ''}`); out.routes.push(await visit(ctx, item, role)); }
      }
      await ctx.close();
    }

    // ---- RTL pass: Persian, light, 375 + 1280, on a small key subset
    if (rtl) {
      const subset = routes.filter((r) => r.matrix && r.kind === 'public').slice(0, 6);
      const ctx = await newContext('light', { lang: RTL_LANGS.includes('fa') ? 'fa' : RTL_LANGS[0] });
      await blockTrackers(ctx);
      for (const item of subset) {
        const page = await ctx.newPage();
        const rec = { route: item.route, lang: 'fa', vps: {} };
        try {
          await page.goto(`${origin}${item.route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await settle(page);
          for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.waitForTimeout(200);
            const r = await page.evaluate(() => ({ dir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction, lang: document.documentElement.lang, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
            rec.vps[vp.name] = r;
            if (shots) { const file = join(shotDir, `${slug(item.route)}__rtl-fa-${vp.name}.jpg`); await page.screenshot({ path: file, type: 'jpeg', quality: 55, fullPage: true, animations: 'disabled' }).catch(() => {}); }
          }
        } catch (e) { rec.error = String(e.message).split('\n')[0].slice(0, 100); } finally { await page.close(); }
        (out.rtl ??= []).push(rec);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }

  // ---- internal link check against the real route table (SPA fallbacks return 200 for unknown paths, so HTTP cannot detect them)
  const broken = new Map();
  const known = knownPath ?? table?.isKnownPath;
  if (known) for (const r of out.routes) for (const href of r.links ?? []) {
    const p = internalPath(href, origin);
    if (!p || /\.(png|jpg|jpeg|svg|webp|ico|pdf|xml|json|txt|js|css|woff2?)$/i.test(p) || known(p)) continue;
    (broken.get(p) ?? broken.set(p, new Set()).get(p)).add(r.route);
  }
  out.brokenLinks = [...broken].map(([path, from]) => ({ path, from: [...from].slice(0, 5), count: from.size }));
  out.finishedAt = new Date().toISOString();
  return out;
}
