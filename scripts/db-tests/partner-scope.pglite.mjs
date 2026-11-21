#!/usr/bin/env node
// Executes the REAL supabase/migrations/20261203000000_partner_portal.sql followed by 20290307000100_partner_portal_scope.sql
// against an in-process Postgres (PGlite) and asserts that partner users are limited to their referred accounts:
// RLS on the new tables, column-limited RPCs, cross-partner isolation, tenant-table isolation, member management,
// self-dealing guard, immediate revocation and privileges.
//
//   npm i -D @electric-sql/pglite      (dev-only; same convention as the other *.pglite.mjs scripts)
//   node scripts/db-tests/partner-scope.pglite.mjs
//
// Limits: PGlite is real Postgres (WASM) but not Supabase. auth.* and roles are stubbed; `profiles`, `team_members`,
// `customers` and `jobs` are minimal stand-ins that keep the repository's policy shape (user_id = get_account_owner_id();
// profiles: auth.uid() = id). The later affiliate guardrail/ledger migrations are NOT applied. The same scenarios exist as
// pgTAP in supabase/tests/database/partner_scope.test.sql for `supabase test db`.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const file = (n) => readFileSync(new URL(`../../supabase/migrations/${n}`, import.meta.url), 'utf8');
const db = new PGlite();
let failed = 0;
const ok = (name, cond, extra = '') => { if (cond) console.log(`PASS  ${name}`); else { failed++; console.log(`FAIL  ${name} ${extra}`); } };
const rows = async (sql) => (await db.query(sql)).rows;
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return String(e.message ?? e); } };
const as = async (role, uid, fn) => {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
};
const asUser = (uid, fn) => as('authenticated', uid, fn);
const errAs = (uid, sql) => asUser(uid, () => err(sql));
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const A_OWNER = U(1), A_MEMBER = U(2), A_FIN = U(3), B_OWNER = U(4), PENDING = U(5), SUSPENDED = U(6), RANDO = U(7), STAFF = U(8);
const ACC1 = U(11), ACC2 = U(12), ACC3 = U(13), ACC4 = U(14), CANDIDATE = U(15), CANDIDATE2 = U(16);
const PA = U(101), PB = U(102), PP = U(103), PS = U(104);

