// scripts/data/ownership-register.test.mjs
// Run: node --test scripts/data/ownership-register.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PATHS, DATA_CLASSES, STEWARDS, OWNERSHIP, classify, buildRegister, gate, renderMd, retentionFor, validateDataFile,
  parseOwnedTables, parseGovernableDatasets, tenantKeyOf, checkRoot, loadAll, ROOT,
} from './ownership-register.mjs';

const model = (...cols) => ({ rls: true, cols: new Map(cols.map((c) => [c, 'uuid'])) });
const DATA = {
  rules: [
    { id: 'secrets', match: '(^|_)secrets?(_|$)', dataClass: 'credential_secret', steward: 'security', ownership: 'customer' },
    { id: 'settings', match: '_settings$', dataClass: 'tenant_config', steward: 'backend', ownership: 'customer', tenantKey: 'present' },
  ],
  entries: { calls: { dataClass: 'personal_sensitive', steward: 'voice', ownership: 'customer', counsel: 'Recording duties vary.' } },
};
const CTX = { owned: new Map([['calls', { dateColumn: 'created_at' }], ['pest_stock', { dateColumn: null }]]), governable: new Set(['calls']) };

test('entry wins over rules and is reviewed', () => {
  const r = classify('calls', model('user_id'), DATA);
  assert.deepEqual([r.status, r.via, r.dataClass, r.steward, r.ownership], ['reviewed', 'entry', 'personal_sensitive', 'voice', 'customer']);
});

test('rules are ordered, first match wins, and are inferred', () => {
  const r = classify('x_connection_secrets', model('user_id'), DATA);
  assert.equal(r.status, 'inferred');
  assert.equal(r.via, 'rule:secrets');
  assert.equal(r.dataClass, 'credential_secret');
});

test('tenantKey "present" rules skip tables without a tenant column', () => {
  assert.equal(classify('foo_settings', model('user_id'), DATA).via, 'rule:settings');
  assert.equal(classify('foo_settings', model('id'), DATA).via, 'default:no-rule');
});

test('defaults are honest: tenant-scoped => tenant_business/customer, otherwise unclassified', () => {
  const a = classify('widgets', model('account_owner_id'), DATA);
  assert.deepEqual([a.dataClass, a.ownership, a.tenantKey], ['tenant_business', 'customer', 'account_owner_id']);
  const b = classify('widgets', model('id'), DATA);
  assert.deepEqual([b.dataClass, b.tenantKey], ['unclassified', null]);
});

test('tenantKeyOf accepts Map and plain-object column models and prefers user_id', () => {
  assert.equal(tenantKeyOf(model('owner_id', 'user_id')), 'user_id');
  assert.equal(tenantKeyOf({ cols: { owner_id: 'uuid' } }), 'owner_id');
  assert.equal(tenantKeyOf({ cols: new Map() }), null);
  assert.equal(tenantKeyOf(undefined), null);
});

test('retention: configurable, erasure-only, documented, none — never a period', () => {
  assert.equal(retentionFor('calls', null, CTX).kind, 'configurable');
  assert.equal(retentionFor('pest_stock', null, CTX).kind, 'erasure-only');
  assert.deepEqual(retentionFor('audit_log', { retentionRef: 'docs/compliance/data-map.md#1-data-classes' }, CTX).kind, 'documented');
  const none = retentionFor('anything', null, CTX);
  assert.equal(none.kind, 'none');
  assert.match(none.href, /data-classification-retention\.md$/);
  for (const k of ['configurable', 'erasure-only', 'documented', 'none']) assert.doesNotMatch(JSON.stringify(retentionFor('calls', null, CTX)) + k, /\d+\s*days/i);
});

test('parsers read OWNED_TABLES and GOVERNABLE_DATASETS from the real sources', () => {
  const owned = parseOwnedTables(fs.readFileSync(path.join(ROOT, PATHS.owned), 'utf8'));
  assert.ok(owned.size >= 20);
  assert.equal(owned.get('calls').dateColumn, 'created_at');
  assert.equal(owned.get('pest_stock').dateColumn, null);
  const gov = parseGovernableDatasets(fs.readFileSync(path.join(ROOT, PATHS.governance), 'utf8'));
  for (const t of ['leads', 'calls', 'jobs', 'quotes', 'payment_requests', 'ai_insights', 'review_requests']) assert.ok(gov.has(t), t);
});

test('validateDataFile rejects bad vocabulary, bad regex, duplicate ids and unclassified entries', () => {
  const bad = {
    rules: [
      { id: 'a', match: '(', dataClass: 'tenant_config', steward: 'backend', ownership: 'customer' },
      { id: 'a', match: 'x', dataClass: 'nope', steward: 'backend', ownership: 'customer' },
      { id: 'b', match: 'x', dataClass: 'tenant_config', steward: 'a-person', ownership: 'mine' },
    ],
    entries: { t1: { dataClass: 'unclassified', steward: 'data', ownership: 'customer' }, 'Bad-Name': { dataClass: 'tenant_config', steward: 'data', ownership: 'customer', retentionRef: 'http://x' } },
  };
  const e = validateDataFile(bad).join('\n');
  assert.match(e, /not a valid regular expression/);
  assert.match(e, /duplicate id/);
  assert.match(e, /dataClass "nope"/);
  assert.match(e, /steward "a-person"/);
  assert.match(e, /ownership "mine"/);
  assert.match(e, /entry "t1".*unclassified|entry "t1".*not allowed/);
  assert.match(e, /not a valid table name/);
  assert.match(e, /retentionRef/);
  assert.deepEqual(validateDataFile(DATA), []);
});

