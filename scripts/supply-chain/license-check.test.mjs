// node --test scripts/supply-chain/license-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpdx, evaluate, makeClassifier, validatePolicy, run } from './license-check.mjs';

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const realPolicy = JSON.parse(fs.readFileSync(path.join(realRoot, 'config', 'license-policy.json'), 'utf8'));
const cls = makeClassifier(realPolicy);
const ev = (s) => evaluate(parseSpdx(s), cls);

test('SPDX: simple allow / deny / review / unknown', () => {
  assert.equal(ev('MIT').status, 'allow');
  assert.equal(ev('mit').status, 'allow', 'case-insensitive');
  assert.equal(ev('GPL-3.0-only').status, 'deny');
  assert.equal(ev('AGPL-3.0-or-later').status, 'deny');
  assert.equal(ev('LGPL-3.0-only').status, 'review', 'GPL-* must not swallow LGPL-*');
  assert.equal(ev('MPL-2.0').status, 'review');
  assert.equal(ev('Acme-Proprietary-1.0').status, 'unknown');
  assert.equal(ev('UNLICENSED').status, 'deny');
  assert.equal(ev('').status, 'unknown');
});

test('SPDX: OR picks the best alternative, AND the worst', () => {
  assert.deepEqual(ev('(MIT OR GPL-3.0-or-later)'), { status: 'allow', elected: 'MIT' });
  assert.equal(ev('(MPL-2.0 OR Apache-2.0)').elected, 'Apache-2.0');
  assert.equal(ev('(MIT AND Zlib)').status, 'allow');
  assert.equal(ev('(MIT AND GPL-2.0-only)').status, 'deny');
  assert.equal(ev('GPL-2.0-only OR GPL-3.0-only').status, 'deny');
  assert.equal(ev('MIT OR (GPL-3.0-only AND Apache-2.0)').elected, 'MIT');
});

test('SPDX: aliases, WITH, SEE LICENSE IN, malformed input', () => {
  assert.equal(ev('MIT/X11').status, 'allow');
  assert.equal(ev('MIT OR SEE LICENSE IN FEEL-FREE.md').status, 'allow');
  assert.equal(ev('SEE LICENSE IN LICENSE.txt').status, 'unknown', 'a bare custom licence needs a human');
  assert.equal(ev('GPL-2.0-only WITH Classpath-exception-2.0').status, 'deny', 'WITH never improves a status');
  assert.equal(ev('(MIT OR').status, 'unknown', 'unparseable => opaque id => unknown');
});

test('policy validation rejects overlaps and incomplete waivers', () => {
  assert.ok(validatePolicy({ allow: ['MIT'], review: [], deny: ['MIT'] }).length > 0);
  assert.ok(validatePolicy({ allow: [], review: [], deny: [], waivers: [{ name: 'x' }] }).length > 0);
  assert.ok(validatePolicy({ allow: [], review: [], deny: [], waivers: [{ name: 'x', reason: 'r', approvedBy: 'a', expires: 'nonsense' }] }).length > 0);
  assert.deepEqual(validatePolicy(realPolicy), []);
});

