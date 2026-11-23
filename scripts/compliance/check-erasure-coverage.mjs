#!/usr/bin/env node
// scripts/compliance/check-erasure-coverage.mjs
// Erasure-registry completeness gate. Every public table that holds personal data must be covered by
// account erasure (swept by erase_user_rows(), OWNED_TABLES, TENANT_KEYED_OWNED_TABLES, FK cascade)
// or explicitly exempted with a reason in supabase/functions/_shared/compliance/ownedTables.ts.
// Heuristic (names/regex over supabase/migrations) — see scripts/compliance/erasure-lib.mjs for limits.
//
//   node scripts/compliance/check-erasure-coverage.mjs            # report (never fails)
//   node scripts/compliance/check-erasure-coverage.mjs --check    # CI: exit 1 on any gap or registry error
//   node scripts/compliance/check-erasure-coverage.mjs --strict   # like --check, also fails on needs_remediation entries
//   node scripts/compliance/check-erasure-coverage.mjs --json     # machine-readable result
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseMigrations, parseRegistry, parseTrustTables, readMigrations } from './erasure-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function run(root = ROOT) {
  const model = parseMigrations(readMigrations(join(root, 'supabase/migrations')));
  const registry = parseRegistry(readFileSync(join(root, 'supabase/functions/_shared/compliance/ownedTables.ts'), 'utf8'));
  const trust = parseTrustTables(readFileSync(join(root, 'supabase/functions/_shared/trust/vault.ts'), 'utf8'));
  return { model, ...classify(model, registry, trust) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const res = run();
  if (args.has('--json')) {
    console.log(JSON.stringify({ counts: res.counts, errors: res.errors, gaps: res.gaps, remediation: res.remediation }, null, 2));
  } else {
    const c = res.counts;
    console.log(`tables: ${res.rows.length} | swept: ${c.swept ?? 0} | owned: ${(c.owned ?? 0) + (c.owned_tenant ?? 0)} | cascade: ${c.cascade ?? 0} | exempt: ${c.exempt ?? 0} | no personal-data signal: ${c.no_signal ?? 0} | GAPS: ${res.gaps.length} | registry errors: ${res.errors.length}`);
    for (const e of res.errors) console.error(`REGISTRY ERROR: ${e}`);
    for (const g of res.gaps) console.error(`GAP [${g.kind}] ${g.table}: ${g.detail}`);
    if (res.remediation.length) console.warn(`NEEDS REMEDIATION (${res.remediation.length}): ${res.remediation.join(', ')}`);
    if (res.gaps.length) console.error('\nFix: register the table in TENANT_KEYED_OWNED_TABLES / OWNED_TABLES, or add an ERASURE_EXEMPTIONS entry with a category (see ownedTables.ts).');
  }
  const fail = res.errors.length > 0 || res.gaps.length > 0 || (args.has('--strict') && res.remediation.length > 0);
  if ((args.has('--check') || args.has('--strict')) && fail) process.exit(1);
  if (args.has('--check') || args.has('--strict')) console.log('OK: erasure registry is complete.');
}
