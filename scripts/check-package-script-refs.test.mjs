// Run: node --test scripts/check-package-script-refs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, extractRefs, findDuplicateKeys, splitShell, BASELINE_FILE } from './check-package-script-refs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(HERE, 'check-package-script-refs.mjs');

const files = (...present) => (p) => present.includes(p);
const pkgOf = (scripts) => JSON.stringify({ name: 't', scripts }, null, 2);
const targets = (cmd) => extractRefs(cmd).map((r) => `${r.kind}:${r.target}`);

// ---- splitShell ------------------------------------------------------------------------------

test('splitShell: separators, quotes and redirections', () => {
  assert.deepEqual(splitShell('a x && b y || c; d | e'), [['a', 'x'], ['b', 'y'], ['c'], ['d'], ['e']]);
  assert.deepEqual(splitShell(`node -e "console.log('a && b')"`), [['node', '-e', "console.log('a && b')"]]);
  assert.deepEqual(splitShell('node a.mjs > out.txt 2>&1'), [['node', 'a.mjs']]);
  assert.deepEqual(splitShell("echo 'it''s'"), [['echo', 'its']]);
});

// ---- extractRefs -----------------------------------------------------------------------------

test('extractRefs: node entry file, ignoring node flags and script arguments', () => {
  assert.deepEqual(targets('node scripts/a.mjs'), ['node-entry:scripts/a.mjs']);
  assert.deepEqual(targets('node --experimental-strip-types --no-warnings scripts/check-settings-registry.mjs'), [
    'node-entry:scripts/check-settings-registry.mjs',
  ]);
  assert.deepEqual(targets('node scripts/a.mjs --write out/report.json'), ['node-entry:scripts/a.mjs']);
  assert.deepEqual(targets('node ./scripts/a.mjs'), ['node-entry:scripts/a.mjs']);
  assert.deepEqual(targets('FOO=1 node scripts/a.mjs'), ['node-entry:scripts/a.mjs']);
  assert.deepEqual(targets('cross-env FOO=1 node scripts/a.mjs'), ['node-entry:scripts/a.mjs']);
  assert.deepEqual(targets('node --import ./loader.mjs scripts/a.mjs'), ['node-entry:scripts/a.mjs']);
});

test('extractRefs: node --test lists every test file; inline code has no refs', () => {
  assert.deepEqual(targets('node --test a.test.mjs b.test.mjs'), ['file:a.test.mjs', 'file:b.test.mjs']);
  assert.deepEqual(targets('node -e "require(\'./nope.js\')"'), []);
  assert.deepEqual(targets('node --eval "1"'), []);
});

test('extractRefs: && chains and npm run', () => {
  assert.deepEqual(targets('node scripts/a.mjs && vite build && node scripts/b.mjs'), [
    'node-entry:scripts/a.mjs',
    'node-entry:scripts/b.mjs',
  ]);
  assert.deepEqual(targets('npm run a && npm run b -- --flag'), ['npm-script:a', 'npm-script:b']);
  assert.deepEqual(targets('npm run --silent c'), ['npm-script:c']);
});

test('extractRefs: tool config flags and spec files, with no false positives on ports/names', () => {
  assert.deepEqual(targets('vitest run -c vitest.built.config.ts'), ['file:vitest.built.config.ts']);
  assert.deepEqual(targets('vitest run --config=vitest.x.ts'), ['file:vitest.x.ts']);
  assert.deepEqual(targets('tsc --noEmit -p tsconfig.app.json'), ['file:tsconfig.app.json']);
  assert.deepEqual(targets('playwright test e2e/a.spec.ts --project=m-iphone-se --project=m-pixel-7'), ['file:e2e/a.spec.ts']);
  assert.deepEqual(targets('playwright test --project chromium e2e/a.spec.ts'), ['file:e2e/a.spec.ts']);
  assert.deepEqual(targets('stryker run stryker/money.conf.mjs'), ['file:stryker/money.conf.mjs']);
  assert.deepEqual(targets('storybook dev -p 6006'), []);
  assert.deepEqual(targets('vite build --mode home --outDir dist-home'), []);
  assert.deepEqual(targets('prettier --write .'), []);
  assert.deepEqual(targets('vitest run supabase/functions/_shared/vertical-ai'), []);
});

test('extractRefs: shell expansion and URLs are never reported', () => {
  assert.deepEqual(targets('node scripts/$NAME.mjs'), []);
  assert.deepEqual(targets('node --test scripts/*.test.mjs'), []);
  assert.deepEqual(targets('node https://example.com/x.mjs'), []);
});

// ---- findDuplicateKeys -----------------------------------------------------------------------

test('findDuplicateKeys: reports duplicates with path and line, ignores same key in different objects', () => {
  const text = `{
  "scripts": {
    "build": "a",
    "test": "b",
    "build": "c"
  },
  "other": { "build": "x" },
  "list": [ { "k": 1 }, { "k": 2 } ]
}`;
  assert.deepEqual(findDuplicateKeys(text), [{ path: 'scripts', key: 'build', line: 5 }]);
  assert.deepEqual(findDuplicateKeys('{"a":{"b":1},"c":{"b":2}}'), []);
  assert.deepEqual(findDuplicateKeys('{"a\\"b":1,"a\\"b":2}'), [{ path: '(root)', key: 'a"b', line: 1 }]);
});

test('findDuplicateKeys: braces inside strings do not confuse the scanner', () => {
  assert.deepEqual(findDuplicateKeys('{"scripts":{"x":"echo {}","y":"a:b,c","x":"z"}}'), [
    { path: 'scripts', key: 'x', line: 1 },
  ]);
});

// ---- analyze ---------------------------------------------------------------------------------

