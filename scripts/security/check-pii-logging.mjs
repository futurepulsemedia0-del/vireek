#!/usr/bin/env node
// CI rule: edge functions must not write request bodies / payloads to the logs through the RAW console.
//   node scripts/security/check-pii-logging.mjs --check            fail on new violations (legacy frozen in the baseline)
//   node scripts/security/check-pii-logging.mjs --update-baseline  accept the current legacy violations (review the diff!)
// A file is compliant when it imports the shared redactor as the console:
//   import { safeConsole as console } from "../_shared/http/core.ts";
// Test files, scripts and _shared/http/core.ts itself are out of scope.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const FUNCTIONS = join(ROOT, 'supabase', 'functions');
const BASELINE = join(ROOT, 'scripts', 'security', 'pii-log-baseline.json');

export const SAFE_IMPORT = /import\s*\{[^}]*\bsafeConsole\s+as\s+console\b[^}]*\}\s*from\s*["'][^"']*_shared\/http\/core\.ts["']/;
// A console.* call whose argument list (up to the closing statement) mentions a request body.
const CALL = /console\.(?:log|info|warn|error|debug)\s*\(/g;
const BODY_REF = /(?:\bawait\s+req\w*\.(?:json|text|formData)\(\)|\b(?:body|rawBody|reqBody|requestBody|payload|rawPayload)\b(?!\s*:\s*["'`]))|JSON\.stringify\(\s*(?:body|payload|data|req\b|await\s+req)/;

export function scanSource(text) {
  if (SAFE_IMPORT.test(text)) return [];
  const hits = [];
  for (const m of text.matchAll(CALL)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth > 0 && i - m.index < 1200; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
    const args = text.slice(m.index + m[0].length, i - 1);
    // Drop plain string literals so words inside messages ("transcript scan failed") are not matched.
    const code = args.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    if (BODY_REF.test(code)) hits.push({ line: text.slice(0, m.index).split('\n').length, snippet: text.slice(m.index, i).replace(/\s+/g, ' ').slice(0, 140) });
  }
  return hits;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/(\.test|_test)\.ts$/.test(name)) yield p;
  }
}

export function scanAll() {
  const out = {};
  for (const f of walk(FUNCTIONS)) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (rel.endsWith('_shared/http/core.ts') || rel.includes('/quickstarts.ts') || rel.endsWith('api-v1/contract.ts')) continue; // customer-facing sample snippets, not logging
    const hits = scanSource(readFileSync(f, 'utf8'));
    if (hits.length) out[rel] = hits;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-pii-logging.mjs')) {
  const found = scanAll();
  const counts = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length]));
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n');
    console.log(`baseline written: ${Object.keys(counts).length} legacy files`);
  } else {
    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
    const bad = Object.entries(counts).filter(([f, n]) => n > (base[f] ?? 0));
    if (bad.length) {
      console.error('PII logging rule violated (raw console of a request body/payload). Fix: import { safeConsole as console } from "../_shared/http/core.ts"; and do not log bodies at all.');
      for (const [f] of bad) for (const h of found[f]) console.error(`  ${f}:${h.line}  ${h.snippet}`);
      process.exit(1);
    }
    const stale = Object.keys(base).filter((f) => !(f in counts));
    console.log(`pii-logging OK (${Object.keys(counts).length} legacy files frozen${stale.length ? `, ${stale.length} baseline entries now clean: run --update-baseline` : ''})`);
  }
}
