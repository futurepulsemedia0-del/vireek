#!/usr/bin/env node
// scripts/compliance/check-data-sources.mjs
// Drift guard for the data_sources registry (supabase/migrations/*data_sources_registry*.sql).
// For the two functions in scope it extracts, from CODE, every external host that receives data and
// fails when a host is missing from the registry seed, or when a seeded row points at a function that
// does not exist. Literal-string heuristic: a host built at runtime would not be seen — treat a pass as
// "no unregistered literal host", not as proof that nothing else leaves the system.
//   node scripts/compliance/check-data-sources.mjs          # report + exit 1 on drift
//   node scripts/compliance/check-data-sources.mjs --json   # machine-readable
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = 'supabase/functions';
const MIG = 'supabase/migrations';

/** Hosts that are Vireek itself or tooling, never a data recipient. */
export const IGNORED_HOSTS = new Set(['vireek.com', 'www.vireek.com', 'localhost']);

export function extractHosts(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[/:?"'`\s)]|$)/gi)) {
    const h = m[1].toLowerCase();
    if (!IGNORED_HOSTS.has(h)) out.add(h);
  }
  return [...out].sort();
}

/** Providers on the continual_identity_learner route, read from registry.ts (not hard-coded here). */
export function identityRouteProviders(registrySrc) {
  const chain = (name) => [...(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(registrySrc)?.[1] ?? '').matchAll(/provider:\s*"(\w+)"/g)].map((m) => m[1]);
  const def = chain('DEFAULT_CHAIN');
  const routeUsesJson = /continual_identity_learner:\s*JSON_CHAIN/.test(registrySrc);
  const exclusion = /JSON_CHAIN[^=]*=\s*DEFAULT_CHAIN\.filter\(\(e\)\s*=>\s*e\.provider\s*!==\s*"(\w+)"\)/.exec(registrySrc)?.[1];
  if (!routeUsesJson) return null; // route no longer uses the JSON chain: caller must review
  return def.filter((p) => p !== exclusion);
}

/** Hosts in the registry seed: bare-host strings inside any ARRAY[...] of an INSERT INTO public.data_sources. */
export function registrySeedHosts(sql) {
  const hosts = new Set();
  const used = [];
  for (const stmt of sql.split(/;\s*\n/).filter((s) => /INSERT\s+INTO\s+public\.data_sources/i.test(s))) {
    for (const arr of stmt.matchAll(/ARRAY\[([^\]]*)\]/g)) {
      for (const s of arr[1].matchAll(/'([a-z0-9][a-z0-9.-]*\.[a-z]{2,})'/g)) hosts.add(s[1].toLowerCase());
    }
    // used_by is the last ARRAY of each tuple: ARRAY['fn'])[,]
    for (const m of stmt.matchAll(/ARRAY\['([a-z0-9-]+)'\]\s*\)\s*[,\n]/g)) used.push(m[1]);
  }
  return { hosts, usedBy: [...new Set(used)] };
}

export function analyse(root = ROOT) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const code = new Map(); // host -> sources of evidence
  const note = (host, where) => code.set(host, [...(code.get(host) ?? []), where]);

  for (const h of extractHosts(read(`${FN}/property-intelligence-enrich/index.ts`))) note(h, 'property-intelligence-enrich');

  const routeProviders = identityRouteProviders(read(`${FN}/_shared/ai-core/registry.ts`));
  const problems = [];
  if (routeProviders === null) problems.push('continual_identity_learner no longer uses JSON_CHAIN in ai-core/registry.ts: review the AI rows of data_sources.');
  for (const p of routeProviders ?? []) {
    const f = `${FN}/_shared/ai-core/providers/${p}.ts`;
    if (!existsSync(join(root, f))) { problems.push(`provider adapter missing: ${f}`); continue; }
    for (const h of extractHosts(read(f))) note(h, `identity-signal-scan via ai-core/${p}`);
  }

  const migs = readdirSync(join(root, MIG)).filter((n) => /data_sources_registry.*\.sql$/.test(n));
  if (migs.length === 0) problems.push('no data_sources registry migration found');
  const seeded = { hosts: new Set(), usedBy: [] };
  for (const m of migs) {
    const s = registrySeedHosts(read(`${MIG}/${m}`));
    s.hosts.forEach((h) => seeded.hosts.add(h));
    seeded.usedBy.push(...s.usedBy);
  }

  const unregistered = [...code.keys()].filter((h) => !seeded.hosts.has(h)).sort();
  const stale = [...seeded.hosts].filter((h) => !code.has(h)).sort(); // registered but no longer in code: info only
  const missingFns = [...new Set(seeded.usedBy)].filter((f) => !existsSync(join(root, `${FN}/${f}/index.ts`))).sort();
  return { code: Object.fromEntries(code), unregistered, stale, missingFns, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = analyse();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`hosts called from code: ${Object.keys(r.code).length}`);
    for (const [h, w] of Object.entries(r.code)) console.log(`  ${h}  <- ${[...new Set(w)].join(', ')}`);
    if (r.stale.length) console.log(`registered but not found in code (review, not a failure): ${r.stale.join(', ')}`);
  }
  const bad = [
    ...r.unregistered.map((h) => `UNREGISTERED host: ${h}`),
    ...r.missingFns.map((f) => `registry points at missing function: ${f}`),
    ...r.problems,
  ];
  if (bad.length) { console.error('\ndata_sources drift:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('OK: every external host called by the in-scope functions is registered.');
}
