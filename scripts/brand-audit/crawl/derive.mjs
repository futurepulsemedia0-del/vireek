// crawl/derive.mjs — turn raw crawl data into category results (same shape as the static checks).
// Rule: a component is `null` (NOT RUN / BLOCKED) when its evidence was not collected — never a default pass.
import { finding, pct, round1, slug } from '../lib/util.mjs';

const SEV = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' };
const live = (r) => !r.skipped;
const comboList = (r) => Object.values(r.combos ?? {});
const at = (r, key) => r.combos?.[key];
const first = (r) => at(r, 'light@1280') ?? comboList(r)[0];
const share = (arr, pred) => (arr.length ? round1(pct(arr.filter(pred).length, arr.length)) : null);
const nullC = (name, weight, why) => ({ name, weight, score: null, detail: `NOT RUN — ${why}` });
const byRoute = (rs) => rs.map((r) => ({ route: r.route }));

export function checkMeta(m, route, canonicalPathOk) {
  const t = (m.title ?? '').trim(); const d = (m.description ?? '').trim();
  return [
    ['title 15–70 chars', t.length >= 15 && t.length <= 70],
    ['meta description 50–170 chars', d.length >= 50 && d.length <= 170],
    ['canonical present', Boolean(m.canonical)],
    ['canonical points to this route', canonicalPathOk(m.canonical, route)],
    ['og:title + og:description + og:image', Boolean(m.ogTitle && m.ogDescription && m.ogImage)],
    ['twitter:card', Boolean(m.twitterCard)],
    ['exactly one <h1>', m.h1Count === 1],
    ['<html lang>', Boolean(m.lang)],
    ['indexable (no noindex)', !/noindex/i.test(m.robots ?? '')],
  ];
}

