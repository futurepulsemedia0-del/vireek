#!/usr/bin/env node
// scripts/compliance/export-coverage.mjs
// Tenant switching / export completeness check. Compares every tenant-scoped table (a CREATE TABLE in
// supabase/migrations with a `user_id` column) against what `tenant-export` actually outputs:
//
//   exported_core        TABLES in _shared/tenant-export/bundle.ts        (part=core, importable)
//   exported_supplement  SUPPLEMENTARY_TABLES in .../coverage.ts          (part=supplement, export-only)
//   excluded:<reason>    matches an EXCLUSION_RULES pattern in coverage.ts (credentials, metering)
//   unreviewed           none of the above  -> a GAP
//
// Hard errors (always exit 1): an exported table that does not exist / has no `user_id` or `id` column,
// a table both exported and excluded, duplicates or core/supplement overlap, or a tenant-export function
// that no longer reads the lists. Gaps: `--check` fails on NEW unreviewed tables (ratchet against
// docs/compliance/export-coverage-baseline.json); `--strict` fails on ANY unreviewed table.
//
//   node scripts/compliance/export-coverage.mjs             # report (exit 1 only on hard errors)
//   node scripts/compliance/export-coverage.mjs --check     # CI: hard errors + new gaps
//   node scripts/compliance/export-coverage.mjs --strict    # fail while any gap remains
//   node scripts/compliance/export-coverage.mjs --baseline  # accept the current gaps
//   node scripts/compliance/export-coverage.mjs --json
//
// Limits (heuristic, line-level regex like check-erasure-coverage.mjs): tables created through
// `ALTER TABLE ... ADD COLUMN user_id` or dynamic SQL are not seen, and tables keyed by owner_id /
// account_id / tenant_id instead of user_id are only COUNTED (blind spot), not classified.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = 'supabase/migrations';
const BUNDLE = 'supabase/functions/_shared/tenant-export/bundle.ts';
const COVERAGE = 'supabase/functions/_shared/tenant-export/coverage.ts';
const FUNCTION = 'supabase/functions/tenant-export/index.ts';
export const BASELINE = 'docs/compliance/export-coverage-baseline.json';

const names = (src) => [...src.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
const arrayBody = (src, constName) => new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src)?.[1] ?? null;

export function parseLists(root = ROOT) {
  const bundle = readFileSync(join(root, BUNDLE), 'utf8');
  const cov = readFileSync(join(root, COVERAGE), 'utf8');
  const core = arrayBody(bundle, 'TABLES');
  const supp = arrayBody(cov.replace(/\/\/.*$/gm, ''), 'SUPPLEMENTARY_TABLES');
  const rulesBody = arrayBody(cov, 'EXCLUSION_RULES') ?? '';
  const rules = [...rulesBody.matchAll(/reason:\s*"(\w+)"\s*,\s*pattern:\s*"([^"]+)"/g)].map((m) => ({ reason: m[1], re: new RegExp(m[2], 'i') }));
  return { core: core ? names(core) : null, supplement: supp ? names(supp) : null, rules };
}

/** table -> { user_id, id, other } from CREATE TABLE statements, honouring later DROP TABLE. */
export function scanSchema(root = ROOT) {
  const dir = join(root, MIG);
  const tabs = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql') && /^\d/.test(n)).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const events = [];
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\)\s*;/gi)) events.push({ at: m.index, kind: 'create', name: m[1], body: m[2] });
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) events.push({ at: m.index, kind: 'drop', name: m[1] });
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'drop') { tabs.delete(e.name); continue; }
      const cols = e.body.split('\n').map((l) => l.trim());
      const has = (c) => cols.some((l) => new RegExp(`^"?${c}"?\\s`, 'i').test(l));
      const t = tabs.get(e.name) ?? { user_id: false, id: false, other: false };
      t.user_id ||= has('user_id');
      t.id ||= has('id');
      t.other ||= has('owner_id') || has('account_owner_id') || has('account_id') || has('tenant_id');
      tabs.set(e.name, t);
    }
  }
  return tabs;
}

