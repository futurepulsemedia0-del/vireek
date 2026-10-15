#!/usr/bin/env node
/**
 * Vireek — Supabase migration version guard.
 *
 * Supabase stores one row per migration in supabase_migrations.schema_migrations with the
 * 14-digit prefix as PRIMARY KEY. Two files sharing a prefix therefore break `db reset` /
 * `db push`, and files that don't match `<digits>_<name>.sql` are silently skipped.
 *
 * Commands (zero dependencies, Node >= 18):
 *   check            Exit 1 on duplicate versions, non-canonical prefixes or ignored files. (CI)
 *   plan             Dry run: print the renumbering that would be applied. Changes nothing.
 *   apply            Rename files on disk (git mv when available) + write the old->new map.
 *   repair-script    Print a bash script of `supabase migration repair` calls for databases
 *                    that already recorded the old versions (reads the map written by apply).
 *
 * Ordering contract: the CLI applies migrations in bytewise filename order. Renumbering uses a
 * greedy `new = max(old, previous_new + 1)` pass over that exact order, so execution order is
 * preserved and only the files that must move are touched.
 *
 * Flags: --dir <path> (default supabase/migrations)  --map <path> (default supabase/migration-renumber-map.json)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = flag('dir', 'supabase/migrations');
const MAP_FILE = flag('map', 'supabase/migration-renumber-map.json');

const CANONICAL = /^(\d{14})_(.+)\.sql$/;
const SHORT = /^(\d{8})_(.+)\.sql$/; // e.g. 20260915_phone_numbers.sql
const LOOKS_LIKE_MIGRATION = /^\d+_/;

/** Read + classify migration files. Returns { entries, ignored }. */
function scan(dir) {
  if (!existsSync(dir)) fail(`Migrations directory not found: ${dir}`);
  // Bytewise sort == Go os.ReadDir order used by the Supabase CLI. Do NOT use localeCompare.
  const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = [];
  const ignored = [];
  for (const name of names) {
    let m = CANONICAL.exec(name);
    if (m) {
      entries.push({ name, slug: m[2], version: m[1], canonical: true });
    } else if ((m = SHORT.exec(name))) {
      entries.push({ name, slug: m[2], version: m[1].padEnd(14, '0'), canonical: false });
    } else if (LOOKS_LIKE_MIGRATION.test(name)) {
      ignored.push(name); // e.g. *.sq typo: the CLI skips it, so it is NEVER applied
    }
  }
  return { entries, ignored };
}

/** Greedy order-preserving unique renumbering. */
function buildPlan(entries) {
  let last = 0n;
  return entries.map((e) => {
    const old = BigInt(e.version);
    const next = old > last ? old : last + 1n;
    last = next;
    const version = String(next);
    return { ...e, newVersion: version, newName: `${version}_${e.slug}.sql`, changed: version !== e.version || !e.canonical };
  });
}

function duplicates(entries) {
  const by = new Map();
  for (const e of entries) by.set(e.version, [...(by.get(e.version) ?? []), e.name]);
  return [...by].filter(([, files]) => files.length > 1);
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function report({ entries, ignored }) {
  const dups = duplicates(entries);
  const short = entries.filter((e) => !e.canonical);
  for (const [v, files] of dups) console.error(`✖ duplicate version ${v}:\n    ${files.join('\n    ')}`);
  for (const e of short) console.error(`✖ non-canonical (not 14 digits): ${e.name}`);
  for (const n of ignored) console.error(`✖ ignored by Supabase CLI (must end in .sql): ${n}`);
  return { dups, short, ignored, ok: !dups.length && !short.length && !ignored.length };
}

function printPlan(plan) {
  const changed = plan.filter((p) => p.changed);
  console.log(`${plan.length} migrations, ${changed.length} need renaming (execution order preserved).\n`);
  for (const p of changed) console.log(`  ${p.name}\n    -> ${p.newName}`);
}

function main() {
  const scanned = scan(DIR);

  if (command === 'check') {
    const r = report(scanned);
    if (!r.ok) {
      console.error(`\nFix with: node scripts/migrations-dedupe.mjs plan  &&  node scripts/migrations-dedupe.mjs apply`);
      process.exit(1);
    }
    console.log(`✔ ${scanned.entries.length} migrations, all versions unique and canonical.`);
    return;
  }

  if (scanned.ignored.length) {
    fail(
      `Files ignored by the CLI must be fixed by hand first (rename to .sql, or delete if obsolete):\n  ${scanned.ignored.join('\n  ')}\n` +
        `If a .sql twin exists, diff both and keep one — do not renumber blindly.`,
    );
  }
  const plan = buildPlan(scanned.entries);
  if (new Set(plan.map((p) => p.newVersion)).size !== plan.length) fail('Internal error: renumbering is not unique.');

  if (command === 'plan') return printPlan(plan);

  if (command === 'apply') {
    const changed = plan.filter((p) => p.changed);
    if (!changed.length) return console.log('Nothing to do.');
    const existing = new Set(readdirSync(DIR));
    for (const p of changed) {
      if (existing.has(p.newName) && p.newName !== p.name) fail(`Target already exists: ${p.newName}`);
    }
    // Write the map first so an interrupted run can still produce repair commands.
    const map = changed.map((p) => ({ oldVersion: p.version, oldName: p.name, newVersion: p.newVersion, newName: p.newName }));
    writeFileSync(MAP_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), renames: map }, null, 2) + '\n');
    for (const p of changed) {
      const from = path.join(DIR, p.name);
      const to = path.join(DIR, p.newName);
      try {
        execFileSync('git', ['mv', from, to], { stdio: 'ignore' });
      } catch {
        renameSync(from, to);
      }
    }
    // Post-verify: unique/canonical AND identical relative order.
    const after = scan(DIR);
    if (!report(after).ok) fail('Post-apply verification failed.');
    const expected = plan.map((p) => p.newName);
    if (JSON.stringify(after.entries.map((e) => e.name)) !== JSON.stringify(expected)) fail('Execution order changed — aborting; inspect with git status.');
    console.log(`✔ Renamed ${changed.length} files. Map written to ${MAP_FILE}. Order verified.`);
    return;
  }

  if (command === 'repair-script') {
    if (!existsSync(MAP_FILE)) fail(`Map not found: ${MAP_FILE} (run \`apply\` first).`);
    const { renames } = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
    const live = new Set(scan(DIR).entries.map((e) => e.version));
    const stale = [...new Set(renames.map((r) => r.oldVersion))].filter((v) => !live.has(v));
    const fresh = renames.map((r) => r.newVersion);
    const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', '# Run ONLY after the runbook pre-checks (schema parity). Requires: supabase link --project-ref <ref>', ''];
    lines.push('# 1) Drop stale history rows that no longer have a local file');
    for (const c of chunk(stale, 20)) lines.push(`supabase migration repair --status reverted ${c.join(' ')}`);
    lines.push('', '# 2) Record renamed files as applied under their new versions');
    for (const c of chunk(fresh, 20)) lines.push(`supabase migration repair --status applied ${c.join(' ')}`);
    lines.push('', 'supabase migration list');
    console.log(lines.join('\n'));
    return;
  }

  fail(`Unknown command "${command}". Use: check | plan | apply | repair-script`);
}

main();
