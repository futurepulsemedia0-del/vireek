// Run: node --test scripts/compliance/erasure-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, parseMigrations, parseRegistry, personalColumns } from './erasure-lib.mjs';
import { run } from './check-erasure-coverage.mjs';

const REG_SRC = (extra = {}) => `
export const OWNED_TABLES: OwnedTable[] = [ { table: "leads" } ];
export const ERASURE_RPC_EXCLUDED: string[] = [ "audit_log" ];
export const TENANT_KEYED_OWNED_TABLES: TenantKeyedOwnedTable[] = [ ${extra.tenant ?? ''} ];
export const ERASURE_EXEMPTION_CATEGORIES: ErasureExemptionCategory[] = [
  { id: "ledger", reason: "append-only ledger kept by design pending a retention decision", counsel: true },
  { id: "evidence", reason: "evidence of erasure decisions kept by design for audit", counsel: true },
  { id: "needs_remediation", reason: "known open problem described in each note", counsel: true },
];
export const ERASURE_EXEMPTIONS: ErasureExemption[] = [ { table: "audit_log", category: "evidence" } ${extra.exempt ?? ''} ];
`;
const BASE = `
create table public.leads (id uuid primary key, user_id uuid not null, email text);
create or replace function public.erase_user_rows(p_user uuid, p_exclude text[] DEFAULT ARRAY['audit_log']) returns jsonb language plpgsql as $$ begin return '{}'; end $$;
create table public.audit_log (id uuid primary key, user_id uuid, actor_email text);
`;
const model = (sql) => parseMigrations([{ name: '1.sql', sql: BASE + sql }]);
const check = (sql, extra) => classify(model(sql), parseRegistry(REG_SRC(extra)), []);

test('tables with uuid user_id are swept; baseline fixture is clean', () => {
  const r = check('');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.gaps, []);
});

test('new table with email and no tenant key is a gap; exemption with a reason clears it', () => {
  const sql = 'create table public.newsletter (id uuid primary key, email text);';
  assert.equal(check(sql).gaps[0].table, 'newsletter');
  assert.equal(check(sql, { exempt: ', { table: "newsletter", category: "ledger" }' }).gaps.length, 0);
});

test('tenant column without user_id is a gap until registered in TENANT_KEYED_OWNED_TABLES', () => {
  const sql = 'create table public.prefs (id uuid primary key, account_id uuid not null);';
  assert.match(check(sql).gaps[0].detail, /account_id/);
  assert.equal(check(sql, { tenant: '{ table: "prefs", ownerColumn: "account_id" }' }).gaps.length, 0);
});

test('table with no personal-data signal passes without registration', () => {
  const r = check('create table public.feature_catalog (id uuid primary key, slug text, price_cents int);');
  assert.equal(r.gaps.length, 0);
  assert.equal(r.counts.no_signal, 1);
});

test('FK cascade to a swept parent counts as covered (also through ALTER TABLE)', () => {
  const sql = `create table public.msgs (id uuid primary key, lead_id uuid, email text);
    alter table public.msgs add constraint fk foreign key (lead_id) references public.leads(id) on delete cascade;`;
  assert.equal(check(sql).gaps.length, 0);
});

test('cascade from auth.users on a non-owner column (e.g. reviewed_by) does not count', () => {
  const sql = 'create table public.notes (id uuid primary key, reviewed_by uuid references auth.users(id) on delete cascade, email text);';
  assert.equal(check(sql).gaps.length, 1);
});

test('BEFORE DELETE guard on a swept table is a gap; DROP TRIGGER then CREATE keeps the guard', () => {
  const sql = `create table public.ledger (id uuid primary key, user_id uuid not null);
    create function public.block() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$;
    drop trigger if exists trg on public.ledger;
    create trigger trg before update or delete on public.ledger for each row execute function public.block();`;
  const r = check(sql);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].kind, 'delete_guarded');
  assert.equal(check(sql, { exempt: ', { table: "ledger", category: "ledger" }' }).gaps.length, 0);
});

