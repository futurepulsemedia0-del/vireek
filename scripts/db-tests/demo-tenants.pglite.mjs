#!/usr/bin/env node
// Executes supabase/migrations/20290307000000_demo_tenants.sql against an in-process Postgres (PGlite) and asserts
// registration guards, privileges, RLS, extension limits, expiry enforcement and the purge marker.
//
//   npm i -D @electric-sql/pglite      (dev-only; same convention as audit-migration.pglite.mjs)
//   node scripts/db-tests/demo-tenants.pglite.mjs
//
// PGlite is real Postgres compiled to WASM but NOT Supabase: auth/roles are stubbed below. It proves the SQL is valid and
// its logic right; it does not prove behaviour through PostgREST/GoTrue (see the manual checklist in docs/sales/poc-playbook.md).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = new URL('../../supabase/migrations/20290307000000_demo_tenants.sql', import.meta.url);
const db = new PGlite();
let failed = 0;
const ok = (name, cond, extra = '') => { if (cond) console.log(`PASS  ${name}`); else { failed++; console.log(`FAIL  ${name} ${extra}`); } };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return String(e.message ?? e); } };
const as = async (role, uid, fn) => {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
};

const DEMO = '00000000-0000-0000-0000-0000000000d1';
const DEMO2 = '00000000-0000-0000-0000-0000000000d2';
const REAL = '00000000-0000-0000-0000-0000000000e1';
const STAFF = '00000000-0000-0000-0000-0000000000a1';
const OUTSIDER = '00000000-0000-0000-0000-0000000000b1';

