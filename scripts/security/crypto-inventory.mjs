#!/usr/bin/env node
// scripts/security/crypto-inventory.mjs
//
// Cryptographic inventory. Statically scans code and config for algorithm use (JWT/WebCrypto/Node/forge/SQL, TLS
// settings, wallet-pass signing), marks quantum-vulnerable public-key uses, lists long-lived confidential data
// classes with the evidence found for them, and emits a migration roadmap.
//
//   node scripts/security/crypto-inventory.mjs            # print summary
//   node scripts/security/crypto-inventory.mjs --write    # write docs/security/crypto-inventory.{md,json}
//   node scripts/security/crypto-inventory.mjs --check    # exit 1 if committed docs are stale OR a critical finding exists
//   options: --root <dir>
//
// Limits (stated in the report too): static regex scan only. It cannot see provider-terminated TLS (Supabase, Vercel,
// Twilio, Vapi...), key sizes held in env/secrets, or what a vendor does server-side. Those are marked [VERIFY].
// Output is deterministic (no timestamps, sorted) so --check is stable.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const OUT_MD = 'docs/security/crypto-inventory.md';
export const OUT_JSON = 'docs/security/crypto-inventory.json';

/* ------------------------------------------------------------------ rules */
// quantum: 'vulnerable' (broken by Shor on a large quantum computer) | 'weakened' (Grover: reduced margin)
//          | 'adequate' (considered adequate at these parameters [VERIFY]) | 'n/a'
// severity: 'critical' (fails --check) | 'review' | 'info'
export const RULES = [
  // ---- public-key signatures / JWT algs
  { id: 'jwt-rs', name: 'RS256/RS384/RS512 (RSASSA-PKCS1-v1_5)', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\bRS(?:256|384|512)\b/ },
  { id: 'jwt-ps', name: 'PS256/PS384/PS512 (RSASSA-PSS)', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\bPS(?:256|384|512)\b/ },
  { id: 'jwt-es', name: 'ES256/ES384/ES512 (ECDSA)', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\bES(?:256|384|512)\b/ },
  { id: 'eddsa', name: 'EdDSA / Ed25519', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\b(?:EdDSA|Ed25519)\b/ },
  { id: 'webcrypto-rsa', name: 'RSA (WebCrypto: RSASSA-PKCS1-v1_5, RSA-PSS, RSA-OAEP)', family: 'public-key signature/encryption', quantum: 'vulnerable', severity: 'info', re: /RSASSA-PKCS1-v1_5|RSA-PSS|RSA-OAEP/ },
  { id: 'ecdsa', name: 'ECDSA', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\bECDSA\b/ },
  { id: 'ecdh', name: 'ECDH / X25519 key agreement', family: 'key agreement', quantum: 'vulnerable', severity: 'info', re: /\b(?:ECDH|X25519|createECDH|createDiffieHellman)\b/ },
  { id: 'ec-curve', name: 'Elliptic curve (P-256/P-384/P-521, secp*)', family: 'public-key', quantum: 'vulnerable', severity: 'info', re: /['"`]P-(?:256|384|521)['"`]|\bprime256v1\b|\bsecp(?:256|384|521)[rk]1\b/ },
  { id: 'forge-rsa', name: 'RSA keys via node-forge', family: 'public-key', quantum: 'vulnerable', severity: 'info', re: /forge\.pki\.(?:rsa|privateKeyFromPem|publicKeyFromPem|certificateFromPem)/ },
  { id: 'pkcs7', name: 'PKCS#7 / CMS signature (wallet pass signing)', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /forge\.pkcs7/ },
  { id: 'node-asym', name: 'Node crypto asymmetric API', family: 'public-key', quantum: 'vulnerable', severity: 'info', re: /\b(?:createSign|createVerify|generateKeyPair(?:Sync)?|publicEncrypt|privateDecrypt)\s*\(/ },
  { id: 'webpush-vapid', name: 'Web Push VAPID (ECDSA P-256 + ECDH)', family: 'public-key signature', quantum: 'vulnerable', severity: 'info', re: /\bVAPID\b|from ['"]web-push['"]/ },
  { id: 'webauthn', name: 'WebAuthn / passkeys (public-key credentials)', family: 'public-key authentication', quantum: 'vulnerable', severity: 'info', re: /navigator\.credentials\.(?:create|get)\b|\bstart(?:Registration|Authentication)\s*\(/ },
  // ---- symmetric / hash / mac / kdf
  { id: 'aes-gcm', name: 'AES-GCM/CBC/CTR/KW', family: 'symmetric encryption', quantum: 'adequate', severity: 'info', re: /\bAES-(?:GCM|CBC|CTR|KW)\b|\baes-(?:128|192|256)-[a-z]+\b/i },
  { id: 'aes-128', name: 'AES-128', family: 'symmetric encryption', quantum: 'weakened', severity: 'review', re: /\bAES[-_]?128\b/ },
  { id: 'aes-256', name: 'AES-256', family: 'symmetric encryption', quantum: 'adequate', severity: 'info', re: /\bAES[-_]?256\b/ },
  { id: 'hmac', name: 'HMAC / HS256', family: 'message authentication', quantum: 'adequate', severity: 'info', re: /\bHMAC\b|\bcreateHmac\b|\bHS(?:256|384|512)\b/ },
  { id: 'sha2', name: 'SHA-256/384/512', family: 'hash', quantum: 'adequate', severity: 'info', re: /\bSHA-?(?:256|384|512)\b|createHash\(\s*['"]sha(?:256|384|512)/i },
  { id: 'kdf', name: 'KDF (PBKDF2/scrypt/argon2/bcrypt/HKDF)', family: 'key derivation', quantum: 'adequate', severity: 'info', re: /\b(?:PBKDF2|scrypt|argon2|bcrypt|HKDF)\b|gen_salt\(/i },
  { id: 'pgcrypto', name: 'pgcrypto (digest/hmac/crypt/pgp_*)', family: 'database crypto', quantum: 'n/a', severity: 'info', re: /\bpgp_(?:sym|pub)_encrypt\b|\bdigest\([^)]*['"](?:sha\d+|md5)['"]\)|\bcrypt\(\s*[^)]*gen_salt/i },
  // ---- weak / legacy
  { id: 'sha1', name: 'SHA-1', family: 'hash (legacy)', quantum: 'n/a', severity: 'review', re: /\bSHA-1\b|\bsha1\b|createHash\(\s*['"]sha1/i },
  { id: 'md5', name: 'MD5', family: 'hash (legacy)', quantum: 'n/a', severity: 'review', re: /\bmd5\s*\(|\bMD5\b|createHash\(\s*['"]md5/i },
  { id: 'broken-cipher', name: 'DES/3DES/RC4/ECB', family: 'broken cipher', quantum: 'n/a', severity: 'critical', re: /\b(?:3DES|DES-EDE3?|RC4|ARCFOUR)\b|\bAES-ECB\b|['"]aes-\d+-ecb['"]/i },
  // ---- TLS
  { id: 'tls-verify-off', name: 'TLS certificate verification disabled', family: 'tls', quantum: 'n/a', severity: 'critical', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0/ },
  { id: 'tls-old', name: 'TLS < 1.2 enabled', family: 'tls', quantum: 'n/a', severity: 'critical', re: /\bTLSv1(?:\.[01])?(?![.\d])|\bSSLv[23]\b/ },
  { id: 'tls-config', name: 'TLS setting (minVersion / ssl mode / verify)', family: 'tls', quantum: 'n/a', severity: 'info', re: /\bminVersion\b|rejectUnauthorized\s*:\s*true|\bsslmode\s*=|\bssl\s*:\s*['"](?:require|verify-full|verify-ca)['"]|ssl\??:\s*['"]require['"]\s*\|/ },
  { id: 'hsts', name: 'HSTS header', family: 'tls', quantum: 'n/a', severity: 'info', re: /Strict-Transport-Security/i },
  { id: 'cleartext', name: 'Cleartext traffic allowed (mobile)', family: 'tls', quantum: 'n/a', severity: 'critical', re: /usesCleartextTraffic\s*=\s*["']?true|cleartext\s*:\s*true|NSAllowsArbitraryLoads/ },
];

// Who decides the algorithm. Inferred from code paths; not a vendor statement. [VERIFY]
export const OWNERSHIP = [
  { re: /notify\/fcm\.ts$/, owner: 'vendor-dictated', note: 'Google service-account JWT (RS256). [VERIFY]' },
  { re: /notify\/apns\.ts$/, owner: 'vendor-dictated', note: 'Apple APNs provider token (ES256). [VERIFY]' },
  { re: /wallet\/googleWallet\.ts$/, owner: 'vendor-dictated', note: 'Google Wallet save-link JWT (RS256). [VERIFY]' },
  { re: /wallet\/applePkpass\.ts$/, owner: 'vendor-dictated', note: 'Apple .pkpass: SHA-1 manifest and PKCS#7 signature with the Pass Type ID certificate. [VERIFY]' },
  { re: /bank\/plaid\.ts$/, owner: 'vendor-dictated', note: 'Verifies Plaid webhook JWT (ES256). [VERIFY]' },
  { re: /(accounting\/netsuite|acct-oauth-start)/, owner: 'customer-chosen', note: 'NetSuite M2M client assertion: ES256 default, PS256 optional.' },
  { re: /consumer-agent\//, owner: 'vireek-defined', note: 'Ed25519 request signing for registered agents; Vireek controls the scheme.' },
  { re: /compliance\/erasureCertificate/, owner: 'vireek-defined', note: 'HMAC-SHA256 (no public-key use).' },
];

/* ------------------------------------------------------------------ data classes */
export const DATA_CLASSES = [
  {
    id: 'call-recordings', name: 'Call recordings and voicemails', kind: 'confidentiality',
    evidence: /\brecording_url\b|\bpbx_recordings\b|\bovb-recordings\b|\bpbx_voicemails\b|\bpbx_recording_grants\b/,
    protectionPath: /^$/, // no class-specific encryption code is known; the scan must not borrow evidence from other classes
    lifetime: 'Per-tenant data_retention_policies.retention_days, which is nullable: no automatic expiry unless the tenant sets one.',
    verify: ['Storage-at-rest encryption is provider-managed and not visible in this repo. [VERIFY]', 'Provider-held copies (Vapi, Twilio) follow provider retention. [VERIFY]', 'Audio objects in Storage are not removed by the erasure job (see delete-account). [VERIFY]'],
  },
  {
    id: 'call-transcripts', name: 'Call transcripts', kind: 'confidentiality',
    evidence: /pii:\s*\[[^\]]*["']transcript["']|\bsealed_transcript|\bconversation_transcripts?\b/,
    protectionPath: /sealed_transcript|transcriptSeal/,
    lifetime: 'Same retention policy mechanism as recordings (nullable retention_days).',
    verify: ['Whether transcripts are sealed per tenant depends on the Trust Pack being enabled. [VERIFY]'],
  },
  {
    id: 'data-room', name: 'Exit data room packages and links', kind: 'confidentiality',
    evidence: /\bexit_dataroom_|\bdata_room_items\b|\bexit-dataroom-public\b/,
    protectionPath: /exit-dataroom-public/,
    lifetime: 'Links carry expires_at (exit_readiness migration); the packages and items behind them have no schema-level expiry.',
    verify: ['The share-link token scheme is not determined by this scan beyond the algorithms listed for it below. [VERIFY]', 'Diligence material is commercially sensitive for years; retention is a business decision. [VERIFY]'],
  },
  {
    id: 'voice-clone', name: 'Voice-clone samples and models', kind: 'confidentiality',
    evidence: /\bcustom_voice_id\b|\bclone-voice\b|\bvoice_clone_consents\b/,
    protectionPath: /^$/,
    lifetime: 'Held at the voice provider until deleted; the erasure job calls the provider delete endpoint. [VERIFY]',
    verify: ['Biometric-adjacent. Provider-side encryption and retention are vendor facts. [VERIFY]'],
  },
  {
    id: 'trust-pack', name: 'Trust Pack sealed tenant data (envelope encryption)', kind: 'confidentiality',
    evidence: /\bSEAL_ALG\b|\bTRUST_TENANT_TABLES\b|GenerateDataKey/,
    protectionPath: /trustPack|trust\/vault/,
    lifetime: 'Until the tenant is erased (eraseTrustPackData).',
    verify: ['Key-wrapping algorithm and key size are decided by the configured KMS, not by this repo. [VERIFY]'],
  },
  {
    id: 'integrity-artefacts', name: 'Long-lived integrity records (audit chain, erasure certificates)', kind: 'integrity',
    evidence: /\baudit_chain_heads\b|\berasure_certificates\b/,
    protectionPath: /audit|erasureCertificate/,
    lifetime: 'Retained as evidence; erasure certificates are append-only.',
    verify: ['Integrity here rests on SHA-256/HMAC. A future switch to public-key signatures would need PQ-capable schemes. [VERIFY]'],
  },
];

/* ------------------------------------------------------------------ roadmap (static; dates are placeholders) */
export const ROADMAP = {
  note: 'Phases are sequencing, not commitments. Every date is a placeholder owned by Security and must be set by a person. [VERIFY dates]',
  standards: [
    'NIST finalized ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205) in 2024. [VERIFY]',
    'NIST IR 8547 proposes deprecating quantum-vulnerable RSA/ECC around 2030 and disallowing them around 2035. [VERIFY dates]',
    'NSA CNSA 2.0 sets its own, earlier timelines for national-security systems. [VERIFY dates]',
  ],
  phases: [
    { phase: 0, name: 'Inventory and ownership', target: '[VERIFY date]', actions: ['Run this scanner in CI (--check) so new public-key use is visible in review.', 'Assign an owner per row in the use table and per data class.', 'Confirm every [VERIFY] item against the live deployment and vendor documentation.'] },
    { phase: 1, name: 'Reduce harvest-now-decrypt-later exposure', target: '[VERIFY date]', actions: ['Set explicit retention_days for call recordings, transcripts and data-room material; decide which have no business reason to outlive 10 years.', 'Ask Supabase, Vercel, Twilio, Vapi and ElevenLabs which TLS key-exchange groups they offer and whether hybrid post-quantum groups are available. [VERIFY vendor facts]', 'Prefer application-layer AES-256-GCM envelope sealing (already used by Trust Pack) for the longest-lived confidential classes.'] },
    { phase: 2, name: 'Crypto agility', target: '[VERIFY date]', actions: ['Put an algorithm identifier and key id in every Vireek-defined signed format (consumer-agent request signing, any new token).', 'Support two verification algorithms side by side so a switch needs no flag day.', 'Keep key material out of code; rotation procedure per key (see key-id rotation in the erasure certificate).'] },
    { phase: 3, name: 'Vireek-defined public-key uses', target: '[VERIFY date]', actions: ['Plan a PQ or hybrid signature for consumer-agent request signing once a standard library is available in the runtime. [VERIFY]', 'Decide whether any new signed artefact needs third-party verifiability. If not, keep HMAC.'] },
    { phase: 4, name: 'Vendor- and customer-dictated uses', target: '[VERIFY date]', actions: ['Track vendor roadmaps for Apple (APNs, .pkpass), Google (FCM, Wallet), Plaid and NetSuite. Vireek cannot move these alone.', 'Record each vendor answer next to its row in this inventory.'] },
    { phase: 5, name: 'Retire classical-only paths', target: '[VERIFY date]', actions: ['Remove RSA/ECC-only code paths that a vendor has replaced.', 'Re-run the inventory and confirm no quantum-vulnerable use is left without a documented exception.'] },
  ],
};

/* ------------------------------------------------------------------ path handling */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.vercel', 'docs', 'knowledge', 'locales', 'i18n', 'Pods', '.gradle', 'generated', 'public', 'assets', '.storybook']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.toml', '.json', '.yml', '.yaml', '.swift', '.kt', '.java', '.gradle', '.xml', '.plist', '.sh']);
const MAX_BYTES = 1_500_000;
const SELF = /scripts\/security\/crypto-inventory/;

export const toPosix = (p) => p.split(sep).join('/');

export function classifyPath(p) {
  if (/\.(test|spec)\.|_test\.|(^|\/)(__tests__|test|tests|e2e|fixtures)\//.test(p)) return 'test';
  if (p.endsWith('.sql')) return 'sql';
  if (/^(scripts|eval|\.github)\//.test(p)) return 'tooling';
  if (/\.(toml|json|ya?ml|xml|plist|gradle)$/.test(p)) return 'config';
  return 'production';
}

export function shouldScan(p, size = 0) {
  const parts = p.split('/');
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d) || d.includes(' '))) return false;
  if (SELF.test(p) || /(^|\/)package-lock\.json$|\.lock$|\.generated\.|\.min\./.test(p)) return false;
  const dot = p.lastIndexOf('.');
  if (dot < 0 || !EXTS.has(p.slice(dot))) return false;
  return size <= MAX_BYTES;
}

export function isCommentLine(line, p) {
  const t = line.trim();
  if (!t) return false;
  if (/\.(json)$/.test(p)) return false;
  if (p.endsWith('.sql')) return t.startsWith('--') || t.startsWith('/*') || t.startsWith('*');
  if (/\.(toml|ya?ml|sh)$/.test(p)) return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

export function ownershipFor(p) {
  const o = OWNERSHIP.find((x) => x.re.test(p));
  return o ? { owner: o.owner, note: o.note } : { owner: 'unassigned', note: '' };
}

/* ------------------------------------------------------------------ scanning */
/** @returns {{ hits: {rule:string,line:number,usage:'use'|'mention'}[], classHits: {cls:string,line:number}[] }} */
export function scanText(path, text, rules = RULES, classes = DATA_CLASSES) {
  const kind = classifyPath(path);
  const hits = [];
  const classHits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 600) continue; // minified / data blobs
    const comment = isCommentLine(line, path);
    for (const r of rules) if (r.re.test(line)) hits.push({ rule: r.id, line: i + 1, usage: comment ? 'mention' : 'use' });
    if (kind !== 'test' && !comment) for (const c of classes) if (c.evidence.test(line)) classHits.push({ cls: c.id, line: i + 1 });
  }
  return { kind, hits, classHits };
}

export function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = toPosix(relative(root, full));
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.includes(' ') || name.startsWith('.') && name !== '.github') continue;
        rec(full);
      } else if (shouldScan(rel, st.size)) out.push(rel);
    }
  };
  rec(root);
  return out;
}

export function scanFiles(root, files = walk(root), read = (p) => readFileSync(join(root, p), 'utf8')) {
  const results = [];
  for (const p of files) {
    let text;
    try { text = read(p); } catch { continue; }
    const r = scanText(p, text);
    if (r.hits.length || r.classHits.length) results.push({ path: p, ...r });
  }
  return { scannedFiles: files.length, results };
}

/* ------------------------------------------------------------------ inventory */
const MAX_FILES_LISTED = 12;
const MAX_LINES_LISTED = 6;

export function buildInventory({ scannedFiles, results }) {
  const byRule = new Map(RULES.map((r) => [r.id, { rule: r, files: new Map(), uses: 0, mentions: 0, testRefs: 0 }]));
  for (const f of results) {
    for (const h of f.hits) {
      const a = byRule.get(h.rule);
      if (f.kind === 'test') { a.testRefs++; continue; }
      if (h.usage === 'mention') { a.mentions++; continue; }
      a.uses++;
      if (!a.files.has(f.path)) a.files.set(f.path, { path: f.path, kind: f.kind, lines: [], ...ownershipFor(f.path) });
      a.files.get(f.path).lines.push(h.line);
    }
  }
  const algorithms = [...byRule.values()]
    .filter((a) => a.uses || a.mentions || a.testRefs)
    .map((a) => {
      const files = [...a.files.values()].sort((x, y) => x.path.localeCompare(y.path));
      return {
        id: a.rule.id, name: a.rule.name, family: a.rule.family, quantum: a.rule.quantum, severity: a.rule.severity,
        uses: a.uses, mentions: a.mentions, testReferences: a.testRefs,
        fileCount: files.length,
        files: files.slice(0, MAX_FILES_LISTED).map((f) => ({ ...f, lines: [...new Set(f.lines)].slice(0, MAX_LINES_LISTED) })),
        filesOmitted: Math.max(0, files.length - MAX_FILES_LISTED),
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id));

  const used = algorithms.filter((a) => a.uses > 0);
  const quantumVulnerable = used.filter((a) => a.quantum === 'vulnerable' && a.family !== 'tls');
  const critical = used.filter((a) => a.severity === 'critical');
  const review = used.filter((a) => a.severity === 'review');

  // wallet pass signing: everything used under a wallet path, regardless of rule
  const wallet = [];
  for (const f of results) {
    if (f.kind === 'test' || !/(^|\/)wallet\//.test(f.path)) continue;
    const ids = [...new Set(f.hits.filter((h) => h.usage === 'use').map((h) => h.rule))].sort();
    if (ids.length) wallet.push({ path: f.path, algorithms: ids, ...ownershipFor(f.path) });
  }
  wallet.sort((a, b) => a.path.localeCompare(b.path));

  const classes = DATA_CLASSES.map((c) => {
    const locs = results.filter((f) => f.kind !== 'tooling' && f.classHits.some((h) => h.cls === c.id)).map((f) => f.path).sort();
    const sealed = results.some((f) => f.kind !== 'test' && c.protectionPath.test(f.path) && f.hits.some((h) => h.usage === 'use' && (h.rule === 'aes-gcm' || h.rule === 'hmac' || h.rule === 'sha2')));
    const aes = results.some((f) => f.kind !== 'test' && c.protectionPath.test(f.path) && f.hits.some((h) => h.usage === 'use' && h.rule === 'aes-gcm'));
    const cryptoInUse = [...new Set(results.filter((f) => f.kind !== 'test' && c.protectionPath.test(f.path)).flatMap((f) => f.hits.filter((h) => h.usage === 'use').map((h) => h.rule)))].sort();
    return {
      id: c.id, name: c.name, kind: c.kind, lifetime: c.lifetime, cryptoInUse,
      evidenceFound: locs.length > 0,
      evidenceFiles: locs.slice(0, 8), evidenceFilesOmitted: Math.max(0, locs.length - 8),
      applicationLayerEncryptionEvidenced: aes,
      symmetricOrHashProtectionEvidenced: sealed,
      harvestNowDecryptLater: c.kind === 'confidentiality' && !aes
        ? 'Relies on transport and provider-managed storage encryption. Public-key key exchange in transit is quantum-vulnerable. [VERIFY]'
        : c.kind === 'confidentiality' ? 'Application-layer AES evidenced in code; transport still uses classical key exchange. [VERIFY]' : 'Integrity, not confidentiality: relevant for signature durability.',
      verify: c.verify,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'scripts/security/crypto-inventory.mjs',
    scan: { filesScanned: scannedFiles, filesWithFindings: results.length },
    summary: {
      algorithmsInUse: used.length,
      quantumVulnerablePublicKeyUses: quantumVulnerable.reduce((n, a) => n + a.uses, 0),
      quantumVulnerableAlgorithms: quantumVulnerable.map((a) => a.id),
      criticalFindings: critical.reduce((n, a) => n + a.uses, 0),
      reviewFindings: review.reduce((n, a) => n + a.uses, 0),
    },
    algorithms,
    walletPassSigning: wallet,
    longLivedConfidentialData: classes,
    roadmap: ROADMAP,
    limitations: [
      'Static regex scan of source and config. It cannot see TLS terminated by providers (Supabase, Vercel, Twilio, Vapi, ElevenLabs), keys held in secrets, or vendor-side behaviour. [VERIFY]',
      'Comment lines are counted as mentions, test files as test references. Neither is counted as a use.',
      'SHA-1 and MD5 hits need a human decision: fingerprinting and deduplication differ from integrity or authentication.',
      'Ownership (vendor-dictated, customer-chosen, Vireek-defined) is inferred from file paths and comments. [VERIFY]',
    ],
  };
}

/* ------------------------------------------------------------------ rendering */
export const renderJson = (inv) => JSON.stringify(inv, null, 2) + '\n';

const esc = (s) => String(s).replace(/\|/g, '\\|');
const QLABEL = { vulnerable: '**QUANTUM-VULNERABLE**', weakened: 'weakened (Grover)', adequate: 'adequate [VERIFY]', 'n/a': 'n/a' };

export function renderMarkdown(inv) {
  const L = [];
  L.push('# Cryptographic inventory', '', '_Generated by `node scripts/security/crypto-inventory.mjs --write`. Do not edit by hand._', '');
  L.push(`Scanned ${inv.scan.filesScanned} files; ${inv.scan.filesWithFindings} contain crypto references.`, '');
  L.push('## Summary', '');
  L.push(`- Algorithms in use: ${inv.summary.algorithmsInUse}`);
  L.push(`- **Quantum-vulnerable public-key uses: ${inv.summary.quantumVulnerablePublicKeyUses}** (${inv.summary.quantumVulnerableAlgorithms.join(', ') || 'none'})`);
  L.push(`- Critical findings (fail \`--check\`): ${inv.summary.criticalFindings}`);
  L.push(`- Items needing review (SHA-1, MD5, AES-128): ${inv.summary.reviewFindings}`, '');

  L.push('## Algorithms and where they are used', '');
  L.push('| Algorithm | Family | Quantum | Uses | Mentions | Tests |', '|---|---|---|---|---|---|');
  for (const a of inv.algorithms) L.push(`| ${esc(a.name)} | ${a.family} | ${QLABEL[a.quantum]} | ${a.uses} | ${a.mentions} | ${a.testReferences} |`);
  L.push('');
  for (const a of inv.algorithms.filter((x) => x.uses > 0)) {
    L.push(`### ${a.name}${a.quantum === 'vulnerable' && a.family !== 'tls' ? '  (quantum-vulnerable)' : ''}`, '');
    L.push('| File | Kind | Lines | Who decides the algorithm |', '|---|---|---|---|');
    for (const f of a.files) L.push(`| \`${f.path}\` | ${f.kind} | ${f.lines.join(', ')} | ${f.owner}${f.note ? ': ' + esc(f.note) : ''} |`);
    if (a.filesOmitted) L.push(`| _…and ${a.filesOmitted} more files_ | | | |`);
    L.push('');
  }

  L.push('## Quantum-vulnerable public-key uses', '');
  const qv = inv.algorithms.filter((a) => a.uses > 0 && a.quantum === 'vulnerable' && a.family !== 'tls');
  if (!qv.length) L.push('None found.', '');
  else {
    L.push('Shor\'s algorithm would break all of these on a sufficiently large quantum computer. Signatures matter when they must stay trustworthy for years; key agreement matters when recorded traffic carries long-lived secrets.', '');
    L.push('| Use | Files | Control |', '|---|---|---|');
    for (const a of qv) {
      const owners = [...new Set(a.files.map((f) => f.owner))].sort().join(', ');
      L.push(`| ${esc(a.name)} | ${a.fileCount} | ${owners} |`);
    }
    L.push('');
  }

  L.push('## TLS', '');
  const tls = inv.algorithms.filter((a) => a.family === 'tls' && a.uses > 0);
  if (!tls.length) L.push('No TLS settings found in code or config.', '');
  else for (const a of tls) L.push(`- ${a.name}: ${a.uses} use(s) in ${a.fileCount} file(s)`);
  L.push('', 'TLS for browser, Supabase, Vercel and third-party API traffic is terminated by those providers. Versions, cipher suites and key-exchange groups are not visible here. **[VERIFY]**', '');

  L.push('## Wallet pass signing', '');
  if (!inv.walletPassSigning.length) L.push('No wallet signing code found.', '');
  else {
    L.push('| File | Algorithms | Who decides |', '|---|---|---|');
    for (const w of inv.walletPassSigning) L.push(`| \`${w.path}\` | ${w.algorithms.join(', ')} | ${w.owner}${w.note ? ': ' + esc(w.note) : ''} |`);
    L.push('');
  }

  L.push('## Long-lived confidential data', '');
  L.push('Data that must stay secret for many years is the exposure that matters most for harvest-now-decrypt-later: traffic recorded today could be decrypted later if its key exchange was classical.', '');
  for (const c of inv.longLivedConfidentialData) {
    L.push(`### ${c.name}`, '');
    L.push(`- Type: ${c.kind}`);
    L.push(`- Found in scan: ${c.evidenceFound ? 'yes' : '**no (stale registry entry or feature removed)**'}`);
    if (c.evidenceFiles.length) L.push(`- Evidence: ${c.evidenceFiles.map((f) => '`' + f + '`').join(', ')}${c.evidenceFilesOmitted ? `, +${c.evidenceFilesOmitted} more` : ''}`);
    L.push(`- Lifetime: ${c.lifetime}`);
    L.push(`- Application-layer AES evidenced: ${c.applicationLayerEncryptionEvidenced ? 'yes' : 'no'}`);
    L.push(`- Algorithms found in this class's own code: ${c.cryptoInUse.length ? c.cryptoInUse.join(', ') : 'none'}`);
    L.push(`- Harvest-now-decrypt-later: ${c.harvestNowDecryptLater}`);
    for (const v of c.verify) L.push(`- ${v}`);
    L.push('');
  }

  L.push('## Migration roadmap', '', inv.roadmap.note, '', '### Reference standards', '');
  for (const s of inv.roadmap.standards) L.push(`- ${s}`);
  L.push('');
  for (const p of inv.roadmap.phases) {
    L.push(`### Phase ${p.phase}: ${p.name}`, '', `Target: ${p.target}`, '');
    for (const a of p.actions) L.push(`- ${a}`);
    L.push('');
  }

  L.push('## Limitations', '');
  for (const l of inv.limitations) L.push(`- ${l}`);
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ CLI */
export function run(argv, cwd = process.cwd()) {
  const rootIdx = argv.indexOf('--root');
  const root = resolve(rootIdx >= 0 ? argv[rootIdx + 1] : cwd);
  const inv = buildInventory(scanFiles(root));
  const md = renderMarkdown(inv);
  const json = renderJson(inv);
  const mdPath = join(root, OUT_MD);
  const jsonPath = join(root, OUT_JSON);

  if (argv.includes('--write')) {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, md);
    writeFileSync(jsonPath, json);
    console.log(`wrote ${OUT_MD} and ${OUT_JSON}`);
    return 0;
  }
  console.log(`files scanned: ${inv.scan.filesScanned} | algorithms in use: ${inv.summary.algorithmsInUse} | quantum-vulnerable uses: ${inv.summary.quantumVulnerablePublicKeyUses} | critical: ${inv.summary.criticalFindings} | review: ${inv.summary.reviewFindings}`);
  if (argv.includes('--check')) {
    let bad = 0;
    if (inv.summary.criticalFindings > 0) {
      console.error('Critical crypto findings:');
      for (const a of inv.algorithms.filter((x) => x.severity === 'critical' && x.uses > 0)) for (const f of a.files) console.error(`  ${a.name}: ${f.path}:${f.lines.join(',')}`);
      bad++;
    }
    const stale = [[mdPath, md, OUT_MD], [jsonPath, json, OUT_JSON]].filter(([p, c]) => !existsSync(p) || readFileSync(p, 'utf8') !== c).map(([, , n]) => n);
    if (stale.length) { console.error(`Stale: ${stale.join(', ')}. Run: node scripts/security/crypto-inventory.mjs --write`); bad++; }
    if (!bad) console.log('OK: inventory is current and has no critical findings.');
    return bad ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(run(process.argv.slice(2)));
}
