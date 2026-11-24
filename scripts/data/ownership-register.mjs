#!/usr/bin/env node
// scripts/data/ownership-register.mjs
//
// Data ownership register: one row per public table in the migration-replayed schema, with
// data class, steward role, ownership category [COUNSEL] and a retention link.
//
//   node scripts/data/ownership-register.mjs --write            regenerate docs/data/ownership-register.md (+ prune the baseline)
//   node scripts/data/ownership-register.mjs --check            CI gate (read-only; exit 1 on any error)
//   node scripts/data/ownership-register.mjs --init-baseline    first-time seeding of the "inferred" baseline (refuses if it exists; --force to overwrite)
//   node scripts/data/ownership-register.mjs --explain <table>  show how one table is classified and why
//
// Sources of truth (this script invents nothing):
//   schema          scripts/security/rls-audit.mjs replay() of supabase/migrations (handles DROP / RENAME), the same model
//                   the RLS and tenant-isolation gates use
//   classification  docs/data/ownership-register.data.json  (vocabulary, ordered inference rules, reviewed entries)
//   retention       supabase/functions/_shared/compliance/ownedTables.ts + src/lib/dataGovernance.ts  (never a number of days)
//   ratchet         docs/data/ownership-register.baseline.json  (tables allowed to keep an INFERRED row; may only shrink)
//
// Review states:
//   reviewed  an explicit entry in the data file. Required for every NEW table.
//   inferred  produced by a name/column rule. Allowed only for tables frozen in the baseline. A heuristic, not a decision.
//
// What this proves: the checked-out source tree. It does NOT prove production state, and the ownership column is an
// engineering proposal, NOT a legal conclusion (every category is [COUNSEL]).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../security/rls-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const PATHS = {
  data: 'docs/data/ownership-register.data.json',
  baseline: 'docs/data/ownership-register.baseline.json',
  md: 'docs/data/ownership-register.md',
  owned: 'supabase/functions/_shared/compliance/ownedTables.ts',
  governance: 'src/lib/dataGovernance.ts',
};

export const TENANT_COLUMNS = ['user_id', 'account_owner_id', 'owner_id'];

/** Closed vocabularies. Adding a value is a deliberate edit here AND in the legend of the generated doc. */
export const DATA_CLASSES = Object.freeze({
  credential_secret: 'Secrets, key and token hashes, OAuth or connection credentials',
  personal_sensitive: 'Recordings, transcripts, voice or biometric-adjacent data, bank data, precise location, identity documents',
  personal_contact: 'Identity or contact data of a tenant’s customers, callers, leads, team members or applicants',
  financial_record: 'Invoices, payments, payroll, ledger, tax and billing records',
  tenant_business: 'Non-personal business operations of one tenant (jobs, schedules, inventory, assets, pricing)',
  tenant_config: 'Tenant settings, preferences, templates, rules and flags',
  compliance_evidence: 'Consent, disclosure, DSAR, retention, legal-hold and control evidence',
  audit_security_log: 'Audit trails, access logs and security events',
  telemetry_operational: 'Queues, rate limits, run logs, webhook logs and health probes',
  derived_analytics: 'Scores, forecasts, benchmarks, cross-tenant aggregates, embeddings and AI outputs computed by Vireek',
  platform_reference: 'Platform catalogs, taxonomies and public content with no tenant data',
  vireek_internal: 'Vireek’s own commercial or operational records (sales, staff, marketing, support)',
  unclassified: 'No rule matched. Allowed only as an INFERRED baseline row; never in a reviewed entry',
});

/** Stewards are ROLES, never people. Vocabulary = .github/CODEOWNERS tokens + docs/OWNERS.md areas. Owners are still TBD there. */
export const STEWARDS = Object.freeze([
  'platform', 'backend', 'data', 'security', 'compliance', 'voice', 'frontend', 'mobile', 'billing', 'integrations', 'support',
]);

export const OWNERSHIP = Object.freeze({
  customer: 'Supplied by, or generated about, one tenant’s own business. The tenant is the data owner / controller.',
  derived: 'Computed by Vireek from customer data (scores, aggregates, models, AI output). Who owns it is open.',
  vireek: 'Vireek’s own records, or platform content that contains no customer data.',
});

