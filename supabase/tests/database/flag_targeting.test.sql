-- Flag targeting: role + region (server-side), override precedence, fail-closed, validation, audit, grants (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff@tg.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-de@tg.test'),   -- tenant DE (country " de ")
  ('00000000-0000-0000-0000-0000000000c3', 'admin@tg.test'),      -- active admin of c2
  ('00000000-0000-0000-0000-0000000000c4', 'tech@tg.test'),       -- PENDING technician of c2
  ('00000000-0000-0000-0000-0000000000c5', 'owner-x@tg.test'),    -- tenant with free-text country
  ('00000000-0000-0000-0000-0000000000c6', 'owner-none@tg.test'); -- tenant without country
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000c1';
update public.profiles set business_country = ' de ', plan = 'professional' where id = '00000000-0000-0000-0000-0000000000c2';
update public.profiles set business_country = 'Germany' where id = '00000000-0000-0000-0000-0000000000c5';

insert into public.team_members (account_owner_id, member_email, role, invite_status, user_id) values
  ('00000000-0000-0000-0000-0000000000c2', 'admin@tg.test', 'admin', 'active', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000c2', 'tech@tg.test', 'technician', 'pending', '00000000-0000-0000-0000-0000000000c4');

insert into public.feature_flags (key, name, enabled, rollout_pct, targeting, risk) values
  ('tg_role',   'Role targeted',   true, 100, '{"roles": ["admin"]}', 'low'),
  ('tg_region', 'Region targeted', true, 100, '{"regions": ["DE", "US"]}', 'low'),
  ('tg_both',   'Role + region',   true, 100, '{"roles": ["admin"], "regions": ["DE"]}', 'low'),
  ('tg_plain',  'No targeting',    true, 100, '{}', 'low'),
  ('tg_hi',     'High risk',       false, 0, '{}', 'high');

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
create or replace function pg_temp.act_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true); -- back to the session (superuser) role
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------- decision: precedence (pure function) --
-- args: enabled, rollout, override, tenant, key, targeting, plan, role, country
select is(public.feature_flag_decision(false, 100, 'on',  gen_random_uuid(), 'k', '{}', 'p', 'admin', 'DE'), 'disabled', '1: master OFF beats an ON override');
select is(public.feature_flag_decision(true, 100, 'off', gen_random_uuid(), 'k', '{}', 'p', 'admin', 'DE'), 'override_off', '2: an OFF override beats 100 % rollout and matching targeting');
select is(public.feature_flag_decision(true, 0, 'on', gen_random_uuid(), 'k', '{"plans":["x"],"roles":["owner"],"regions":["FR"]}', 'p', 'member', 'DE'), 'override_on', '3: an ON override bypasses rollout, plan, role and region');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"plans":["x"]}', 'p', 'admin', 'DE'), 'plan_excluded', '4a: plan excludes');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":["admin"]}', 'p', 'member', 'DE'), 'role_excluded', '4b: role excludes');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"regions":["US"]}', 'p', 'admin', 'DE'), 'region_excluded', '4c: region excludes');
select is(public.feature_flag_decision(true, 0, null, gen_random_uuid(), 'k', '{"roles":["admin"]}', 'p', 'admin', 'DE'), 'rollout_excluded', '5a: targeted but outside the rollout percentage');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":["admin"],"regions":["DE"]}', 'p', 'admin', 'DE'), 'on', '5b: all dimensions match, 100 % => ON');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":["admin","owner"]}', 'p', 'owner', 'DE'), 'on', 'OR within a list');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":["admin"],"regions":["US"]}', 'p', 'admin', 'DE'), 'region_excluded', 'AND across lists: role ok, region fails => OFF');

-- fail closed + "no restriction" cases
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":["admin"]}', 'p', null, 'DE'), 'role_excluded', 'unknown role fails closed');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"regions":["DE"]}', 'p', 'admin', null), 'region_excluded', 'unknown country fails closed');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{}', 'p', null, null), 'on', 'no targeting => unknown attributes do not matter');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":[],"regions":[]}', 'p', null, null), 'on', 'empty lists = no restriction');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"roles":"admin"}', 'p', 'admin', 'DE'), 'role_excluded', 'a malformed (non-array) restriction fails closed');
select is(public.feature_flag_decision(true, 100, null, gen_random_uuid(), 'k', '{"regions":["de"]}', 'p', 'admin', 'DE'), 'region_excluded', 'stored values are canonical (upper-case); lower-case in stored JSON does not match');