export function deriveFromCrawl(crawl, { lhci = null, bundle = null, canonicalPathOk = (c, route) => { try { return new URL(c).pathname.replace(/\/$/, '') === route.replace(/\/$/, ''); } catch { return false; } } } = {}) {
  const out = {};
  const get = (id) => (out[id] ??= { category: id, components: [], metrics: {}, findings: [] });
  const routes = crawl.routes ?? [];
  const audited = routes.filter(live);
  const skipped = routes.filter((r) => r.skipped);
  const pub = audited.filter((r) => r.kind === 'public');
  const hostLocal = /^(localhost|127\.|\[::1\])/.test(new URL(crawl.baseUrl).hostname);

  // coverage / auth status
  const authInfo = Object.entries(crawl.auth ?? {});
  for (const [role, a] of authInfo) if (a.status !== 'ok') get('states').findings.push(finding({ id: `crawl/auth-${role}`, category: 'states', severity: 'info', title: `Authenticated "${role}" routes NOT audited: ${a.status}${a.reason ? ` (${a.reason})` : ''}`, detail: 'Set E2E_TEST_EMAIL / E2E_TEST_PASSWORD (and BRAND_AUDIT_STAFF_EMAIL / _PASSWORD for /staff) in CI secrets, using a sandbox tenant.', refs: [], count: a.routes ?? 1 }));
  if (skipped.length) get('states').findings.push(finding({ id: 'crawl/skipped', category: 'states', severity: 'info', title: `${skipped.length} route(s) skipped: ${[...new Set(skipped.map((r) => r.skipped.split(':')[0]))].join(', ')}`, refs: skipped.slice(0, 50).map((r) => ({ route: r.route, text: r.skipped })), count: skipped.length }));
  get('states').metrics.crawl = { routesAudited: audited.length, routesSkipped: skipped.length, matrixRoutes: audited.filter((r) => r.matrix).length, auth: crawl.auth, blockedWrites: crawl.blockedWrites?.length ?? 0 };

  // ---------------- accessibility
  const axeCombos = audited.flatMap((r) => Object.entries(r.combos).filter(([, c]) => c.axe).map(([k, c]) => ({ r, k, c })));
  const A = get('a11y').components;
  if (crawl.axe === 'unavailable' || !axeCombos.length) {
    const why = crawl.axe === 'unavailable' ? 'BLOCKED: @axe-core/playwright is not installed' : 'axe produced no results';
    A.push(nullC('No critical/serious axe violations', 50, why), nullC('No axe violations of any impact', 20, why));
    get('a11y').findings.push(finding({ id: 'crawl/axe-unavailable', category: 'a11y', severity: 'high', title: why, refs: [], count: 1 }));
  } else {
    A.push({ name: 'No critical/serious axe violations (per page × theme × viewport)', weight: 50, score: share(axeCombos, ({ c }) => c.axe.severeCount === 0), detail: `${axeCombos.length} axe runs on ${new Set(axeCombos.map((x) => x.r.route)).size} routes` });
    A.push({ name: 'No axe violations of any impact', weight: 20, score: share(axeCombos, ({ c }) => c.axe.total === 0), detail: 'WCAG 2.0/2.1/2.2 A+AA tags' });
    const rules = new Map();
    for (const { r, k, c } of axeCombos) for (const v of c.axe.violations) {
      const e = rules.get(v.id) ?? { impact: v.impact, help: v.help, url: v.helpUrl, pages: new Set(), refs: [] };
      e.pages.add(`${r.route}|${k}`);
      if (e.refs.length < 40) e.refs.push({ route: r.route, text: `${k} · ${v.nodes} node(s) · ${v.sample[0] ?? ''}`.slice(0, 140) });
      rules.set(v.id, e);
    }
    for (const [id, e] of rules) get('a11y').findings.push(finding({ id: `a11y/axe-${id}`, category: 'a11y', severity: SEV[e.impact] ?? 'medium', title: `axe ${id} (${e.impact}) on ${e.pages.size} page-state(s): ${e.help}`, detail: e.url, refs: e.refs, count: e.pages.size }));
  }
  const focusRoutes = audited.filter((r) => at(r, 'light@1280')?.focus);
  A.push(focusRoutes.length ? { name: 'First Tab stop is focused and shows a visible focus indicator', weight: 20, score: share(focusRoutes, (r) => at(r, 'light@1280').focus.focused && at(r, 'light@1280').focus.visible), detail: `${focusRoutes.length} routes (full keyboard/screen-reader flows still need manual testing)` } : nullC('First Tab stop focus indicator', 20, 'no focus probes'));
  const badFocus = focusRoutes.filter((r) => !(at(r, 'light@1280').focus.focused && at(r, 'light@1280').focus.visible));
  if (badFocus.length) get('a11y').findings.push(finding({ id: 'a11y/focus-indicator', category: 'a11y', severity: 'high', title: `${badFocus.length} route(s): first Tab stop has no visible focus indicator`, refs: byRoute(badFocus), count: badFocus.length }));
  if (lhci) A.push({ name: 'Lighthouse accessibility score (public key routes)', weight: 10, score: round1(lhci.reduce((a, p) => a + (p.accessibility ?? 0), 0) / lhci.length), detail: `${lhci.length} URLs` });

  // ---------------- performance
  const P = get('performance').components;
  const perfRoutes = audited.filter((r) => first(r)?.perf?.lcp != null);
  const grade = (v, good, ok) => (v == null ? null : v <= good ? 1 : v <= ok ? 0.5 : 0);
  const routeScores = perfRoutes.map((r) => { const p = first(r).perf; const g = [grade(p.lcp, 2500, 4000), grade(p.cls, 0.1, 0.25), grade(p.longTaskMs, 200, 600)].filter((x) => x !== null); return { r, p, s: g.reduce((a, b) => a + b, 0) / g.length }; });
  P.push(routeScores.length ? { name: 'Lab Core Web Vitals (LCP, CLS, long-task time) — unthrottled, directional', weight: 45, score: round1((100 * routeScores.reduce((a, x) => a + x.s, 0)) / routeScores.length), detail: `${routeScores.length} routes (field data needed for real CWV)` } : nullC('Lab Core Web Vitals', 45, 'no perf data'));
  const poor = routeScores.filter((x) => x.s < 0.5);
  if (poor.length) get('performance').findings.push(finding({ id: 'perf/cwv-poor', category: 'performance', severity: 'high', title: `${poor.length} route(s) fail lab LCP/CLS/long-task thresholds`, refs: poor.map((x) => ({ route: x.r.route, text: `LCP ${x.p.lcp}ms · CLS ${(x.p.cls ?? 0).toFixed(3)} · long tasks ${Math.round(x.p.longTaskMs)}ms · JS ${x.p.jsKb}KB` })), count: poor.length }));
  P.push(lhci ? { name: 'Lighthouse performance score (public key routes, throttled)', weight: 30, score: round1(lhci.reduce((a, p) => a + (p.performance ?? 0), 0) / lhci.length), detail: `${lhci.length} URLs` } : nullC('Lighthouse performance score', 30, 'no .lighthouseci output (run @lhci/cli first)'));
  P.push(bundle ? { name: 'Bundle budgets (scripts/check-bundle-size.mjs)', weight: 25, score: bundle.code === 0 ? 100 : 0, detail: bundle.summary } : nullC('Bundle budgets', 25, 'no dist/ build'));
  if (bundle && bundle.code !== 0) get('performance').findings.push(finding({ id: 'perf/bundle', category: 'performance', severity: 'high', title: 'Bundle budget exceeded', detail: bundle.summary, refs: [{ file: 'scripts/check-bundle-size.mjs' }], count: 1 }));

  // ---------------- SEO (public routes)
  const S = get('seo').components;
  const metaRoutes = pub.filter((r) => first(r));
  let pass = 0; let total = 0; const failsByCheck = new Map();
  for (const r of metaRoutes) for (const [n, ok] of checkMeta(first(r).meta, r.route, canonicalPathOk)) { total++; if (ok) pass++; else (failsByCheck.get(n) ?? failsByCheck.set(n, []).get(n)).push(r.route); }
  S.push(total ? { name: 'Per-route metadata completeness (rendered DOM, public routes)', weight: 60, score: round1(pct(pass, total)), detail: `${pass}/${total} checks over ${metaRoutes.length} routes` } : nullC('Per-route metadata completeness', 60, 'no public routes crawled'));
  for (const [n, rts] of failsByCheck) get('seo').findings.push(finding({ id: `seo/route-${slug(n)}`, category: 'seo', severity: /noindex|canonical points/.test(n) ? 'high' : 'medium', title: `${rts.length} public route(s) fail: ${n}`, refs: rts.map((route) => ({ route })), count: rts.length }));
  const bl = crawl.brokenLinks ?? [];
  S.push({ name: 'Internal links resolve to real routes (checked against the router)', weight: 20, score: Math.max(0, 100 - 10 * bl.length), detail: `${bl.length} broken internal link target(s)` });
  if (bl.length) get('seo').findings.push(finding({ id: 'seo/broken-links', category: 'seo', severity: 'high', title: `${bl.length} internal link target(s) hit no route (404 page)`, refs: bl.map((b) => ({ route: b.path, text: `linked from ${b.from.join(', ')}` })), count: bl.length }));
  if (lhci) S.push({ name: 'Lighthouse SEO score', weight: 10, score: round1(lhci.reduce((a, p) => a + (p.seo ?? 0), 0) / lhci.length), detail: `${lhci.length} URLs` });

  // ---------------- UX states (runtime)
  const ST = get('states').components;
  const lr = audited.filter(first);
  ST.push({ name: 'No crash screens (error boundary / uncaught page errors)', weight: 35, score: share(lr, (r) => !r.pageErrors.length && !first(r).states.boundary), detail: `${lr.length} routes` });
  ST.push({ name: 'No console errors on load', weight: 20, score: share(lr, (r) => !r.console.length), detail: '' });
  ST.push({ name: 'No stuck loaders after the page settles (aria-busy)', weight: 20, score: share(lr, (r) => first(r).states.busy === 0), detail: '' });
  ST.push({ name: 'No failed same-origin / API requests (4xx/5xx)', weight: 15, score: share(lr, (r) => !r.failed.length), detail: '' });
  ST.push({ name: 'Routes render real content', weight: 10, score: share(lr, (r) => first(r).states.bodyTextLength > 50), detail: '' });
  const crashed = lr.filter((r) => r.pageErrors.length || first(r).states.boundary);
  if (crashed.length) get('states').findings.push(finding({ id: 'states/crash', category: 'states', severity: 'critical', title: `${crashed.length} route(s) crash or show the error boundary`, refs: crashed.map((r) => ({ route: r.route, text: r.pageErrors[0] ?? 'error boundary' })), count: crashed.length }));
  const cons = lr.filter((r) => r.console.length);
  if (cons.length) get('states').findings.push(finding({ id: 'states/console', category: 'states', severity: 'medium', title: `${cons.length} route(s) log console errors`, refs: cons.slice(0, 60).map((r) => ({ route: r.route, text: r.console[0] })), count: cons.length }));
  const stuck = lr.filter((r) => first(r).states.busy > 0);
  if (stuck.length) get('states').findings.push(finding({ id: 'states/stuck-loader', category: 'states', severity: 'high', title: `${stuck.length} route(s) still show aria-busy after settling`, refs: byRoute(stuck), count: stuck.length }));
  const failed = lr.filter((r) => r.failed.length);
  if (failed.length) get('states').findings.push(finding({ id: 'states/failed-requests', category: 'states', severity: 'medium', title: `${failed.length} route(s) have failing requests`, refs: failed.slice(0, 60).map((r) => ({ route: r.route, text: r.failed[0] })), count: failed.length }));

  // ---------------- localization (runtime)
  const L = get('l10n').components;
  const textCombos = audited.flatMap((r) => comboList(r).map((c) => ({ r, c })));
  L.push({ name: 'No raw i18n keys or placeholder leaks (undefined/NaN/{{x}}) in rendered text', weight: 50, score: share(textCombos, ({ c }) => !c.i18n.rawKeys.length && !c.i18n.leaks.length), detail: `${textCombos.length} page-states` });
  const leaky = [...new Map(textCombos.filter(({ c }) => c.i18n.rawKeys.length || c.i18n.leaks.length).map(({ r, c }) => [r.route, { r, c }])).values()];
  if (leaky.length) get('l10n').findings.push(finding({ id: 'l10n/rendered-leak', category: 'l10n', severity: 'critical', title: `${leaky.length} route(s) render raw i18n keys or placeholders`, refs: leaky.map(({ r, c }) => ({ route: r.route, text: [...c.i18n.rawKeys, ...c.i18n.leaks].slice(0, 3).join(' | ') })), count: leaky.length }));
  const rtlVps = (crawl.rtl ?? []).flatMap((r) => Object.entries(r.vps).map(([vp, v]) => ({ r, vp, v })));
  L.push(rtlVps.length ? { name: 'RTL pass (fa): dir="rtl" is applied and no horizontal overflow', weight: 50, score: share(rtlVps, ({ v }) => v.dir === 'rtl' && !v.overflow), detail: `${rtlVps.length} route×viewport checks` } : nullC('RTL pass', 50, 'RTL pass disabled or no routes'));
  const rtlBad = rtlVps.filter(({ v }) => v.dir !== 'rtl' || v.overflow);
  if (rtlBad.length) get('l10n').findings.push(finding({ id: 'l10n/rtl-runtime', category: 'l10n', severity: 'high', title: `${rtlBad.length} RTL check(s) failed (dir not rtl, or horizontal overflow)`, refs: rtlBad.map(({ r, vp, v }) => ({ route: r.route, text: `${vp}px · dir=${v.dir} · overflow=${v.overflow}` })), count: rtlBad.length }));

  // ---------------- mobile (runtime)
  const M = get('mobile').components;
  const small = audited.flatMap((r) => ['light@375', 'dark@375', ...(r.matrix ? [] : [])].map((k) => ({ r, k, c: at(r, k) })).filter((x) => x.c));
  const narrow = audited.flatMap((r) => Object.entries(r.combos).filter(([k]) => /@(375|768)$/.test(k)).map(([k, c]) => ({ r, k, c })));
  M.push(narrow.length ? { name: 'No horizontal overflow at 375 / 768 px', weight: 55, score: share(narrow, ({ c }) => !c.layout.overflow), detail: `${narrow.length} page-states` } : nullC('No horizontal overflow at 375/768', 55, 'no narrow-viewport data'));
  const ov = [...new Map(narrow.filter(({ c }) => c.layout.overflow).map((x) => [`${x.r.route}${x.k}`, x])).values()];
  if (ov.length) get('mobile').findings.push(finding({ id: 'mobile/overflow', category: 'mobile', severity: 'high', title: `${ov.length} page-state(s) scroll horizontally on narrow screens`, refs: ov.map(({ r, k, c }) => ({ route: r.route, text: `${k} · content ${c.layout.scrollW}px > viewport ${c.layout.innerW}px` })), count: ov.length }));
  const light375 = small.filter((x) => x.k === 'light@375');
  const inter = light375.reduce((a, x) => a + x.c.layout.interactive, 0); const smallT = light375.reduce((a, x) => a + x.c.layout.smallTargets, 0);
  M.push(inter ? { name: 'Interactive targets ≥ 24×24 px at 375 px (WCAG 2.5.8)', weight: 45, score: round1(pct(inter - smallT, inter)), detail: `${smallT} too-small of ${inter} controls on ${light375.length} routes` } : nullC('Tap-target size at 375 px', 45, 'no 375px data'));
  const tiny = light375.filter((x) => x.c.layout.smallTargets > 0);
  if (tiny.length) get('mobile').findings.push(finding({ id: 'mobile/tap-targets', category: 'mobile', severity: 'medium', title: `${tiny.length} route(s) have controls under 24×24 px`, refs: tiny.slice(0, 60).map((x) => ({ route: x.r.route, text: x.c.layout.smallSamples[0] })), count: tiny.length }));

  // ---------------- visual identity (runtime fonts)
  const V = get('visual').components;
  const fc = textCombos.map((x) => x.c.fonts).filter(Boolean);
  const totalText = fc.reduce((a, f) => a + f.total, 0); const offText = fc.reduce((a, f) => a + f.offBrandCount, 0);
  V.push(totalText ? { name: 'Rendered text uses brand fonts (first family in allow-list)', weight: 30, score: round1(pct(totalText - offText, totalText)), detail: `${offText}/${totalText} text nodes off-brand` } : nullC('Rendered fonts', 30, 'no text sampled'));
  const offR = [...new Map(textCombos.filter(({ c }) => c.fonts.offBrandCount > 0).map(({ r, c }) => [r.route, { r, c }])).values()];
  if (offR.length) get('visual').findings.push(finding({ id: 'visual/off-brand-fonts', category: 'visual', severity: 'medium', title: `${offR.length} route(s) render text in non-brand fonts`, refs: offR.slice(0, 60).map(({ r, c }) => ({ route: r.route, text: c.fonts.offBrand.join(', ') })), count: offR.length }));

  // ---------------- security + privacy (runtime)
  const SE = get('security').components;
  const tr = crawl.trackerHitsBeforeConsent ?? [];
  SE.push({ name: 'No analytics/tracker requests before a consent decision', weight: 20, score: tr.length ? 0 : 100, detail: `${tr.length} request(s) to Google trackers on anonymous first visit` });
  if (tr.length) get('security').findings.push(finding({ id: 'security/tracker-before-consent', category: 'security', severity: 'critical', title: `${tr.length} tracker request(s) fired before consent`, refs: [...new Set(tr)].slice(0, 10).map((u) => ({ text: u })), count: tr.length }));
  if (hostLocal || !crawl.headers) SE.push(nullC('Live response headers on the crawled origin', 20, hostLocal ? 'origin is localhost — the Vite preview server does not apply vercel.json; crawl staging/production with --base-url' : 'no headers captured'));
  else {
    const h = crawl.headers; const need = ['strict-transport-security', 'x-content-type-options', 'referrer-policy', 'content-security-policy', 'permissions-policy'];
    const ok = need.filter((k) => h[k]);
    SE.push({ name: 'Live response headers on the crawled origin', weight: 20, score: round1(pct(ok.length, need.length)), detail: `${ok.length}/${need.length} present` });
    for (const k of need.filter((x) => !h[x])) get('security').findings.push(finding({ id: 'security/live-header', category: 'security', severity: 'high', title: `Live origin does not serve ${k}`, refs: [{ text: crawl.baseUrl }], count: 1 }));
  }
  const blocked = crawl.blockedWrites ?? [];
  if (blocked.length) get('states').findings.push(finding({ id: 'crawl/blocked-writes', category: 'states', severity: 'info', title: `${blocked.length} mutating request(s) fired during page load and were blocked by the read-only guard`, detail: 'Page loads that write data are worth reviewing (analytics aside).', refs: blocked.slice(0, 20).map((b) => ({ text: `${b.method} ${b.url}` })), count: blocked.length }));
  return Object.values(out);
}
