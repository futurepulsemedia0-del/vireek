// Run: node --test scripts/compliance/check-risk-register.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseDay, summary, AREAS } from './check-risk-register.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(HERE, 'check-risk-register.mjs');
const TODAY = new Date('2027-01-31T00:00:00Z');

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'src.md'), '# Source\n| T1 | cross tenant |\n');
  writeFileSync(join(root, 'docs', 'ctl.md'), 'control');
  return root;
}
const risk = (o = {}) => ({
  id: 'RR-001', title: 'Cross-tenant read', description: 'A user reads another tenant data.', category: 'security',
  source: { path: 'docs/src.md', anchor: '| T1 |' }, owner: { area: 'security', person: 'Sam Example' },
  likelihood: 2, impact: 4, controls: [{ description: 'RLS scoping', status: 'documented', ref: 'docs/ctl.md' }],
  status: 'open', last_reviewed: '2027-01-10', ...o,
});
const reg = (risks = [risk()], over = {}) => ({ schema: 'vireek.risk-register/v1', review: { default_interval_days: 90 }, risks, ...over });
const run = (r, root = fixtureRoot(), today = TODAY) => evaluate(r, { today, root });

test('a complete, fresh risk has no errors and no findings', () => {
  const out = run(reg());
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.findings, []);
});

test('parseDay is strict', () => {
  assert.ok(parseDay('2027-02-28'));
  assert.equal(parseDay('2027-02-30'), null);
  assert.equal(parseDay('2027-2-1'), null);
  assert.equal(parseDay('2027-01-31T00:00:00Z'), null);
  assert.equal(parseDay(20270131), null);
});

test('stale boundary: due date itself is fine, one day later is stale', () => {
  const root = fixtureRoot();
  // last_reviewed 2026-11-02 + 90 days = 2027-01-31
  assert.deepEqual(run(reg([risk({ last_reviewed: '2026-11-02' })]), root).findings, []);
  const f = run(reg([risk({ last_reviewed: '2026-11-01' })]), root).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'stale_review');
  assert.match(f[0].msg, /due 2027-01-30 \(1 days overdue\)/);
});

test('per-risk review_interval_days overrides the default', () => {
  const root = fixtureRoot();
  assert.equal(run(reg([risk({ last_reviewed: '2027-01-10', review_interval_days: 7 })]), root).findings[0].kind, 'stale_review');
  assert.deepEqual(run(reg([risk({ last_reviewed: '2026-06-01', review_interval_days: 400 })]), root).findings, []);
});

test('null last_reviewed is never_reviewed; unowned and unscored are reported', () => {
  const out = run(reg([risk({ last_reviewed: null, owner: { area: 'security', person: null }, likelihood: null })]));
  assert.deepEqual(out.errors, []);
  assert.deepEqual(summary(out.findings), { never_reviewed: 1, unowned: 1, unscored: 1 });
});

test('closed risks produce no process findings', () => {
  const out = run(reg([risk({ status: 'closed', last_reviewed: null, likelihood: null, owner: { area: 'security', person: null } })]));
  assert.deepEqual(out.findings, []);
});

test('traceability: missing source file, missing anchor, missing control ref are errors', () => {
  assert.match(run(reg([risk({ source: { path: 'docs/nope.md', anchor: 'x' } })])).errors[0].msg, /source\.path does not exist/);
  assert.match(run(reg([risk({ source: { path: 'docs/src.md', anchor: 'invented risk' } })])).errors[0].msg, /anchor not found/);
  assert.match(run(reg([risk({ controls: [{ description: 'ghost control', status: 'documented', ref: 'docs/ghost.md' }] })])).errors[0].msg, /ref does not exist/);
  assert.match(run(reg([risk({ related_sources: [{ path: 'docs/src.md', anchor: 'zzz' }] })])).errors[0].msg, /related_sources\[0\]\.anchor not found/);
});

