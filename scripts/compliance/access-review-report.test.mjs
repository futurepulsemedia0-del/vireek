// Run: node --test scripts/compliance/access-review-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DORMANT_DAYS, FLAGS, SCHEMA, evaluateStaff, parseReport, renderMarkdown, summarise } from './access-review-report.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'access-review-report.mjs');
const NOW = new Date('2030-04-02T00:00:00Z');
const REF = new Date('2030-04-01T00:00:00Z');

const clean = (over = {}) => ({
  id: '00000000-0000-0000-0000-000000000001', email: 'a@vireek.test', role: 'owner', status: 'active',
  last_sign_in_at: '2030-03-25T08:00:00Z', mfa_verified_factors: 1, impersonation_sessions: 2, impersonated_accounts: 2,
  sessions_without_ticket: 0, staff_audit_actions: { impersonation_start: 2 }, sensitive_read_records: 10,
  sensitive_export_events: 0, alerts_in_period: 0, alerts_open: 0, ...over,
});
const report = (staff = [clean()], over = {}) => ({
  schema: SCHEMA, generated_at: '2030-04-02T00:00:00Z',
  period: { year: 2030, quarter: 1, from: '2030-01-01T00:00:00+00:00', to: '2030-04-01T00:00:00+00:00' },
  staff, alerts_by_rule: [], open_alerts_from_earlier_periods: 0,
  platform_access: { scim: { active: 1, revoked: 0, active_unused_90d: 0 }, custom_roles: 2, profiles_by_role: [{ role: 'owner', status: 'active', count: 3 }] },
  ...over,
});

test('a healthy account raises no flag', () => {
  assert.deepEqual(evaluateStaff(clean(), REF), []);
});

test('each flag fires on its own condition', () => {
  assert.deepEqual(evaluateStaff(clean({ mfa_verified_factors: 0 }), REF), ['no_verified_mfa']);
  assert.deepEqual(evaluateStaff(clean({ status: 'suspended' }), REF), ['not_active']);
  assert.deepEqual(evaluateStaff(clean({ alerts_open: 1 }), REF), ['open_alerts']);
  assert.deepEqual(evaluateStaff(clean({ sessions_without_ticket: 2 }), REF), ['sessions_without_ticket']);
  assert.deepEqual(evaluateStaff(clean({ sensitive_export_events: 1 }), REF), ['staff_exports']);
  assert.deepEqual(evaluateStaff(clean({ last_sign_in_at: null }), REF), ['dormant']);
});

test('dormant boundary: exactly 90 days is fine, 91 is flagged', () => {
  const at = (days) => new Date(REF.getTime() - days * 86_400_000).toISOString();
  assert.equal(DORMANT_DAYS, 90);
  assert.deepEqual(evaluateStaff(clean({ last_sign_in_at: at(90) }), REF), []);
  assert.deepEqual(evaluateStaff(clean({ last_sign_in_at: at(91) }), REF), ['dormant']);
});

test('numbers arriving as strings (bigint from JSON) are handled; junk counts as zero', () => {
  assert.deepEqual(evaluateStaff(clean({ mfa_verified_factors: '0' }), REF), ['no_verified_mfa']);
  assert.deepEqual(evaluateStaff(clean({ alerts_open: 'x' }), REF), []);
});

test('every flag id used by evaluateStaff is documented in FLAGS', () => {
  const worst = clean({ mfa_verified_factors: 0, status: 'x', alerts_open: 1, sessions_without_ticket: 1, sensitive_export_events: 1, last_sign_in_at: null });
  const got = evaluateStaff(worst, REF);
  assert.equal(got.length, Object.keys(FLAGS).length);
  for (const f of got) assert.ok(f in FLAGS, f);
});

test('summarise counts flagged accounts and flags', () => {
  const s = summarise(report([clean(), clean({ email: 'b@vireek.test', mfa_verified_factors: 0, alerts_open: 2 })]), NOW);
  assert.equal(s.rows.length, 2);
  assert.equal(s.flagged.length, 1);
  assert.equal(s.flagCount, 2);
});

test('parseReport rejects unusable input with a readable message', () => {
  assert.throws(() => parseReport('{nope'), /not valid JSON/);
  assert.throws(() => parseReport([]), /JSON object/);
  assert.throws(() => parseReport({ schema: 'other/v9' }), /unsupported schema/);
  assert.throws(() => parseReport({ schema: SCHEMA, period: {}, staff: [] }), /period/);
  assert.throws(() => parseReport({ schema: SCHEMA, period: { year: 2030, quarter: 1 }, staff: 'x' }), /staff/);
});

test('markdown is unsigned: banner present, sign-off fields blank, no attestation wording', () => {
  const md = renderMarkdown(report(), NOW);
  assert.match(md, /^# Staff access review: 2030 Q1/);
  assert.match(md, /\*\*DRAFT: not signed\.\*\*/);
  assert.match(md, /- Reviewer \(name, role\): *\n/);
  assert.match(md, /- Reviewed on: *\n/);
  assert.doesNotMatch(md, /(reviewed and approved|access review (was|has been) (completed|performed)|compliant with)/i);
  assert.match(md, /- \[ \] GitHub organisation/);
  assert.doesNotMatch(md, /- \[x\]/i);
});

test('markdown escapes table-breaking characters in e-mails and role names', () => {
  const md = renderMarkdown(report([clean({ email: 'a|b@vireek.test', role: 'ow|ner' })]), NOW);
  assert.match(md, /a\\\|b@vireek\.test/);
  assert.match(md, /ow\\\|ner/);
});

test('empty staff list tells the reviewer to confirm, and decisions table stays valid', () => {
  const md = renderMarkdown(report([]), NOW);
  assert.match(md, /No account has `profiles\.is_staff = true`/);
  assert.match(md, /\| Account \| Decision/);
});

test('decisions table lists only flagged accounts when any exist', () => {
  const md = renderMarkdown(report([clean({ email: 'ok@vireek.test' }), clean({ email: 'bad@vireek.test', mfa_verified_factors: 0 })]), NOW);
  const decisions = md.split('## 6. Decisions')[1].split('## 7.')[0];
  assert.match(decisions, /bad@vireek\.test/);
  assert.doesNotMatch(decisions, /ok@vireek\.test/);
});

test('no-alerts section warns that detection may not be scheduled', () => {
  assert.match(renderMarkdown(report(), NOW), /staff-insider-detect/);
});

test('CLI: --strict exits 1 on flags, 0 on a clean report, 2 on bad input; --out writes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-'));
  const flagged = join(dir, 'flagged.json');
  const ok = join(dir, 'ok.json');
  const bad = join(dir, 'bad.json');
  writeFileSync(flagged, JSON.stringify(report([clean({ mfa_verified_factors: 0 })])));
  writeFileSync(ok, JSON.stringify(report()));
  writeFileSync(bad, '{"schema":"x"}');
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  assert.equal(run(flagged, '--strict', '--now', '2030-04-02T00:00:00Z').status, 1);
  assert.equal(run(flagged, '--now', '2030-04-02T00:00:00Z').status, 0);
  assert.equal(run(ok, '--strict', '--now', '2030-04-02T00:00:00Z').status, 0);
  assert.equal(run(bad).status, 2);
  assert.equal(run().status, 2);
  const out = join(dir, 'nested', 'r.md');
  const r = run(ok, '--out', out, '--now', '2030-04-02T00:00:00Z');
  assert.equal(r.status, 0);
  assert.match(readFileSync(out, 'utf8'), /^# Staff access review/);
});
