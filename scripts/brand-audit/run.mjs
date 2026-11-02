#!/usr/bin/env node
// scripts/brand-audit/run.mjs — orchestrator.
//
//   node scripts/brand-audit/run.mjs --static-only                         static checks only (fast, no browser, no secrets)
//   node scripts/brand-audit/run.mjs --base-url http://localhost:4173      static + crawl (public; authed if E2E_TEST_EMAIL/PASSWORD set)
//   options: --depth smoke|standard|full   --shard i/n   --max-routes N   --no-shots   --no-rtl   --allow-writes
//            --lhci-dir .lighthouseci   --crawl-input a.json,b.json (skip crawling, re-score saved crawls)
//            --previous path.json       --out reports   --check   --require-measured a11y,seo
//            --write-baseline-scores    record current scores as the CI floor baseline (commit the file)
//   env: E2E_TEST_EMAIL / E2E_TEST_PASSWORD (sandbox tenant!), BRAND_AUDIT_STAFF_EMAIL / BRAND_AUDIT_STAFF_PASSWORD
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runNode } from './lib/util.mjs';
import { mergeResults, scoreAll, prioritize, evaluateGate, snapshot } from './score.mjs';
import { renderReport } from './report.mjs';
import { deriveFromCrawl } from './crawl/derive.mjs';
import { ingestLhci } from './crawl/lhci.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const outDir = join(ROOT, opt('out', 'reports'));
const assetsDir = join(outDir, 'brand-audit');
const jsonPath = join(outDir, 'brand-audit.json');
const baselinePath = join(ROOT, 'scripts/brand-audit/baselines/scores.json');
mkdirSync(assetsDir, { recursive: true });

const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const previous = readJson(opt('previous') ? join(ROOT, opt('previous')) : jsonPath) ?? null; // read BEFORE we overwrite it
const baseline = readJson(baselinePath);

const STATIC = ['tokens', 'localization', 'states', 'security', 'seo', 'visual', 'naming', 'documents', 'mobile', 'devdocs', 'trust'];
const CATEGORY_OF = { localization: 'l10n' };

async function runStatic() {
  const results = [];
  for (const name of STATIC) {
    const t = Date.now();
    try {
      const r = await (await import(`./checks/${name}.mjs`)).run();
      results.push(r);
      console.log(`  ✓ ${name.padEnd(13)} ${String(Date.now() - t).padStart(5)} ms  ${r.findings.length} finding(s)`);
    } catch (e) {
      const category = CATEGORY_OF[name] ?? name;
      console.error(`  ✘ ${name} crashed: ${e.message}`);
      results.push({ category, components: [{ name: `${name} check`, weight: 100, score: null, detail: `NOT RUN — check crashed: ${e.message}` }], findings: [{ id: `audit/${name}-crashed`, category, severity: 'high', title: `Audit check "${name}" crashed: ${e.message}`, refs: [], count: 1 }], metrics: {} });
    }
  }
  return results;
}

