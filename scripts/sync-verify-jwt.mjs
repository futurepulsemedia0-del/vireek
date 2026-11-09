#!/usr/bin/env node
// Usage:  node scripts/sync-verify-jwt.mjs check   (CI: exit 1 on drift / invalid TOML)
//         node scripts/sync-verify-jwt.mjs write   (rewrites supabase/config.toml; review `git diff` before committing)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computePlan, renderConfig } from './lib/verifyJwt.mjs';

const FN_DIR = 'supabase/functions';
const CFG = 'supabase/config.toml';
const mode = process.argv[2] ?? 'check';
if (!['check', 'write'].includes(mode)) {
  console.error('usage: sync-verify-jwt.mjs check|write');
  process.exit(2);
}

const fns = readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(FN_DIR, d.name, 'index.ts')))
  .map((d) => ({ name: d.name, src: readFileSync(join(FN_DIR, d.name, 'index.ts'), 'utf8') }));

const cfg = readFileSync(CFG, 'utf8');
const plan = computePlan(cfg, fns);
const list = (t, a) => a.length && console.log(`${t} (${a.length}):\n  ${a.join('\n  ')}`);

list('Duplicate [functions.*] tables (invalid TOML)', plan.duplicates);
list('Declared --no-verify-jwt but missing in config.toml', plan.toAdd);
list('NEEDS HUMAN REVIEW: declares --no-verify-jwt but no self-auth found in source (NOT auto-added)', plan.needsReview);
list('config.toml entries without a function directory (warning only)', plan.orphans);

if (mode === 'write') {
  writeFileSync(CFG, renderConfig(cfg, plan.toAdd));
  console.log(`\nWrote ${CFG}: +${plan.toAdd.length} entries, ${plan.duplicates.length} duplicates removed.`);
  process.exit(0);
}
const drift = plan.toAdd.length + plan.duplicates.length;
console.log(drift ? `\nFAIL: ${drift} problem(s). Run: node scripts/sync-verify-jwt.mjs write` : '\nOK: config.toml in sync.');
process.exit(drift ? 1 : 0);
