// node --test scripts/security/crypto-inventory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RULES, DATA_CLASSES, ROADMAP, OUT_MD, OUT_JSON,
  classifyPath, shouldScan, isCommentLine, scanText, scanFiles, buildInventory, renderMarkdown, renderJson, run, ownershipFor,
} from './crypto-inventory.mjs';

const hit = (id, line) => RULES.find((r) => r.id === id).re.test(line);

test('rule table is well formed', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of RULES) {
    assert.ok(r.re instanceof RegExp && r.name && r.family);
    assert.ok(['vulnerable', 'weakened', 'adequate', 'n/a'].includes(r.quantum), r.id);
    assert.ok(['critical', 'review', 'info'].includes(r.severity), r.id);
    assert.equal(r.re.global, false, `${r.id}: global regex makes .test() stateful`);
  }
});

test('public-key rules match real usages', () => {
  assert.ok(hit('jwt-rs', 'const header = { alg: "RS256", typ: "JWT" }'));
  assert.ok(hit('jwt-es', "alg: 'ES256'"));
  assert.ok(hit('jwt-ps', "alg === 'PS256'"));
  assert.ok(hit('eddsa', 'importKey("raw", raw, { name: "Ed25519" }, false, ["verify"])'));
  assert.ok(hit('webcrypto-rsa', '{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }'));
  assert.ok(hit('ecdsa', '{ name: "ECDSA", namedCurve: "P-256" }'));
  assert.ok(hit('ec-curve', 'namedCurve: "P-256"'));
  assert.ok(hit('ecdh', 'crypto.createECDH("prime256v1")'));
  assert.ok(hit('pkcs7', 'const p7 = forge.pkcs7.createSignedData();'));
  assert.ok(hit('node-asym', 'const s = createSign("SHA256");'));
});

test('rules do not fire on look-alikes', () => {
  assert.equal(hit('jwt-es', 'x-amz-server-side-encryption: "AES256"'), false);
  assert.equal(hit('jwt-rs', 'const PARS256 = 1'), false);
  assert.equal(hit('jwt-es', 'MODES256'), false);
  assert.equal(hit('md5', 'const cmd5x = 1'), false);
  assert.equal(hit('aes-128', 'length: 128'), false);
  assert.equal(hit('broken-cipher', 'DESCRIPTION of the DESIGN'), false);
  assert.equal(hit('ec-curve', 'const P_256 = 3'), false);
});

test('symmetric, legacy and TLS rules', () => {
  assert.ok(hit('aes-gcm', "{ name: 'AES-GCM', iv }"));
  assert.ok(hit('aes-256', "const SEAL_ALG = 'AES-256-GCM'"));
  assert.ok(hit('aes-128', 'KeySpec: "AES_128"') || hit('aes-128', 'AES-128-GCM'));
  assert.ok(hit('hmac', 'crypto.subtle.sign("HMAC", k, d)'));
  assert.ok(hit('sha1', 'crypto.subtle.digest("SHA-1", data)'));
  assert.ok(hit('md5', 'v_hash := md5(v_uid::text)'));
  assert.ok(hit('broken-cipher', "createCipheriv('aes-128-ecb', k, null)"));
  assert.ok(hit('broken-cipher', 'cipher = "3DES"'));
  assert.ok(hit('tls-verify-off', 'ssl: { rejectUnauthorized: false }'));
  assert.ok(hit('tls-verify-off', 'NODE_TLS_REJECT_UNAUTHORIZED=0'));
  assert.ok(hit('tls-old', "minVersion: 'TLSv1'"));
  assert.equal(hit('tls-old', "minVersion: 'TLSv1.2'"), false);
  assert.ok(hit('tls-config', "ssl: { rejectUnauthorized: true, servername: h }"));
  assert.ok(hit('hsts', '{ "key": "Strict-Transport-Security" }'));
  assert.ok(hit('cleartext', 'android:usesCleartextTraffic="true"'));
});

