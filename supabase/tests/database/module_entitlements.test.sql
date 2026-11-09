-- Module entitlements: default deny, tenant isolation, staff-only writes, expiry, append-only audit (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff1@vireek.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'owner-a@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'owner-b@beta.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'member@acme.test');
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'member' where id = '00000000-0000-0000-0000-0000000000a5';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- The profile trigger gave the member a core row at insert (it was an owner for an instant): remove it, then link to owner A.
delete from public.account_module_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a5';
insert into public.team_members (account_owner_id, member_email, member_name, role, user_id, invite_status, permissions)
values ('00000000-0000-0000-0000-0000000000a3', 'member@acme.test', 'Mia Member', 'member', '00000000-0000-0000-0000-0000000000a5', 'active', '{}');

-- -------------------------------------------------------------------- seed --
select is((select count(*) from public.account_module_entitlements
            where module_id = 'core' and state = 'on' and source = 'plan'
              and tenant_id in ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a4')),
          2::bigint, 'new owners get core = on');
select is((select count(*) from public.account_module_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a3' and module_id <> 'core'),
          0::bigint, 'everything except core is off (no rows)');
select lives_ok($$insert into public.account_module_entitlements (tenant_id, module_id, state, source, reason)
                  select p.id, 'core', 'on', 'plan', 'Seed: existing account' from public.profiles p where p.role = 'owner'
                  on conflict (tenant_id, module_id) do nothing$$, 'seed statement is idempotent');
select is((select count(*) from public.account_module_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a3' and module_id = 'core'),
          1::bigint, 're-running the seed adds no duplicates');

-- ------------------------------------------------------------ constraints --
select pg_temp.act_service();
select throws_ok($$insert into public.account_module_entitlements (tenant_id, module_id, state) values ('00000000-0000-0000-0000-0000000000a3', 'bogus', 'on')$$,
                 '23514', null, 'unknown module ids are rejected');
select throws_ok($$insert into public.account_module_entitlements (tenant_id, module_id, state) values ('00000000-0000-0000-0000-0000000000a3', 'pay', 'trial')$$,
                 '23514', null, 'a trial without an expiry is rejected');
select lives_ok($$insert into public.account_module_entitlements (tenant_id, module_id, state, source) values ('00000000-0000-0000-0000-0000000000a4', 'packs:hvac-2', 'on', 'manual')$$,
                'packs:<slug> module ids are accepted');
select throws_ok($$update public.account_module_entitlements set module_id = 'ai' where tenant_id = '00000000-0000-0000-0000-0000000000a4' and module_id = 'packs:hvac-2'$$,
                 '22023', null, 'module_id cannot be changed');

-- ---------------------------------------------------------- authorization --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'pay', 'on', 'manual', null, 'self grant attempt')$$,
                 '42501', null, 'a tenant cannot grant itself a module');
select throws_ok($$select * from public.staff_list_entitlement_audit('00000000-0000-0000-0000-0000000000a3')$$, '42501', null, 'non-staff cannot read the audit RPC');
select throws_ok($$select * from public.staff_list_account_entitlements('00000000-0000-0000-0000-0000000000a4')$$, '42501', null, 'non-staff cannot read another account through the staff RPC');
select throws_ok($$update public.account_module_entitlements set state = 'on' where tenant_id = '00000000-0000-0000-0000-0000000000a3'$$,
                 '42501', null, 'a tenant cannot write the table directly');
select throws_ok($$select public.entitlement_check('00000000-0000-0000-0000-0000000000a3', 'core')$$, '42501', null, 'tenants cannot call entitlement_check (probing other accounts)');
select is((select count(*) from public.module_entitlement_audit), 0::bigint, 'tenants read no audit rows (RLS)');

-- ------------------------------------------------------------ staff writes --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'pay', 'on', 'manual', null, 'Pilot agreement signed')$$, 'staff can grant a module with a reason');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'ai', 'on', 'manual', null, '  hi ')$$, '22023', null, 'a reason shorter than 5 characters is rejected');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'nope', 'on', 'manual', null, 'valid reason')$$, '22023', null, 'unknown module is rejected');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'ai', 'maybe', 'manual', null, 'valid reason')$$, '22023', null, 'invalid state is rejected');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'ai', 'trial', 'manual', null, 'valid reason')$$, '22023', null, 'a trial needs an expiry');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'ai', 'on', 'manual', now() - interval '1 day', 'valid reason')$$, '22023', null, 'a past expiry is rejected');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000ff', 'ai', 'on', 'manual', null, 'valid reason')$$, 'P0002', null, 'unknown tenant is rejected');
select throws_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a5', 'ai', 'on', 'manual', null, 'valid reason')$$, 'P0002', null, 'a team member profile is not a tenant');
select lives_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a4', 'ai', 'trial', 'manual', now() + interval '1 hour', 'Trial for demo')$$, 'staff can start a timed trial');
select is((select count(*) from public.staff_list_account_entitlements('00000000-0000-0000-0000-0000000000a3')), 2::bigint, 'staff list shows core + pay for account A');

