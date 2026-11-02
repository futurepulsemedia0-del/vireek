// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSource, ratchet, RULES } from './checks/tokens.mjs';
import { stripComments, esc, combine } from './lib/util.mjs';
import { patternToRegex, buildMatcher, internalPath } from './lib/routes.mjs';
import { mergeResults, scoreAll, prioritize, compare, evaluateGate } from './score.mjs';
import { renderReport } from './report.mjs';
import { effectiveHeaders, cspQuality, parseCsp } from './checks/security.mjs';
import { pngSize, checkHead } from './checks/seo.mjs';
import { scanClaims, entryCovers } from './checks/trust.mjs';
import { scanNaming } from './checks/naming.mjs';
import { classifyPage } from './checks/states.mjs';
import { parity, rtlRatio } from './checks/localization.mjs';
import { manifestChecks } from './checks/mobile.mjs';
import { relativeLinks } from './checks/devdocs.mjs';
import { isPdfModule, usesPdfBrand } from './checks/documents.mjs';
import { rgbTripletToHex } from './checks/visual.mjs';
import { isRawKey, hasLeak } from './crawl/probes.mjs';
import { summarizeAxe } from './crawl/axe.mjs';
import { summarizeLhr } from './crawl/lhci.mjs';
import { deriveFromCrawl, checkMeta } from './crawl/derive.mjs';
import { planRoutes } from './crawl/crawl.mjs';

const rules = (src) => analyzeSource(src).hits.map((h) => h.rule);

describe('token rules', () => {
  it('flags raw hex, rgb(), arbitrary px, type sizes and palette classes', () => {
    expect(rules(`const a = '#3448E8'`)).toEqual(['raw-hex']);
    expect(rules(`style={{ color: 'rgba(0,0,0,.5)' }}`)).toEqual(['raw-rgb']);
    expect(rules(`<div className="w-[320px] md:min-h-[44px]">`)).toEqual(['arbitrary-px', 'arbitrary-px']);
    expect(rules(`<p className="text-[11px] leading-[1.2rem]">`)).toEqual(['arbitrary-type-size', 'arbitrary-type-size']);
    expect(rules(`<p className="dark:text-slate-400 bg-red-500/20">`)).toEqual(['palette-class', 'palette-class']);
  });
  it('does not flag tokens, hairlines, anchors, url(#id) or var()-based colors', () => {
    expect(rules(`<div className="bg-bg-secondary text-text-primary border-border text-accent w-[1px] w-[2px]">`)).toEqual([]);
    expect(rules(`<a href="#fade">x</a> <a to="/#pricing">y</a> fill="url(#grad)" querySelector('#add')`)).toEqual([]);
    expect(rules(`boxShadow: '0 0 0 rgb(var(--accent-primary) / 0.4)'`)).toEqual([]);
  });
  it('ignores commented-out code but keeps URLs in text', () => {
    expect(rules(`// const a = '#fff'\n/* bg-slate-500 */\nconst b = 1`)).toEqual([]);
    expect(stripComments('a // c\nhttps://x.com/#abc').includes('https://x.com')).toBe(true);
  });
  it('honors brand-audit-allow only with a reason', () => {
    expect(rules(`// brand-audit-allow raw-hex: tenant logo color\nconst a = '#fff'`)).toEqual([]);
    const r = analyzeSource(`// brand-audit-allow raw-hex:\nconst a = '#fff'`);
    expect(r.hits.length).toBe(1);
    expect(r.badAllows).toEqual([1]);
  });
  it('ratchet fails only when a file/rule count grows', () => {
    const base = { files: { 'a.tsx': { 'raw-hex': 2 } } };
    expect(ratchet({ 'a.tsx': { 'raw-hex': 2 } }, base)).toEqual([]);
    expect(ratchet({ 'a.tsx': { 'raw-hex': 1 } }, base)).toEqual([]);
    expect(ratchet({ 'a.tsx': { 'raw-hex': 3 } }, base).length).toBe(1);
    expect(ratchet({ 'new.tsx': { 'palette-class': 1 } }, base).length).toBe(1);
    expect(Object.keys(RULES).length).toBe(5);
  });
});