// ---------------------------------------------------------------- stand-ins
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
  -- Supabase default privileges: new public tables/functions are open to the API roles; RLS and explicit REVOKEs do the restricting.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, company_name text, full_name text, phone text,
    plan text NOT NULL DEFAULT 'starter', status text NOT NULL DEFAULT 'active', subscription_status text, is_staff boolean NOT NULL DEFAULT false);
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY select_own_profile ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
  GRANT SELECT ON public.profiles TO authenticated;
  CREATE TABLE public.team_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_owner_id uuid NOT NULL, user_id uuid, member_email text);
  CREATE FUNCTION public.get_account_owner_id() RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT account_owner_id FROM team_members WHERE user_id = auth.uid() LIMIT 1), (SELECT id FROM profiles WHERE id = auth.uid())); $$;
  CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text);
  CREATE TABLE public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, customer_name text, invoice_amount numeric);
  ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY select_own_customers ON public.customers FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
  CREATE POLICY select_own_jobs ON public.jobs FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers, public.jobs TO authenticated;
  CREATE FUNCTION public.is_vireek_staff(uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE((SELECT is_staff FROM profiles WHERE id = uid), false) $$;
  GRANT EXECUTE ON FUNCTION public.is_vireek_staff(uuid) TO authenticated, anon;
`);

const users = [
  [A_OWNER, 'owner@partner-a.test', 'Partner A Co'], [A_MEMBER, 'member@partner-a.test', null], [A_FIN, 'finance@partner-a.test', null],
  [B_OWNER, 'owner@partner-b.test', 'Partner B Co'], [PENDING, 'pending@partner.test', null], [SUSPENDED, 'suspended@partner.test', null],
  [RANDO, 'rando@nowhere.test', 'Random Plumbing'], [STAFF, 'staff@vireek.test', null],
  [ACC1, 'acc1@cust.test', 'Acme Heating'], [ACC2, 'acc2@cust.test', 'Blue Pipe'], [ACC3, 'acc3@cust.test', 'Other Partner Customer'],
  [ACC4, 'acc4@cust.test', 'Rejected Referral Co'], [CANDIDATE, 'candidate@x.test', null], [CANDIDATE2, 'Candidate2@X.test', null],
];
for (const [id, email, company] of users) {
  await db.exec(`INSERT INTO auth.users VALUES ('${id}', '${email}'); INSERT INTO public.profiles (id, email, company_name, full_name, phone, plan) VALUES ('${id}', '${email}', ${company ? `'${company}'` : 'NULL'}, 'Private Name', '+1-555-0100', 'professional');`);
}
await db.exec(`UPDATE public.profiles SET is_staff = true WHERE id = '${STAFF}'`);

await db.exec(file('20261203000000_partner_portal.sql'));
ok('base partner portal migration applies (real file)', true);
const migration = file('20290307000100_partner_portal_scope.sql');
await db.exec(migration);
ok('scope migration applies cleanly', true);
const rerun = await db.exec(migration).then(() => null, (e) => String(e.message ?? e));
ok('scope migration is re-runnable', rerun === null, String(rerun).slice(0, 200));

await db.exec(`
  INSERT INTO public.partners (id, user_id, company_name, contact_name, contact_email, referral_code, status) VALUES
    ('${PA}', '${A_OWNER}', 'Partner A Co', 'A', 'a@a.test', 'AAAAAAAA', 'approved'),
    ('${PB}', '${B_OWNER}', 'Partner B Co', 'B', 'b@b.test', 'BBBBBBBB', 'approved'),
    ('${PP}', '${PENDING}', 'Pending Co', 'P', 'p@p.test', 'PPPPPPPP', 'pending'),
    ('${PS}', '${SUSPENDED}', 'Suspended Co', 'S', 's@s.test', 'SSSSSSSS', 'suspended');
  INSERT INTO public.partner_members (partner_id, user_id, can_view_commissions) VALUES ('${PA}', '${A_MEMBER}', false), ('${PA}', '${A_FIN}', true);
  INSERT INTO public.partner_referrals (partner_id, referred_user_id, status, mrr_cents, commission_cents, commission_status, converted_at) VALUES
    ('${PA}', '${ACC1}', 'converted', 19900, 3980, 'approved', now()),
    ('${PA}', '${ACC2}', 'signed_up', 0, 0, 'pending', NULL),
    ('${PA}', '${ACC4}', 'rejected', 0, 0, 'void', NULL),
    ('${PB}', '${ACC3}', 'converted', 7900, 1580, 'pending', now());
  INSERT INTO public.customers (user_id, name) VALUES ('${ACC1}', 'ACC1 secret customer'), ('${ACC2}', 'ACC2 secret customer'), ('${ACC3}', 'ACC3 secret customer');
  INSERT INTO public.jobs (user_id, customer_name, invoice_amount) VALUES ('${ACC1}', 'ACC1 job', 500), ('${ACC3}', 'ACC3 job', 900);
`);

// ---------------------------------------------------------------- privileges
const clientFns = ['partner_scope_context()', 'partner_list_referred_accounts(integer,integer)', 'partner_get_referred_account(uuid)', 'partner_add_member(text,boolean)', 'partner_update_member(uuid,boolean)', 'partner_remove_member(uuid)', 'partner_list_members()'];
for (const f of clientFns) {
  const r = (await rows(`SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') a, has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') u`))[0];
  ok(`privileges ${f.split('(')[0]}: authenticated yes, anon no`, r.u && !r.a, JSON.stringify(r));
}
const internalFns = ['partner_scope_for(uuid)', 'partner__referred_accounts(uuid,boolean,uuid,integer,integer)', 'partner_members_guard()', 'partner_access_log_append_only()', 'partner_referrals_no_self_dealing()'];
for (const f of internalFns) {
  const r = (await rows(`SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') a, has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') u`))[0];
  ok(`privileges internal ${f.split('(')[0]}: no client role`, !r.u && !r.a, JSON.stringify(r));
}
ok('anon cannot call the RPCs', /permission denied/.test(await as('anon', null, () => err('SELECT * FROM public.partner_list_referred_accounts()')) ?? ''));
ok('a signed-out authenticated call is refused', /Authentication required/.test(await errAs(null, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));
ok('internal helper cannot be called directly by a partner user', /permission denied/.test(await errAs(A_OWNER, `SELECT * FROM public.partner__referred_accounts('${PA}', true, NULL, 50, 0)`) ?? ''));

// ---------------------------------------------------------------- scope context
const ctx = (uid) => asUser(uid, async () => (await rows('SELECT public.partner_scope_context() AS c'))[0].c);
let c = await ctx(A_OWNER);
ok('owner context: scope referred_accounts, owner, sees commissions', c.has_scope && c.scope === 'referred_accounts' && c.is_owner && c.can_view_commissions && c.partner_id === PA);
c = await ctx(A_MEMBER);
ok('member context: not owner, no commissions', c.has_scope && !c.is_owner && !c.can_view_commissions && c.partner_id === PA);
c = await ctx(A_FIN);
ok('finance member context: commissions visible', c.has_scope && c.can_view_commissions);
ok('non-partner has no scope', (await ctx(RANDO)).has_scope === false);
ok('pending partner has no scope', (await ctx(PENDING)).has_scope === false);
ok('suspended partner has no scope', (await ctx(SUSPENDED)).has_scope === false);
ok('a referred customer has no partner scope', (await ctx(ACC1)).has_scope === false);

// ---------------------------------------------------------------- list: only referred accounts
const list = (uid, args = '') => asUser(uid, () => rows(`SELECT * FROM public.partner_list_referred_accounts(${args})`));
let l = await list(A_OWNER);
ok('owner lists exactly its 2 live referrals (not the other partner, not the rejected one)', l.length === 2 && l.every((r) => [ACC1, ACC2].includes(r.account_id)), JSON.stringify(l.map((r) => r.account_id)));
const acc1 = l.find((r) => r.account_id === ACC1);
ok('owner sees business name, plan, status and money', acc1.company_name === 'Acme Heating' && acc1.plan === 'professional' && acc1.account_status === 'active' && acc1.mrr_cents === 19900 && acc1.commission_cents === 3980 && acc1.commission_status === 'approved');
ok('columns are a fixed minimal set (no email, phone, name, user_id)', JSON.stringify(Object.keys(acc1).sort()) === JSON.stringify(['account_id', 'account_status', 'commission_cents', 'commission_status', 'company_name', 'converted_at', 'mrr_cents', 'plan', 'referral_status', 'referred_at']));
ok('no personal data leaks in the payload', !/Private Name|\+1-555|@cust\.test/.test(JSON.stringify(l)));
l = await list(A_MEMBER);
ok('member lists the same accounts with money columns NULL', l.length === 2 && l.every((r) => r.mrr_cents === null && r.commission_cents === null && r.commission_status === null));
l = await list(A_FIN);
ok('finance member sees money', l.find((r) => r.account_id === ACC1).commission_cents === 3980);
l = await list(B_OWNER);
ok('partner B sees only its own referral', l.length === 1 && l[0].account_id === ACC3);
ok('limit 1 returns 1 row', (await list(A_OWNER, '1, 0')).length === 1);
ok('offset past the end returns nothing', (await list(A_OWNER, '50, 5')).length === 0);
ok('limit 0 is clamped to 1, not an error', (await list(A_OWNER, '0, 0')).length === 1);
ok('a non-partner is refused', /No partner access/.test(await errAs(RANDO, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));
ok('a pending partner is refused', /No partner access/.test(await errAs(PENDING, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));
ok('a suspended partner is refused', /No partner access/.test(await errAs(SUSPENDED, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));
ok('a referred customer cannot list partner data', /No partner access/.test(await errAs(ACC1, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));

// ---------------------------------------------------------------- get one account + audit log
const get = (uid, acc) => asUser(uid, () => rows(`SELECT * FROM public.partner_get_referred_account('${acc}')`));
ok('owner gets a referred account', (await get(A_OWNER, ACC1))[0].company_name === 'Acme Heating');
ok('another partner\'s account: "Account not found."', /^.*Account not found\.$/.test(await errAs(A_OWNER, `SELECT * FROM public.partner_get_referred_account('${ACC3}')`) ?? ''));
ok('a random uuid gives the same message (no probing)', /Account not found\./.test(await errAs(A_OWNER, `SELECT * FROM public.partner_get_referred_account('${U(999)}')`) ?? ''));
ok('a rejected referral is not retrievable', /Account not found\./.test(await errAs(A_OWNER, `SELECT * FROM public.partner_get_referred_account('${ACC4}')`) ?? ''));
ok('NULL account is refused', /Account not found\./.test(await errAs(A_OWNER, 'SELECT * FROM public.partner_get_referred_account(NULL)') ?? ''));
const mem = (await get(A_MEMBER, ACC1))[0];
ok('member get: money columns NULL', mem.mrr_cents === null && mem.commission_cents === null);
const logRows = await rows('SELECT partner_id, actor_id, account_id, action FROM public.partner_access_log ORDER BY id');
ok('exactly the 2 successful views were logged (denied attempts are not)', logRows.length === 2 && logRows[0].actor_id === A_OWNER && logRows[1].actor_id === A_MEMBER && logRows.every((r) => r.partner_id === PA && r.account_id === ACC1 && r.action === 'view_account'));
ok('owner can read its access log', (await asUser(A_OWNER, () => rows('SELECT * FROM public.partner_access_log'))).length === 2);
ok('another partner cannot read it', (await asUser(B_OWNER, () => rows('SELECT * FROM public.partner_access_log'))).length === 0);
ok('a member cannot read it', (await asUser(A_MEMBER, () => rows('SELECT * FROM public.partner_access_log'))).length === 0);
ok('staff can read it', (await asUser(STAFF, () => rows('SELECT * FROM public.partner_access_log'))).length === 2);
ok('the log is append-only (UPDATE)', /append-only/.test(await err(`UPDATE public.partner_access_log SET action = 'view_account'`) ?? ''));
ok('the log is append-only (DELETE)', /append-only/.test(await err('DELETE FROM public.partner_access_log') ?? ''));
ok('a partner user cannot write the log directly', (await errAs(A_OWNER, `INSERT INTO public.partner_access_log (partner_id, actor_id, account_id, action) VALUES ('${PA}', '${A_OWNER}', '${ACC1}', 'view_account')`)) !== null);

// ---------------------------------------------------------------- tenant data stays closed
for (const [who, uid] of [['owner', A_OWNER], ['member', A_MEMBER], ['finance member', A_FIN]]) {
  const cust = await asUser(uid, () => rows('SELECT * FROM public.customers'));
  const jobs = await asUser(uid, () => rows('SELECT * FROM public.jobs'));
  ok(`${who} sees no customers or jobs of any referred account`, cust.length === 0 && jobs.length === 0);
  ok(`${who} cannot read a referred account's profile directly`, (await asUser(uid, () => rows(`SELECT * FROM public.profiles WHERE id IN ('${ACC1}','${ACC2}')`))).length === 0);
}
ok('a referred customer still sees its own data (control)', (await asUser(ACC1, () => rows('SELECT * FROM public.customers'))).length === 1);
ok('a partner user cannot insert into a referred account\'s tables', (await errAs(A_OWNER, `INSERT INTO public.customers (user_id, name) VALUES ('${ACC1}', 'x')`)) !== null);