test('path traversal and absolute paths in source/ref are rejected', () => {
  assert.ok(run(reg([risk({ source: { path: '../etc/passwd', anchor: 'root' } })])).errors.length > 0);
  assert.ok(run(reg([risk({ source: { path: '/etc/passwd', anchor: 'root' } })])).errors.length > 0);
  assert.ok(run(reg([risk({ controls: [{ description: 'escape attempt', status: 'gap', ref: '../x' }] })])).errors.length > 0);
});

test('structure errors: id format, duplicates, enums, scores, dates, owner area', () => {
  const bad = (o) => run(reg([risk(o)])).errors.map((e) => e.msg).join(' | ');
  assert.match(bad({ id: 'R1' }), /id must look like/);
  assert.match(run(reg([risk(), risk()])).errors.map((e) => e.msg).join('|'), /duplicate id/);
  assert.match(bad({ category: 'misc' }), /category must be/);
  assert.match(bad({ status: 'done' }), /status must be/);
  assert.match(bad({ likelihood: 0 }), /likelihood must be/);
  assert.match(bad({ impact: 6 }), /impact must be/);
  assert.match(bad({ impact: 2.5 }), /impact must be/);
  assert.match(bad({ last_reviewed: '31/01/2027' }), /last_reviewed must be/);
  assert.match(bad({ last_reviewed: '2027-03-01' }), /in the future/);
  assert.match(bad({ owner: { area: 'marketing', person: null } }), /owner\.area must be/);
  assert.match(bad({ owner: { area: 'security', person: ' ' } }), /owner\.person/);
  assert.match(bad({ review_interval_days: 0 }), /review_interval_days/);
  assert.match(bad({ controls: [{ description: 'x', status: 'gap' }] }), /description is required/);
  assert.match(bad({ controls: [{ description: 'valid text', status: 'done' }] }), /status must be/);
});

test('register-level errors: wrong schema, bad default interval, empty risks, non-object', () => {
  assert.ok(run(reg([risk()], { schema: 'v0' })).errors.length > 0);
  assert.ok(run(reg([risk()], { review: { default_interval_days: 0 } })).errors.length > 0);
  assert.ok(run(reg([])).errors.length > 0);
  assert.equal(run('nope').errors.length, 1);
});

test('area vocabulary matches docs/OWNERS.md', () => {
  const owners = readFileSync(join(ROOT, 'docs/OWNERS.md'), 'utf8').toLowerCase();
  for (const a of AREAS) assert.ok(owners.includes(`| ${a} |`), `${a} missing from OWNERS.md`);
});

test('the real register is structurally valid and fully traceable to repo documents', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'docs/compliance/risk-register.json'), 'utf8'));
  const out = evaluate(real, { today: TODAY, root: ROOT });
  assert.deepEqual(out.errors, []);
  assert.ok(out.risks >= 30);
});

test('the real register invents nothing: no scores, no review dates, no named owners were seeded', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'docs/compliance/risk-register.json'), 'utf8'));
  for (const r of real.risks) {
    assert.equal(r.likelihood, null, r.id);
    assert.equal(r.impact, null, r.id);
    assert.equal(r.last_reviewed, null, r.id);
    assert.equal(r.owner.person, null, r.id);
    assert.ok(r.source.anchor.length > 0);
  }
  assert.equal(new Set(real.risks.map((r) => r.id)).size, real.risks.length);
});

test('CLI exit codes: default 0 with findings, --strict 1, errors 1, bad usage 2; --json is parseable', () => {
  const sh = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', cwd: ROOT });
  assert.equal(sh('--today', '2027-01-31').status, 0);
  assert.equal(sh('--strict', '--today', '2027-01-31').status, 1);
  assert.equal(sh('--bogus').status, 2);
  assert.equal(sh('--today', '2027-13-01').status, 2);
  assert.equal(sh('--file', 'docs/compliance/does-not-exist.json').status, 1);
  const j = JSON.parse(sh('--json', '--today', '2027-01-31').stdout);
  assert.equal(j.errors.length, 0);
  assert.equal(j.summary.never_reviewed, j.risks);
  const out = sh('--today', '2027-01-31').stdout;
  assert.match(out, /never_reviewed: \d+ risk\(s\)/);
  assert.ok(out.split('\n').length < 12, 'default output stays short');
});