describe('routes', () => {
  it('matches params, wildcards, trailing slashes and never matches the 404 route', () => {
    expect(patternToRegex('/blog/:slug').test('/blog/hello')).toBe(true);
    expect(patternToRegex('/blog/:slug').test('/blog/a/b')).toBe(false);
    expect(patternToRegex('*')).toBe(null);
    const known = buildMatcher(['/', '/pricing', '/home/*', '*']);
    expect(known('/pricing/')).toBe(true);
    expect(known('/home/x/y')).toBe(true);
    expect(known('/nope')).toBe(false);
  });
  it('normalises hrefs and rejects external / non-navigational links', () => {
    expect(internalPath('/pricing#x', 'https://vireek.com')).toBe('/pricing');
    expect(internalPath('https://evil.com/a', 'https://vireek.com')).toBe(null);
    expect(internalPath('mailto:a@b.c', 'https://vireek.com')).toBe(null);
    expect(internalPath('javascript:alert(1)', 'https://vireek.com')).toBe(null);
  });
  it('plans matrix vs light routes and honors depth, shard and cap', () => {
    const table = { all: ['/', '/pricing', '/a', '/b', '/dashboard', '/dashboard/x'], publicStatic: ['/', '/pricing', '/a', '/b'], authRoutes: ['/dashboard', '/dashboard/x'], staffRoutes: ['/staff/q'], dataPatterns: [] };
    const std = planRoutes({ depth: 'standard', table });
    expect(std.matrix.some((m) => m.route === '/pricing' && m.kind === 'public')).toBe(true);
    expect(std.light.map((l) => l.route)).toEqual(['/a', '/b']);
    expect(planRoutes({ depth: 'full', table }).light.some((l) => l.kind === 'staff')).toBe(true);
    expect(planRoutes({ depth: 'standard', table, shard: { index: 1, of: 2 } }).matrix).toEqual([]);
    expect(planRoutes({ depth: 'standard', table, maxRoutes: 1 }).light.length).toBe(1);
  });
});