test('path classification and scan filter', () => {
  assert.equal(classifyPath('src/lib/foo.test.ts'), 'test');
  assert.equal(classifyPath('supabase/functions/_shared/wallet/crypto_test.ts'), 'test');
  assert.equal(classifyPath('e2e/a.spec.ts'), 'test');
  assert.equal(classifyPath('supabase/migrations/1_a.sql'), 'sql');
  assert.equal(classifyPath('scripts/x.mjs'), 'tooling');
  assert.equal(classifyPath('vercel.json'), 'config');
  assert.equal(classifyPath('supabase/functions/a/index.ts'), 'production');
  assert.equal(shouldScan('src/a.ts', 10), true);
  assert.equal(shouldScan('node_modules/x/a.ts', 10), false);
  assert.equal(shouldScan('docs/security/x.json', 10), false);
  assert.equal(shouldScan('chmod +x scripts/a.mjs', 10), false);
  assert.equal(shouldScan('scripts/security/crypto-inventory.mjs', 10), false);
  assert.equal(shouldScan('src/a.md', 10), false);
  assert.equal(shouldScan('src/big.ts', 5_000_000), false);
  assert.equal(shouldScan('package-lock.json', 10), false);
});

test('comment detection per language', () => {
  assert.equal(isCommentLine('  // RS256 here', 'a.ts'), true);
  assert.equal(isCommentLine(' * ES256', 'a.ts'), true);
  assert.equal(isCommentLine('-- md5 note', 'a.sql'), true);
  assert.equal(isCommentLine('v := md5(x);', 'a.sql'), false);
  assert.equal(isCommentLine('# sslmode=require', 'a.toml'), true);
  assert.equal(isCommentLine('"alg": "RS256"', 'a.json'), false);
  assert.equal(isCommentLine('const a = 1; // RS256', 'a.ts'), false);
});

test('scanText separates uses, mentions and test files', () => {
  const src = ['// we sign with RS256', 'const alg = "RS256";'].join('\n');
  const prod = scanText('supabase/functions/x/a.ts', src);
  assert.deepEqual(prod.hits.map((h) => [h.rule, h.line, h.usage]), [['jwt-rs', 1, 'mention'], ['jwt-rs', 2, 'use']]);
  assert.equal(scanText('src/a.test.ts', src).kind, 'test');
});

test('scanText skips huge lines (minified blobs)', () => {
  assert.equal(scanText('src/a.ts', 'RS256 ' + 'x'.repeat(700)).hits.length, 0);
});

function inventoryOf(files) {
  return buildInventory(scanFiles('/virtual', Object.keys(files), (p) => files[p]));
}

test('inventory counts quantum-vulnerable uses, excluding comments and tests', () => {
  const inv = inventoryOf({
    'supabase/functions/_shared/notify/fcm.ts': 'const h = { alg: "RS256" };\nawait crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, d);',
    'supabase/functions/_shared/notify/apns.ts': '// ES256 note\nconst a = { alg: "ES256" };',
    'src/a.test.ts': 'alg: "RS256"',
  });
  assert.equal(inv.summary.quantumVulnerablePublicKeyUses, 3);
  assert.deepEqual(inv.summary.quantumVulnerableAlgorithms, ['jwt-es', 'jwt-rs', 'webcrypto-rsa']);
  const rs = inv.algorithms.find((a) => a.id === 'jwt-rs');
  assert.equal(rs.uses, 1);
  assert.equal(rs.testReferences, 1);
  assert.equal(rs.files[0].owner, 'vendor-dictated');
  assert.equal(inv.algorithms.find((a) => a.id === 'jwt-es').mentions, 1);
});

test('critical findings are counted; legacy hashes are review, not critical', () => {
  const inv = inventoryOf({
    'src/db.ts': 'const o = { ssl: { rejectUnauthorized: false } };',
    'supabase/migrations/1_a.sql': 'v := md5(x);',
  });
  assert.equal(inv.summary.criticalFindings, 1);
  assert.equal(inv.summary.reviewFindings, 1);
});

test('wallet pass signing is grouped by path', () => {
  const inv = inventoryOf({
    'supabase/functions/_shared/wallet/applePkpass.ts': 'forge.pkcs7.createSignedData();\ndigest("SHA-1", d);',
    'src/other.ts': 'alg: "RS256"',
  });
  assert.equal(inv.walletPassSigning.length, 1);
  assert.deepEqual(inv.walletPassSigning[0].algorithms, ['pkcs7', 'sha1']);
  assert.equal(inv.walletPassSigning[0].owner, 'vendor-dictated');
});

