#!/usr/bin/env node
// scripts/secret-scan.mjs
//
// Fast local secret scan for staged files (called by lint-staged from the husky pre-commit hook).
// This is a FIRST LINE of defence, not a replacement for the gitleaks job in .github/workflows/security.yml:
// it uses a small set of high-signal patterns so it stays quick and rarely cries wolf.
//
// Usage:  node scripts/secret-scan.mjs <file> [<file> ...]      (exit 1 when something is found)
//         node scripts/secret-scan.mjs --self-test
//
// Suppress a reviewed false positive by adding the marker `secret-scan:ignore` on the same line.
// Output never prints the secret itself: only file, line, rule and a masked preview.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.lockb', '.keystore', '.jks']);
const IGNORE_MARK = 'secret-scan:ignore';

/** Files that must never be committed, whatever their content. */
export function forbiddenFileName(file) {
  const base = path.basename(file);
  if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) return `environment file "${base}" must not be committed`;
  if (/\.(pem|p12|pfx|key|keystore|jks)$/i.test(base) && !/\.pub$/i.test(base)) return `key/certificate file "${base}" must not be committed`;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return `SSH private key "${base}" must not be committed`;
  if (base === 'service-account.json' || /^serviceAccount.*\.json$/i.test(base)) return `service-account credential "${base}" must not be committed`;
  return null;
}

const RULES = [
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[0-9A-Za-z]{24,}\b/ },
  { id: 'anthropic-api-key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  { id: 'openai-api-key', re: /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b|\bgithub_pat_[0-9A-Za-z_]{40,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[0-9A-Za-z-]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'sendgrid-key', re: /\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}\b/ },
  { id: 'twilio-auth-token', re: /\b(?:TWILIO_AUTH_TOKEN|twilioAuthToken)\b["']?\s*[:=]\s*["'][0-9a-f]{32}["']/i },
  {
    id: 'generic-secret-assignment',
    // name looks secret-ish AND the value is a long literal that is not obviously a placeholder / env read
    re: /\b[A-Za-z0-9_]*(?:SECRET|PRIVATE_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SERVICE_ROLE)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9/+=_.-]{24,})["']/i,
    valueGroup: 1,
  },
];

/** JWTs: flag only Supabase-style service_role tokens (anon keys are public by design). */
function jwtFinding(line) {
  const m = line.match(/\beyJ[0-9A-Za-z_-]{10,}\.(eyJ[0-9A-Za-z_-]{10,})\.[0-9A-Za-z_-]{10,}\b/);
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload && payload.role === 'service_role') return { id: 'supabase-service-role-jwt', value: m[0] };
  } catch { /* not a JWT */ }
  return null;
}

const AWS_DOC_EXAMPLE = /AKIAIOSFODNN7EXAMPLE/;
const PLACEHOLDER = /(?:your[-_ ]|example|placeholder|changeme|change-me|dummy|sample|xxxxx|\*{4,}|<[^>]+>|\$\{|process\.env|Deno\.env|import\.meta\.env|test[-_]?(?:secret|key|token)|do-not-use|redteam-secret)/i;

function mask(v) {
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

/** @returns {{line:number, rule:string, preview:string}[]} */
export function scanText(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000 || line.includes(IGNORE_MARK) || AWS_DOC_EXAMPLE.test(line)) continue;
    const jwt = jwtFinding(line);
    if (jwt) out.push({ line: i + 1, rule: jwt.id, preview: mask(jwt.value) });
    for (const r of RULES) {
      const m = line.match(r.re);
      if (!m) continue;
      const value = r.valueGroup ? m[r.valueGroup] : m[0];
      if (r.valueGroup && (PLACEHOLDER.test(value) || PLACEHOLDER.test(line) || /^[A-Z0-9_]+$/.test(value))) continue;
      out.push({ line: i + 1, rule: r.id, preview: mask(value) });
    }
  }
  return out;
}

/** Test / fixture paths hold deliberately fake credentials; content rules are skipped there (gitleaks in CI still covers them). */
export function isTestPath(file) {
  return /(\.test\.|\.spec\.|\/__tests__\/|\/tests?\/|\/fixtures?\/|Fixtures?\.[a-z]+$)/i.test(file.replace(/\\/g, '/'));
}

export function scanFile(file) {
  const findings = [];
  const name = forbiddenFileName(file);
  if (name) findings.push({ file, line: 0, rule: 'forbidden-file', preview: name });
  let stat;
  try { stat = fs.statSync(file); } catch { return findings; } // deleted / renamed away
  if (isTestPath(file)) return findings;
  if (!stat.isFile() || stat.size > MAX_BYTES || BINARY_EXT.has(path.extname(file).toLowerCase())) return findings;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return findings; }
  if (text.includes('\u0000')) return findings; // binary
  for (const f of scanText(text)) findings.push({ file, ...f });
  return findings;
}

function selfTest() {
  const fake = (parts) => parts.join('');
  const cases = [
    [fake(['AKIA', 'ABCDEFGHIJKLMNOP']), 'aws-access-key-id'],
    [fake(['sk_li', 've_', 'a1B2c3D4e5F6g7H8i9J0k1L2']), 'stripe-secret-key'],
    [fake(['-----BEGIN ', 'PRIVATE KEY-----']), 'private-key-block'],
    [fake(['const API_KEY = "', 'q8Zr2LmN4xV7bT1cY5uW9eH3jK6pA0sD', '"']), 'generic-secret-assignment'],
  ];
  let bad = 0;
  for (const [text, rule] of cases) {
    const hit = scanText(text).some((f) => f.rule === rule);
    if (!hit) { console.error(`self-test FAILED: ${rule} not detected`); bad++; }
  }
  const clean = ['const key = process.env.STRIPE_KEY', 'API_KEY="your-api-key-here-0000000000000"', 'const x = "hello world"', `token ${fake(['AKIA', 'ABCDEFGHIJKLMNOP'])} // ${IGNORE_MARK}`];
  for (const text of clean) if (scanText(text).length) { console.error(`self-test FAILED: false positive on: ${text.slice(0, 40)}`); bad++; }
  if (!forbiddenFileName('.env') || forbiddenFileName('.env.example')) { console.error('self-test FAILED: .env handling'); bad++; }
  console.log(bad ? 'self-test: FAILED' : 'self-test: ok');
  process.exit(bad ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();
  const all = args.flatMap((f) => scanFile(f));
  if (all.length) {
    console.error('\n✖ Possible secrets found in staged files:\n');
    for (const f of all) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.preview}`);
    console.error(`\nRemove the secret (and rotate it if it was ever pushed). For a reviewed false positive add "${IGNORE_MARK}" on that line.\n`);
    process.exit(1);
  }
}