// ---------------------------------------------------------------- direct table RLS
ok('member cannot read partner_referrals directly', (await asUser(A_MEMBER, () => rows('SELECT * FROM public.partner_referrals'))).length === 0);
ok('owner reads its partner_referrals directly (unchanged base policy)', (await asUser(A_OWNER, () => rows('SELECT * FROM public.partner_referrals'))).length === 3);
ok('owner sees its 2 members; member sees only itself', (await asUser(A_OWNER, () => rows('SELECT * FROM public.partner_members'))).length === 2 && (await asUser(A_MEMBER, () => rows('SELECT * FROM public.partner_members'))).length === 1);
ok('partner B and outsiders see none of A\'s members', (await asUser(B_OWNER, () => rows('SELECT * FROM public.partner_members'))).length === 0 && (await asUser(RANDO, () => rows('SELECT * FROM public.partner_members'))).length === 0);
ok('staff sees all members', (await asUser(STAFF, () => rows('SELECT * FROM public.partner_members'))).length === 2);
ok('no direct INSERT into partner_members', (await errAs(A_OWNER, `INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${CANDIDATE}')`)) !== null);
ok('no direct UPDATE of partner_members', (await errAs(A_OWNER, `UPDATE public.partner_members SET can_view_commissions = true`)) !== null);
ok('no direct DELETE of partner_members', (await errAs(A_OWNER, 'DELETE FROM public.partner_members')) !== null);
ok('a member cannot promote itself', (await errAs(A_MEMBER, `UPDATE public.partner_members SET can_view_commissions = true WHERE user_id = '${A_MEMBER}'`)) !== null && (await rows(`SELECT can_view_commissions FROM public.partner_members WHERE user_id = '${A_MEMBER}'`))[0].can_view_commissions === false);