const comp = (score, weight = 100) => ({ name: 'c', weight, score, detail: '' });
describe('scoring honesty', () => {
  it('combine() ignores NOT RUN components and returns null when nothing ran', () => {
    expect(combine([comp(80, 50), comp(null, 50)])).toBe(80);
    expect(combine([comp(null), comp(undefined)])).toBe(null);
  });
  it('unmeasured categories are NOT RUN, excluded from overall, and coverage is reported', () => {
    const merged = mergeResults([{ category: 'tokens', components: [comp(90)], findings: [] }]);
    const s = scoreAll(merged);
    expect(s.categories.find((c) => c.id === 'a11y').score).toBe(null);
    expect(s.categories.find((c) => c.id === 'a11y').status).toBe('not-run');
    expect(s.overall).toBe(90);
    expect(s.coverage).toBe(10);
  });
  it('evidence-gated items are listed but never change the score', () => {
    const base = scoreAll(mergeResults([{ category: 'trust', components: [comp(100)], findings: [] }]));
    const withNeeds = scoreAll(mergeResults([{ category: 'trust', components: [comp(100)], findings: [], needsEvidenceDetected: [{ id: 'cert:soc2', label: 'SOC 2 claim', occurrences: 11, refs: [] }] }]));
    expect(withNeeds.categories.find((c) => c.id === 'trust').score).toBe(100);
    expect(withNeeds.categories.find((c) => c.id === 'trust').needsEvidence.length).toBeGreaterThan(base.categories.find((c) => c.id === 'trust').needsEvidence.length);
  });
  it('rejects unknown categories instead of dropping them', () => {
    let msg = ''; try { mergeResults([{ category: 'bogus', components: [] }]); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/Unknown category/);
  });
  it('prioritises by severity × weight × count and skips info', () => {
    const merged = mergeResults([{ category: 'a11y', components: [], findings: [{ id: 'x', severity: 'high', title: 't', count: 100, refs: [] }, { id: 'y', severity: 'info', title: 'i', count: 999, refs: [] }, { id: 'z', severity: 'low', title: 'l', count: 1, refs: [] }] }]);
    const f = prioritize(merged);
    expect(f.map((x) => x.id)).toEqual(['x', 'z']);
  });
  it('detects regressions beyond tolerance only for categories measured in both runs', () => {
    const cur = scoreAll(mergeResults([{ category: 'tokens', components: [comp(80)], findings: [] }, { category: 'seo', components: [comp(90)], findings: [] }]));
    const prev = { categories: [{ id: 'tokens', score: 85 }, { id: 'seo', score: 89 }, { id: 'a11y', score: 99 }] };
    const c = compare(prev, cur);
    expect(c.regressions.map((r) => r.id)).toEqual(['tokens']);
    expect(c.rows.some((r) => r.id === 'a11y')).toBe(false);
  });
  it('gate: floors from baseline, regressions fail, no-baseline warns, required NOT RUN fails', () => {
    const cur = { ...scoreAll(mergeResults([{ category: 'tokens', components: [comp(70)], findings: [] }])), criticalIds: [] };
    expect(evaluateGate(cur, { baseline: { categories: { tokens: 80 } } }).pass).toBe(false);
    expect(evaluateGate(cur, { baseline: { categories: { tokens: 71 } } }).pass).toBe(true);
    const none = evaluateGate(cur, {});
    expect(none.pass).toBe(true);
    expect(none.warnings.some((w) => /no floor/.test(w))).toBe(true);
    expect(evaluateGate(cur, { requireMeasured: ['a11y'] }).pass).toBe(false);
    expect(evaluateGate({ ...cur, criticalIds: ['k'] }, { prev: { categories: [], criticalIds: [] } }).pass).toBe(false);
  });
});