test('a later DROP TRIGGER removes the guard; a later DROP TABLE removes the table', () => {
  const sql = `create table public.ledger (id uuid primary key, user_id uuid not null);
    create function public.block() returns trigger language plpgsql as $$ begin raise exception 'x'; end $$;
    create trigger trg before delete on public.ledger for each row execute function public.block();
    drop trigger trg on public.ledger;
    create table public.gone (id uuid, email text);
    drop table if exists public.gone;`;
  const r = check(sql);
  assert.equal(r.gaps.length, 0);
  assert.ok(!r.rows.some((x) => x.table === 'gone'));
});

test('registry errors: unknown/duplicate/stale entries, missing reason, wrong category precondition', () => {
  const r = check('', {
    exempt: `, { table: "ghost", category: "ledger" }, { table: "audit_log", category: "evidence" }, { table: "leads", category: "nope" }, { table: "audit_log", category: "needs_remediation" }`,
  });
  const text = r.errors.join('\n');
  assert.match(text, /"ghost" does not exist/);
  assert.match(text, /duplicate entry for "audit_log"/);
  assert.match(text, /unknown category "nope"/);
  assert.match(text, /needs_remediation and needs a note/);
});

test('delete_guarded_ledger precondition: exemption without a guard is stale', () => {
  const src = REG_SRC({ exempt: ', { table: "leads", category: "delete_guarded_ledger" }' }).replace('{ id: "ledger"', '{ id: "delete_guarded_ledger", reason: "a BEFORE DELETE trigger blocks erase_user_rows here", counsel: true },\n  { id: "ledger"');
  const r = classify(model(''), parseRegistry(src), []);
  assert.match(r.errors.join('\n'), /no raising BEFORE DELETE trigger/);
});

test('ERASURE_RPC_EXCLUDED must match erase_user_rows() default exclusion list', () => {
  const src = REG_SRC().replace('[ "audit_log" ];', '[ "audit_log", "other" ];');
  assert.match(classify(model(''), parseRegistry(src), []).errors.join('\n'), /differs from erase_user_rows/);
});

test('OWNED_TABLES entry without uuid user_id is rejected (delete-account deletes by user_id)', () => {
  const r = classify(parseMigrations([{ name: '1.sql', sql: BASE.replace('user_id uuid not null,', '') }]), parseRegistry(REG_SRC()), []);
  assert.match(r.errors.join('\n'), /OWNED_TABLES: "leads" has no uuid user_id/);
});

test('personalColumns is name based and ignores plain "name"', () => {
  assert.deepEqual(personalColumns(new Map([['name', 'text'], ['contact_email', 'text'], ['full_name', 'text'], ['slug', 'text']])), ['contact_email', 'full_name']);
});

test('REAL REPO: registry is complete (0 gaps, 0 registry errors)', () => {
  const r = run();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.gaps, []);
});

test('REAL REPO mutation: a new personal-data table makes the check fail, then an exemption fixes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'erasure-'));
  for (const p of ['supabase/migrations', 'supabase/functions/_shared/compliance', 'supabase/functions/_shared/trust']) mkdirSync(join(root, p), { recursive: true });
  cpSync('supabase/migrations', join(root, 'supabase/migrations'), { recursive: true });
  cpSync('supabase/functions/_shared/trust/vault.ts', join(root, 'supabase/functions/_shared/trust/vault.ts'));
  const reg = readFileSync('supabase/functions/_shared/compliance/ownedTables.ts', 'utf8');
  writeFileSync(join(root, 'supabase/functions/_shared/compliance/ownedTables.ts'), reg);
  writeFileSync(join(root, 'supabase/migrations/99999999999999_new_pii.sql'), 'create table public.zz_new_contacts (id uuid primary key, contact_email text, phone text);');
  const failing = run(root);
  assert.deepEqual(failing.gaps.map((g) => g.table), ['zz_new_contacts']);
  writeFileSync(join(root, 'supabase/functions/_shared/compliance/ownedTables.ts'),
    reg.replace('export const ERASURE_EXEMPTIONS: ErasureExemption[] = [', 'export const ERASURE_EXEMPTIONS: ErasureExemption[] = [\n  { table: "zz_new_contacts", category: "operator_held_records" },'));
  assert.deepEqual(run(root).gaps, []);
});
