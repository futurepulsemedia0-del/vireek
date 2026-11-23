// Run with: node --test scripts/governance/check-codeowners.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRules, patternToRegExp, renderCodeowners, renderDoc, resolveOwner, validateMap } from './ownership-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CHECK = resolve(here, 'check-codeowners.mjs');

const baseMap = (over = {}) => ({
  version: 1,
  enforcePlaceholders: false,
  roles: {
    PLATFORM: { title: 'Platform', primary: '@OWNER_PLATFORM', backup: '@BACKUP_PLATFORM' },
    BACKEND: { title: 'Backend', primary: '@OWNER_BACKEND', backup: '@BACKUP_BACKEND' },
  },
  domains: [
    { id: 'fallback', area: 'Repository', title: 'Fallback', role: 'PLATFORM', paths: ['*'] },
    { id: 'fe', area: 'Frontend', title: 'Frontend', role: 'PLATFORM', paths: ['/src/'] },
    { id: 'fn-core', area: 'Edge functions', title: 'Core', role: 'BACKEND', paths: ['/supabase/functions/'] },
  ],
  ...over,
});

function fixture(map, { stale = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  for (const d of ['docs/governance', '.github', 'supabase/functions/alpha', 'src/pages']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'supabase/functions/alpha/index.ts'), '// fn\n');
  writeFileSync(join(dir, 'src/pages/a.ts'), '// page\n');
  writeFileSync(join(dir, 'docs/governance/ownership-map.json'), JSON.stringify(map));
  writeFileSync(join(dir, '.github/CODEOWNERS'), stale ? '# hand edited\n' : renderCodeowners(map));
  writeFileSync(join(dir, 'docs/governance/service-ownership.md'), renderDoc(map));
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [CHECK, ...args], { cwd: dir, encoding: 'utf8' });
const withFixture = (map, opts, fn) => {
  const dir = fixture(map, opts);
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const filled = () => baseMap({
  roles: {
    PLATFORM: { title: 'Platform', primary: '@alice', backup: '@bob' },
    BACKEND: { title: 'Backend', primary: '@your-org/backend', backup: '@carol' },
  },
});

test('placeholders only warn while enforcePlaceholders is false', () => {
  withFixture(baseMap(), {}, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /::warning::4 placeholder owner/);
  });
});

test('placeholders fail once enforcePlaceholders is true', () => {
  withFixture(baseMap({ enforcePlaceholders: true }), {}, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::4 placeholder owner/);
  });
});

test('--strict fails on placeholders even when the flag is false', () => {
  withFixture(baseMap(), {}, (dir) => assert.equal(run(dir, '--strict').status, 1));
});

test('a fully filled map passes, and asks to lock enforcement', () => {
  withFixture(filled(), {}, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /set "enforcePlaceholders": true/);
  });
});

test('a filled map with enforcement on passes cleanly', () => {
  withFixture({ ...filled(), enforcePlaceholders: true }, {}, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /::warning::/);
  });
});

test('a reintroduced placeholder fails when enforcement is on', () => {
  const map = { ...filled(), enforcePlaceholders: true };
  map.roles.BACKEND.backup = '@BACKUP_BACKEND';
  withFixture(map, {}, (dir) => assert.equal(run(dir).status, 1));
});

test('hand-edited CODEOWNERS is rejected as out of date', () => {
  withFixture(filled(), { stale: true }, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CODEOWNERS is out of date/);
  });
});

test('same primary and backup is rejected unless explicitly allowed', () => {
  const same = filled();
  same.roles.PLATFORM.backup = '@alice';
  withFixture(same, {}, (dir) => {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /primary and backup are the same/);
  });
  const allowed = filled();
  allowed.roles.PLATFORM.backup = '@alice';
  allowed.roles.PLATFORM.allowSamePrimaryBackup = true;
  withFixture(allowed, {}, (dir) => assert.equal(run(dir).status, 0));
});

test('invalid owner syntax and unknown roles are structural errors', () => {
  const bad = baseMap();
  bad.roles.PLATFORM.primary = 'alice smith';
  bad.domains[1].role = 'NOPE';
  const problems = validateMap(bad);
  assert.ok(problems.some((p) => /not a valid GitHub/.test(p)));
  assert.ok(problems.some((p) => /unknown role "NOPE"/.test(p)));
});

test('patterns must be anchored and a fallback must exist', () => {
  const bad = baseMap();
  bad.domains[1].paths = ['src/'];
  bad.domains = bad.domains.filter((d) => d.id !== 'fallback');
  const problems = validateMap(bad);
  assert.ok(problems.some((p) => /must be "\*" or start with "\/"/.test(p)));
  assert.ok(problems.some((p) => /no fallback domain/.test(p)));
});

test('matching follows CODEOWNERS semantics: globs, trailing slash and last match wins', () => {
  assert.ok(patternToRegExp('/supabase/functions/voice-*/').test('/supabase/functions/voice-call/index.ts'));
  assert.ok(!patternToRegExp('/supabase/functions/voice-*/').test('/supabase/functions/voice/index.ts'));
  assert.ok(patternToRegExp('/package.json').test('/package.json'));
  assert.ok(!patternToRegExp('/package.json').test('/package.json.bak'));
  const map = baseMap();
  map.domains.push({ id: 'special', area: 'Edge functions', title: 'Alpha', role: 'PLATFORM', paths: ['/supabase/functions/alpha/'] });
  const rules = buildRules(map);
  assert.equal(resolveOwner(rules, 'supabase/functions/alpha/index.ts').domain, 'special');
  assert.equal(resolveOwner(rules, 'supabase/functions/beta/index.ts').domain, 'fn-core');
  assert.equal(resolveOwner(rules, 'README.md').domain, 'fallback');
});
