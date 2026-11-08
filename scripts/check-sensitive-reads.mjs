#!/usr/bin/env node
// scripts/check-sensitive-reads.mjs
//
// Read-path completeness guard for the sensitive-read access log.
// Finds (a) queries on `calls` that select '*', recording_url or transcript (looked up in a 6-line
// window after `.from('calls')`, so multi-line chains are caught) and (b) edge functions minting
// signed URLs. A site passes when it is logged, allow-listed WITH a reason, or in the baseline of
// known gaps. New unlogged sites fail the check.
//   node scripts/check-sensitive-reads.mjs            -> check (CI)
//   node scripts/check-sensitive-reads.mjs --update   -> rewrite the baseline (review the diff!)
//   node scripts/check-sensitive-reads.mjs --list     -> print every site and its status
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = join(ROOT, 'scripts', 'sensitive-reads.baseline.json');
const LOGGED = /logSensitiveRead|log_sensitive_read|begin_sensitive_export_action|read_call_sensitive|readCallSensitive/;

// Reviewed exceptions. Each needs a reason a reviewer can challenge.
const ALLOW = [
  { file: 'supabase/functions/ovb-public/index.ts', reason: 'Public Open Voice Benchmark recordings of synthetic agents; not tenant data.' },
  { file: 'supabase/functions/_shared/home-inventory/handler.ts', reason: 'Homeowner opens their own files (data subject self-access).' },
  { file: 'supabase/functions/voice-brief/index.ts', reason: "Owner's own generated briefing audio. NOT VERIFIED that scripts never quote customer PII: review." },
  { dir: 'supabase/functions/', kind: 'calls-direct-read', reason: 'Service-role background processing (AI analysis, webhooks); no human reads the data. Subprocessor/LLM handling is a counsel item.' },
];
const allowed = (f) => ALLOW.find((a) => (a.file ? a.file === f.file : f.file.startsWith(a.dir) && (!a.kind || a.kind === f.kind)));

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
  lines.forEach((line, i) => {
    if (/from\(\s*['"]calls['"]\s*\)/.test(line)) {
      const m = lines.slice(i, i + 6).join(' ').match(/select\(\s*(['"`])(.*?)\1/);
      const cols = m?.[2] ?? '';
      if (/^\s*\*\s*$/.test(cols) || /recording_url|transcript/.test(cols)) {
        // strict: a raw select on calls bypasses the log until the enforcement SQL is applied
        found.push({ kind: 'calls-direct-read', file: rel, snippet: `L${i + 1} select(${cols.slice(0, 40)})`, logged: false });
      }
    }
    if (rel.startsWith('supabase/functions') && /createSignedUrl\(/.test(line)) {
      found.push({ kind: 'signed-url', file: rel, snippet: line.trim().slice(0, 90), logged: fileLogged });
    }
  });
}

const key = (f) => `${f.kind}|${f.file}|${f.snippet.replace(/^L\d+ /, '')}`;
const status = (f) => (f.logged ? 'logged' : allowed(f) ? 'allowed' : 'GAP');
if (process.argv.includes('--list')) {
  for (const f of found) console.log(`${status(f).padEnd(8)} ${f.kind.padEnd(17)} ${f.file}  ${f.snippet}`);
  process.exit(0);
}

const gaps = found.filter((f) => status(f) === 'GAP');
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ generatedFor: 'known unlogged read sites; shrink this list, never grow it', sites: [...new Set(gaps.map(key))].sort() }, null, 2) + '\n');
  console.log(`baseline written: ${gaps.length} known unlogged sites`);
  process.exit(0);
}

const baseline = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).sites : []);
const fresh = gaps.filter((g) => !baseline.has(key(g)));
const fixed = [...baseline].filter((k) => !gaps.some((g) => key(g) === k));
const n = (s) => found.filter((f) => status(f) === s).length;
console.log(`sensitive read sites: ${found.length} | logged: ${n('logged')} | allowed (reviewed): ${n('allowed')} | gaps: ${gaps.length} (baselined: ${gaps.length - fresh.length})`);
if (fixed.length) console.log(`\nno longer gaps (remove from baseline with --update):\n  ${fixed.join('\n  ')}`);
if (fresh.length) {
  console.error('\nNEW unlogged sensitive read sites:');
  for (const f of fresh) console.error(`  [${f.kind}] ${f.file}\n     ${f.snippet}`);
  console.error('\nRoute the read through read_call_sensitive()/calls_safe/logSensitiveRead(), or add a reasoned ALLOW entry.');
  process.exit(1);
}
