#!/usr/bin/env node
// scripts/check-sensitive-reads.mjs
//
// Read-path completeness guard for the sensitive-read access log.
// Scans the CURRENT code for places that read call recordings/transcripts (client queries on
// `calls` that select '*', recording_url or transcript) and edge functions that mint signed URLs,
// and fails if a site is neither logged nor listed in scripts/sensitive-reads.baseline.json.
//   node scripts/check-sensitive-reads.mjs            -> check (CI)
//   node scripts/check-sensitive-reads.mjs --update   -> rewrite the baseline (review the diff!)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = join(ROOT, 'scripts', 'sensitive-reads.baseline.json');
const LOGGED = /logSensitiveRead|log_sensitive_read|begin_sensitive_export_action|read_call_sensitive/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (['.ts', '.tsx'].includes(extname(p)) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const found = [];
for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'supabase', 'functions'))]) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  const fileLogged = LOGGED.test(text);
  const lines = text.split('\n');
  lines.forEach((line) => {
    // 1) direct client/edge reads of calls that include the sensitive columns
    if (/from\(\s*['"]calls['"]\s*\)/.test(line) && /select\(\s*['"`]([^'"`]*)['"`]/.test(line)) {
      const cols = line.match(/select\(\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '';
      if (/^\s*\*\s*$/.test(cols) || /recording_url|transcript/.test(cols)) {
        // strict: a raw select on calls bypasses the log until the enforcement SQL is applied
        found.push({ kind: 'calls-direct-read', file: rel, snippet: line.trim().slice(0, 110), logged: false });
      }
    }
    // 2) signed URLs minted by edge functions
    if (rel.startsWith('supabase/functions') && /createSignedUrl\(/.test(line)) {
      found.push({ kind: 'signed-url', file: rel, snippet: line.trim().slice(0, 110), logged: fileLogged });
    }
  });
}

const gaps = found.filter((f) => !f.logged);
const key = (f) => `${f.kind}|${f.file}|${f.snippet}`;

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ generatedFor: 'known unlogged read sites; shrink this list, never grow it', sites: gaps.map(key).sort() }, null, 2) + '\n');
  console.log(`baseline written: ${gaps.length} known unlogged sites`);
  process.exit(0);
}

const baseline = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).sites : []);
const fresh = gaps.filter((g) => !baseline.has(key(g)));
const fixed = [...baseline].filter((k) => !gaps.some((g) => key(g) === k));

console.log(`sensitive read sites found: ${found.length} | logged: ${found.length - gaps.length} | unlogged: ${gaps.length} (baselined: ${gaps.length - fresh.length})`);
if (fixed.length) console.log(`\nno longer unlogged (remove from baseline with --update):\n  ${fixed.join('\n  ')}`);
if (fresh.length) {
  console.error('\nNEW unlogged sensitive read sites:');
  for (const f of fresh) console.error(`  [${f.kind}] ${f.file}\n     ${f.snippet}`);
  console.error('\nRoute the read through read_call_sensitive()/logSensitiveRead(), or justify it and run with --update.');
  process.exit(1);
}
