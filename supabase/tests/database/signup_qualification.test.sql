-- signup_qualification: RLS, RPC authorization, mirroring rules (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- a1 = owner, a3 = team member of a1, a4 = unrelated user, a5 = fresh user who skips
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sq-owner@test.local'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sq-member@test.local'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sq-other@test.local'),
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sq-skip@test.local');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'sq-member@test.local', 'Sam Member', 'admin',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------------------------------------------------------------- owner saves --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(
  $$select public.save_signup_qualification('hvac', '2-5', 'voicemail', false)$$,
  'owner can save answers');
select is((select status from public.signup_qualification where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'completed', 'status is completed');

reset role;
select is((select primary_industry from public.business_profile where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'hvac', 'answer is mirrored into an empty business_profile column');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(
  $$select public.save_signup_qualification('plumbing', null, null, false)$$,
  'owner can re-save with a different trade');
select is((select trade from public.signup_qualification where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'plumbing', 'qualification row takes the latest answer');

reset role;
select is((select primary_industry from public.business_profile where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'hvac', 'existing business_profile value is never overwritten');

-- ---------------------------------------------------------------- validation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$select public.save_signup_qualification('not-a-trade', null, null, false)$$,
  '23514', null, 'unknown option value is rejected');

-- ---------------------------------------------------------------- isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from public.signup_qualification where user_id = '00000000-0000-0000-0000-0000000000a1'),
  0, 'another tenant cannot read the row (RLS)');
select throws_ok(
  $$insert into public.signup_qualification (user_id, status) values ('00000000-0000-0000-0000-0000000000a4', 'completed')$$,
  '42501', null, 'authenticated cannot write the table directly');

-- ---------------------------------------------------------------- skip path --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
select lives_ok(
  $$select public.save_signup_qualification(null, null, null, true)$$,
  'skip with no answers succeeds');
reset role;
select ok(
  (select status from public.signup_qualification where user_id = '00000000-0000-0000-0000-0000000000a5') = 'skipped'
  and not exists (select 1 from public.business_profile where user_id = '00000000-0000-0000-0000-0000000000a5'),
  'skip records status and creates no business_profile');

-- ---------------------------------------------------------------- team member --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok(
  $$select public.save_signup_qualification('roofing', null, null, false)$$,
  'team member can save their own row');
reset role;
select ok(
  (select primary_industry from public.business_profile where user_id = '00000000-0000-0000-0000-0000000000a1') = 'hvac'
  and not exists (select 1 from public.business_profile where user_id = '00000000-0000-0000-0000-0000000000a3'),
  'team member never touches the owner business_profile');

-- ---------------------------------------------------------------- anon --
set local role anon;
select throws_ok(
  $$select public.save_signup_qualification('hvac', null, null, false)$$,
  '42501', null, 'anon cannot execute the function');
reset role;

select * from finish();
rollback;