export const RETENTION_KINDS = Object.freeze({
  configurable: 'A tenant retention policy can sweep this table (`data_retention_policies`, `data-retention-sweep`). Period is tenant-set; no default period exists.',
  'erasure-only': 'Removed by `delete-account` (listed in `OWNED_TABLES`). No retention period is defined.',
  documented: 'An explicit entry points to the document that governs retention.',
  none: 'No retention rule found in the repository. This is a gap; see the policy draft.',
});

const GAP_DOC = 'docs/compliance/policies/data-classification-retention.md';

// ------------------------------------------------------------------ data file
export function validateDataFile(data) {
  const errors = [];
  const bad = (m) => errors.push(`data file: ${m}`);
  if (!data || typeof data !== 'object') return ['data file: not an object'];
  if (!Array.isArray(data.rules)) bad('"rules" must be an array');
  if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) bad('"entries" must be an object');
  const seen = new Set();
  for (const r of data.rules ?? []) {
    const id = r?.id ?? '(no id)';
    if (!r?.id || !/^[a-z0-9-]+$/.test(r.id)) bad(`rule ${id}: id must match [a-z0-9-]+`);
    else if (seen.has(r.id)) bad(`rule ${id}: duplicate id`);
    else seen.add(r.id);
    try { new RegExp(r.match); } catch { bad(`rule ${id}: "match" is not a valid regular expression`); }
    if (r.tenantKey !== undefined && !['present', 'absent'].includes(r.tenantKey)) bad(`rule ${id}: tenantKey must be "present" or "absent"`);
    errors.push(...fieldErrors(`rule ${id}`, r, { allowUnclassified: false }));
  }
  for (const [table, e] of Object.entries(data.entries ?? {})) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) bad(`entry "${table}": not a valid table name`);
    errors.push(...fieldErrors(`entry "${table}"`, e, { allowUnclassified: false }));
    if (e?.retentionRef !== undefined && !/^[\w./-]+(#[\w-]+)?$/.test(String(e.retentionRef))) errors.push(`entry "${table}": retentionRef must be a repo-relative path with an optional #anchor`);
  }
  return errors;
}

function fieldErrors(who, o, { allowUnclassified }) {
  const out = [];
  if (!o || typeof o !== 'object') return [`${who}: not an object`];
  if (!(o.dataClass in DATA_CLASSES) || (!allowUnclassified && o.dataClass === 'unclassified')) out.push(`${who}: dataClass "${o.dataClass}" is not allowed (one of ${Object.keys(DATA_CLASSES).filter((k) => allowUnclassified || k !== 'unclassified').join(', ')})`);
  if (!STEWARDS.includes(o.steward)) out.push(`${who}: steward "${o.steward}" is not a known role (one of ${STEWARDS.join(', ')})`);
  if (!(o.ownership in OWNERSHIP)) out.push(`${who}: ownership "${o.ownership}" must be one of ${Object.keys(OWNERSHIP).join(', ')}`);
  return out;
}

// ------------------------------------------------------------------ retention inputs
export function parseOwnedTables(ts) {
  const out = new Map();
  for (const m of ts.matchAll(/\{\s*table:\s*"(\w+)"([^}]*)\}/g)) out.set(m[1], { dateColumn: /dateColumn:\s*"(\w+)"/.exec(m[2])?.[1] ?? null });
  return out;
}
export function parseGovernableDatasets(ts) {
  const block = /GOVERNABLE_DATASETS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(ts)?.[1] ?? '';
  return new Set([...block.matchAll(/id:\s*'(\w+)'/g)].map((m) => m[1]));
}

export function retentionFor(table, entry, { owned, governable }) {
  const o = owned.get(table);
  if (o?.dateColumn && governable.has(table)) return { kind: 'configurable', label: `configurable: ${table}` };
  if (o) return { kind: 'erasure-only', label: 'erasure-only' };
  if (entry?.retentionRef) return { kind: 'documented', label: String(entry.retentionRef), href: String(entry.retentionRef) };
  return { kind: 'none', label: 'none defined', href: GAP_DOC };
}