-- ----------------------------------------------- allow / deny / isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.has_module('pay'), true, 'A has pay');
select is(public.has_module('ai'), false, 'A has no ai (default deny)');
select is((select count(*) from public.get_my_entitlements()), 2::bigint, 'A reads all its modules in one call');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is(public.has_module('pay'), false, 'ISOLATION: B does not inherit A''s pay');
select is((select count(*) from public.get_my_entitlements() where module_id = 'pay'), 0::bigint, 'ISOLATION: B does not see A''s rows via the RPC');
select is((select count(*) from public.account_module_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a3'), 0::bigint, 'ISOLATION: RLS hides A''s rows from B');
select is(public.has_module('ai'), true, 'B has its active trial');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
select is(public.has_module('pay'), true, 'a team member resolves to the account owner''s modules');
select throws_ok($$insert into public.account_module_entitlements (tenant_id, module_id, state) values ('00000000-0000-0000-0000-0000000000a5', 'finance', 'on')$$,
                 '42501', null, 'a team member cannot write entitlements');

-- ------------------------------------------------------------ service role --
select pg_temp.act_service();
select is(public.entitlement_check('00000000-0000-0000-0000-0000000000a3', 'pay'), true, 'service check: entitled');
select is(public.entitlement_check('00000000-0000-0000-0000-0000000000a4', 'pay'), false, 'service check: other tenant is not entitled');
select is(public.entitlement_check('00000000-0000-0000-0000-0000000000a3', 'not a module'), false, 'service check: invalid module denies');
select is(public.entitlement_check(null, 'pay'), false, 'service check: null tenant denies');

-- ------------------------------------------------------------------ expiry --
update public.account_module_entitlements set expires_at = now() - interval '1 minute'
 where tenant_id = '00000000-0000-0000-0000-0000000000a4' and module_id = 'ai';
select is(public.entitlement_check('00000000-0000-0000-0000-0000000000a4', 'ai'), false, 'expired trial denies (service)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is(public.has_module('ai'), false, 'expired trial denies (tenant)');
select is((select active from public.get_my_entitlements() where module_id = 'ai'), false, 'expired row is reported inactive');

-- -------------------------------------------------------------------- revoke --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.staff_set_entitlement('00000000-0000-0000-0000-0000000000a3', 'pay', 'off', 'manual', null, 'Contract ended')$$, 'staff can revoke');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.has_module('pay'), false, 'revoked module denies immediately');

-- --------------------------------------------------------------------- audit --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.staff_list_entitlement_audit('00000000-0000-0000-0000-0000000000a3') where module_id = 'pay'), 2::bigint, 'audit holds grant + revoke');
select is((select action from public.staff_list_entitlement_audit('00000000-0000-0000-0000-0000000000a3') where module_id = 'pay' order by id desc limit 1), 'revoke', 'newest audit action is revoke');
select is((select reason from public.staff_list_entitlement_audit('00000000-0000-0000-0000-0000000000a3') where module_id = 'pay' order by id desc limit 1), 'Contract ended', 'audit stores the reason');
select pg_temp.act_service();
select ok((select count(*) from public.module_entitlement_audit where actor = '00000000-0000-0000-0000-0000000000a1') >= 3, 'audit stores the staff actor');

-- --------------------------------------------------------------- append-only --
select throws_ok($$update public.module_entitlement_audit set reason = 'edited'$$, '42501', null, 'audit rows cannot be updated');
select throws_ok($$delete from public.module_entitlement_audit$$, '42501', null, 'audit rows cannot be deleted');
select throws_ok($$truncate public.module_entitlement_audit$$, '42501', null, 'audit table cannot be truncated');

select * from finish();
rollback;
