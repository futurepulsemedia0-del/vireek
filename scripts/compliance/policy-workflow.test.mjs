// node --test scripts/compliance/policy-workflow.test.mjs
// Guards the lock-step between policy files, the SQL seed, the collector lists and the control registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTORS } from './lib.mjs';
import { REPO_ROOT, loadRegistry } from './validate-controls.mjs';
import { buildPolicyItems, hashPolicyText, normalizePolicyText } from './policies.mjs';

const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const migration = read('supabase/migrations/20290306000000_policy_approval_workforce_evidence.sql');

test('normalisation makes the hash independent of line endings and trailing whitespace', () => {
  assert.equal(hashPolicyText('# A\r\nline  \r\n\r\n'), hashPolicyText('# A\nline\n'));
  assert.notEqual(hashPolicyText('# A\nline\n'), hashPolicyText('# A\nline changed\n'));
  assert.equal(normalizePolicyText('x\n\n\n'), 'x\n');
});

test('every policy file is seeded in the migration and vice versa', () => {
  const files = buildPolicyItems(REPO_ROOT).map((i) => i.slug).sort();
  const seeded = [...migration.matchAll(/^\s*\('([a-z0-9-]+)',\s*'[^']+',\s*'docs\/compliance\/policies\//gm)].map((m) => m[1]).sort();
  assert.deepEqual(seeded, files);
});

test('policy items carry valid hashes and paths', () => {
  for (const i of buildPolicyItems(REPO_ROOT)) {
    assert.match(i.sha256, /^[0-9a-f]{64}$/);
    assert.equal(i.source_path, `docs/compliance/policies/${i.slug}.md`);
    assert.ok(i.title.length >= 3);
  }
});

test('new evidence collectors exist in the registry twin and the edge twin', () => {
  const core = read('supabase/functions/_shared/compliance/evidenceCore.ts');
  const edge = read('supabase/functions/compliance-evidence/index.ts');
  for (const c of ['supabase.policy_approvals', 'supabase.workforce_records', 'supabase.pentest_findings']) {
    assert.equal(COLLECTORS[c]?.runsIn, 'edge', `${c} in lib.mjs`);
    assert.ok(core.includes(`'${c}': 'edge'`), `${c} in evidenceCore.ts`);
    assert.ok(edge.includes(`'${c}': async`), `${c} implemented in the edge function`);
  }
});

test('the five reconciled controls are partial, never met, and describe the real gap', () => {
  const reg = loadRegistry(REPO_ROOT);
  for (const id of ['GOV-01', 'GOV-02', 'RSK-01', 'AVL-04', 'PEN-01']) {
    const c = reg.controls.find((x) => x.id === id);
    assert.equal(c.status, 'partial', id);
    assert.ok(c.gap && c.gap.length > 40, `${id} gap text`);
  }
  assert.match(reg.controls.find((c) => c.id === 'PEN-01').gap, /NO third-party penetration test has been performed/);
});

test('no database object in the new migrations claims certification or compliance', () => {
  for (const f of ['20290306000000_policy_approval_workforce_evidence.sql', '20290306000100_pentest_program.sql']) {
    // Comments may legitimately say "this does NOT make Vireek SOC 2 compliant"; only executable SQL is checked.
    const sql = read(`supabase/migrations/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sql, /SOC ?2[ -]compliant|certified|is compliant/i, f);
  }
});

test('workforce migration has no column that could hold sensitive outcomes', () => {
  const block = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS public.compliance_workforce_records'), migration.indexOf('CREATE INDEX IF NOT EXISTS compliance_workforce_records_subject_idx'));
  for (const bad of ['result', 'notes', 'note ', 'report', 'score', 'dob', 'ssn', 'passport', ' user_id']) {
    assert.ok(!block.includes(`\n  ${bad.trim()} `) && !block.includes(` ${bad.trim()} text`), `forbidden column ${bad}`);
  }
});