// ------------------------------------------------------------------ classification
export function tenantKeyOf(model) {
  const cols = model?.cols;
  const has = (c) => (cols instanceof Map ? cols.has(c) : Boolean(cols && c in cols));
  return TENANT_COLUMNS.find(has) ?? null;
}

export function classify(table, model, data) {
  const tenantKey = tenantKeyOf(model);
  const entry = data.entries[table];
  if (entry) return { table, tenantKey, status: 'reviewed', via: 'entry', entry, dataClass: entry.dataClass, steward: entry.steward, ownership: entry.ownership };
  for (const r of data.rules) {
    if (r.tenantKey === 'present' && !tenantKey) continue;
    if (r.tenantKey === 'absent' && tenantKey) continue;
    if (new RegExp(r.match).test(table)) return { table, tenantKey, status: 'inferred', via: `rule:${r.id}`, entry: null, dataClass: r.dataClass, steward: r.steward, ownership: r.ownership };
  }
  return tenantKey
    ? { table, tenantKey, status: 'inferred', via: 'default:tenant-scoped', entry: null, dataClass: 'tenant_business', steward: 'data', ownership: 'customer' }
    : { table, tenantKey, status: 'inferred', via: 'default:no-rule', entry: null, dataClass: 'unclassified', steward: 'data', ownership: 'vireek' };
}

export function buildRegister(tables, data, retentionCtx) {
  const names = [...(tables instanceof Map ? tables.keys() : Object.keys(tables))].sort();
  const get = (n) => (tables instanceof Map ? tables.get(n) : tables[n]);
  return names.map((table) => {
    const row = classify(table, get(table), data);
    return { ...row, retention: retentionFor(table, row.entry, retentionCtx), rls: Boolean(get(table)?.rls) };
  });
}

// ------------------------------------------------------------------ gate
export function gate({ rows, data, baseline }) {
  const errors = [];
  errors.push(...validateDataFile(data));
  const names = new Set(rows.map((r) => r.table));
  const base = new Set(baseline?.tables ?? []);
  for (const r of rows) {
    if (r.status === 'reviewed') {
      if (base.has(r.table)) errors.push(`table "${r.table}" has a reviewed entry but is still in the baseline — run --write to prune it`);
    } else if (!base.has(r.table)) {
      errors.push(`table "${r.table}" has no ownership-register entry. Add one to ${PATHS.data} under "entries" (dataClass, steward, ownership; use ${GAP_DOC} for retention gaps). Inferred rows are frozen for legacy tables only (${r.via}).`);
    }
  }
  for (const t of Object.keys(data.entries ?? {})) if (!names.has(t)) errors.push(`entry "${t}" matches no table in supabase/migrations (dropped or renamed?) — remove it from ${PATHS.data}`);
  for (const t of base) if (!names.has(t)) errors.push(`baseline lists "${t}" which is not in the schema — run --write to prune it`);
  return errors;
}

// ------------------------------------------------------------------ rendering
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const count = (rows, f) => rows.reduce((m, r) => m.set(f(r), (m.get(f(r)) ?? 0) + 1), new Map());
const tally = (m, order) => [...m.entries()].sort((a, b) => (order ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));

function retentionCell(r) {
  const k = r.retention;
  if (k.kind === 'configurable') return `[configurable](#r-configurable) (\`${r.table}\`)`;
  if (k.kind === 'erasure-only') return '[erasure-only](#r-erasure-only)';
  if (k.kind === 'documented') return `[documented](../../${k.href.split('#')[0]}${k.href.includes('#') ? `#${k.href.split('#')[1]}` : ''})`;
  return `[none](../../${k.href})`;
}