-- ----------------------------------------------------------------- resolvers --
select is(public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c2'), 'owner', 'the account owner resolves to owner');
select is(public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3'), 'admin', 'an active member resolves to their team role');
select is(public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c4'), null, 'a PENDING invite has no role');
select is(public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000c3'), null, 'a member of another tenant has no role here (no cross-tenant role)');
select is(public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c2', null), null, 'no user => no role');
select is(public.feature_flag_tenant_country('00000000-0000-0000-0000-0000000000c2'), 'DE', 'country is trimmed and upper-cased');
select is(public.feature_flag_tenant_country('00000000-0000-0000-0000-0000000000c5'), null, 'free-text country ("Germany") does not match');
select is(public.feature_flag_tenant_country('00000000-0000-0000-0000-0000000000c6'), null, 'missing country is null');

-- --------------------------------------------- end-to-end evaluation (service role) --
select pg_temp.act_service();
select is(public.flag_evaluate_for_user('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3'), true, 'admin sees the admin-targeted flag');
select is(public.flag_evaluate_for_user('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c2'), false, 'owner does not (role not listed)');
select is(public.flag_evaluate_for_user('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c4'), false, 'pending technician does not');
select is(public.flag_evaluate('tg_role', '00000000-0000-0000-0000-0000000000c2'), false, 'tenant-level evaluation of a role-targeted flag is OFF (fail closed)');
select is(public.flag_evaluate('tg_region', '00000000-0000-0000-0000-0000000000c2'), true, 'DE tenant sees the DE/US flag at tenant level');
select is(public.flag_evaluate('tg_region', '00000000-0000-0000-0000-0000000000c5'), false, 'free-text-country tenant does not');
select is(public.flag_evaluate('tg_region', '00000000-0000-0000-0000-0000000000c6'), false, 'tenant without country does not');
select is(public.flag_evaluate_for_user('tg_both', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3'), true, 'admin in DE sees the role+region flag');
select is(public.flag_evaluate('tg_plain', '00000000-0000-0000-0000-0000000000c6'), true, 'an untargeted flag is unchanged (backward compatible)');
select is(public.flag_evaluate('does_not_exist', '00000000-0000-0000-0000-0000000000c2'), false, 'unknown flag is OFF');

-- override precedence through the real tables
select pg_temp.act_admin();
insert into public.feature_flag_overrides (flag_id, tenant_id, state) values
  ((select id from public.feature_flags where key = 'tg_role'), '00000000-0000-0000-0000-0000000000c6', 'on'),
  ((select id from public.feature_flags where key = 'tg_both'), '00000000-0000-0000-0000-0000000000c2', 'off');
select pg_temp.act_service();
select is(public.flag_evaluate('tg_role', '00000000-0000-0000-0000-0000000000c6'), true, 'an ON override turns a role-targeted flag on for the tenant (documented bypass)');
select is(public.flag_evaluate_for_user('tg_both', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3'), false, 'an OFF override beats matching role + region');
select pg_temp.act_admin();
update public.feature_flags set enabled = false where key = 'tg_role';
select pg_temp.act_service();
select is(public.flag_evaluate('tg_role', '00000000-0000-0000-0000-0000000000c6'), false, 'master OFF beats the ON override');

-- ------------------------------------------------------------ client function --
select pg_temp.act_admin();
update public.feature_flags set enabled = true where key = 'tg_role';
delete from public.feature_flag_overrides where flag_id = (select id from public.feature_flags where key = 'tg_role');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
select ok(exists (select 1 from public.get_my_feature_flags() where flag_key = 'tg_role'), 'get_my_feature_flags: the admin gets the role-targeted flag');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
select ok(not exists (select 1 from public.get_my_feature_flags() where flag_key = 'tg_role'), 'get_my_feature_flags: the owner does not');

-- ---------------------------------------------------------------- grants / auth --
select throws_ok($$select public.flag_evaluate_for_user('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3')$$, '42501', null, 'tenants cannot call flag_evaluate_for_user');
select throws_ok($$select public.feature_flag_user_role('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3')$$, '42501', null, 'tenants cannot probe other users'' roles');
select throws_ok($$select public.staff_set_flag_targeting('tg_plain', '{"roles":["admin"]}', 'not allowed')$$, '42501', null, 'non-staff cannot set targeting');
select throws_ok($$select * from public.staff_flag_explain('tg_role', '00000000-0000-0000-0000-0000000000c2', null)$$, '42501', null, 'non-staff cannot explain');

-- ------------------------------------------------- staff RPC, validation, audit --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$select public.staff_set_flag_targeting('tg_plain', '{"roles":["admin"]}', '')$$, '22023', null, 'a reason is mandatory');
select throws_ok($$select public.staff_set_flag_targeting('tg_plain', '{"roles":["boss"]}', 'bad role')$$, '22023', null, 'an unknown role is rejected');
select throws_ok($$select public.staff_set_flag_targeting('tg_plain', '{"regions":["Germany"]}', 'bad region')$$, '22023', null, 'a non ISO-2 region is rejected');
select throws_ok($$select public.staff_set_flag_targeting('tg_plain', '{"state":["CA"]}', 'bad key')$$, '22023', null, 'an unknown targeting key (e.g. state) is rejected');
select throws_ok($$select public.staff_set_flag_targeting('nope', '{}', 'missing flag')$$, 'P0002', null, 'an unknown flag is reported');
select is(public.staff_set_flag_targeting('tg_plain', '{"regions":["us","DE","de"],"roles":["Admin"]}', 'beta for DE/US admins'), '{"roles": ["admin"], "regions": ["DE", "US"]}'::jsonb, 'targeting is normalised (case, duplicates, order)');
select is((select after ->> 'change_reason' from public.feature_flag_audit where flag_key = 'tg_plain' and action = 'update' order by id desc limit 1), 'beta for DE/US admins', 'the audit row carries the reason');
select ok((select (after -> 'targeting') = '{"roles": ["admin"], "regions": ["DE", "US"]}'::jsonb and (before -> 'targeting') = '{}'::jsonb from public.feature_flag_audit where flag_key = 'tg_plain' and action = 'update' order by id desc limit 1), 'the audit row records targeting before and after');
select is((select reason from public.staff_flag_explain('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c2')), 'role_excluded', 'explain: owner is excluded by role');
select is((select resolved_role from public.staff_flag_explain('tg_role', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3')), 'admin', 'explain shows the server-resolved role');

-- high-risk guard still applies (enabled high-risk flag: targeting change needs the two-person flow)
select pg_temp.act_admin();
update public.feature_flags set enabled = true where key = 'tg_hi';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$select public.staff_set_flag_targeting('tg_hi', '{"roles":["admin"]}', 'try to widen')$$, '42501', null, 'an enabled high-risk flag cannot be re-targeted by one person');

-- direct table writes are validated too
select pg_temp.act_admin();
select throws_ok($$update public.feature_flags set targeting = '{"roles":["root"]}' where key = 'tg_plain'$$, '22023', null, 'the trigger validates direct writes');

select * from finish();
rollback;
