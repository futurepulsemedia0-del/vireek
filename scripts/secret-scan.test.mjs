// node --test scripts/secret-scan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { forbiddenFileName, isTestPath, scanFile, scanText } from './secret-scan.mjs';

const j = (...p) => p.join('');
const jwt = (role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.${'s'.repeat(30)}`;
};

test('detects high-signal secrets and masks the preview', () => {
  const f = scanText(`const k = "${j('sk_li', 've_', 'a1B2c3D4e5F6g7H8i9J0k1L2')}"`);
  assert.equal(f[0].rule, 'stripe-secret-key');
  assert.ok(!f[0].preview.includes('a1B2c3D4e5F6g7H8i9J0'));
});
test('flags service_role JWTs but not anon JWTs', () => {
  assert.equal(scanText(`KEY=${jwt('service_role')}`)[0].rule, 'supabase-service-role-jwt');
  assert.equal(scanText(`KEY=${jwt('anon')}`).length, 0);
});
test('ignores placeholders, env reads and the ignore marker', () => {
  for (const l of ['API_KEY = process.env.API_KEY', 'SECRET="<your-secret-here-0000000000000>"', 'PASSWORD="changeme-changeme-changeme-1"', `x = "${j('AKIA', 'ABCDEFGHIJKLMNOP')}" // secret-scan:ignore`]) {
    assert.equal(scanText(l).length, 0, l);
  }
});
test('forbidden file names', () => {
  assert.ok(forbiddenFileName('.env'));
  assert.ok(forbiddenFileName('apps/x/.env.production'));
  assert.ok(forbiddenFileName('certs/server.pem'));
  assert.ok(forbiddenFileName('id_rsa'));
  assert.equal(forbiddenFileName('.env.example'), null);
  assert.equal(forbiddenFileName('src/lib/env.ts'), null);
});
test('scanFile skips missing, oversized and binary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  assert.deepEqual(scanFile(path.join(dir, 'nope.ts')), []);
  fs.writeFileSync(path.join(dir, 'a.png'), j('AKIA', 'ABCDEFGHIJKLMNOP'));
  assert.deepEqual(scanFile(path.join(dir, 'a.png')), []);
  fs.writeFileSync(path.join(dir, 'b.ts'), `x="${j('AKIA', 'ABCDEFGHIJKLMNOP')}"`);
  assert.equal(scanFile(path.join(dir, 'b.ts'))[0].rule, 'aws-access-key-id');
});
test('CLI exits 1 on a finding, 0 when clean, and --self-test passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const bad = path.join(dir, 'bad.ts');
  const ok = path.join(dir, 'ok.ts');
  fs.writeFileSync(bad, `const k = "${j('sk_li', 've_', 'a1B2c3D4e5F6g7H8i9J0k1L2')}"`);
  fs.writeFileSync(ok, 'export const a = 1;');
  const script = new URL('./secret-scan.mjs', import.meta.url).pathname;
  assert.equal(spawnSync('node', [script, bad]).status, 1);
  assert.equal(spawnSync('node', [script, ok]).status, 0);
  assert.equal(execFileSync('node', [script, '--self-test']).toString().includes('ok'), true);
});

test('test/fixture paths are skipped for content rules but never for forbidden file names', () => {
  assert.equal(isTestPath('src/lib/a.test.ts'), true);
  assert.equal(isTestPath('supabase/tests/database/x.sql'), true);
  assert.equal(isTestPath('src/lib/a.ts'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'k.ts'), `x="${j('AKIA', 'ABCDEFGHIJKLMNOP')}"`);
  assert.deepEqual(scanFile(path.join(dir, 'tests', 'k.ts')), []);
  fs.writeFileSync(path.join(dir, 'tests', '.env'), 'A=1');
  assert.equal(scanFile(path.join(dir, 'tests', '.env'))[0].rule, 'forbidden-file');
});
