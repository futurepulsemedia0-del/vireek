#!/usr/bin/env node
// Ratchet: edge functions must reach LLM providers through supabase/functions/_shared/ai-core.
// Existing direct callers are frozen in scripts/direct-llm-baseline.json; any NEW file that calls a
// provider endpoint directly (or reads a provider key) fails this check. Shrink the baseline over time.
//   node scripts/check-direct-llm-calls.mjs            -> verify
//   node scripts/check-direct-llm-calls.mjs --update   -> rewrite baseline (only after removing callers)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = 'supabase/functions';
const ALLOWED_PREFIX = 'supabase/functions/_shared/ai-core/';
const BASELINE = 'scripts/direct-llm-baseline.json';
const PATTERN = /generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|api\.groq\.com|api\.cerebras\.ai|openrouter\.ai\/api|api\.cohere\.(ai|com)|Deno\.env\.get\(\s*["'](GEMINI|OPENAI|ANTHROPIC|GROQ|CEREBRAS|OPENROUTER|COHERE)_API_KEYS?["']/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

const offenders = [];
for (const file of walk(ROOT)) {
  const rel = relative('.', file).split(sep).join('/');
  if (rel.startsWith(ALLOWED_PREFIX)) continue;
  if (PATTERN.test(readFileSync(file, 'utf8'))) offenders.push(rel);
}
offenders.sort();

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(offenders, null, 2) + '\n');
  console.log(`baseline written: ${offenders.length} files`);
  process.exit(0);
}

const baseline = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : []);
const fresh = offenders.filter((f) => !baseline.has(f));
const fixed = [...baseline].filter((f) => !offenders.includes(f));
if (fixed.length) console.log(`note: ${fixed.length} baseline file(s) no longer call providers directly; run with --update to shrink the baseline.`);
if (fresh.length) {
  console.error('New direct LLM provider usage outside ai-core (use askVireekAi / askVireekAiStream):');
  for (const f of fresh) console.error('  - ' + f);
  process.exit(1);
}
console.log(`ok: ${offenders.length} frozen direct callers, 0 new.`);