test('gate: a new table without entry or baseline fails; reviewed or baselined passes', () => {
  const tables = new Map([['calls', model('user_id')], ['legacy_a', model('user_id')], ['brand_new', model('user_id')]]);
  const rows = buildRegister(tables, DATA, CTX);
  const errs = gate({ rows, data: DATA, baseline: { tables: ['legacy_a'] } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /table "brand_new" has no ownership-register entry/);
  const data2 = { ...DATA, entries: { ...DATA.entries, brand_new: { dataClass: 'tenant_business', steward: 'data', ownership: 'customer' } } };
  assert.deepEqual(gate({ rows: buildRegister(tables, data2, CTX), data: data2, baseline: { tables: ['legacy_a'] } }), []);
});

test('gate: stale entries, stale baseline names and reviewed-but-baselined are errors', () => {
  const tables = new Map([['calls', model('user_id')]]);
  const rows = buildRegister(tables, DATA, CTX);
  const data = { ...DATA, entries: { ...DATA.entries, ghost: { dataClass: 'tenant_config', steward: 'data', ownership: 'customer' } } };
  const errs = gate({ rows, data, baseline: { tables: ['calls', 'gone'] } }).join('\n');
  assert.match(errs, /entry "ghost" matches no table/);
  assert.match(errs, /baseline lists "gone"/);
  assert.match(errs, /table "calls" has a reviewed entry but is still in the baseline/);
});

test('renderMd is deterministic, escapes pipes and lists counsel questions', () => {
  const tables = new Map([['calls', model('user_id')], ['b|c', model('id')]]);
  const rows = buildRegister(tables, DATA, CTX);
  const a = renderMd(rows);
  assert.equal(a, renderMd(buildRegister(tables, DATA, CTX)));
  assert.match(a, /\*\*\[COUNSEL\]\*\*/);
  assert.match(a, /Recording duties vary\./);
  assert.match(a, /\| `calls` \| `personal_sensitive` \| voice \| customer \|/);
  assert.doesNotMatch(a, /Date\(|\d{4}-\d{2}-\d{2}T/);
});

test('vocabulary is closed and self-consistent', () => {
  assert.ok('unclassified' in DATA_CLASSES);
  assert.deepEqual(Object.keys(OWNERSHIP).sort(), ['customer', 'derived', 'vireek']);
  assert.equal(new Set(STEWARDS).size, STEWARDS.length);
});

// ------------------------------------------------------------ end-to-end on a temporary repo
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownreg-'));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w('supabase/migrations/20300101000000_a.sql', 'CREATE TABLE public.calls (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz);\nALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;\nCREATE TABLE public.legacy_a (id uuid PRIMARY KEY, user_id uuid);\nALTER TABLE public.legacy_a ENABLE ROW LEVEL SECURITY;\n');
  w(PATHS.owned, 'export const OWNED_TABLES = [\n  { table: "calls", dateColumn: "created_at" },\n];\n');
  w(PATHS.governance, "export const GOVERNABLE_DATASETS = [\n  { id: 'calls', label: 'Calls' },\n] as const;\n");
  w(PATHS.data, JSON.stringify({ version: 1, rules: [], entries: { calls: { dataClass: 'personal_sensitive', steward: 'voice', ownership: 'customer' } } }));
  w(PATHS.baseline, JSON.stringify({ tables: ['legacy_a'] }));
  const rows = loadAll(root).rows;
  w(PATHS.md, renderMd(rows));
  return { root, w };
}

test('e2e: clean repo passes; a new migration table without an entry fails; adding the entry + regenerating passes', () => {
  const { root, w } = tempRepo();
  assert.deepEqual(checkRoot(root).errors, []);

  w('supabase/migrations/20300102000000_b.sql', 'CREATE TABLE IF NOT EXISTS public.shiny_new_things (id uuid PRIMARY KEY, user_id uuid);\nALTER TABLE public.shiny_new_things ENABLE ROW LEVEL SECURITY;\n');
  const failing = checkRoot(root).errors.join('\n');
  assert.match(failing, /table "shiny_new_things" has no ownership-register entry/);
  assert.match(failing, /ownership-register\.md is stale/);

  const data = JSON.parse(fs.readFileSync(path.join(root, PATHS.data), 'utf8'));
  data.entries.shiny_new_things = { dataClass: 'tenant_business', steward: 'data', ownership: 'customer' };
  w(PATHS.data, JSON.stringify(data));
  w(PATHS.md, renderMd(loadAll(root).rows));
  assert.deepEqual(checkRoot(root).errors, []);
});

test('e2e: dropping a table makes its entry stale; a stale register fails', () => {
  const { root, w } = tempRepo();
  w('supabase/migrations/20300103000000_drop.sql', 'DROP TABLE IF EXISTS public.calls;\n');
  const errs = checkRoot(root).errors.join('\n');
  assert.match(errs, /entry "calls" matches no table/);
});

test('e2e: a missing baseline fails closed', () => {
  const { root } = tempRepo();
  fs.rmSync(path.join(root, PATHS.baseline));
  assert.match(checkRoot(root).errors.join('\n'), /baseline missing/);
});

// ------------------------------------------------------------ the real repository
test('real repository: register is current, complete, and every reviewed entry is valid', () => {
  const { errors, rows } = checkRoot(ROOT);
  assert.deepEqual(errors, []);
  assert.ok(rows.length > 1500);
  for (const t of ['calls', 'leads', 'customers', 'audit_log', 'insights_index_cells']) assert.equal(rows.find((r) => r.table === t)?.status, 'reviewed', t);
  assert.equal(rows.find((r) => r.table === 'calls').retention.kind, 'configurable');
});