async function runCrawl() {
  const inputs = opt('crawl-input');
  if (inputs) {
    const parts = inputs.split(',').map((f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')));
    const merged = { ...parts[0], routes: parts.flatMap((p) => p.routes), rtl: parts.flatMap((p) => p.rtl ?? []), brokenLinks: parts.flatMap((p) => p.brokenLinks ?? []), blockedWrites: parts.flatMap((p) => p.blockedWrites ?? []), trackerHitsBeforeConsent: parts.flatMap((p) => p.trackerHitsBeforeConsent ?? []) };
    return merged;
  }
  const baseUrl = opt('base-url');
  if (!baseUrl) return null;
  const { crawl } = await import('./crawl/crawl.mjs');
  const { planRoutes } = await import('./crawl/crawl.mjs');
  const { loadRouteTable } = await import('./lib/routes.mjs');
  const table = await loadRouteTable();
  const [i, n] = (opt('shard', '') || '').split('/').map(Number);
  const plan = planRoutes({ depth: opt('depth', 'standard'), table, shard: n ? { index: i - 1, of: n } : null, maxRoutes: opt('max-routes') ? Number(opt('max-routes')) : null });
  if (plan.missingKey.length) console.warn(`  ! ${plan.missingKey.length} configured key route(s) are not in the router: ${plan.missingKey.join(', ')}`);
  const routes = [...plan.matrix, ...plan.light];
  console.log(`  crawling ${routes.length} route(s) at ${baseUrl} (depth ${opt('depth', 'standard')})`);
  const data = await crawl({
    baseUrl, outDir: assetsDir, table, routes, depth: opt('depth', 'standard'), shots: !flag('no-shots'), rtl: !flag('no-rtl'), allowWrites: flag('allow-writes'),
    creds: { user: { email: process.env.E2E_TEST_EMAIL, password: process.env.E2E_TEST_PASSWORD }, staff: { email: process.env.BRAND_AUDIT_STAFF_EMAIL, password: process.env.BRAND_AUDIT_STAFF_PASSWORD } },
    log: (m) => console.log(`    ${m}`),
  });
  data.missingKeyRoutes = plan.missingKey;
  writeFileSync(join(assetsDir, `crawl${n ? `-${i}of${n}` : ''}.json`), JSON.stringify(data));
  return data;
}

async function bundleResult() {
  if (!existsSync(join(ROOT, 'dist'))) return null;
  const r = await runNode(['scripts/check-bundle-size.mjs']);
  return { code: r.code, summary: r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
}

console.log('Static checks');
const results = await runStatic();
let crawlData = null;
if (flag('static-only') === false && (opt('base-url') || opt('crawl-input'))) {
  console.log('Crawl');
  crawlData = await runCrawl();
  if (crawlData) {
    const lhci = ingestLhci(join(ROOT, opt('lhci-dir', '.lighthouseci')));
    results.push(...deriveFromCrawl(crawlData, { lhci, bundle: await bundleResult() }));
  }
}

const merged = mergeResults(results);
const scored = scoreAll(merged);
const fixes = prioritize(merged, 40);
const requireMeasured = (opt('require-measured', '') || '').split(',').filter(Boolean);
const gate = evaluateGate({ ...scored, criticalIds: fixes.filter((f) => f.severity === 'critical').map((f) => f.id) }, { prev: previous, baseline, requireMeasured });
const crawlSummary = crawlData ? `${crawlData.routes.length} route-visits, ${crawlData.routes.filter((r) => r.skipped).length} skipped, ${crawlData.blockedWrites.length} mutating request(s) blocked by the read-only guard, axe ${crawlData.axe}, auth: ${JSON.stringify(Object.fromEntries(Object.entries(crawlData.auth ?? {}).map(([k, v]) => [k, v.status])))}` : 'Static checks only — no crawl was run, so runtime categories are NOT RUN.';
const meta = { generatedAt: new Date().toISOString(), commit: (process.env.GITHUB_SHA ?? '').slice(0, 7) || null, mode: crawlData ? 'static + crawl' : 'static only', baseUrl: crawlData?.baseUrl };

writeFileSync(join(outDir, 'brand-audit.html'), renderReport({ scored, fixes, gate, crawlSummary, crawl: crawlData, meta }));
const snap = snapshot(scored, fixes, { mode: meta.mode, commit: meta.commit });
writeFileSync(jsonPath, `${JSON.stringify({ ...snap, categories: scored.categories.map(({ id, label, weight, score, status, components, notRunComponents, metrics, needsEvidence }) => ({ id, label, weight, score, status, components, notRunComponents, metrics, needsEvidence })), fixes: fixes.map(({ refs, ...f }) => ({ ...f, refs: refs.slice(0, 50) })) }, null, 1)}\n`);
if (flag('write-baseline-scores')) {
  writeFileSync(baselinePath, `${JSON.stringify({ version: 1, createdAt: snap.generatedAt, note: 'CI floor = score − tolerance. Commit after a reviewed run; categories that were NOT RUN are omitted.', categories: Object.fromEntries(scored.categories.filter((c) => c.score !== null).map((c) => [c.id, c.score])) }, null, 1)}\n`);
  console.log(`Baseline scores written to ${baselinePath}`);
}

console.log(`\nOverall ${scored.overall ?? '—'} / 100   (rubric coverage ${scored.coverage}%)`);
for (const c of scored.categories) console.log(`  ${(c.score === null ? 'NOT RUN' : c.score.toFixed(1)).padStart(7)}  ${c.label}${c.status === 'partial' ? `  [partial: ${c.notRunComponents.length} component(s) not run]` : ''}`);
console.log(`\nReport: ${join(outDir, 'brand-audit.html')}`);
if (gate.warnings.length) console.log(`\nWarnings:\n  - ${gate.warnings.join('\n  - ')}`);
if (flag('check')) {
  if (gate.pass) console.log('\nGATE PASSED');
  else { console.error(`\nGATE FAILED:\n  - ${gate.failures.join('\n  - ')}`); process.exit(1); }
}
