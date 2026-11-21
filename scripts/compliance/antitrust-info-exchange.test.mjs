// Static regression guard for the antitrust information-exchange guardrails (plain Node, no database).
//   node --test scripts/compliance/antitrust-info-exchange.test.mjs
// Behavioural proof lives in supabase/tests/database/antitrust_info_exchange_guardrails.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const MIG = '20290306000000_antitrust_info_exchange_guardrails.sql';
const sql = read('supabase', 'migrations', MIG);
const doc = read('docs', 'compliance', 'antitrust-info-exchange-review.md');

// Registry seed rows: ('flow', 'metric', tier, ...
const seed = [...sql.matchAll(/\(\s*'([a-z0-9_]+)',\s*'([a-z0-9_]+)',\s*([0-3]),\s*'(national|region|state|metro|locality|postal)',\s*(true|false)/g)]
  .map((m) => ({ flow: m[1], metric: m[2], tier: Number(m[3]) }));

test('registry seed is non-empty and covers the five inspected flows', () => {
  assert.ok(seed.length >= 25, `expected >= 25 seeded metrics, got ${seed.length}`);
  for (const f of ['benchmark_cohorts', 'regional_demand', 'platform_benchmarks', 'service_data_exchange', 'procurement_network']) {
    assert.ok(seed.some((s) => s.flow === f), `flow ${f} missing from registry seed`);
  }
});

test('every benchmark_cohort_stats metric (CHECK list in the base migration) is registered', () => {
  const base = read('supabase', 'migrations', '20260923000000_cross_tenant_benchmarking.sql');
  const list = base.match(/metric text NOT NULL CHECK \(metric IN \(([^)]*)\)\)/)[1];
  const metrics = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(metrics.length, 6);
  for (const m of metrics) assert.ok(seed.some((s) => s.flow === 'benchmark_cohorts' && s.metric === m), `unregistered: ${m}`);
});

test('every legacy platform benchmark metric is registered', () => {
  const c = read('supabase', 'migrations', '20290305000000_cross_tenant_consent_enforcement.sql');
  const keys = [...c.matchAll(/SELECT '([a-z_]+)'::text, 'all'::text/g)].map((m) => m[1]);
  assert.ok(keys.length >= 6);
  for (const k of keys) assert.ok(seed.some((s) => s.flow === 'platform_benchmarks' && s.metric === k), `unregistered: ${k}`);
});

test('regional demand columns published by the edge function are registered', () => {
  const fn = read('supabase', 'functions', 'compute-regional-demand', 'index.ts');
  const listed = fn.match(/const metrics = \[([^\]]*)\]/)[1];
  for (const m of [...listed.matchAll(/"([a-z_]+)"/g)].map((x) => x[1])) {
    assert.ok(seed.some((s) => s.flow === 'regional_demand' && s.metric === m), `unregistered: ${m}`);
  }
});

test('every registered metric appears in the review document with a tier', () => {
  for (const s of seed) assert.ok(doc.includes('`' + s.metric + '`'), `doc does not list ${s.flow}.${s.metric}`);
  assert.match(doc, /\[COUNSEL\]/);
  assert.match(doc, /\| 3 \| Direct price/);
});

test('direct-price metrics are tier 3 and median paid ticket is not downgraded', () => {
  const t = seed.find((s) => s.metric === 'median_paid_ticket_cents');
  assert.equal(t.tier, 3);
  assert.equal(seed.find((s) => s.metric === 'avg_ticket_cents').tier, 2);
});

test('nothing ships pre-approved by counsel (seed insert never sets counsel_status)', () => {
  const start = sql.indexOf('INSERT INTO public.ixg_metric_registry');
  const block = sql.slice(start, sql.indexOf('ON CONFLICT', start));
  assert.ok(start > 0 && !/counsel_status|approved/.test(block));
});

test('fail-closed markers are present in the evaluator', () => {
  for (const r of ['metric_not_registered', 'config_missing', 'counsel_approval_required', 'cohort_below_minimum',
    'geography_too_narrow', 'single_tenant_share_exceeded', 'share_unknown', 'data_too_recent', 'malformed_item']) {
    assert.ok(sql.includes(`'${r}'`), `missing reason ${r}`);
  }
  assert.ok(sql.includes('2147483647'), 'unconfigured minimum cohort must be unreachable');
});

test('regression: no text[] || untyped literal in PL/pgSQL (parsed as an array literal)', () => {
  assert.ok(!/\br\s*:=\s*r\s*\|\|\s*'/.test(sql));
  assert.ok(!/,\s*r\s*\|\|\s*'/.test(sql));
});

test('ixg_* tables have RLS, no client policy, and are revoked from clients', () => {
  for (const t of ['ixg_guardrail_config', 'ixg_metric_registry', 'ixg_guardrail_audit']) {
    assert.ok(sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`), `${t} RLS`);
    assert.ok(sql.includes(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated`), `${t} revoke`);
    assert.ok(!new RegExp(`CREATE POLICY[^;]*ON public\\.${t}`).test(sql), `${t} must have no policy`);
  }
});

test('evaluator and share functions are service_role only', () => {
  for (const fn of ['ixg_evaluate(text, text, integer, text, numeric, date, date)', 'ixg_check_rows(text, jsonb)',
    'ixg_regional_segment_shares()', 'ixg_regional_dominated_segments()', 'ixg_purge_published()']) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated`), `revoke ${fn}`);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role`), `grant ${fn}`);
  }
});

test('the old open read policies are replaced, not left in place', () => {
  assert.ok(sql.includes('DROP POLICY IF EXISTS "select_benchmark_cohort_stats"'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS "select_regional_demand_snapshots"'));
  assert.ok(!/USING \(true\)/.test(sql.split('Rollback')[0]), 'no USING (true) outside the rollback comment');
});

test('edge publishers use the guard and fail closed (503 + purge path kept)', () => {
  for (const [fn, flow] of [['compute-benchmarks', 'platform_benchmarks'], ['compute-regional-demand', 'regional_demand']]) {
    const src = read('supabase', 'functions', fn, 'index.ts');
    assert.ok(src.includes('../_shared/infoExchangeGuard.ts'), `${fn} imports the guard`);
    assert.ok(src.includes(`"${flow}"`), `${fn} uses flow ${flow}`);
    assert.ok(/guardFailed\s*=\s*true/.test(src) && /,\s*503\)/.test(src), `${fn} fails closed`);
    assert.ok(src.includes('.delete()') && src.includes('.lt("computed_at", computedAt)'), `${fn} still purges`);
  }
});

test('guard helper never embeds thresholds', () => {
  const g = read('supabase', 'functions', '_shared', 'infoExchangeGuard.ts');
  assert.ok(!/min_cohort|max_single|data_lag|=== 5\b|>= 5\b/.test(g));
});

test('supplier-price-feed and capacity-demand-insight stay out of cross-tenant builders', () => {
  const dir = path.join(root, 'supabase', 'migrations');
  const crossTenant = /xtl_contributors|sde_consents|ixg_/;
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f === MIG) continue;
    if (/supplier_price_history|supplier_catalog_items/.test(s) && crossTenant.test(s)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'supplier price tables must not feed a consent-gated cross-tenant builder without review');
  const fn = read('supabase', 'functions', 'supplier-price-feed', 'index.ts');
  assert.ok(fn.includes('p_owner: key.user_id'), 'feed writes only into the key owner');
  const cap = read('supabase', 'functions', 'capacity-demand-insight', 'index.ts');
  assert.ok(!/benchmark_cohort_stats|regional_demand_snapshots|sde_/.test(cap), 'capacity insight is own-account only');
});