test('analyze: passes when everything exists', () => {
  const r = analyze({
    pkgText: pkgOf({ a: 'node scripts/a.mjs', b: 'npm run a' }),
    exists: files('scripts/a.mjs'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.broken.length, 0);
});

test('analyze: a missing file fails (the original `sbom` bug)', () => {
  const r = analyze({
    pkgText: pkgOf({ sbom: 'node scripts/supply-chain/sbom.mjs' }),
    exists: files(),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.newBroken, [{ script: 'sbom', kind: 'node-entry', target: 'scripts/supply-chain/sbom.mjs' }]);
});

test('analyze: an undefined `npm run` target fails', () => {
  const r = analyze({ pkgText: pkgOf({ a: 'npm run ghost' }), exists: files() });
  assert.equal(r.ok, false);
  assert.equal(r.newBroken[0].target, 'ghost');
});

test('analyze: duplicate keys fail even when every reference resolves', () => {
  const dup = '{"scripts":{"build":"node a.mjs","build":"node b.mjs"}}';
  const r = analyze({ pkgText: dup, exists: files('a.mjs', 'b.mjs') });
  assert.equal(r.ok, false);
  assert.equal(r.duplicateKeys.length, 1);
});

test('analyze: a node entry resolves like Node does (extensionless / index.js)', () => {
  assert.equal(analyze({ pkgText: pkgOf({ a: 'node scripts/a' }), exists: files('scripts/a.mjs') }).ok, true);
  assert.equal(analyze({ pkgText: pkgOf({ a: 'node scripts' }), exists: files('scripts/index.js') }).ok, true);
});

test('analyze: baseline suppresses known debt, but a NEW break still fails', () => {
  const baseline = [{ script: 'old', file: 'scripts/old.mjs' }];
  const pkgText = pkgOf({ old: 'node scripts/old.mjs', fresh: 'node scripts/fresh.mjs' });
  const r = analyze({ pkgText, exists: files(), baseline });
  assert.equal(r.ok, false);
  assert.deepEqual(r.newBroken.map((b) => b.script), ['fresh']);
  assert.deepEqual(r.baselined.map((b) => b.script), ['old']);
});

test('analyze: a stale baseline entry fails so the ratchet only tightens', () => {
  const baseline = [{ script: 'old', file: 'scripts/old.mjs' }];
  const r = analyze({ pkgText: pkgOf({ old: 'node scripts/old.mjs' }), exists: files('scripts/old.mjs'), baseline });
  assert.equal(r.ok, false);
  assert.equal(r.staleBaseline.length, 1);
});

test('analyze: --strict ignores the baseline', () => {
  const baseline = [{ script: 'old', file: 'scripts/old.mjs' }];
  const r = analyze({ pkgText: pkgOf({ old: 'node scripts/old.mjs' }), exists: files(), baseline, strict: true });
  assert.equal(r.ok, false);
  assert.equal(r.newBroken.length, 1);
});

// ---- CLI -------------------------------------------------------------------------------------

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

function tmpRepo(scripts, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'script-refs-'));
  writeFileSync(path.join(dir, 'package.json'), pkgOf(scripts));
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('CLI: exit 1 and a GitHub error annotation for a missing file', () => {
  const dir = tmpRepo({ sbom: 'node scripts/supply-chain/sbom.mjs' });
  try {
    const r = run(['--root', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error file=package\.json::Script "sbom" references "scripts\/supply-chain\/sbom\.mjs"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: exit 0 when the referenced file exists', () => {
  const dir = tmpRepo({ ok: 'node scripts/ok.mjs' }, { 'scripts/ok.mjs': '' });
  try {
    assert.equal(run(['--root', dir]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --write-baseline then check passes; fixing the file makes the baseline stale (fails)', () => {
  const dir = tmpRepo({ gone: 'node scripts/gone.mjs' });
  try {
    assert.equal(run(['--root', dir, '--write-baseline']).status, 0);
    assert.equal(run(['--root', dir]).status, 0);
    assert.equal(run(['--root', dir, '--strict']).status, 1);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts/gone.mjs'), '');
    const r = run(['--root', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Delete it from the baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --write-baseline keeps existing notes', () => {
  const dir = tmpRepo({ gone: 'node scripts/gone.mjs' });
  try {
    run(['--root', dir, '--write-baseline']);
    const file = path.join(dir, BASELINE_FILE);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entries[0].note = 'my hand-written note';
    writeFileSync(file, JSON.stringify(data));
    run(['--root', dir, '--write-baseline']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[0].note, 'my hand-written note');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a malformed baseline is a hard error, not a silent pass', () => {
  const dir = tmpRepo({ a: 'node a.mjs' }, { 'a.mjs': '', [BASELINE_FILE]: '{"entries":[{"script":1}]}' });
  try {
    assert.notEqual(run(['--root', dir]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- This repository --------------------------------------------------------------------------

test('this repo: package.json passes the check with the committed baseline', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stdout);
});

test('this repo: every baseline entry has a note and points at a really-missing file', () => {
  const { entries } = JSON.parse(readFileSync(path.join(REPO, BASELINE_FILE), 'utf8'));
  for (const e of entries) {
    assert.ok(e.note && e.note.length > 20, `baseline entry ${e.script} needs a real note`);
    assert.equal(existsSync(path.join(REPO, e.file)), false, `${e.file} exists now: remove ${e.script} from the baseline`);
  }
});

test('this repo: package.json has no duplicate keys', () => {
  assert.deepEqual(findDuplicateKeys(readFileSync(path.join(REPO, 'package.json'), 'utf8')), []);
});

test('this repo: esbuild is declared (regression for the phantom dependency)', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(declared.esbuild, 'esbuild must be in package.json: scripts import it directly');
  const lock = JSON.parse(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].devDependencies.esbuild, declared.esbuild, 'package-lock.json root entry must match package.json');
});