await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, banned_until timestamptz);
  CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_staff boolean NOT NULL DEFAULT false);
  CREATE FUNCTION public.is_vireek_staff(uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE((SELECT is_staff FROM profiles WHERE id = uid), false) $$;
  INSERT INTO auth.users (id, email) VALUES
    ('${DEMO}', 'demo-acme-1234abcd@demo.vireek.invalid'), ('${DEMO2}', 'demo-two-1234abcd@demo.vireek.invalid'),
    ('${REAL}', 'owner@realcompany.com'), ('${STAFF}', 'demo-staff-1@demo.vireek.invalid'), ('${OUTSIDER}', 'x@y.com');
  INSERT INTO public.profiles (id, is_staff) VALUES ('${DEMO}', false), ('${DEMO2}', false), ('${REAL}', false), ('${STAFF}', true), ('${OUTSIDER}', false);
  INSERT INTO auth.sessions (user_id) VALUES ('${DEMO}'), ('${DEMO}'), ('${DEMO2}');
`);

const sql = readFileSync(MIGRATION, 'utf8');
await db.exec(sql);
ok('migration applies cleanly', true);
const rerun = await db.exec(sql).then(() => null, (e) => String(e.message ?? e));
ok('migration is re-runnable', rerun === null, String(rerun).slice(0, 200));

// ---- privileges (Supabase grants EXECUTE to anon/authenticated by default; the migration must remove it) ----
const fns = [
  'public.register_demo_tenant(uuid,text,text,text,text,timestamptz,text)', 'public.extend_demo_tenant(uuid,integer)',
  'public.expire_due_demo_tenants()', 'public.mark_demo_tenant_purged(uuid)', 'public.is_demo_tenant(uuid)',
];
for (const f of fns) {
  const r = await one(`SELECT has_function_privilege('anon', '${f}', 'EXECUTE') a, has_function_privilege('authenticated', '${f}', 'EXECUTE') u, has_function_privilege('service_role', '${f}', 'EXECUTE') s`);
  ok(`privileges ${f.split('(')[0]}: service_role only`, !r.a && !r.u && r.s, JSON.stringify(r));
}

// ---- register guards ----
const inFuture = (days) => `now() + interval '${days} days'`;
ok('register rejects a non-demo email', /Only a demo account/.test(await err(`SELECT public.register_demo_tenant('${REAL}', 'x', null, 'hvac', 's', ${inFuture(5)})`) ?? ''));
ok('register rejects a staff account', /staff account/.test(await err(`SELECT public.register_demo_tenant('${STAFF}', 'x', null, 'hvac', 's', ${inFuture(5)})`) ?? ''));
ok('register rejects an unknown account', /Only a demo account/.test(await err(`SELECT public.register_demo_tenant('00000000-0000-0000-0000-00000000ffff', 'x', null, 'hvac', 's', ${inFuture(5)})`) ?? ''));
ok('register rejects an expiry in the past', /future/.test(await err(`SELECT public.register_demo_tenant('${DEMO}', 'x', null, 'hvac', 's', now() - interval '1 hour')`) ?? ''));
ok('register rejects an expiry beyond 30 days', /30 days/.test(await err(`SELECT public.register_demo_tenant('${DEMO}', 'x', null, 'hvac', 's', ${inFuture(31)})`) ?? ''));
ok('register rejects an unknown scenario', /scenario/.test(await err(`SELECT public.register_demo_tenant('${DEMO}', 'x', null, 'roofing', 's', ${inFuture(5)})`) ?? ''));
const reg = await one(`SELECT * FROM public.register_demo_tenant('${DEMO}', 'Acme', 'Acme Heating', 'hvac', 'seed1', ${inFuture(14)}, 'tester')`);
ok('register accepts a valid demo tenant (active, 0 extensions)', reg.status === 'active' && reg.extensions === 0 && reg.created_by === 'tester');
ok('register twice for the same account is rejected', (await err(`SELECT public.register_demo_tenant('${DEMO}', 'Acme', null, 'hvac', 's', ${inFuture(5)})`)) !== null);
await db.query(`SELECT public.register_demo_tenant('${DEMO2}', 'Two', null, 'plumbing', 's2', ${inFuture(3)})`);

// ---- table constraints ----
ok('60-day lifetime ceiling enforced by CHECK', /demo_tenants_lifetime_ceiling/.test(await err(`UPDATE public.demo_tenants SET expires_at = created_at + interval '61 days' WHERE account_id = '${DEMO}'`) ?? ''));

// ---- RLS ----
ok('anonymous cannot read demo_tenants', /permission denied/.test(await as('anon', null, () => err('SELECT * FROM public.demo_tenants')) ?? ''));
ok('non-staff authenticated user sees 0 rows', (await as('authenticated', OUTSIDER, () => q('SELECT * FROM public.demo_tenants'))).length === 0);
ok('a demo tenant sees 0 rows (cannot read the registry)', (await as('authenticated', DEMO, () => q('SELECT * FROM public.demo_tenants'))).length === 0);
ok('staff sees both rows', (await as('authenticated', STAFF, () => q('SELECT * FROM public.demo_tenants'))).length === 2);
ok('authenticated cannot INSERT', (await as('authenticated', STAFF, () => err(`INSERT INTO public.demo_tenants (account_id,label,seed,expires_at,original_expires_at) VALUES ('${OUTSIDER}','x','s',${inFuture(2)},${inFuture(2)})`))) !== null);
ok('authenticated cannot UPDATE', (await as('authenticated', STAFF, () => err(`UPDATE public.demo_tenants SET status = 'purged'`))) !== null);
ok('authenticated cannot DELETE', (await as('authenticated', STAFF, () => err('DELETE FROM public.demo_tenants'))) !== null);
ok('authenticated cannot call register/extend/expire', (await as('authenticated', STAFF, () => err('SELECT public.expire_due_demo_tenants()'))) !== null);

// ---- extend ----
ok('extend rejects 0 and 15 days', /between 1 and 14/.test(await err(`SELECT public.extend_demo_tenant('${DEMO}', 0)`) ?? '') && /between 1 and 14/.test(await err(`SELECT public.extend_demo_tenant('${DEMO}', 15)`) ?? ''));
ok('extend rejects an unknown tenant', /Unknown/.test(await err(`SELECT public.extend_demo_tenant('${OUTSIDER}', 3)`) ?? ''));
const before = await one(`SELECT expires_at FROM public.demo_tenants WHERE account_id = '${DEMO}'`);
const e1 = await one(`SELECT * FROM public.extend_demo_tenant('${DEMO}', 7)`);
ok('extend adds days and counts the extension', e1.extensions === 1 && Math.round((new Date(e1.expires_at) - new Date(before.expires_at)) / 86_400_000) === 7);
await db.query(`SELECT public.extend_demo_tenant('${DEMO}', 7)`);
ok('a third extension is refused', /at most twice/.test(await err(`SELECT public.extend_demo_tenant('${DEMO}', 1)`) ?? ''));

// ---- expire ----
await db.exec(`UPDATE public.demo_tenants SET created_at = now() - interval '5 days', expires_at = now() - interval '1 minute', original_expires_at = now() - interval '1 minute' WHERE account_id = '${DEMO2}'`);
const expired = await q('SELECT * FROM public.expire_due_demo_tenants() AS id');
ok('expire returns only the due tenant', expired.length === 1 && expired[0].id === DEMO2, JSON.stringify(expired));
const u2 = await one(`SELECT banned_until FROM auth.users WHERE id = '${DEMO2}'`);
ok('expired login is banned far into the future', u2.banned_until && new Date(u2.banned_until) > new Date(Date.now() + 365 * 86_400_000));
ok('expired tenant sessions are deleted, others untouched', (await one(`SELECT count(*)::int n FROM auth.sessions WHERE user_id = '${DEMO2}'`)).n === 0 && (await one(`SELECT count(*)::int n FROM auth.sessions WHERE user_id = '${DEMO}'`)).n === 2);
ok('the active tenant is not banned', (await one(`SELECT banned_until FROM auth.users WHERE id = '${DEMO}'`)).banned_until === null);
ok('expire is idempotent', (await q('SELECT * FROM public.expire_due_demo_tenants() AS id')).length === 0);
ok('an expired tenant cannot be extended', /Only an active/.test(await err(`SELECT public.extend_demo_tenant('${DEMO2}', 3)`) ?? ''));
ok('status and expired_at recorded', (await one(`SELECT status, expired_at IS NOT NULL AS stamped FROM public.demo_tenants WHERE account_id = '${DEMO2}'`)).stamped === true);

// ---- helper + purge marker ----
ok('is_demo_tenant true for active and expired, false for unknown', (await one(`SELECT public.is_demo_tenant('${DEMO}') a, public.is_demo_tenant('${DEMO2}') b, public.is_demo_tenant('${REAL}') c`)).a === true && (await one(`SELECT public.is_demo_tenant('${DEMO2}') b`)).b === true && (await one(`SELECT public.is_demo_tenant('${REAL}') c`)).c === false);
await db.query(`SELECT public.mark_demo_tenant_purged('${DEMO2}')`);
ok('purge marker sets status purged', (await one(`SELECT status, purged_at IS NOT NULL AS stamped FROM public.demo_tenants WHERE account_id = '${DEMO2}'`)).status === 'purged');
ok('purging twice is rejected', /already purged/.test(await err(`SELECT public.mark_demo_tenant_purged('${DEMO2}')`) ?? ''));
ok('is_demo_tenant false once purged', (await one(`SELECT public.is_demo_tenant('${DEMO2}') b`)).b === false);
await db.exec(`DELETE FROM auth.users WHERE id = '${DEMO2}'; DELETE FROM public.profiles WHERE id = '${DEMO2}'`);
ok('tombstone survives deletion of the account (no FK)', (await one(`SELECT count(*)::int n FROM public.demo_tenants WHERE account_id = '${DEMO2}'`)).n === 1);

console.log(failed ? `\n${failed} FAILED` : '\nAll demo_tenants checks passed.');
process.exit(failed ? 1 : 0);
