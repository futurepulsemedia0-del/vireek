// scripts/data/check-data-product-gates.test.mjs
// Run: node --test scripts/data/check-data-product-gates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, callPattern, criteriaFromDoc, criteriaFromSql, ROOT, REGISTRY, DOC } from './check-data-product-gates.mjs';

const MIG = 'supabase/migrations/20290311000000_data_product_reviews.sql';
const SQL = fs.readFileSync(path.join(ROOT, MIG), 'utf8');

test('real repository: every external data endpoint references an approval check', () => {
  assert.deepEqual(check(ROOT), []);
});

test('real repository: registry covers exactly the three known external data endpoints', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY), 'utf8'));
  assert.deepEqual(reg.endpoints.map((e) => e.function).sort(), ['evidence-marketplace-api', 'insights-api', 'state-of-calls-public']);
});

test('criteria parsers agree on the real doc and migration', () => {
  const doc = criteriaFromDoc(fs.readFileSync(path.join(ROOT, DOC), 'utf8'));
  assert.deepEqual(doc, ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
  assert.deepEqual(criteriaFromSql(SQL), doc);
});

test('callPattern needs the exact product key and function literals', () => {
  const ok = 'await assertDataProductApproved(admin, "vireek_insights", "insights-api", corsHeaders)';
  assert.ok(callPattern('vireek_insights', 'insights-api').test(ok));
  assert.ok(!callPattern('vireek_insights', 'insights-api').test(ok.replace('vireek_insights', 'other_key')));
  assert.ok(!callPattern('vireek_insights', 'insights-api').test(ok.replace('"insights-api"', '"x-api"')));
  assert.ok(!callPattern('vireek_insights', 'insights-api').test('// assertDataProductApproved is mentioned only'));
});

// ---- migration static checks (STATIC: the executed counterpart is supabase/tests/database/data_product_reviews.test.sql)
test('STATIC migration: RLS on, staff-only reads, no client write policy, gate is service_role only', () => {
  assert.match(SQL, /ALTER TABLE public\.data_product_reviews ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL, /ALTER TABLE public\.data_product_review_events ENABLE ROW LEVEL SECURITY/);
  assert.equal([...SQL.matchAll(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/g)].length, 0);
  assert.match(SQL, /REVOKE ALL ON FUNCTION public\.data_product_gate\(text, text\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.data_product_gate\(text, text\) TO service_role;/);
  assert.match(SQL, /REVOKE ALL ON public\.data_product_reviews FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(SQL, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*ON public\.data_product_reviews TO authenticated/);
});

test('STATIC migration: every SECURITY DEFINER function pins search_path; no destructive SQL', () => {
  const fns = SQL.split(/CREATE OR REPLACE FUNCTION/).slice(1);
  for (const f of fns) if (/SECURITY DEFINER/.test(f.split('AS $$')[0])) assert.match(f.split('AS $$')[0], /SET search_path = public, pg_temp/, f.slice(0, 60));
  assert.doesNotMatch(SQL.replace(/\/\*[\s\S]*?\*\//, ''), /\b(DROP TABLE|TRUNCATE|DELETE FROM|ALTER COLUMN)\b/i);
});

test('STATIC migration: seeds are pending only and are skipped when the product already has a review', () => {
  const seed = SQL.slice(SQL.indexOf('-- F. Seed'));
  assert.doesNotMatch(seed, /'approved'/);
  assert.match(seed, /WHERE NOT EXISTS \(SELECT 1 FROM public\.data_product_reviews d WHERE d\.product_key = v\.product_key\)/);
  for (const k of ['vireek_insights', 'evidence_marketplace', 'state_of_calls']) assert.ok(seed.includes(`'${k}'`), k);
});

test('STATIC migration: approval invariants are present in the guard trigger', () => {
  for (const code of ['DPR_SEPARATION', 'DPR_PRIVACY_REVIEW', 'DPR_CRITERIA', 'DPR_ENDPOINTS', 'DPR_COUNSEL', 'DPR_EXPIRY', 'DPR_IMMUTABLE', 'DPR_AUTH']) assert.ok(SQL.includes(code), code);
  assert.match(SQL, /interval '366 days'/);
  assert.match(SQL, /NEW\.min_cohort_size < 5/);
});

// ---- negative cases on a temporary repo
function tempRepo(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpgate-'));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w(REGISTRY, JSON.stringify({ version: 1, endpoints: [{ function: 'ext-api', productKey: 'ext_product' }], exempt: [] }));
  w(MIG, "-- data_product_reviews\nCREATE OR REPLACE FUNCTION public.data_product_required_criteria() RETURNS text[] AS $$ SELECT ARRAY['E1','E2']::text[] $$;\nINSERT INTO public.data_product_reviews VALUES ('ext_product', 'ARRAY[''ext-api'']');\nSELECT 'ext-api';\n");
  w(DOC, '| ID | C |\n|---|---|\n| E1 | a |\n| E2 | b |\n');
  w('supabase/functions/ext-api/index.ts', 'import { assertDataProductApproved } from "../_shared/data-products/guard.ts";\nawait assertDataProductApproved(admin, "ext_product", "ext-api", h);\n');
  mutate(w, root);
  return root;
}

test('temp repo: a correctly wired endpoint passes', () => assert.deepEqual(check(tempRepo()), []));

test('temp repo: an endpoint that does not call the guard fails', () => {
  const root = tempRepo((w) => w('supabase/functions/ext-api/index.ts', 'import { assertDataProductApproved } from "../_shared/data-products/guard.ts";\n// TODO call it\n'));
  assert.match(check(root).join('\n'), /must call assertDataProductApproved\(<client>, "ext_product", "ext-api"/);
});

test('temp repo: calling the guard with the wrong product key fails', () => {
  const root = tempRepo((w) => w('supabase/functions/ext-api/index.ts', 'import { assertDataProductApproved } from "../_shared/data-products/guard.ts";\nawait assertDataProductApproved(admin, "someone_elses", "ext-api", h);\n'));
  assert.match(check(root).join('\n'), /must call assertDataProductApproved/);
});

test('temp repo: an unregistered function that uses the guard, or announces itself as external, fails', () => {
  const a = tempRepo((w) => w('supabase/functions/new-partner-api/index.ts', 'import { assertDataProductApproved } from "../_shared/data-products/guard.ts";\n'));
  assert.match(check(a).join('\n'), /new-partner-api\/index\.ts: uses the data-product guard but is not listed/);
  const b = tempRepo((w) => w('supabase/functions/sneaky/index.ts', '// The partner-facing Vireek aggregate API\nDeno.serve(() => new Response("x"));\n'));
  assert.match(check(b).join('\n'), /sneaky\/index\.ts: header describes an external data endpoint/);
});

test('temp repo: an exemption needs a real reason and silences only the named function', () => {
  const ok = tempRepo((w) => {
    w(REGISTRY, JSON.stringify({ endpoints: [{ function: 'ext-api', productKey: 'ext_product' }], exempt: [{ function: 'sneaky', reason: 'Tenant-directed export, not a data product.' }] }));
    w('supabase/functions/sneaky/index.ts', '// partner-facing export\n');
  });
  assert.deepEqual(check(ok), []);
  const bad = tempRepo((w) => w(REGISTRY, JSON.stringify({ endpoints: [{ function: 'ext-api', productKey: 'ext_product' }], exempt: [{ function: 'sneaky', reason: 'short' }] })));
  assert.match(check(bad).join('\n'), /exempt entry "sneaky" needs a reason/);
});

test('temp repo: missing function, bad key, missing review path and criteria drift all fail', () => {
  assert.match(check(tempRepo((w) => w(REGISTRY, JSON.stringify({ endpoints: [{ function: 'ghost', productKey: 'ext_product' }] })))).join('\n'), /ghost\/index\.ts does not exist/);
  assert.match(check(tempRepo((w) => w(REGISTRY, JSON.stringify({ endpoints: [{ function: 'ext-api', productKey: 'Bad Key' }] })))).join('\n'), /productKey "Bad Key"/);
  assert.match(check(tempRepo((w) => w(MIG, '-- data_product_reviews\nSELECT ARRAY[\'E1\',\'E2\'];\n'))).join('\n'), /no migration seeds a review|criteria drift/);
  assert.match(check(tempRepo((w) => w(DOC, '| E1 | a |\n| E2 | b |\n| E3 | c |\n'))).join('\n'), /criteria drift/);
});

test('temp repo: unreadable or malformed registry fails closed', () => {
  assert.match(check(tempRepo((w) => w(REGISTRY, '{not json'))).join('\n'), /cannot read or parse/);
  assert.match(check(tempRepo((w) => w(REGISTRY, '{"endpoints":{}}'))).join('\n'), /must be arrays/);
});