// ------------------------------------------------------- integration ---
function fixture({ packages, policy = realPolicy, functions = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'license-policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }));
  for (const [rel, src] of Object.entries(functions)) {
    const f = path.join(dir, 'supabase', 'functions', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  return dir;
}
const go = (dir, args = [], now) => {
  let out = ''; let err = '';
  const code = run(['--root', dir, ...args], { stdout: (s) => (out += s), stderr: (s) => (err += s), now });
  return { code, out, err };
};
const pk = (name, version, license, extra = {}) => ({ [`node_modules/${name}`]: { version, license, ...extra } });

test('passes on permissive production deps', () => {
  const d = fixture({ packages: { ...pk('a', '1.0.0', 'MIT'), ...pk('b', '2.0.0', '(MIT OR GPL-3.0-or-later)') } });
  assert.equal(go(d).code, 0);
});

test('fails on a denied production licence', () => {
  const d = fixture({ packages: pk('gpl-lib', '1.0.0', 'GPL-3.0-only') });
  const r = go(d);
  assert.equal(r.code, 1);
  assert.match(r.err, /gpl-lib@1\.0\.0 — denied licence GPL-3\.0-only/);
});

test('fails on unknown and on missing licences', () => {
  assert.equal(go(fixture({ packages: pk('x', '1.0.0', 'Weird-1.0') })).code, 1);
  const r = go(fixture({ packages: pk('y', '1.0.0', undefined) }));
  assert.equal(r.code, 1);
  assert.match(r.err, /no licence declared/);
});

test('dev-only dependencies are ignored unless --include-dev', () => {
  const d = fixture({ packages: { ...pk('ok', '1.0.0', 'MIT'), ...pk('devgpl', '1.0.0', 'GPL-3.0-only', { dev: true }) } });
  assert.equal(go(d).code, 0);
  assert.equal(go(d, ['--include-dev']).code, 1);
});

test('devOptional / optional / peer entries count as production', () => {
  assert.equal(go(fixture({ packages: pk('o', '1.0.0', 'GPL-3.0-only', { optional: true }) })).code, 1);
  assert.equal(go(fixture({ packages: pk('d', '1.0.0', 'GPL-3.0-only', { devOptional: true }) })).code, 1);
});

test('nested duplicates are de-duplicated by name@version and the scoped name is derived from the last node_modules segment', () => {
  const d = fixture({ packages: { 'node_modules/a/node_modules/@s/b': { version: '1.0.0', license: 'GPL-2.0-only' } } });
  assert.match(go(d).err, /@s\/b@1\.0\.0/);
});

test('review licence needs a waiver; waiver passes until it expires; deny is never waivable', () => {
  const base = { ...realPolicy, waivers: [] };
  const lock = pk('mpl', '1.2.3', 'MPL-2.0');
  assert.equal(go(fixture({ packages: lock, policy: base })).code, 1);

  const waiver = { name: 'mpl', version: '1.2.3', reason: 'unmodified', approvedBy: 'counsel', expires: '2030-01-01' };
  const withW = { ...realPolicy, waivers: [waiver] };
  const ok = go(fixture({ packages: lock, policy: withW }), [], new Date('2029-12-31T00:00:00Z'));
  assert.equal(ok.code, 0);
  assert.match(ok.err, /WAIVED/);

  const expired = go(fixture({ packages: lock, policy: withW }), [], new Date('2030-01-02T00:00:00Z'));
  assert.equal(expired.code, 1);
  assert.match(expired.err, /waiver expired on 2030-01-01/);

  const gplWaiver = { ...waiver, name: 'g' };
  assert.equal(go(fixture({ packages: pk('g', '1.2.3', 'GPL-3.0-only'), policy: { ...realPolicy, waivers: [gplWaiver] } })).code, 1);

  const otherVersion = { ...waiver, version: '9.9.9' };
  assert.equal(go(fixture({ packages: lock, policy: { ...realPolicy, waivers: [otherVersion] } })).code, 1, 'waiver is version-scoped');
});

test('edge-function imports are scanned; unresolved fails; manual entry passes but is [VERIFY]; --strict-verify fails it', () => {
  const functions = {
    'a/index.ts': 'import { x } from "npm:left-pad@1.3.0";\nimport y from "https://esm.sh/foo@2/bar";',
    'a/index.test.ts': 'import z from "npm:only-in-tests@1";',
    '_shared/b.ts': 'const m = await import("npm:@scope/pkg@3.1.0/sub");',
  };
  const d = fixture({ packages: pk('keep', '1.0.0', 'MIT'), functions });
  const r = go(d);
  assert.equal(r.code, 1);
  assert.match(r.err, /npm:left-pad@1\.3\.0 — no licence declared/);
  assert.match(r.err, /npm:@scope\/pkg@3\.1\.0/);
  assert.match(r.err, /https:\/\/esm\.sh\/foo/);
  assert.doesNotMatch(r.err, /only-in-tests/, 'test files are not production code');

  const policy = { ...realPolicy, externalImports: {
    'npm:left-pad': { license: 'MIT', verified: false },
    'npm:@scope/pkg': { license: 'Apache-2.0', verified: true },
    'https://esm.sh/foo': { license: 'ISC', verified: false } } };
  const d2 = fixture({ packages: pk('keep', '1.0.0', 'MIT'), functions, policy });
  const ok = go(d2);
  assert.equal(ok.code, 0);
  assert.match(ok.err, /\[VERIFY\] npm:left-pad/);
  assert.doesNotMatch(ok.err, /\[VERIFY\] npm:@scope/);
  assert.equal(go(d2, ['--strict-verify']).code, 1);
});

test('edge import resolves from the lockfile when the same package is installed', () => {
  const d = fixture({ packages: pk('qrcode', '1.5.4', 'MIT'), functions: { 'q/index.ts': 'import q from "npm:qrcode@1.5.3";' } });
  assert.equal(go(d).code, 0);
});

test('notices: write is deterministic, check detects staleness', () => {
  const d = fixture({ packages: { ...pk('b', '1.0.0', 'MIT'), ...pk('a', '1.0.0', 'ISC') } });
  assert.equal(go(d, ['--check-notices']).code, 1, 'missing file is stale');
  assert.equal(go(d, ['--write-notices']).code, 0);
  const first = fs.readFileSync(path.join(d, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.equal(go(d, ['--write-notices']).code, 0);
  assert.equal(fs.readFileSync(path.join(d, 'THIRD_PARTY_NOTICES.md'), 'utf8'), first, 'deterministic');
  assert.ok(first.indexOf('| a |') < first.indexOf('| b |'), 'sorted by name');
  assert.equal(go(d, ['--check-notices']).code, 0);
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pk('c', '1.0.0', 'MIT') } }));
  assert.equal(go(d, ['--check-notices']).code, 1, 'lockfile change makes notices stale');
});

test('--json output is parseable and mirrors the exit code', () => {
  const d = fixture({ packages: pk('gpl-lib', '1.0.0', 'GPL-3.0-only') });
  const r = go(d, ['--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.problems[0].name, 'gpl-lib');
  assert.equal(r.code, 1);
});

test('usage and configuration errors exit 2', () => {
  assert.equal(go(fixture({ packages: {} }), ['--nope']).code, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  assert.equal(go(empty).code, 2);
  const bad = fixture({ packages: {}, policy: { allow: ['MIT'], review: [], deny: ['MIT'] } });
  assert.equal(go(bad).code, 2);
});

test('the real repository passes and THIRD_PARTY_NOTICES.md is current', { skip: !fs.existsSync(path.join(realRoot, 'package-lock.json')) }, () => {
  const r = go(realRoot, ['--check-notices']);
  assert.equal(r.code, 0, r.err);
});
