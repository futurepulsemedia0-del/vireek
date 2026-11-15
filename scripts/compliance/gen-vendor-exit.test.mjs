// Guards docs/vendor-exit and its generator.
// Run: node --test scripts/compliance/gen-vendor-exit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT, DOC_DIR, PROVIDERS, SCAN_BEGIN, SCAN_END, classifyHost, couplingTier, drillStatus, extractEnvNames,
  extractHosts, extractRelativeSpecs, injectBlock, parseDocMeta, planDocs, resolveImport, rotation, scanRepo,
} from './gen-vendor-exit.mjs';

const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'vexit-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
};

test('extractors read literals only', () => {
  assert.deepEqual(extractHosts('fetch("https://api.stripe.com/v1"); http://x.test/a'), ['api.stripe.com', 'x.test']);
  assert.deepEqual(extractEnvNames(`Deno.env.get("A_KEY"); Deno.env.get( 'B_KEY' ); Deno.env.get(name)`), ['A_KEY', 'B_KEY']);
  assert.deepEqual(extractRelativeSpecs(`import a from "../_shared/x.ts"; export * from './y.ts'; import z from "npm:zod"`).sort(), ['../_shared/x.ts', './y.ts']);
});

test('resolveImport tries extensions and index files, rejects unknown', () => {
  const known = new Set(['_shared/a.ts', '_shared/b/index.ts']);
  assert.equal(resolveImport('fn/index.ts', '../_shared/a.ts', known), '_shared/a.ts');
  assert.equal(resolveImport('fn/index.ts', '../_shared/a', known), '_shared/a.ts');
  assert.equal(resolveImport('fn/index.ts', '../_shared/b', known), '_shared/b/index.ts');
  assert.equal(resolveImport('fn/index.ts', '../_shared/nope', known), null);
});

test('classifyHost: ignored, known and unclassified', () => {
  assert.deepEqual(classifyHost('app.vireek.com'), { ignored: true });
  assert.deepEqual(classifyHost('docs.vapi.ai'), { ignored: true });
  assert.deepEqual(classifyHost('evil.test'), { ignored: true });
  assert.deepEqual(classifyHost('api.stripe.com'), { slug: 'stripe' });
  assert.deepEqual(classifyHost('generativelanguage.googleapis.com'), { slug: 'gemini' });
  assert.deepEqual(classifyHost('sheets.googleapis.com'), { slug: 'google' });
  assert.deepEqual(classifyHost('api.brand-new-vendor.io'), { unclassified: true });
});

test('couplingTier thresholds', () => {
  assert.deepEqual([0, 3, 4, 12, 13, 40, 41].map(couplingTier), ['S', 'S', 'M', 'M', 'L', 'L', 'XL']);
});

test('blast radius separates direct from import-reachable and ignores tests', () => {
  const root = fixture({
    'supabase/functions/_shared/pay.ts': 'const k = Deno.env.get("STRIPE_SECRET_KEY");',
    'supabase/functions/_shared/hub.ts': 'import "./pay.ts";',
    'supabase/functions/a/index.ts': 'import "../_shared/hub.ts";',
    'supabase/functions/b/index.ts': 'fetch("https://api.stripe.com/v1/x");',
    'supabase/functions/c/index.ts': 'export {}',
    'supabase/functions/c/index.test.ts': 'fetch("https://api.stripe.com/v1/x");',
  });
  const s = scanRepo(root);
  const stripe = s.providers.find((p) => p.slug === 'stripe');
  assert.equal(s.functions, 3);
  assert.deepEqual(stripe.direct, ['b']);
  assert.deepEqual(stripe.indirect, ['a']);
  assert.equal(stripe.total, 2);
  assert.deepEqual(stripe.env, ['STRIPE_SECRET_KEY']);
  assert.deepEqual(s.unclassified, []);
});

test('unclassified host is reported once with its first file', () => {
  const root = fixture({ 'supabase/functions/a/index.ts': 'fetch("https://api.new-vendor.io/x")', 'supabase/functions/b/index.ts': 'fetch("https://api.new-vendor.io/y")' });
  assert.deepEqual(scanRepo(root).unclassified, [['api.new-vendor.io', 'a/index.ts']]);
});

test('injectBlock replaces only the marked region and is idempotent', () => {
  const doc = `top\n${SCAN_BEGIN}\nold\n${SCAN_END}\nbottom`;
  const block = `${SCAN_BEGIN}\nnew\n${SCAN_END}`;
  const once = injectBlock(doc, SCAN_BEGIN, SCAN_END, block);
  assert.equal(once, `top\n${block}\nbottom`);
  assert.equal(injectBlock(once, SCAN_BEGIN, SCAN_END, block), once);
  assert.equal(injectBlock('no markers', SCAN_BEGIN, SCAN_END, block), null);
});

test('drillStatus', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  assert.equal(drillStatus('never performed', now).state, 'never');
  assert.equal(drillStatus('2026-12-01', now).state, 'ok');
  assert.equal(drillStatus('2026-09-01', now).state, 'overdue');
  assert.equal(drillStatus('2027-02-01', now).state, 'invalid');
  assert.equal(drillStatus('2026-02-30', now).state, 'invalid');
  assert.equal(drillStatus('soon', now).state, 'invalid');
  assert.equal(drillStatus(null, now).state, 'invalid');
});

test('parseDocMeta and rotation', () => {
  const m = parseDocMeta('| Criticality tier (proposed) | 2 — x |\n| Estimated switch effort | **XL** — y |\n| Last drill date | never performed |\n');
  assert.deepEqual([m.tier, m.effort, m.lastDrill], [2, 'XL', 'never performed']);
  const r = rotation([{ slug: 'a', tier: 1 }, { slug: 'b', tier: 2 }, { slug: 'c', tier: 2 }, { slug: 'd', tier: 3 }, { slug: 'e', tier: 3 }]);
  assert.deepEqual(r.get('a'), [1, 2, 3, 4]);
  assert.deepEqual([r.get('b'), r.get('c')], [[1, 3], [2, 4]]);
  assert.deepEqual([r.get('d'), r.get('e')], [[1], [2]]);
});

test('catalog slugs are unique', () => {
  const slugs = PROVIDERS.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('repository docs: every provider has a fresh page, no unclassified hosts', () => {
  const plan = planDocs({ root: REPO_ROOT });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.writes.map((w) => w.path), []);
});

test('provider pages never claim a drill happened or contain secrets-like values', () => {
  const dir = join(REPO_ROOT, DOC_DIR);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const t = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(t, /(sk_live|sk_test|whsec_|AKIA[0-9A-Z]{12}|-----BEGIN [A-Z ]*PRIVATE KEY)/, f);
    assert.doesNotMatch(t, /\b(drill|exit) (was|has been) (completed|passed|performed|successful)\b(?! unless)/i, f);
    if (!['README.md', '_TEMPLATE.md', 'QUARTERLY_DRILL_CHECKLIST.md'].includes(f)) {
      assert.match(t, /\| Last drill date \| never performed \|/, `${f}: only edit this when a drill is really recorded`);
    }
  }
});