describe('report safety', () => {
  it('escapes untrusted text from findings, routes and screenshots', () => {
    const merged = mergeResults([{ category: 'tokens', components: [{ name: '<img src=x onerror=alert(1)>', weight: 1, score: 50, detail: '"><script>x</script>' }], findings: [{ id: 'f', severity: 'high', title: '<script>alert(1)</script>', detail: '<b>d</b>', refs: [{ file: '"><svg onload=1>', line: 1, text: '<iframe>' }], count: 1 }] }]);
    const html = renderReport({ scored: scoreAll(merged), fixes: prioritize(merged), gate: { pass: false, failures: ['<x>'], warnings: [], compare: { available: false, rows: [] } }, crawlSummary: '<b>', crawl: { routes: [{ route: '/<script>', role: 'anon', status: 200, console: [], combos: {}, shots: ['a b/<x>.jpg'] }] }, meta: { generatedAt: 'now', mode: 'm' } });
    expect(html.includes('<script>')).toBe(false);
    expect(html.includes('<iframe>')).toBe(false);
    expect(html.includes('onerror=alert(1)>')).toBe(false);
    expect(html.includes('&lt;script&gt;')).toBe(true);
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('security headers', () => {
  const cfg = { headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }, { source: '/((?!badge|embed/).*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }, { source: '/badge', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors *" }] }] };
  it('resolves which rules apply to a path', () => {
    expect(Object.keys(effectiveHeaders(cfg, '/'))).toEqual(['x-content-type-options', 'x-frame-options']);
    expect(Object.keys(effectiveHeaders(cfg, '/badge'))).toEqual(['x-content-type-options', 'content-security-policy']);
  });
  it('scores CSP weaknesses', () => {
    const good = "default-src 'self'; script-src 'self' 'sha256-abc'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
    expect(cspQuality(good).score).toBe(100);
    expect(cspQuality("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:").score).toBeLessThan(50);
    expect(cspQuality(undefined).score).toBe(0);
    expect(parseCsp(good)['upgrade-insecure-requests']).toEqual([]);
  });
});

describe('seo / trust / naming / states / l10n / mobile / docs / documents', () => {
  it('reads PNG dimensions and validates head tags', () => {
    const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(1200, 16); b.writeUInt32BE(630, 20);
    expect(pngSize(b)).toEqual({ width: 1200, height: 630 });
    expect(pngSize(Buffer.from('nope'))).toBe(null);
    expect(checkHead('<html lang="en"><title>x</title>').filter(([, ok]) => ok).length).toBeLessThan(3);
  });
  it('detects claims and requires owner+url+date for evidence', () => {
    expect(scanClaims('We are SOC 2 compliant and 99.9% uptime').map((c) => c.id)).toEqual(['cert:soc2', 'stat:uptime']);
    expect(scanClaims('Never miss another call').map((c) => c.id)).toEqual(['claim:absolute']);
    expect(scanClaims('placeholder Pool #1').length).toBe(0);
    const ok = { evidence: { url: 'https://x', owner: 'a', issuedAt: new Date().toISOString() } };
    expect(entryCovers(ok)).toBe(true);
    expect(entryCovers({ evidence: { url: 'https://x', issuedAt: new Date().toISOString() } })).toBe(false);
    expect(entryCovers({ evidence: { ...ok.evidence, issuedAt: '2020-01-01' } })).toBe(false);
    expect(entryCovers({ evidence: { ...ok.evidence, expiresAt: '2020-01-01' } })).toBe(false);
  });
  it('naming: flags VIREEK and foreign domains, not identifiers', () => {
    expect(scanNaming(`<h1>VIREEK</h1>`).map((h) => h.rule)).toEqual(['allcaps']);
    expect(scanNaming(`const u = 'command.vireek.ai'`).map((h) => h.rule)).toEqual(['domain']);
    expect(scanNaming(`const k = 'vireek.timeclock'; const v = 'VITE_VIREEK_X'; a@vireek.com; https://app.vireek.com`).length).toBe(0);
  });
  it('states: understands this repo idioms', () => {
    const c = classifyPage(`import { supabase } from '@/lib/supabase'; if (isLoading) return <Skeleton/>; if (rows.length === 0) return <EmptyState/>; toast('x', 'error')`);
    expect(c.isData && c.loading && c.empty && c.error).toBe(true);
    expect(classifyPage(`export const P = () => <div/>`).isData).toBe(false);
  });
  it('l10n: parity treats unshipped namespaces as missing; RTL ratio counts physical vs logical', () => {
    const en = { common: new Set(['a', 'b']), extra: new Set(['x', 'y']) };
    const r = parity(en, { es: { common: new Set(['a', 'b']) }, fr: { common: new Set(['a']), extra: new Set(['x', 'y']) } });
    expect(r.find((x) => x.lang === 'es').coverage).toBe(50);
    expect(r.find((x) => x.lang === 'fr').coverage).toBe(75);
    expect(rtlRatio('<div className="ml-2 pr-4 text-left ms-2 pe-1">')).toEqual({ physical: 3, logical: 2 });
  });
  it('mobile manifest + devdocs links + documents heuristics', () => {
    expect(manifestChecks({}).every(([, ok]) => !ok)).toBe(true);
    expect(relativeLinks('[a](./x.md) [b](https://e.com) [c](#h) `[d](nope.md)` [e](docs/y.md#z)')).toEqual(['./x.md', 'docs/y.md']);
    expect(isPdfModule(`import { jsPDF } from 'jspdf'`)).toBe(true);
    expect(usesPdfBrand(`import { getPdfBrand } from '@/lib/pdfBrand'`)).toBe(true);
    expect(usesPdfBrand(`import { jsPDF } from 'jspdf'`)).toBe(false);
    expect(rgbTripletToHex('32 58 216')).toBe('#203AD8');
  });
});

describe('crawl derivation', () => {
  it('probe helpers', () => {
    expect(isRawKey('format.showMore')).toBe(true);
    expect(isRawKey('vireek.com')).toBe(false);
    expect(isRawKey('Save changes')).toBe(false);
    expect(hasLeak('Total: undefined')).toBe(true);
    expect(hasLeak('Hello {{name}}')).toBe(true);
  });
  it('summarises axe and lighthouse output', () => {
    const s = summarizeAxe({ violations: [{ id: 'x', impact: 'serious', help: 'h', helpUrl: 'u', nodes: [{ target: ['a', 'b'] }] }], passes: [1, 2], incomplete: [] });
    expect(s.severeCount).toBe(1);
    expect(s.violations[0].sample).toEqual(['a b']);
    expect(summarizeLhr({ finalUrl: 'u', categories: { performance: { score: 0.91 } }, audits: { 'largest-contentful-paint': { numericValue: 1234 } } })).toEqual({ url: 'u', performance: 91, accessibility: null, bestPractices: null, seo: null, lcp: 1234, cls: null, tbt: null });
  });
  const combo = (o = {}) => ({ meta: { title: 'A good title for the page', description: 'x'.repeat(80), canonical: 'https://vireek.com/p', ogTitle: 't', ogDescription: 'd', ogImage: 'i', twitterCard: 's', h1Count: 1, lang: 'en', robots: 'index' }, layout: { overflow: false, interactive: 10, smallTargets: 0, smallSamples: [], scrollW: 1, innerW: 1 }, i18n: { rawKeys: [], leaks: [] }, fonts: { total: 10, offBrandCount: 0, offBrand: [] }, states: { busy: 0, boundary: false, bodyTextLength: 500, alerts: [] }, perf: { lcp: 1000, cls: 0, longTaskMs: 0, jsKb: 100 }, focus: { focused: true, visible: true }, ...o });
  const crawl = (r) => ({ baseUrl: 'http://localhost:4173', axe: 'unavailable', auth: {}, blockedWrites: [], trackerHitsBeforeConsent: [], brokenLinks: [], routes: [{ route: '/p', kind: 'public', matrix: true, role: 'anon', console: [], pageErrors: [], failed: [], links: [], combos: { 'light@1280': combo(), 'light@375': combo(), ...r } }] });
  it('axe unavailable => a11y components are NOT RUN, never a pass', () => {
    const a11y = deriveFromCrawl(crawl()).find((d) => d.category === 'a11y');
    expect(a11y.components.slice(0, 2).every((c) => c.score === null)).toBe(true);
  });
  it('clean route scores 100 on runtime components; localhost headers are NOT RUN', () => {
    const d = deriveFromCrawl(crawl());
    expect(d.find((x) => x.category === 'states').components.every((c) => c.score === 100)).toBe(true);
    expect(d.find((x) => x.category === 'security').components.find((c) => /Live/.test(c.name)).score).toBe(null);
  });
  it('defects become findings with the right severity', () => {
    const bad = deriveFromCrawl(crawl({ 'light@375': combo({ layout: { overflow: true, interactive: 4, smallTargets: 4, smallSamples: ['b'], scrollW: 700, innerW: 375 } }), 'light@1280': combo({ i18n: { rawKeys: ['format.showMore'], leaks: [] }, states: { busy: 1, boundary: true, bodyTextLength: 500, alerts: [] } }) }));
    const ids = bad.flatMap((d) => d.findings.map((f) => `${f.id}:${f.severity}`));
    expect(ids.includes('l10n/rendered-leak:critical')).toBe(true);
    expect(ids.includes('mobile/overflow:high')).toBe(true);
    expect(ids.includes('states/crash:critical')).toBe(true);
    expect(checkMeta({ title: 'x' }, '/p', () => true).filter(([, ok]) => ok).length).toBeLessThan(5);
  });
  it('tracker before consent is critical and zeroes the privacy component', () => {
    const c = crawl(); c.trackerHitsBeforeConsent = ['https://www.googletagmanager.com/gtag/js'];
    const sec = deriveFromCrawl(c).find((x) => x.category === 'security');
    expect(sec.components.find((k) => /tracker/.test(k.name)).score).toBe(0);
    expect(sec.findings[0].severity).toBe('critical');
  });
});
