// Static guards for the insider-risk feature. They do NOT execute SQL (that is
// supabase/tests/database/staff_insider_risk.test.sql, which needs a database). They keep the migration,
// the SQL test, docs/compliance/insider-risk-monitoring.md and docs/compliance/ethics-channel.md in step,
// and stop the docs from drifting into claims the code cannot back.
// Run: node --test scripts/compliance/staff-insider-risk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const MIG = 'supabase/migrations/20290307000000_staff_insider_risk.sql';
const SQLTEST = 'supabase/tests/database/staff_insider_risk.test.sql';
const MON = 'docs/compliance/insider-risk-monitoring.md';
const ETH = 'docs/compliance/ethics-channel.md';
const mig = read(MIG);
const sqltest = read(SQLTEST);
const mon = read(MON);
const eth = read(ETH);

const checkRules = () => {
  const m = mig.match(/rule\s+text NOT NULL CHECK \(rule IN \(([\s\S]*?)\)\)/);
  assert.ok(m, 'rule CHECK list not found');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};
const raisedRules = () => [...mig.matchAll(/public\.sir_raise\('([a-z_]+)',\s*'([a-z]+)'/g)].map((x) => ({ rule: x[1], severity: x[2] }));
const dedupeKeys = () => [...mig.matchAll(/public\.sir_raise\([\s\S]*?'([a-z-]+)',\s*'([a-z]+):'/g)].map((x) => ({ runbook: x[1], prefix: x[2] }));

test('rule CHECK list, detection calls, docs table and SQL test all name the same rules', () => {
  const declared = checkRules();
  const raised = raisedRules().map((r) => r.rule);
  assert.equal(declared.length, 8);
  assert.deepEqual([...raised].sort(), [...declared].sort(), 'every declared rule is raised exactly once, and vice versa');
  assert.equal(new Set(raised).size, raised.length, 'no rule raised from two places');
  const table = mon.split('## 2. Alert rules')[1].split('## 3.')[0];
  for (const r of declared) {
    assert.ok(table.includes(`\`${r}\``), `doc table missing ${r}`);
    assert.ok(sqltest.includes(`'${r}'`), `SQL test never exercises ${r}`);
  }
});

test('severities in code match the docs table', () => {
  const table = mon.split('## 2. Alert rules')[1].split('## 3.')[0];
  for (const { rule, severity } of raisedRules()) {
    const row = table.split('\n').find((l) => l.startsWith(`| \`${rule}\``));
    assert.ok(row, `no doc row for ${rule}`);
    assert.ok(row.split('|')[2].trim() === severity, `${rule}: doc says ${row.split('|')[2].trim()}, code says ${severity}`);
  }
});

test('runbook keys: valid per column CHECK, unique, and listed in the docs', () => {
  const keys = dedupeKeys();
  assert.equal(keys.length, 8);
  for (const { runbook } of keys) {
    assert.match(runbook, /^[a-z][a-z0-9-]{2,60}$/);
    assert.ok(mon.includes(`\`${runbook}\``), `doc missing runbook key ${runbook}`);
  }
  assert.equal(new Set(keys.map((k) => k.runbook)).size, keys.length);
  assert.equal(new Set(keys.map((k) => k.prefix)).size, keys.length, 'dedupe key prefixes must be unique per rule');
});

test('default thresholds in the policy table match the docs', () => {
  const pol = {};
  for (const m of mig.matchAll(/(\w+)\s+integer NOT NULL DEFAULT (\d+)/g)) pol[m[1]] = Number(m[2]);
  const expectInDoc = {
    imp_starts_per_day: '>= 6 impersonation sessions in 24 h',
    imp_distinct_accounts_per_day: '>= 4 different accounts in 24 h',
    imp_denied_per_hour: '>= 3 refused impersonation attempts',
    imp_no_ticket_per_week: '>= 3 sessions without a ticket reference in 7 days',
    account_views_per_hour: '>= 25 different accounts opened',
    staff_bulk_records_10min: '>= 100 records read',
  };
  for (const [col, text] of Object.entries(expectInDoc)) {
    assert.ok(col in pol, `policy column ${col} missing`);
    assert.ok(mon.includes(text), `doc text for ${col} not found: "${text}"`);
    assert.ok(text.includes(String(pol[col])), `${col} default ${pol[col]} not reflected in "${text}"`);
  }
});

test('every new table has RLS on and client access revoked; no anon grants anywhere', () => {
  for (const t of ['staff_insider_policy', 'staff_insider_alerts']) {
    assert.match(mig, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`), `${t}: RLS`);
    assert.match(mig, new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated`), `${t}: revoke`);
  }
  assert.doesNotMatch(mig, /GRANT[^;]*\bTO\b[^;]*\banon\b/i, 'no GRANT to anon');
  assert.doesNotMatch(mig, /CREATE POLICY/i, 'no client policies: access is by RPC only');
});

test('every function is hardened: SECURITY DEFINER sets search_path; each is revoked from PUBLIC', () => {
  const fns = [...mig.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\n\$\$;/g)];
  assert.equal(fns.length, 8, `expected 8 functions, found ${fns.length}`);
  for (const [whole, name] of fns) {
    if (/SECURITY DEFINER/.test(whole)) assert.match(whole, /SET search_path = public/, `${name}: search_path`);
    if (['staff_insider_alerts_guard', 'sir_is_offhours'].includes(name)) continue; // trigger fn / pure helper
    assert.match(mig, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(`), `${name}: REVOKE from PUBLIC`);
  }
});

test('detection and attribution helpers are service_role only; review RPCs check staff + step-up', () => {
  for (const f of ['detect_staff_insider_risk(timestamptz)', 'sir_raise(', 'sir_staff_read_events(timestamptz, timestamptz)']) {
    const idx = mig.indexOf(`GRANT EXECUTE ON FUNCTION public.${f}`);
    assert.ok(idx > -1, `${f}: GRANT missing`);
    assert.match(mig.slice(idx, idx + 260), /TO service_role;/, `${f}: only service_role`);
  }
  const review = mig.split('CREATE OR REPLACE FUNCTION public.set_staff_insider_alert_status')[1].split('$$;')[0];
  for (const needle of ['is_vireek_staff(auth.uid())', 'sensitive_read_stepup_ok()', 'v_subject = auth.uid()', 'BETWEEN 10 AND 500']) {
    assert.ok(review.includes(needle), `set_staff_insider_alert_status lacks ${needle}`);
  }
});

test('alerts hold counts and ids only: no free-text evidence columns', () => {
  const table = mig.split('CREATE TABLE IF NOT EXISTS public.staff_insider_alerts')[1].split(');')[0];
  assert.doesNotMatch(table, /\b(reason|ticket|content|metadata|payload)\b\s+(text|jsonb)/i);
  assert.match(table, /review_note\s+text CHECK \(review_note IS NULL OR char_length\(review_note\) BETWEEN 10 AND 500\)/);
});

test('detection is idempotent by construction: dedupe key + conflict clause + advisory lock', () => {
  assert.match(mig, /dedupe_key\s+text NOT NULL UNIQUE/);
  assert.match(mig, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
  assert.match(mig, /pg_try_advisory_xact_lock/);
});

test('migration is additive and idempotent: no DROP TABLE/DELETE/TRUNCATE outside comments; IF NOT EXISTS / OR REPLACE used', () => {
  const code = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(code, /\bCREATE TABLE (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(code, /\bCREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(code, /\bCREATE FUNCTION\b/i);
  assert.match(mig, /DROP TRIGGER IF EXISTS trg_sia_guard/);
  assert.match(mig, /Rollback/);
});

test('migration timestamp is unique and the newest in the folder', async () => {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(resolve(ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_/.test(f)).sort();
  const mine = '20290307000000';
  assert.equal(files.filter((f) => f.startsWith(mine)).length, 1, 'version collision');
  assert.ok(files[files.length - 1] >= `${mine}_`, 'a newer migration exists: re-check ordering');
});

test('the SQL test file is transactional and ends with ROLLBACK', () => {
  assert.match(sqltest, /^BEGIN;/m);
  assert.match(sqltest.trimEnd(), /ROLLBACK;$/);
  assert.ok((sqltest.match(/pg_temp\.(ok|fails_with)\(/g) ?? []).length >= 60, 'expected many assertions');
});

test('monitoring doc is a draft, claims nothing, and flags counsel / verify items', () => {
  assert.match(mon, /DRAFT: not approved/);
  assert.match(mon, /makes no compliance claim/);
  for (const t of ['[COUNSEL]', '[VERIFY']) assert.ok(mon.includes(t), `missing ${t}`);
  for (const re of [/\bwe are (SOC ?2|ISO|GDPR)[- ]?(compliant|certified)\b/i, /\bfully (secure|protected)\b/i, /\bguarantee[sd]? (anonymity|protection|compliance|security)\b/i]) {
    assert.doesNotMatch(mon, re, `matched ${re}`);
  }
  assert.match(mon, /no notification channel and no staff UI/i, 'must state the delivery gap honestly');
});

test('ethics channel doc: not live, no invented contacts or guarantees, required sections present', () => {
  assert.match(eth, /DRAFT: not approved, channel not live/);
  assert.match(eth, /does \*\*not\*\* state that Vireek operates such a channel/);
  for (const h of ['## 1. Purpose and scope', '## 3. How to report (to be set up)', '## 4. What should happen after a report',
    '## 5. Conflicts of interest and escalation', '## 6. Confidentiality and protection from retaliation', '## 7. Records and data protection',
    '## 8. Legal frameworks to check', '## 9. Intake template', '## 11. Open decisions']) assert.ok(eth.includes(h), `missing ${h}`);
  for (const t of ['[COUNSEL]', '[VERIFY]', '[TO BE SET UP]']) assert.ok(eth.includes(t), `missing ${t}`);
  assert.doesNotMatch(eth, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, 'no e-mail addresses may be invented or copied');
  assert.doesNotMatch(eth, /(https?:\/\/)/i, 'no URLs invented');
  for (const re of [/\b(is|are) (fully )?(compliant|compliant with)\b/i, /\bguarantee[sd]? (anonymity|protection|confidentiality)\b/i, /\bwe (comply|are compliant)\b/i]) {
    assert.doesNotMatch(eth, re, `matched ${re}`);
  }
  assert.match(eth, /Do not reuse the personal contact in `public\/\.well-known\/security\.txt`/);
});

test('every repo path cited in the new docs exists', () => {
  const missing = [];
  for (const [name, doc] of [[MON, mon], [ETH, eth]]) {
    for (const m of doc.matchAll(/`([A-Za-z0-9_.\-/]+\.(?:md|sql|mjs|ts|tsx|json|txt|toml))`/g)) {
      const p = m[1];
      if (!p.includes('/') && !/^[A-Z_]+\.md$/.test(p)) continue;
      if (p.startsWith('docs/compliance/access-reviews/')) continue; // output folder, created by --out
      if (!existsSync(resolve(ROOT, p))) missing.push(`${name}: ${p}`);
    }
  }
  assert.deepEqual(missing, []);
});