// ---------------------------------------------------------------- member management
const GENERIC = /Could not add that member\./;
ok('a member cannot add members', /Only an approved partner owner/.test(await errAs(A_MEMBER, `SELECT * FROM public.partner_add_member('${'candidate@x.test'}')`) ?? ''));
ok('a non-partner cannot add members', /Only an approved partner owner/.test(await errAs(RANDO, `SELECT * FROM public.partner_add_member('candidate@x.test')`) ?? ''));
ok('a pending partner cannot add members', /Only an approved partner owner/.test(await errAs(PENDING, `SELECT * FROM public.partner_add_member('candidate@x.test')`) ?? ''));
for (const [why, email] of [['unknown email', 'nobody@nowhere.test'], ['partner owner', 'owner@partner-b.test'], ['already a member', 'member@partner-a.test'], ['referred account', 'acc1@cust.test'], ['staff', 'staff@vireek.test'], ['empty', '']]) {
  ok(`add refused with the one generic message: ${why}`, GENERIC.test(await errAs(A_OWNER, `SELECT * FROM public.partner_add_member('${email}')`) ?? ''));
}
const added = (await asUser(A_OWNER, () => rows(`SELECT * FROM public.partner_add_member('  CANDIDATE@x.test ', false)`)))[0];
ok('owner adds a member by email (case/space-insensitive), read-only scope, no commissions', added.user_id === CANDIDATE && added.partner_id === PA && added.scope === 'referred_accounts' && added.can_view_commissions === false && added.added_by === A_OWNER);
ok('the new member immediately has scope', (await ctx(CANDIDATE)).partner_id === PA);
ok('owner lists members with emails', (await asUser(A_OWNER, () => rows('SELECT * FROM public.partner_list_members()'))).length === 3);
ok('a member cannot list members', /Only an approved partner owner/.test(await errAs(A_MEMBER, 'SELECT * FROM public.partner_list_members()') ?? ''));
ok('owner grants commission visibility', (await asUser(A_OWNER, () => rows(`SELECT * FROM public.partner_update_member('${CANDIDATE}', true)`)))[0].can_view_commissions === true);
ok('partner B cannot modify A\'s member', /Member not found/.test(await errAs(B_OWNER, `SELECT * FROM public.partner_update_member('${CANDIDATE}', false)`) ?? ''));
ok('a member cannot modify members', /Only an approved partner owner/.test(await errAs(A_MEMBER, `SELECT * FROM public.partner_update_member('${CANDIDATE}', false)`) ?? ''));
ok('partner B removing A\'s member is a no-op (false) and the member stays', (await asUser(B_OWNER, () => rows(`SELECT public.partner_remove_member('${CANDIDATE}') AS r`)))[0].r === false && (await ctx(CANDIDATE)).has_scope === true);
ok('a member cannot remove members', /Only an approved partner owner/.test(await errAs(A_MEMBER, `SELECT public.partner_remove_member('${CANDIDATE}')`) ?? ''));
ok('owner removes a member', (await asUser(A_OWNER, () => rows(`SELECT public.partner_remove_member('${CANDIDATE}') AS r`)))[0].r === true);
ok('a removed member loses access immediately', (await ctx(CANDIDATE)).has_scope === false && /No partner access/.test(await errAs(CANDIDATE, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));

// ---------------------------------------------------------------- invariants for every writer (superuser/service path)
ok('trigger: a partner owner cannot be a member', /cannot also be a member/.test(await err(`INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${B_OWNER}')`) ?? ''));
ok('trigger: a referred account cannot be a member of its referrer', /cannot be a member of the partner that referred it/.test(await err(`INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${ACC1}')`) ?? ''));
ok('trigger: staff cannot be a member', /staff account/.test(await err(`INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${STAFF}')`) ?? ''));
ok('a user belongs to one partner only', /partner_members_one_partner_per_user/.test(await err(`INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PB}', '${A_MEMBER}')`) ?? ''));
ok('scope is fixed to referred_accounts', /check/i.test(await err(`UPDATE public.partner_members SET scope = 'everything'`) ?? ''));

// member cap: A has 2; add 8 more directly -> 10; the 11th is refused by the RPC and by the trigger
for (let i = 0; i < 8; i++) {
  const id = U(200 + i);
  await db.exec(`INSERT INTO auth.users VALUES ('${id}', 'bulk${i}@x.test'); INSERT INTO public.profiles (id, email) VALUES ('${id}', 'bulk${i}@x.test'); INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${id}');`);
}
ok('the member cap is 10', (await rows('SELECT public.partner_max_members() AS n'))[0].n === 10 && (await rows(`SELECT count(*)::int AS n FROM public.partner_members WHERE partner_id = '${PA}'`))[0].n === 10);
ok('the 11th member is refused by the RPC', /Member limit reached \(10\)/.test(await errAs(A_OWNER, `SELECT * FROM public.partner_add_member('candidate2@x.test')`) ?? ''));
ok('the 11th member is refused by the trigger for any writer', /Member limit reached/.test(await err(`INSERT INTO public.partner_members (partner_id, user_id) VALUES ('${PA}', '${CANDIDATE2}')`) ?? ''));

// ---------------------------------------------------------------- self-dealing
await db.exec(`INSERT INTO public.profiles (id, email) VALUES ('${U(300)}', 'fresh@x.test') ON CONFLICT DO NOTHING; INSERT INTO auth.users VALUES ('${U(300)}', 'fresh@x.test') ON CONFLICT DO NOTHING;`);
const before = (await rows('SELECT count(*)::int AS n FROM public.partner_referrals'))[0].n;
await db.exec(`INSERT INTO public.partner_referrals (partner_id, referred_user_id) VALUES ('${PA}', '${A_MEMBER}')`);
await db.exec(`INSERT INTO public.partner_referrals (partner_id, referred_user_id) VALUES ('${PA}', '${A_OWNER}')`);
ok('a member or the owner signing up through its own partner code is not credited (silently skipped)', (await rows('SELECT count(*)::int AS n FROM public.partner_referrals'))[0].n === before);
await db.exec(`INSERT INTO public.partner_referrals (partner_id, referred_user_id) VALUES ('${PA}', '${U(300)}')`);
ok('a genuine new referral is still credited', (await rows('SELECT count(*)::int AS n FROM public.partner_referrals'))[0].n === before + 1);
await db.exec(`INSERT INTO public.partner_referrals (partner_id, referred_user_id) VALUES ('${PB}', '${A_MEMBER}')`);
ok('a member of A may be referred by B (only same-partner self-dealing is blocked)', (await rows(`SELECT count(*)::int AS n FROM public.partner_referrals WHERE partner_id = '${PB}' AND referred_user_id = '${A_MEMBER}'`))[0].n === 1);
await db.exec(`DELETE FROM public.partner_referrals WHERE partner_id = '${PB}' AND referred_user_id = '${A_MEMBER}'`);

// ---------------------------------------------------------------- revocation and lifecycle
await db.exec(`UPDATE public.partners SET status = 'suspended' WHERE id = '${PA}'`);
ok('suspending the partner revokes owner and members immediately', !(await ctx(A_OWNER)).has_scope && !(await ctx(A_MEMBER)).has_scope && /No partner access/.test(await errAs(A_FIN, 'SELECT * FROM public.partner_list_referred_accounts()') ?? ''));
await db.exec(`UPDATE public.partners SET status = 'approved' WHERE id = '${PA}'`);
ok('re-approval restores access', (await ctx(A_MEMBER)).has_scope === true);
await db.exec(`DELETE FROM public.partner_referrals WHERE referred_user_id = '${ACC2}'`);
ok('a withdrawn referral disappears from the list', (await list(A_OWNER)).every((r) => r.account_id !== ACC2));
await db.exec(`DELETE FROM auth.users WHERE id = '${ACC1}'`);
ok('an erased referred account disappears (referred_user_id set NULL) and cannot be fetched', (await list(A_OWNER)).every((r) => r.account_id !== ACC1) && /Account not found/.test(await errAs(A_OWNER, `SELECT * FROM public.partner_get_referred_account('${ACC1}')`) ?? ''));
await db.exec(`DELETE FROM auth.users WHERE id = '${A_MEMBER}'`);
ok('deleting a user removes its membership (cascade)', (await rows(`SELECT count(*)::int AS n FROM public.partner_members WHERE user_id = '${A_MEMBER}'`))[0].n === 0);
ok('the access log survives deletion of the actor and the account (audit record)', (await rows('SELECT count(*)::int AS n FROM public.partner_access_log'))[0].n === 2);

console.log(failed ? `\n${failed} FAILED` : '\nAll partner scope checks passed.');
process.exit(failed ? 1 : 0);