export function renderMd(rows) {
  const total = rows.length;
  const reviewed = rows.filter((r) => r.status === 'reviewed').length;
  const L = [];
  L.push('# Data ownership register', '');
  L.push('> **Generated — do not edit by hand.** Source: `scripts/data/ownership-register.mjs` over `supabase/migrations`, classification in `docs/data/ownership-register.data.json`. Regenerate with `npm run data:register`; CI runs `npm run data:register:check`.', '>');
  L.push('> **Status: engineering proposal, not a legal position.** The ownership category in every row is **[COUNSEL]**: it records how engineering reads the data model, and it is not a conclusion about legal ownership, controller/processor roles or licence rights. Nothing here is a compliance claim (see `src/lib/trust/claims.ts`). Retention periods are not defined anywhere in the repository; this register only links to the mechanism that exists (or says there is none).', '>');
  L.push('> **Scope:** public tables in the final replayed schema (CREATE / ALTER / DROP / RENAME). A static read of the checked-out tree; nothing was run against a live database ([VERIFY] against `npm run db:audit`).', '');
  L.push('## 1. Summary', '');
  L.push(`| | Tables |`, '|---|---:|', `| In the register | ${total} |`, `| **reviewed** (explicit entry) | ${reviewed} |`, `| **inferred** (name/column rule; frozen legacy baseline, may only shrink) | ${total - reviewed} |`, `| of which \`unclassified\` (no rule matched) | ${rows.filter((r) => r.dataClass === 'unclassified').length} |`, '');
  const block = (title, m, order) => { L.push(`| ${title} | Tables |`, '|---|---:|'); for (const [k, v] of tally(m, order)) L.push(`| \`${k}\` | ${v} |`); L.push(''); };
  block('Data class', count(rows, (r) => r.dataClass), Object.keys(DATA_CLASSES));
  block('Ownership category [COUNSEL]', count(rows, (r) => r.ownership), Object.keys(OWNERSHIP));
  block('Steward role', count(rows, (r) => r.steward), [...STEWARDS]);
  block('Retention link', count(rows, (r) => r.retention.kind), Object.keys(RETENTION_KINDS));

  L.push('## 2. Legend', '', '### Data classes', '', '| Class | Meaning |', '|---|---|');
  for (const [k, v] of Object.entries(DATA_CLASSES)) L.push(`| \`${k}\` | ${esc(v)} |`);
  L.push('', '### Ownership category [COUNSEL]', '', '| Category | Working meaning (engineering) |', '|---|---|');
  for (const [k, v] of Object.entries(OWNERSHIP)) L.push(`| \`${k}\` | ${esc(v)} |`);
  L.push('', '### Steward role', '', `A **role**, not a person: ${STEWARDS.map((s) => `\`${s}\``).join(', ')} (the \`.github/CODEOWNERS\` tokens plus the \`docs/OWNERS.md\` areas). Named owners are still TBD in \`docs/OWNERS.md\`; until they are assigned, a steward role means "the team that must answer for this table".`);
  L.push('', '### Retention link', '');
  for (const [k, v] of Object.entries(RETENTION_KINDS)) L.push(`<a id="r-${k}"></a>**\`${k}\`** — ${v}  `);
  L.push('', '### Scope key', '', 'The first tenant column found (`user_id`, `account_owner_id`, `owner_id`); `—` means the table has none (platform-wide or keyed another way). Account-owner scoping follows the existing `accountOwnerId` / RLS pattern; this column does not replace the RLS audit.', '');

  const counsel = rows.filter((r) => r.entry?.counsel);
  L.push('## 3. Open [COUNSEL] questions raised by reviewed entries', '');
  if (!counsel.length) L.push('_None recorded._', '');
  else { L.push('| Table | Question |', '|---|---|'); for (const r of counsel) L.push(`| \`${r.table}\` | ${esc(r.entry.counsel)} |`); L.push(''); }

  L.push('## 4. Adding a table', '', '1. Add the migration that creates the table.', `2. Add an entry to \`${PATHS.data}\` under \`entries\`: \`{ "dataClass": "...", "steward": "...", "ownership": "customer|derived|vireek" }\`, optionally \`retentionRef\` (repo path, optional \`#anchor\`) and \`counsel\` (the open legal question).`, '3. Run `npm run data:register` and commit the regenerated register.', '', 'CI (`npm run data:register:check`) fails when a table has no entry, when the register is stale, when an entry names a table that no longer exists, or when a vocabulary value is invalid. Inferred rows are frozen for legacy tables in `docs/data/ownership-register.baseline.json`; promoting a table to a reviewed entry removes it from the baseline automatically.', '');

  L.push('## 5. Register', '', '| Table | Data class | Steward | Ownership [COUNSEL] | Retention | Scope key | Review |', '|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| \`${r.table}\` | \`${r.dataClass}\` | ${r.steward} | ${r.ownership} | ${retentionCell(r)} | ${r.tenantKey ? `\`${r.tenantKey}\`` : '—'} | ${r.status} |`);
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ IO
const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (root, p) => fs.existsSync(path.join(root, p));

export function loadAll(root = ROOT) {
  const data = JSON.parse(read(root, PATHS.data));
  const baseline = exists(root, PATHS.baseline) ? JSON.parse(read(root, PATHS.baseline)) : null;
  const { tables } = load(root);
  const retentionCtx = { owned: parseOwnedTables(read(root, PATHS.owned)), governable: parseGovernableDatasets(read(root, PATHS.governance)) };
  const rows = buildRegister(tables, data, retentionCtx);
  return { data, baseline, rows, retentionCtx };
}

const sortedJson = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** Full CI check for a repository root: returns every error (empty = pass). Used by --check and by the tests. */
export function checkRoot(root = ROOT) {
  const { data, baseline, rows } = loadAll(root);
  if (!baseline) return { errors: ['baseline missing — run --init-baseline'], rows };
  const errors = gate({ rows, data, baseline });
  if (!exists(root, PATHS.md) || read(root, PATHS.md) !== renderMd(rows)) errors.push(`${PATHS.md} is stale — run: npm run data:register`);
  return { errors, rows };
}

function main(argv, root = ROOT) {
  const args = new Set(argv);
  const { data, baseline, rows } = loadAll(root);
  const out = (p) => path.join(root, p);
  const unreviewed = rows.filter((r) => r.status !== 'reviewed').map((r) => r.table);

  if (args.has('--explain')) {
    const t = argv[argv.indexOf('--explain') + 1];
    const r = rows.find((x) => x.table === t);
    if (!r) { console.error(`unknown table "${t}"`); process.exit(2); }
    console.log(JSON.stringify({ table: r.table, status: r.status, via: r.via, dataClass: r.dataClass, steward: r.steward, ownership: r.ownership, retention: r.retention, scopeKey: r.tenantKey }, null, 2));
    return;
  }

  if (args.has('--init-baseline')) {
    if (baseline && !args.has('--force')) { console.error('baseline already exists; it may only shrink. Use --force only to reset deliberately.'); process.exit(2); }
    fs.writeFileSync(out(PATHS.baseline), sortedJson({ note: 'Tables allowed to keep an INFERRED ownership-register row. May only shrink: add a reviewed entry to ownership-register.data.json and --write prunes it. NEVER add a new table here.', tables: unreviewed }));
    console.log(`baseline written: ${unreviewed.length} tables`);
    return;
  }

  if (args.has('--write')) {
    if (!baseline) { console.error('no baseline yet; run --init-baseline first.'); process.exit(2); }
    const names = new Set(rows.map((r) => r.table));
    const pruned = baseline.tables.filter((t) => names.has(t) && unreviewed.includes(t));
    if (pruned.length !== baseline.tables.length) fs.writeFileSync(out(PATHS.baseline), sortedJson({ ...baseline, tables: pruned }));
    fs.mkdirSync(path.dirname(out(PATHS.md)), { recursive: true });
    fs.writeFileSync(out(PATHS.md), renderMd(rows));
    console.log(`wrote ${PATHS.md} (${rows.length} tables, ${rows.length - unreviewed.length} reviewed); baseline ${baseline.tables.length} -> ${pruned.length}`);
    return;
  }

  if (args.has('--check')) {
    const { errors } = checkRoot(root);
    if (errors.length) { console.error(`Ownership register gate FAILED (${errors.length}):`); for (const e of errors.slice(0, 60)) console.error(`  - ${e}`); if (errors.length > 60) console.error(`  … and ${errors.length - 60} more`); process.exit(1); }
    console.log(`Ownership register gate passed (${rows.length} tables; ${rows.length - unreviewed.length} reviewed, ${unreviewed.length} inferred in baseline).`);
    return;
  }

  console.log(JSON.stringify({ tables: rows.length, reviewed: rows.length - unreviewed.length, inferred: unreviewed.length, unclassified: rows.filter((r) => r.dataClass === 'unclassified').length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
