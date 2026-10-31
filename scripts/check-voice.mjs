#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Voice & tone lint (see docs/voice-and-tone.md)                      */
/*                                                                      */
/*  Fails on forbidden patterns in:                                     */
/*   - every locale JSON value (src/locales/**)                         */
/*   - user-facing literals in TSX: JSX text nodes and toast('…')       */
/*  Patterns: "Oops!"-style filler, raw error codes, ALL-CAPS words.    */
/*  Run: node scripts/check-voice.mjs   (CI: npm run lint:voice)        */
/* ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ACRONYMS = new Set([
  'AI', 'SMS', 'MMS', 'PDF', 'CSV', 'API', 'VAT', 'GST', 'HVAC', 'FAQ', 'URL', 'QR', 'GPS', 'NPS', 'CSAT', 'SLA',
  'PWA', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'IVR', 'PBX', 'VOIP', 'RAG', 'CRM', 'ROI', 'KPI', 'SEO', 'HTML',
  'JSON', 'OTP', 'SSO', 'MFA', 'LLC', 'EIN', 'ZIP', 'USA', 'OSHA', 'EPA', 'NATE', 'HIPAA', 'GDPR', 'SOC', 'DSO',
  'EBITDA', 'NEW', 'BETA', 'LIVE', 'VIP', 'TCPA', 'DNC', 'IBAN', 'SWIFT', 'ACH', 'HTTP', 'HTTPS', 'REST', 'SMTP',
  'HMAC', 'SHA', 'USPS', 'ASHRAE', 'AHRI', 'STOP', 'HELP', 'TCPA', 'CAN', 'SPAM', 'UTC', 'JSON', 'XML', 'DNS', 'SPF', 'DKIM',
  'DMARC', 'TLS', 'SSL', 'RLS', 'UUID', 'ISO', 'ANSI', 'NEC', 'IRC', 'ACCA', 'AWG', 'BTU', 'SEER', 'HSPF', 'COP',
  'WCAG', 'CCPA', 'DMCA', 'NOAA', 'NASA', 'FEMA', 'EIA', 'WAI', 'ARIA', 'CNAME', 'MM', 'DD', 'YYYY', 'STOPALL',
  'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'PLANS', 'NVDA', 'CPRA', 'POST', 'XXXX', 'START', 'SIEM', 'DELETE',
]);
const FILLER = /\b(?:oops|whoops|uh[- ]oh|yikes)\b/i;
const RAW_CODE = /\b(?:ERR_[A-Z_]+|E\d{4,}|[45]\d{2} error|error [45]\d{2}|HTTP [45]\d{2}|error code:?\s*\w+)\b/i;
const caps = (s) => (s.replace(/\{\{[^}]*\}\}|\$\{[^}]*\}/g, '').match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w));
const LATIN = new Set(['en', 'es', 'fr', 'de']);

const problems = [];
const flag = (where, rule, text) => problems.push(`${where}  [${rule}]  ${(rule === 'all-caps' ? caps(text).join(', ') + ' — ' : '') + text.trim().replace(/\s+/g, ' ').slice(0, 70)}`);

function* walk(dir, exts) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') yield* walk(full, exts); }
    else if (exts.includes(extname(e)) && !/\.test\.tsx?$/.test(e)) yield full;
  }
}
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[p ? `${p}.${k}` : k, v]] : flat(v, p ? `${p}.${k}` : k)));

// 1. Locale JSON
for (const file of walk(join(ROOT, 'src/locales'), ['.json'])) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const lang = rel.split('/')[2];
  for (const [key, value] of flat(JSON.parse(readFileSync(file, 'utf8')))) {
    if (FILLER.test(value)) flag(`${rel}:${key}`, 'filler', value);
    if (RAW_CODE.test(value)) flag(`${rel}:${key}`, 'raw-error-code', value);
    if (LATIN.has(lang) && caps(value).length) flag(`${rel}:${key}`, 'all-caps', value);
  }
}

// 2. TSX copy: JSX text nodes and toast('literal')
// Text between an opening/closing tag and the next tag; code-looking captures are skipped.
const JSX_TEXT = /(?:<[A-Za-z][\w.]*(?:\s[^<>]*)?|<\/[A-Za-z][\w.]*)>\s*([^<>{}=\n][^<>{}]*?)\s*</g;
const CODEISH = /\$\{|;|=>|&&|\|\||\/\/|\b(?:const|let|return|import|export)\b/;
const TOAST = /\btoast\(\s*(['"`])((?:(?!\1).)*)\1/g;
for (const file of walk(join(ROOT, 'src'), ['.tsx'])) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(JSX_TEXT)) {
    const t = m[1];
    if (!/[A-Za-z]{3,}/.test(t) || CODEISH.test(t)) continue;
    if (FILLER.test(t)) flag(`${rel}:${lineOf(m.index)}`, 'filler', t);
    if (RAW_CODE.test(t)) flag(`${rel}:${lineOf(m.index)}`, 'raw-error-code', t);
    if (caps(t).length) flag(`${rel}:${lineOf(m.index)}`, 'all-caps', t);
  }
  for (const m of src.matchAll(TOAST)) {
    const t = m[2];
    if (FILLER.test(t)) flag(`${rel}:${lineOf(m.index)}`, 'filler', t);
    if (RAW_CODE.test(t)) flag(`${rel}:${lineOf(m.index)}`, 'raw-error-code', t);
    if (caps(t).length) flag(`${rel}:${lineOf(m.index)}`, 'all-caps', t);
  }
}

if (problems.length) {
  console.error(`Voice lint: ${problems.length} problem(s)\n`);
  problems.slice(0, 200).forEach((p) => console.error('  ' + p));
  if (problems.length > 200) console.error(`  …and ${problems.length - 200} more`);
  process.exit(1);
}
console.log('Voice lint OK.');