export function analyse(root = ROOT) {
  const { core, supplement, rules } = parseLists(root);
  const schema = scanSchema(root);
  const errors = [];
  if (!core) errors.push(`cannot read TABLES from ${BUNDLE}`);
  if (!supplement) errors.push(`cannot read SUPPLEMENTARY_TABLES from ${COVERAGE}`);
  if (rules.length === 0) errors.push(`cannot read EXCLUSION_RULES from ${COVERAGE}`);

  const fn = existsSync(join(root, FUNCTION)) ? readFileSync(join(root, FUNCTION), 'utf8') : '';
  if (!/\bTABLES\b/.test(fn) || !/\bSUPPLEMENTARY_TABLES\b/.test(fn)) errors.push(`${FUNCTION} must read both TABLES and SUPPLEMENTARY_TABLES`);

  const exclusionFor = (t) => rules.find((r) => r.re.test(t))?.reason ?? null;
  const coreSet = new Set(core ?? []);
  const suppSet = new Set(supplement ?? []);
  if (supplement && suppSet.size !== supplement.length) errors.push('SUPPLEMENTARY_TABLES has duplicate entries');
  for (const t of suppSet) if (coreSet.has(t)) errors.push(`${t} is in both TABLES and SUPPLEMENTARY_TABLES`);

  for (const [list, label] of [[core ?? [], 'TABLES'], [supplement ?? [], 'SUPPLEMENTARY_TABLES']]) {
    for (const t of list) {
      const s = schema.get(t);
      if (!s) errors.push(`${label}: ${t} has no CREATE TABLE in migrations (typo, dropped, or created dynamically)`);
      else {
        if (!s.user_id) errors.push(`${label}: ${t} has no user_id column — the export filters by user_id`);
        if (!s.id) errors.push(`${label}: ${t} has no id column — the export pages by id`);
      }
      const ex = exclusionFor(t);
      if (ex) errors.push(`${label}: ${t} is exported but matches the "${ex}" exclusion rule`);
    }
  }

  const tenant = [...schema].filter(([, s]) => s.user_id).map(([t]) => t).sort();
  const status = {};
  for (const t of tenant) {
    status[t] = coreSet.has(t) ? 'exported_core' : suppSet.has(t) ? 'exported_supplement' : exclusionFor(t) ? `excluded:${exclusionFor(t)}` : 'unreviewed';
  }
  const count = (pred) => Object.values(status).filter(pred).length;
  const unreviewed = tenant.filter((t) => status[t] === 'unreviewed');
  return {
    totals: {
      tenantTables: tenant.length,
      exportedCore: count((s) => s === 'exported_core'),
      exportedSupplement: count((s) => s === 'exported_supplement'),
      excluded: count((s) => s.startsWith('excluded:')),
      unreviewed: unreviewed.length,
      blindSpotOwnerKeyed: [...schema].filter(([, s]) => !s.user_id && s.other).length,
    },
    unreviewed,
    errors,
  };
}

export function compareToBaseline(unreviewed, baselineTables) {
  const known = new Set(baselineTables);
  const now = new Set(unreviewed);
  return {
    fresh: unreviewed.filter((t) => !known.has(t)),
    resolved: [...known].filter((t) => !now.has(t)).sort(),
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const r = analyse();
  const T = r.totals;
  if (args.has('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`tenant-scoped tables (user_id): ${T.tenantTables}`);
    console.log(`  exported (core / supplement): ${T.exportedCore} / ${T.exportedSupplement}   excluded: ${T.excluded}   UNREVIEWED GAPS: ${T.unreviewed}`);
    console.log(`  blind spot: ${T.blindSpotOwnerKeyed} tables keyed by owner_id/account_id/tenant_id are not classified by this check`);
  }

  if (args.has('--baseline')) {
    if (r.errors.length) { console.error('Refusing to write a baseline while there are hard errors:\n  ' + r.errors.join('\n  ')); process.exit(1); }
    writeFileSync(join(ROOT, BASELINE), JSON.stringify({ note: 'Tenant tables accepted as not yet classified for export. New entries fail --check; each should shrink over time.', unreviewed: r.unreviewed }, null, 2) + '\n');
    console.log(`baseline written: ${r.unreviewed.length} tables`);
    return;
  }

  let failed = false;
  if (r.errors.length) { console.error('\nexport coverage errors:\n  ' + r.errors.join('\n  ')); failed = true; }

  if (args.has('--check') || args.has('--strict')) {
    if (args.has('--strict') && r.unreviewed.length) {
      console.error(`\nSTRICT: ${r.unreviewed.length} tenant tables are neither exported nor excluded. First 40:\n  ` + r.unreviewed.slice(0, 40).join('\n  '));
      failed = true;
    } else if (args.has('--check')) {
      if (!existsSync(join(ROOT, BASELINE))) { console.error(`No baseline at ${BASELINE}. Run with --baseline first.`); process.exit(2); }
      const base = JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8')).unreviewed ?? [];
      const { fresh, resolved } = compareToBaseline(r.unreviewed, base);
      if (resolved.length) console.log(`note: ${resolved.length} baseline entries are now classified or gone; re-run --baseline to shrink it.`);
      if (fresh.length) {
        console.error('\nNEW tenant tables not covered by the export (add to SUPPLEMENTARY_TABLES, exclude with a reason in coverage.ts, or justify):\n  ' + fresh.join('\n  '));
        failed = true;
      }
    }
  }
  if (failed) process.exit(1);
  if (args.has('--check') || args.has('--strict')) console.log('OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
