// node --test scripts/supply-chain/sbom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBom, nameFromPath, purl, sriToHashes, deterministicSerial } from './sbom.mjs';

const NOW = new Date('2026-01-01T00:00:00Z');
const lock = {
  name: 'app', version: '1.2.3', lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.2.3', dependencies: { a: '^1', '@s/b': '^2' }, devDependencies: { d: '^1' } },
    'node_modules/a': { version: '1.0.0', resolved: 'https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-AAAA', license: 'MIT', dependencies: { c: '^1' } },
    'node_modules/a/node_modules/c': { version: '1.1.0', license: '(MIT OR Apache-2.0)' },
    'node_modules/c': { version: '2.0.0' },
    'node_modules/@s/b': { version: '2.0.0', optional: true, hasInstallScript: true },
    'node_modules/d': { version: '1.0.0', dev: true },
    'node_modules/ws': { resolved: 'packages/ws', link: true },
  },
};

test('path/purl helpers', () => {
  assert.equal(nameFromPath('node_modules/a/node_modules/@s/b'), '@s/b');
  assert.equal(purl('@s/b', '1.0.0'), 'pkg:npm/%40s/b@1.0.0');
});

test('SRI -> hex hashes; garbage ignored', () => {
  assert.deepEqual(sriToHashes('sha1-AAAA'), [{ alg: 'SHA-1', content: '000000' }]);
  assert.deepEqual(sriToHashes('md5-xx not-valid'), []);
  assert.deepEqual(sriToHashes(undefined), []);
});

test('builds components, scopes, nested versions, skips links', () => {
  const { bom, stats } = buildBom(lock, { now: NOW, serialNumber: 'urn:uuid:x' });
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  assert.equal(stats.skipped.link, 1);
  const refs = bom.components.map((c) => c['bom-ref']);
  assert.ok(refs.includes('pkg:npm/c@1.1.0') && refs.includes('pkg:npm/c@2.0.0'));
  const b = bom.components.find((c) => c.name === 'b');
  assert.equal(b.group, '@s');
  assert.equal(b.scope, 'optional');
  assert.ok(b.properties.some((p) => p.name === 'cdx:npm:package:has-install-script'));
  const a = bom.components.find((c) => c.name === 'a');
  assert.deepEqual(a.licenses, [{ license: { id: 'MIT' } }]);
  assert.deepEqual(bom.components.find((c) => c.version === '1.1.0').licenses, [{ expression: '(MIT OR Apache-2.0)' }]);
});

test('registry credentials are stripped from URLs', () => {
  const { bom } = buildBom(lock, { now: NOW });
  const a = bom.components.find((c) => c.name === 'a');
  assert.ok(!JSON.stringify(a).includes('pw'));
  assert.ok(!JSON.stringify(a).includes('user:'));
});

test('dependency graph resolves nested before hoisted; no dangling refs', () => {
  const { bom } = buildBom(lock, { now: NOW });
  const all = new Set([...bom.components.map((c) => c['bom-ref']), bom.metadata.component['bom-ref']]);
  for (const d of bom.dependencies) {
    assert.ok(all.has(d.ref));
    for (const x of d.dependsOn) assert.ok(all.has(x), `dangling ${x}`);
  }
  assert.deepEqual(bom.dependencies.find((d) => d.ref === 'pkg:npm/a@1.0.0').dependsOn, ['pkg:npm/c@1.1.0']);
});

test('--omit-dev drops dev packages and their edges', () => {
  const { bom } = buildBom(lock, { now: NOW, omitDev: true });
  assert.ok(!bom.components.some((c) => c.name === 'd'));
  assert.ok(!JSON.stringify(bom.dependencies).includes('pkg:npm/d@'));
});

test('deterministic output for identical input', () => {
  const o = { now: NOW, serialNumber: deterministicSerial(JSON.stringify(lock)) };
  assert.equal(JSON.stringify(buildBom(lock, o).bom), JSON.stringify(buildBom(lock, o).bom));
  assert.match(o.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
});

test('rejects unsupported lockfiles (v1 has no packages map)', () => {
  assert.throws(() => buildBom({ lockfileVersion: 1, dependencies: {} }), /Unsupported lockfile/);
  assert.throws(() => buildBom(null), /Unsupported lockfile/);
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBom } from './sbom.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'sbom.mjs');
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

test('verifyBom accepts a built BOM and flags corruption', () => {
  const { bom } = buildBom(lock, { now: NOW });
  assert.deepEqual(verifyBom(bom), []);
  const bad = structuredClone(bom);
  bad.dependencies[0].dependsOn.push('pkg:npm/ghost@9.9.9');
  assert.match(verifyBom(bad).join(), /dangling/);
  assert.ok(verifyBom({}).length > 0);
});

test('CLI: generate, verify, and failure exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-'));
  const lockFile = join(dir, 'package-lock.json');
  const out = join(dir, 'out', 'bom.json');
  writeFileSync(lockFile, JSON.stringify(lock));
  assert.equal(run('--lock', lockFile, '--out', out).status, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).bomFormat, 'CycloneDX');
  assert.equal(run('--verify', out).status, 0);
  assert.equal(run('--lock', join(dir, 'missing.json')).status, 1);
  writeFileSync(lockFile, '{ not json');
  assert.equal(run('--lock', lockFile).status, 1);
  assert.equal(run('--bogus').status, 2);
  writeFileSync(out, '{}');
  assert.equal(run('--verify', out).status, 1);
});
