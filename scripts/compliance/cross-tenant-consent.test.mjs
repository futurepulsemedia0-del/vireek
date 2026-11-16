// Static regression guard for the cross-tenant consent gate (runs with plain Node, no database).
//   node --test scripts/compliance/cross-tenant-consent.test.mjs
// It does NOT execute SQL. Behavioural proof lives in supabase/tests/database/cross_tenant_consent.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = path.join(root, 'supabase', 'migrations');
const NEW = '20290305000000_cross_tenant_consent_enforcement.sql';
const newSql = fs.readFileSync(path.join(MIG_DIR, NEW), 'utf8');

const REGISTRY = {
  benchmark_cohorts: 'refresh_benchmark_cohorts',
  platform_benchmarks: 'compute_platform_benchmarks',
  regional_demand: 'compute_regional_demand',
  outcome_benchmarks: 'refresh_outcome_benchmarks',
  service_loop_priors: 'refresh_service_loop_global_priors',
  fie_patterns: 'fie_refresh_global_patterns',
  failure_genome: 'refresh_failure_patterns',
  vertical_intelligence: 'mine_vertical_intelligence',
  causal_cohorts: 'compute_causal_cohort_insights',
  rebate_realization: 'rebate_network_realization',
};
const EXTRA_FUNCTIONS = ['ob_is_participating'];

function extract(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return null;
  const open = sql.indexOf('$$', start);
  const end = sql.indexOf('$$;', open + 2);
  return sql.slice(start, end + 3);
}
function latestBefore(name) {
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f) && f < NEW).sort();
  let found = null;
  for (const f of files) {
    const def = extract(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'), name);
    if (def) found = { f, def };
  }
  return found;
}
const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

test('registry in the migration matches the expected flow set', () => {
  const keys = [...newSql.matchAll(/^\s+\('([a-z0-9_]+)',\s+(?:'[a-z]+'|NULL),/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, Object.keys(REGISTRY).sort());
});

test('exactly three flows are unmapped (fail-closed)', () => {
  const unmapped = [...newSql.matchAll(/^\s+\('([a-z0-9_]+)',\s+NULL,/gm)].map((m) => m[1]).sort();
  assert.deepEqual(unmapped, ['causal_cohorts', 'rebate_realization', 'vertical_intelligence']);
});

for (const [flow, fn] of [...Object.entries(REGISTRY), ['outcome_benchmarks', 'ob_is_participating']]) {
  test(`${fn} only differs from its latest prior definition by the consent gate`, () => {
    const now = extract(newSql, fn);
    assert.ok(now, `${fn} missing in migration`);
    const prev = latestBefore(fn);
    assert.ok(prev, `no prior definition of ${fn}`);
    const a = norm(prev.def);
    const b = norm(now);
    const removed = a.filter((l) => !b.includes(l));
    const added = b.filter((l) => !a.includes(l));
    assert.ok(added.some((l) => l.includes(`'${flow}'`) && l.includes('xtl_contribut')), `${fn}: gate for '${flow}' not added`);
    // Removed lines are only allowed where a statement was extended with the gate, or the history delete changed.
    for (const l of removed) {
      const extended = added.some((x) => x.startsWith(l.replace(/[;)]+$/, '')) || x_contains(added, l));
      const historyDelete = l.includes("interval '14 days'");
      assert.ok(extended || historyDelete, `${fn}: unexpected removed line: ${l}`);
    }
    for (const l of added) {
      const gate = l.includes('xtl_contribut');
      const tail = /^[);]*$/.test(l) || removed.some((r) => l.startsWith(r.replace(/[;)]+$/, '')));
      const historyDelete = l.includes('computed_at < now()');
      assert.ok(gate || tail || historyDelete || /^\)?;?$/.test(l), `${fn}: unexpected added line: ${l}`);
    }
  });
}
function x_contains(added, l) {
  const core = l.replace(/[;)]+$/, '').trim();
  return core.length > 0 && added.some((x) => x.includes(core));
}

test('voice pooled prior counts a contribution only while its contributor still opts in', () => {
  const now = extract(newSql, 'get_voice_pooled_prior');
  assert.ok(now);
  assert.match(now, /JOIN public\.voice_autopilot_settings cs ON cs\.user_id = c\.user_id AND cs\.pooled_priors_opt_in/);
  assert.match(now, /agg\.a >= 10/, 'k >= 10 floor must be unchanged');
});

test('gate functions are not executable by clients', () => {
  for (const sig of ['xtl_contributors(text)', 'xtl_contributes(uuid, text)']) {
    assert.match(newSql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${sig.replace(/[()]/g, '\\$&')} FROM PUBLIC, anon, authenticated;`));
    assert.match(newSql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${sig.replace(/[()]/g, '\\$&')} TO service_role;`));
  }
  assert.match(newSql, /REVOKE ALL ON public\.cross_tenant_flows FROM PUBLIC, anon, authenticated;/);
});

test('migration is additive: no top-level DROP/TRUNCATE/DELETE; bodies only drop temp tables', () => {
  const noComments = newSql.replace(/\/\*[\s\S]*?\*\//, '').replace(/^\s*--.*$/gm, '');
  const topLevel = noComments.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
  assert.doesNotMatch(topLevel, /\b(DROP|TRUNCATE|DELETE)\b/i);
  const bodies = [...noComments.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]).join('\n');
  for (const m of bodies.matchAll(/\bDROP\s+TABLE\s+IF\s+EXISTS\s+([^;]+);/gi)) {
    for (const t of m[1].split(',')) assert.match(t.trim(), /^(_|tmp_)/, `non-temp DROP: ${t}`);
  }
  assert.doesNotMatch(bodies, /\b(TRUNCATE|DROP\s+(COLUMN|POLICY|FUNCTION))\b/i);
  const deletes = [...bodies.matchAll(/^\s*DELETE FROM (\w+)/gm)].map((m) => m[1]);
  // pre-existing stale-row deletes in rebuilt aggregate tables + the benchmark purge; never tenant data
  for (const t of new Set(deletes)) {
    assert.match(t, /^(benchmark_cohort_stats|outcome_benchmark_cohorts|service_loop_global_priors|service_loop_global_totals|fie_global_patterns|failure_patterns|vertical_intelligence_signals)$/, `unexpected DELETE target ${t}`);
  }
});

test('seed is non-destructive (ON CONFLICT DO NOTHING) so operator remaps survive re-runs', () => {
  assert.match(newSql, /ON CONFLICT \(flow_key\) DO NOTHING;/);
});

test('edge functions purge rows not rewritten in the run (revocation cannot be stuck behind k-anonymity)', () => {
  for (const [file, table] of [
    ['compute-regional-demand', 'regional_demand_snapshots'],
    ['compute-benchmarks', 'benchmark_snapshots'],
  ]) {
    const src = fs.readFileSync(path.join(root, 'supabase', 'functions', file, 'index.ts'), 'utf8');
    assert.match(src, new RegExp(`from\\("${table}"\\)\\s*\\.delete\\(\\)\\s*\\.lt\\("computed_at", computedAt\\)`));
    assert.ok(src.indexOf('purgeError') > src.indexOf('upsertError'), `${file}: purge must follow the upsert`);
  }
});

test('data-flow register lists every registered flow', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'compliance', 'cross-tenant-data-flows.md'), 'utf8');
  for (const k of Object.keys(REGISTRY)) assert.ok(doc.includes('`' + k + '`'), `doc is missing flow ${k}`);
  assert.ok(doc.includes('[COUNSEL]'));
});
