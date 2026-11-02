#!/usr/bin/env node
// npm run brand:audit:selftest — proves the CRAWLER + DERIVATION work end to end against a fixture with known defects.
// Needs Playwright + Chromium. Exit 1 on any failed expectation. axe assertions run only when @axe-core/playwright is installed.
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from './fixture/server.mjs';
import { crawl } from './crawl/crawl.mjs';
import { deriveFromCrawl } from './crawl/derive.mjs';
import { buildMatcher } from './lib/routes.mjs';

const fx = await startFixture();
const out = mkdtempSync(join(tmpdir(), 'brand-audit-selftest-'));
const known = buildMatcher(['/', '/bad', '/login', '/dashboard']);
const data = await crawl({
  baseUrl: fx.url, outDir: out, shots: true, rtl: false, depth: 'smoke', knownPath: known,
  table: { all: ['/', '/bad', '/login', '/dashboard'], dataPatterns: [], isKnownPath: known },
  routes: [{ route: '/', kind: 'public', matrix: true }, { route: '/bad', kind: 'public', matrix: true }, { route: '/dashboard', kind: 'auth', matrix: true }],
  writeAllow: [/\/api\/login$/], creds: { user: { email: 'audit@example.test', password: 'correct horse' } }, log: () => {},
});
const derived = deriveFromCrawl(data);
const cat = (id) => derived.find((d) => d.category === id);
const comp = (id, re) => cat(id)?.components.find((c) => re.test(c.name));
const finds = (id) => (cat(id)?.findings ?? []).map((f) => f.id);
const R = (route, role) => data.routes.find((r) => r.route === route && (!role || r.role === role));

const checks = [
  ['login succeeded with the sandbox credentials', data.auth.user?.status === 'ok'],
  ['unauthenticated visit to /dashboard is NOT part of the public pass (only the authed pass audits it)', !data.routes.some((r) => r.route === '/dashboard' && r.role === 'anon')],
  ['authenticated /dashboard audited (not redirected to login)', R('/dashboard', 'user') && !R('/dashboard', 'user').skipped],
  ['read-only guard blocked the dashboard POST, including the first load right after login (server saw 0 writes)', fx.hits.writePosts === 0 && data.blockedWrites.some((b) => b.url.endsWith('/api/write'))],
  ['matrix produced 6 screenshots per matrix route (2 themes × 3 viewports)', R('/', 'anon').shots.length === 6 && R('/bad', 'anon').shots.every((s) => existsSync(join(out, s)))],
  ['dark theme really applied (html.dark set and body background differs from light)', R('/', 'anon').combos['dark@1280'].rendered.htmlDark === true && R('/', 'anon').combos['light@1280'].rendered.htmlDark === false && R('/', 'anon').combos['dark@1280'].rendered.bodyBg !== R('/', 'anon').combos['light@1280'].rendered.bodyBg],
  ['clean page: exactly one h1, lang set, no console errors', R('/', 'anon').combos['light@1280'].meta.h1Count === 1 && R('/', 'anon').console.length === 0],
  ['bad page: two h1 detected', R('/bad', 'anon').combos['light@1280'].meta.h1Count === 2],
  ['bad page: console error captured', R('/bad', 'anon').console.some((c) => /fixture boom/.test(c))],
  ['bad page: horizontal overflow at 375 detected, none on the clean page', R('/bad', 'anon').combos['light@375'].layout.overflow === true && R('/', 'anon').combos['light@375'].layout.overflow === false],
  ['bad page: undersized tap targets found at 375', R('/bad', 'anon').combos['light@375'].layout.smallTargets >= 2],
  ['bad page: raw i18n key + "undefined" leak detected', R('/bad', 'anon').combos['light@1280'].i18n.rawKeys.includes('format.showMore') && R('/bad', 'anon').combos['light@1280'].i18n.leaks.length > 0],
  ['authed page: raw key detected', R('/dashboard', 'user').combos['light@1280'].i18n.rawKeys.includes('dashboard.jobs.emptyTitle')],
  ['bad page: off-brand font detected, clean page has none', R('/bad', 'anon').combos['light@1280'].fonts.offBrandCount > 0 && R('/', 'anon').combos['light@1280'].fonts.offBrandCount === 0],
  ['broken internal link (/nope-404) found via the route table', data.brokenLinks.some((b) => b.path === '/nope-404')],
  ['perf probes captured an LCP-or-FCP number on the clean page', R('/', 'anon').combos['light@1280'].perf.fcp != null || R('/', 'anon').combos['light@1280'].perf.lcp != null],
  ['focus probe ran on the clean page (visible outline on first Tab)', R('/', 'anon').combos['light@1280'].focus?.visible === true],
  ['derive: l10n leak finding is critical', (cat('l10n').findings.find((f) => f.id === 'l10n/rendered-leak') ?? {}).severity === 'critical'],
  ['derive: mobile overflow finding present', finds('mobile').includes('mobile/overflow')],
  ['derive: SEO flags the bad page missing description/canonical', finds('seo').some((i) => /seo\/route-/.test(i))],
  ['derive: broken-link finding present', finds('seo').includes('seo/broken-links')],
  ['derive: localhost origin => live-header component is NOT RUN (not a fake pass)', comp('security', /Live response headers/)?.score === null],
  ['derive: no tracker requests on fixture => privacy component 100', comp('security', /tracker/i)?.score === 100],
];
if (data.axe === 'unavailable') checks.push(['axe unavailable => a11y components are NOT RUN (BLOCKED), never a pass', cat('a11y').components.slice(0, 2).every((c) => c.score === null)]);
else checks.push(['axe ran and found violations on the bad page (e.g. html-has-lang / duplicate h1 landmark rules)', (R('/bad', 'anon').combos['light@1280'].axe?.total ?? 0) > 0]);

let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; }
console.log(`\naxe: ${data.axe}   routes visited: ${data.routes.length}   screenshots dir: ${readdirSync(join(out, 'screenshots')).length} files`);
await fx.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll self-test checks passed');
process.exit(failed ? 1 : 0);
