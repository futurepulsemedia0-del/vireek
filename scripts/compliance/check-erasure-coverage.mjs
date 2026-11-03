#!/usr/bin/env node
// scripts/compliance/check-erasure-coverage.mjs
// Ratchet for account-erasure coverage (gap E4). Finds every table with a `user_id` column in
// supabase/migrations and classifies it: listed in OWNED_TABLES / TRUST_TENANT_TABLES, cascading FK
// to auth.users/profiles, or UNCOVERED. Heuristic (line-level regex on CREATE TABLE) — FKs added via
// ALTER TABLE are not seen, so treat UNCOVERED as "needs review", not "proven leak".
//   node scripts/compliance/check-erasure-coverage.mjs             # report
//   node scripts/compliance/check-erasure-coverage.mjs --baseline  # accept current state
//   node scripts/compliance/check-erasure-coverage.mjs --check     # fail only on NEW uncovered tables
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(ROOT, 'supabase/migrations');
const BASELINE = join(ROOT, 'docs/compliance/erasure-coverage-baseline.json');

const owned = new Set([...readFileSync(join(ROOT, 'supabase/functions/_shared/compliance/ownedTables.ts'), 'utf8').matchAll(/table:\s*"(\w+)"/g)].map((m) => m[1]));
const trustSrc = readFileSync(join(ROOT, 'supabase/functions/_shared/trust/vault.ts'), 'utf8');
const trust = new Set([...(/TRUST_TENANT_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(trustSrc)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]));

const withUserId = new Map(); // table -> cascades?
for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql'))) {
  const sql = readFileSync(join(MIG, f), 'utf8');
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\)\s*;/gi)) {
    for (const line of m[2].split('\n')) {
      if (!/^\s*user_id\b/i.test(line)) continue;
      const cascades = /references\s+(auth\.users|public\.profiles)/i.test(line) && /on\s+delete\s+cascade/i.test(line);
      withUserId.set(m[1], (withUserId.get(m[1]) ?? false) || cascades);
    }
  }
}
const uncovered = [...withUserId].filter(([t, c]) => !c && !owned.has(t) && !trust.has(t)).map(([t]) => t).sort();
console.log(`tables with user_id: ${withUserId.size} | listed: ${[...withUserId.keys()].filter((t) => owned.has(t) || trust.has(t)).length} | cascade FK: ${[...withUserId.values()].filter(Boolean).length} | uncovered: ${uncovered.length}`);

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE, JSON.stringify({ note: 'Tables accepted as uncovered. New entries fail --check.', uncovered }, null, 2) + '\n');
  console.log(`baseline written: ${uncovered.length} tables`);
} else if (process.argv.includes('--check')) {
  if (!existsSync(BASELINE)) { console.error('No baseline. Run with --baseline first.'); process.exit(2); }
  const known = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).uncovered);
  const fresh = uncovered.filter((t) => !known.has(t));
  if (fresh.length) { console.error('NEW tables with user_id not covered by erasure (list in OWNED_TABLES, add ON DELETE CASCADE, or justify):\n  ' + fresh.join('\n  ')); process.exit(1); }
  console.log('OK: no new uncovered tables.');
}
