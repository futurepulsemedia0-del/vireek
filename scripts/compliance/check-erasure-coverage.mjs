#!/usr/bin/env node
// scripts/compliance/check-erasure-coverage.mjs
//
// Account-erasure coverage ratchet (gap E4). Lists every public table that carries an owner column
// (user_id / owner_id / account_owner_id) and classifies HOW its rows disappear on full-account erasure:
//
//   listed       explicitly deleted by code  (OWNED_TABLES in ownedTables.ts, TRUST_TENANT_TABLES in trust/vault.ts)
//   cascade      FK ON DELETE CASCADE to auth.users / profiles (removed when the auth user is deleted)
//   catalog_rpc  uuid user_id table, deleted at run time by the erase_user_rows() RPC
//   exempt       deliberately kept; reason recorded in docs/compliance/erasure-exemptions.json
//   uncovered    no erasure path  -> ratcheted by docs/compliance/erasure-coverage-baseline.json
//
//   node scripts/compliance/check-erasure-coverage.mjs                 # report (first line = uncovered count)
//   node scripts/compliance/check-erasure-coverage.mjs --json          # full classification as JSON
//   node scripts/compliance/check-erasure-coverage.mjs --baseline      # accept the current uncovered set
//   node scripts/compliance/check-erasure-coverage.mjs --check         # CI: fail on anything NEW (see below)
//   node scripts/compliance/check-erasure-coverage.mjs --catalog-json <file>   # use a real DB catalog dump instead
//                                                                              # of parsing migrations (see erasure-catalog.sql)
//
// --check fails (exit 1) when: a table is uncovered and not in the baseline; an exemption has no reason or points
// at a table that no longer exists; a name in OWNED_TABLES / TRUST_TENANT_TABLES is not a real owner table.
// Stale baseline entries (table now covered or gone) only warn: run --baseline to ratchet down.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, fromCatalogRows, parseMigrations, parseRpcExclude, validateExemptions } from './erasure-lib.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(ROOT, 'supabase/migrations');
const BASELINE = join(ROOT, 'docs/compliance/erasure-coverage-baseline.json');
const EXEMPTIONS = join(ROOT, 'docs/compliance/erasure-exemptions.json');
const RPC_MIGRATION = '20280410000000_erase_user_rows.sql';

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** Loads everything from disk and returns the classification. Pure of side effects. */
export function analyse({ catalogJson } = {}) {
  const owned = new Set([...readFileSync(join(ROOT, 'supabase/functions/_shared/compliance/ownedTables.ts'), 'utf8').matchAll(/table:\s*"(\w+)"/g)].map((m) => m[1]));
  const trustSrc = readFileSync(join(ROOT, 'supabase/functions/_shared/trust/vault.ts'), 'utf8');
  const trust = new Set([...(/TRUST_TENANT_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(trustSrc)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]));
  const rpcExclude = parseRpcExclude(readFileSync(join(MIG, RPC_MIGRATION), 'utf8'));
  const exemptions = readJson(EXEMPTIONS, { exemptions: {} }).exemptions ?? {};

  let tables;
  let skipped = [];
  if (catalogJson) tables = fromCatalogRows(JSON.parse(readFileSync(catalogJson, 'utf8')));
  else {
    const all = readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort();
    skipped = all.filter((n) => !/^\d+_/.test(n));
    tables = parseMigrations(all.filter((n) => /^\d+_/.test(n)).map((name) => ({ name, sql: readFileSync(join(MIG, name), 'utf8') })));
  }
  const result = classify({ tables, owned, trust, exemptions, rpcExclude });
  const problems = validateExemptions(exemptions, tables);
  for (const t of [...owned, ...trust]) if (!tables.get(t)?.has('user_id')) problems.push(`${t}: listed in OWNED_TABLES/TRUST_TENANT_TABLES but no user_id column found`);
  return { ...result, problems, skipped, rpcExclude, source: catalogJson ? 'catalog' : 'migrations' };
}

/** Pure decision used by --check and by the unit test. */
export function evaluate({ rows, problems }, baselineUncovered) {
  const known = new Set(baselineUncovered);
  const uncovered = rows.filter((r) => r.class === 'uncovered').map((r) => r.table);
  return {
    fresh: uncovered.filter((t) => !known.has(t)),
    stale: [...known].filter((t) => !uncovered.includes(t)),
    problems,
  };
}

function main(argv) {
  const flag = (f) => argv.includes(f);
  const ci = argv.indexOf('--catalog-json');
  const a = analyse({ catalogJson: ci >= 0 ? argv[ci + 1] : undefined });
  const { summary } = a;
  const uncovered = a.rows.filter((r) => r.class === 'uncovered');

  if (flag('--json')) {
    process.stdout.write(JSON.stringify({ source: a.source, summary, rows: a.rows }, null, 2) + '\n');
    return 0;
  }
  console.log(`uncovered: ${summary.uncovered} of ${summary.total} tables with an owner column (source: ${a.source})`);
  console.log(`  listed ${summary.listed} | cascade ${summary.cascade} | catalog_rpc ${summary.catalog_rpc} | exempt ${summary.exempt} | uncovered ${summary.uncovered}`);
  if (a.skipped.length) console.log(`  skipped non-versioned migration files: ${a.skipped.join(', ')}`);

  if (flag('--baseline')) {
    writeFileSync(BASELINE, JSON.stringify({ note: 'Owner-column tables with no erasure path, accepted until reviewed. New entries fail --check. Regenerate: node scripts/compliance/check-erasure-coverage.mjs --baseline', uncovered: uncovered.map((r) => r.table) }, null, 2) + '\n');
    console.log(`baseline written: ${uncovered.length} tables`);
    return 0;
  }
  if (flag('--check')) {
    if (!existsSync(BASELINE)) { console.error('No baseline. Run with --baseline first.'); return 2; }
    const { fresh, stale, problems } = evaluate(a, readJson(BASELINE, { uncovered: [] }).uncovered);
    if (stale.length) console.warn(`warning: ${stale.length} baseline entries are now covered or gone (run --baseline to ratchet down): ${stale.join(', ')}`);
    if (problems.length) console.error('Problems:\n  ' + problems.join('\n  '));
    if (fresh.length) {
      const by = Object.fromEntries(a.rows.map((r) => [r.table, r]));
      console.error('NEW owner-column tables with no erasure path. Fix by ONE of: add ON DELETE CASCADE to profiles/auth.users, list in OWNED_TABLES, or add an entry (with reason) to docs/compliance/erasure-exemptions.json:\n  ' + fresh.map((t) => `${t} (${by[t].detail})`).join('\n  '));
    }
    if (fresh.length || problems.length) return 1;
    console.log('OK: nothing new is uncovered.');
    return 0;
  }
  for (const r of uncovered) console.log(`  - ${r.table}  [${r.columns.join(', ')}]  ${r.detail}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
