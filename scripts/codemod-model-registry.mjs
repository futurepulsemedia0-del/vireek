#!/usr/bin/env node
// One-shot, idempotent refactor: replaces hard-coded model-id literals in supabase/functions with the
// registry (supabase/functions/_shared/ai-models.ts) and adds the import.
//   node scripts/codemod-model-registry.mjs            -> dry run (lists every change)
//   node scripts/codemod-model-registry.mjs --write    -> apply
// Rewrites (comments are never touched):
//   Deno.env.get("A") || Deno.env.get("B") || "gemini-2.5-flash"  ->  resolveModel(["A","B"], MODELS.GEMINI_FLASH)
//   ctx.env("A") || ... || "<id>"                                 ->  resolveModel(["A"], MODELS.X, (n) => ctx.env(n))
//   Deno.env.get("A") || DEFAULT_*MODEL                           ->  resolveModel(["A"], DEFAULT_*MODEL)
//   any other "<registered id>" literal                           ->  MODELS.X   (object key: [MODELS.X])
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { parseRegisteredIds, REGISTRY_PATH } from './lib/modelRegistryScan.mjs';

const WRITE = process.argv.includes('--write');
const ROOT = 'supabase/functions';

const regText = readFileSync(REGISTRY_PATH, 'utf8');
parseRegisteredIds(regText); // validates the block exists
const block = regText.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const/)[1];
const KEY_BY_ID = new Map([...block.matchAll(/([A-Z0-9_]+)\s*:\s*"([^"]+)"/g)].map((m) => [m[2], m[1]]));

/** Same length as the input; comment characters become spaces so indexes still line up. */
function maskComments(s) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])(\/\/.*)$/gm, (_, a, c) => a + blank(c));
}

const Q = `(["'])`;
const ENV_NAME = `[A-Z0-9_]+`;
const LIT_ALT = [...KEY_BY_ID.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
const DEFAULT_IDENT = `DEFAULT_[A-Z0-9_]*MODEL`;

function plan(masked) {
  const edits = [];
  const taken = [];
  const add = (index, length, text) => {
    if (taken.some(([a, b]) => index < b && index + length > a)) return;
    taken.push([index, index + length]);
    edits.push({ index, length, text });
  };
  // 1) env chains with a getter: Deno.env.get("A") || ... || <literal | DEFAULT_*MODEL>
  const denoChain = new RegExp(`((?:Deno\\.env\\.get\\(${Q}${ENV_NAME}\\2\\)\\s*\\|\\|\\s*)+)(?:${Q}(${LIT_ALT})\\3|(${DEFAULT_IDENT}))`, 'g');
  for (const m of masked.matchAll(denoChain)) {
    const names = [...m[1].matchAll(new RegExp(`get\\(${Q}(${ENV_NAME})\\1\\)`, 'g'))].map((x) => `"${x[2]}"`);
    const fb = m[4] ? `MODELS.${KEY_BY_ID.get(m[4])}` : m[5];
    add(m.index, m[0].length, `resolveModel([${names.join(', ')}], ${fb})`);
  }
  // 2) same with ctx.env(...) / deps.env(...)
  const objChain = new RegExp(`((?:(\\w+)\\.env\\(${Q}${ENV_NAME}\\3\\)\\s*\\|\\|\\s*)+)(?:${Q}(${LIT_ALT})\\4|(${DEFAULT_IDENT}))`, 'g');
  for (const m of masked.matchAll(objChain)) {
    const names = [...m[1].matchAll(new RegExp(`\\.env\\(${Q}(${ENV_NAME})\\1\\)`, 'g'))].map((x) => `"${x[2]}"`);
    const fb = m[5] ? `MODELS.${KEY_BY_ID.get(m[5])}` : m[6];
    add(m.index, m[0].length, `resolveModel([${names.join(', ')}], ${fb}, (n) => ${m[2]}.env(n))`);
  }
  // 3) remaining registered literals (object keys become computed keys)
  const lit = new RegExp(`${Q}(${LIT_ALT})\\1(\\s*:)?`, 'g');
  for (const m of masked.matchAll(lit)) add(m.index, m[0].length, m[3] ? `[MODELS.${KEY_BY_ID.get(m[2])}]${m[3]}` : `MODELS.${KEY_BY_ID.get(m[2])}`);
  return edits;
}

function addImport(text, file) {
  const used = ['MODELS', 'resolveModel'].filter((n) => new RegExp(`\\b${n}\\b`).test(maskComments(text)));
  if (!used.length) return text;
  if (/from\s+["'][^"']*ai-models\.ts["']/.test(text)) return text;
  let rel = relative(dirname(file), 'supabase/functions/_shared/ai-models.ts').split(sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  const line = `import { ${used.join(', ')} } from "${rel}";\n`;
  const m = text.match(/^import\s/m);
  if (m) return text.slice(0, m.index) + line + text.slice(m.index);
  const header = text.match(/^(?:\s*\/\/.*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*/)[0];
  return header + line + text.slice(header.length);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

let changed = 0;
for (const file of walk(ROOT)) {
  const rel = relative('.', file).split(sep).join('/');
  if (rel === REGISTRY_PATH) continue;
  const raw = readFileSync(file, 'utf8');
  const edits = plan(maskComments(raw));
  if (!edits.length) continue;
  let out = raw;
  for (const e of edits.sort((a, b) => b.index - a.index)) out = out.slice(0, e.index) + e.text + out.slice(e.index + e.length);
  out = addImport(out, rel);
  changed++;
  console.log(`${WRITE ? 'updated' : 'would update'}: ${rel} (${edits.length} replacement${edits.length > 1 ? 's' : ''})`);
  if (WRITE) writeFileSync(file, out);
}
console.log(`${changed} file(s) ${WRITE ? 'updated' : 'need updating'}.`);
