#!/usr/bin/env node
// scripts/data/check-data-product-gates.mjs
//
// CI gate: every external data endpoint references an approved-review check.
//   node scripts/data/check-data-product-gates.mjs            # check (exit 1 on any error)
//
// Static, regex-level checks over the checked-out tree. It proves the WIRING exists; it does not prove that a review
// has been approved in any database, and it cannot discover an endpoint nobody described (see "Limits" in
// docs/data/monetization-ethics.md). Checks:
//   1. docs/data/external-data-endpoints.json is well formed; every function exists.
//   2. Each registered function calls assertDataProductApproved(<client>, "<productKey>", "<function>", ...) with its own literals.
//   3. Each productKey and endpoint appears in a migration that creates data_product_reviews rows (a review path exists).
//   4. No function outside the registry imports _shared/data-products/guard, and none announces itself as a
//      partner-facing / subscriber / public-egress / data-product endpoint in its header without being registered or exempted.
//   5. The criteria ids in docs/data/monetization-ethics.md equal data_product_required_criteria() in the migration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const REGISTRY = 'docs/data/external-data-endpoints.json';
export const DOC = 'docs/data/monetization-ethics.md';
const FN_DIR = 'supabase/functions';
const MIG_DIR = 'supabase/migrations';
const KEY_RE = /^[a-z0-9_]{2,48}$/;
const HEADER_RE = /partner-facing|subscriber api|public egress|data product/i;

const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function callPattern(productKey, fn) {
  return new RegExp(`assertDataProductApproved\\(\\s*[\\w.]+\\s*,\\s*["']${esc(productKey)}["']\\s*,\\s*["']${esc(fn)}["']`);
}

export function criteriaFromDoc(md) {
  return [...new Set([...md.matchAll(/^\|\s*(E\d+)\s*\|/gm)].map((m) => m[1]))].sort();
}
export function criteriaFromSql(sql) {
  const m = /data_product_required_criteria\(\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(sql);
  return m ? [...m[1].matchAll(/'(E\d+)'/g)].map((x) => x[1]).sort() : [];
}

export function check(root = ROOT) {
  const errors = [];
  const err = (m) => errors.push(m);
  let reg;
  try { reg = JSON.parse(read(root, REGISTRY)); } catch (e) { return [`${REGISTRY}: cannot read or parse (${e.message})`]; }
  if (!Array.isArray(reg.endpoints) || !Array.isArray(reg.exempt ?? [])) return [`${REGISTRY}: "endpoints" and "exempt" must be arrays`];

  const migDir = path.join(root, MIG_DIR);
  const migs = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).map((f) => ({ f, sql: read(root, `${MIG_DIR}/${f}`) })) : [];
  const reviewMigs = migs.filter((m) => /data_product_reviews/.test(m.sql));
  if (!reviewMigs.length) err('no migration creates data_product_reviews');

  const seenFn = new Set();
  const registered = new Set();
  for (const e of reg.endpoints) {
    const { function: fn, productKey } = e ?? {};
    if (!fn || !/^[a-z0-9-]+$/.test(fn)) { err(`registry: invalid function name "${fn}"`); continue; }
    if (!KEY_RE.test(productKey ?? '')) { err(`registry: ${fn}: productKey "${productKey}" must match ${KEY_RE}`); continue; }
    if (seenFn.has(fn)) err(`registry: ${fn} listed twice`);
    seenFn.add(fn); registered.add(fn);
    const file = `${FN_DIR}/${fn}/index.ts`;
    if (!fs.existsSync(path.join(root, file))) { err(`registry: ${file} does not exist`); continue; }
    const src = read(root, file);
    if (!callPattern(productKey, fn).test(src)) err(`${file}: must call assertDataProductApproved(<client>, "${productKey}", "${fn}", ...) before returning product data`);
    if (!/from\s+["']\.\.\/_shared\/data-products\/guard\.ts["']/.test(src)) err(`${file}: must import ../_shared/data-products/guard.ts`);
    if (!reviewMigs.some((m) => m.sql.includes(`'${productKey}'`) && m.sql.includes(`'${fn}'`))) err(`${fn}: no migration seeds a review for product "${productKey}" covering endpoint "${fn}"`);
  }

  const exempt = new Map((reg.exempt ?? []).map((x) => [x?.function, x?.reason]));
  for (const [fn, reason] of exempt) if (!fn || !reason || String(reason).trim().length < 15) err(`registry: exempt entry "${fn}" needs a reason of at least 15 characters`);

  const fnRoot = path.join(root, FN_DIR);
  for (const name of fs.existsSync(fnRoot) ? fs.readdirSync(fnRoot) : []) {
    const file = `${FN_DIR}/${name}/index.ts`;
    if (name.startsWith('_') || !fs.existsSync(path.join(root, file))) continue;
    if (registered.has(name) || exempt.has(name)) continue;
    const src = read(root, file);
    if (/_shared\/data-products\/guard/.test(src)) err(`${file}: uses the data-product guard but is not listed in ${REGISTRY}`);
    else if (HEADER_RE.test(src.split('\n').slice(0, 60).join('\n'))) err(`${file}: header describes an external data endpoint but it is not in ${REGISTRY} (register it, or exempt it with a reason)`);
  }

  try {
    const docIds = criteriaFromDoc(read(root, DOC));
    const sqlIds = reviewMigs.map((m) => criteriaFromSql(m.sql)).find((x) => x.length) ?? [];
    if (!docIds.length) err(`${DOC}: no criteria table rows (| E1 | ...) found`);
    else if (JSON.stringify(docIds) !== JSON.stringify(sqlIds)) err(`criteria drift: ${DOC} has [${docIds}] but data_product_required_criteria() has [${sqlIds}]`);
  } catch (e) { err(`${DOC}: cannot read (${e.message})`); }

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = check();
  if (errors.length) { console.error(`Data product gate check FAILED (${errors.length}):`); for (const e of errors) console.error(`  - ${e}`); process.exit(1); }
  const n = JSON.parse(read(ROOT, REGISTRY)).endpoints.length;
  console.log(`Data product gate check passed (${n} external data endpoints reference an approval check).`);
}