test('data classes: evidence found, absent classes flagged, no borrowed encryption evidence', () => {
  const inv = inventoryOf({
    'supabase/migrations/1_a.sql': 'ALTER TABLE calls ADD COLUMN recording_url text;',
    'src/lib/trustPack/envelope.ts': "const SEAL_ALG = 'AES-256-GCM'; crypto.subtle.encrypt({ name: 'AES-GCM' }, k, d);",
    'scripts/x.mjs': 'const t = "exit_dataroom_links";',
  });
  const by = Object.fromEntries(inv.longLivedConfidentialData.map((c) => [c.id, c]));
  assert.equal(by['call-recordings'].evidenceFound, true);
  assert.equal(by['call-recordings'].applicationLayerEncryptionEvidenced, false);
  assert.equal(by['trust-pack'].applicationLayerEncryptionEvidenced, true);
  assert.equal(by['data-room'].evidenceFound, false, 'tooling files are not evidence');
  assert.equal(by['voice-clone'].evidenceFound, false);
  assert.equal(inv.longLivedConfidentialData.length, DATA_CLASSES.length);
});

test('every data class evidence regex is non-global', () => {
  for (const c of DATA_CLASSES) assert.equal(c.evidence.global, false, c.id);
});

test('ownership inference', () => {
  assert.equal(ownershipFor('supabase/functions/_shared/consumer-agent/security.ts').owner, 'vireek-defined');
  assert.equal(ownershipFor('supabase/functions/_shared/bank/plaid.ts').owner, 'vendor-dictated');
  assert.equal(ownershipFor('src/new.ts').owner, 'unassigned');
});

test('output is deterministic, has the required sections and no timestamps', () => {
  const files = { 'supabase/functions/_shared/notify/fcm.ts': 'alg: "RS256"', 'src/x.ts': 'AES-GCM' };
  const a = inventoryOf(files);
  const b = inventoryOf({ 'src/x.ts': files['src/x.ts'], 'supabase/functions/_shared/notify/fcm.ts': files['supabase/functions/_shared/notify/fcm.ts'] });
  assert.equal(renderMarkdown(a), renderMarkdown(b));
  assert.equal(renderJson(a), renderJson(b));
  const md = renderMarkdown(a);
  for (const h of ['## Summary', '## Quantum-vulnerable public-key uses', '## TLS', '## Wallet pass signing', '## Long-lived confidential data', '## Migration roadmap', '## Limitations']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('Call recordings') && md.includes('data room'.slice(0, 4)) || md.includes('Exit data room'));
  assert.equal(/\b20\d\d-\d\d-\d\dT/.test(md + renderJson(a)), false, 'no generated timestamps');
  assert.equal(JSON.parse(renderJson(a)).schemaVersion, 1);
});

test('roadmap never invents dates', () => {
  for (const p of ROADMAP.phases) assert.ok(p.target.includes('[VERIFY'), `phase ${p.phase}`);
  assert.ok(ROADMAP.note.includes('[VERIFY dates]'));
  for (const s of ROADMAP.standards) assert.ok(s.includes('[VERIFY'));
});

test('CLI: --write then --check passes; stale docs and critical findings fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'cryptoinv-'));
  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'const alg = "ES256";\n');
    assert.equal(run(['--root', root, '--write']), 0);
    assert.ok(readFileSync(join(root, OUT_MD), 'utf8').includes('# Cryptographic inventory'));
    assert.ok(JSON.parse(readFileSync(join(root, OUT_JSON), 'utf8')).summary.quantumVulnerablePublicKeyUses === 1);
    assert.equal(run(['--root', root, '--check']), 0);

    writeFileSync(join(root, 'src/b.ts'), 'const k = "RS256";\n');
    assert.equal(run(['--root', root, '--check']), 1, 'stale after a new use');

    assert.equal(run(['--root', root, '--write']), 0);
    writeFileSync(join(root, 'src/c.ts'), 'const o = { rejectUnauthorized: false };\n');
    assert.equal(run(['--root', root, '--write']), 0);
    assert.equal(run(['--root', root, '--check']), 1, 'critical finding fails even with current docs');
  } finally {
    console.log = origLog; console.error = origErr;
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --check fails when docs were never generated', () => {
  const root = mkdtempSync(join(tmpdir(), 'cryptoinv-'));
  const e = console.error, l = console.log;
  console.log = () => {}; console.error = () => {};
  try { assert.equal(run(['--root', root, '--check']), 1); } finally { console.log = l; console.error = e; rmSync(root, { recursive: true, force: true }); }
});
