-- warranty_claims: tenant isolation (RLS) tests (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
-- Policies under test: select/insert/update/delete_own_warranty_claims  (user_id = get_account_owner_id()).
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- ---------------------------------------------------------------- fixtures --
-- A, B   = owners of two DIFFERENT tenants
-- AM     = active admin team member of A         (a2)
-- AT     = active technician team member of A    (a3)
-- AP     = PENDING (not yet accepted) invitee of A (a4)
-- S      = signed-in stranger with no profile and no team row (c1)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@b.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@a.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@a.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'pending@a.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'stranger@x.test');
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@b.test')
  on conflict (id) do nothing;
insert into public.team_members (account_owner_id, member_email, role, invite_status, user_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@a.test',   'admin',      'active',  '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a1', 'tech@a.test',    'technician', 'active',  '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000a1', 'pending@a.test', 'technician', 'pending', '00000000-0000-0000-0000-0000000000a4');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;

insert into public.warranty_claims (id, user_id, customer_name, manufacturer, claim_deadline) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'Customer of A', 'Carrier', current_date + 3),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'Customer of B', 'Trane',   current_date + 3);

select ok((select relrowsecurity from pg_class where oid = 'public.warranty_claims'::regclass), 'RLS is enabled on warranty_claims');

-- ------------------------------------------------------------------- owner A --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.warranty_claims)::int, 1, 'owner A sees exactly one claim');
select is((select customer_name from public.warranty_claims), 'Customer of A', 'and it is A''s own');
select is((select count(*) from public.warranty_claims where id = '10000000-0000-0000-0000-00000000000b')::int, 0, 'A cannot read B''s claim even by primary key');
select lives_ok($$ update public.warranty_claims set customer_name = 'HACKED' where id = '10000000-0000-0000-0000-00000000000b' $$, 'updating B''s claim does not error (RLS filters it)');
select lives_ok($$ delete from public.warranty_claims where id = '10000000-0000-0000-0000-00000000000b' $$, 'deleting B''s claim does not error (RLS filters it)');
select throws_ok($$ insert into public.warranty_claims (user_id, customer_name) values ('00000000-0000-0000-0000-0000000000b1', 'planted in B') $$, '42501', null, 'A cannot insert a claim owned by B');
select throws_ok($$ update public.warranty_claims set user_id = '00000000-0000-0000-0000-0000000000b1' where id = '10000000-0000-0000-0000-00000000000a' $$, '42501', null, 'A cannot hand one of its own claims to B (WITH CHECK)');
select lives_ok($$ insert into public.warranty_claims (customer_name) values ('new claim of A') $$, 'A can insert a claim (user_id defaults to auth.uid())');
select is((select user_id from public.warranty_claims where customer_name = 'new claim of A'), '00000000-0000-0000-0000-0000000000a1'::uuid, 'the new claim is stamped with A');

-- B's data really is untouched (checked as the table owner, bypassing RLS)
reset role;
select is((select customer_name from public.warranty_claims where id = '10000000-0000-0000-0000-00000000000b'), 'Customer of B', 'B''s claim was not modified by A');
select is((select count(*) from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000b1')::int, 1, 'B still has exactly its one claim (nothing deleted, nothing planted)');

-- ------------------------------------------------------------------- owner B --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.warranty_claims)::int, 1, 'owner B sees exactly one claim');
select is((select count(*) from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000a1')::int, 0, 'B sees none of A''s claims');

-- ------------------------------------------------------------- A's team (active) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.warranty_claims)::int, 2, 'an active team member of A sees A''s claims (and none of B''s)');
select throws_ok($$ insert into public.warranty_claims (user_id, customer_name) values ('00000000-0000-0000-0000-0000000000b1', 'team member plants in B') $$, '42501', null, 'a team member of A cannot insert into B either');

-- ----------------------------------------------------------- strangers / anon --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*) from public.warranty_claims)::int, 0, 'a signed-in user with no profile and no team sees nothing');
select pg_temp.act_as_anon();
select is((select count(*) from public.warranty_claims)::int, 0, 'anon sees nothing');
select throws_ok($$ insert into public.warranty_claims (user_id, customer_name) values ('00000000-0000-0000-0000-0000000000a1', 'anon insert') $$, '42501', null, 'anon cannot insert');

-- ----------------------------------------------- known gap, expressed as TODO --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select todo_start('PENDING invitees should not see tenant data: get_account_owner_id() resolves team_members by user_id without checking invite_status');
select is((select count(*) from public.warranty_claims)::int, 0, 'a pending (not yet accepted) invitee of A sees none of A''s claims');
select todo_end();

-- -------------------------------------------- service role bypasses RLS (by design) --
reset role;
select set_config('role', 'service_role', true);
select is((select count(*) from public.warranty_claims where customer_name in ('Customer of A', 'Customer of B'))::int, 2, 'service_role sees every tenant — edge functions using it must scope by user_id themselves');

select * from finish();
rollback;
