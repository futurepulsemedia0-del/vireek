-- Dispatch Wallboard: token gating / RLS / PII-minimisation tests (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- ---------------------------------------------------------------- fixtures --
-- A = owner of the account under test, M = a manager on A's team, B = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_all_jobs": true}');

insert into public.jobs (id, user_id, customer_name, address, scheduled_datetime, job_status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Maria Garcia', '123 Secret Street', now(), 'in_progress'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'Walter White', '9 Hidden Lane', now(), 'scheduled'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Other Company Customer', '1 Other Road', now(), 'scheduled');

insert into public.calls (user_id, caller_phone, status, call_datetime) values
  ('00000000-0000-0000-0000-0000000000a1', '+15551234567', 'missed', now()),
  ('00000000-0000-0000-0000-0000000000a1', '+15559998888', 'new_lead', now()),
  ('00000000-0000-0000-0000-0000000000b1', '+15550001111', 'missed', now());

insert into public.emergency_incidents (user_id, customer_name, severity_tier, sla_minutes, sla_due_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'Pat Burst', 'critical', 30, now() + interval '30 minutes');

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

-- ------------------------------------------------------------ owner-only RPCs --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$ select * from public.create_wallboard('Manager TV') $$, '42501', null,
  'a manager (not the owner) cannot create a wallboard');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.tok', (select token from public.create_wallboard('Front office TV', 20, array['jobs','revenue'], 50000)), true);
select ok(current_setting('t.tok') ~ '^[0-9a-f]{64}$', 'owner gets a 64-hex token, returned once');
select is((select count(*)::int from public.wallboards), 1, 'owner sees exactly their own wallboard');
select throws_ok($$ select token_hash from public.wallboards $$, '42501', null,
  'token_hash is not selectable, even by the owner');
select throws_ok($$ select channel_key from public.wallboards $$, '42501', null,
  'channel_key is not selectable by clients');

-- ------------------------------------------------------- anonymous TV access --
select pg_temp.act_as_anon();
select throws_ok($$ select * from public.wallboards $$, '42501', null,
  'anon has no direct table access to wallboards');
select set_config('t.snap', public.get_wallboard_snapshot(current_setting('t.tok'))::text, true);
select ok(current_setting('t.snap') <> '', 'anon can read a snapshot with a valid token');
select is((current_setting('t.snap')::jsonb) -> 'config' ->> 'name', 'Front office TV', 'snapshot carries the display name');
select is((current_setting('t.snap')::jsonb) -> 'config' -> 'panels', '["jobs","revenue"]'::jsonb, 'snapshot carries the configured panels');
select is((current_setting('t.snap')::jsonb) -> 'job_counts' ->> 'total', '2', 'only the owner account''s two jobs are counted');
select ok(current_setting('t.snap') not like '%Other Company%', 'another account''s data never appears');
select ok(current_setting('t.snap') like '%Maria G.%', 'customer names are shortened');
select ok(current_setting('t.snap') not like '%Garcia%' and current_setting('t.snap') not like '%Secret Street%' and current_setting('t.snap') not like '%Hidden Lane%',
  'no full surnames and no street addresses leave the database');
select is((current_setting('t.snap')::jsonb) -> 'calls' ->> 'missed_today', '1', 'missed calls are counted per account');
select ok(current_setting('t.snap') like '%•••• 4567%' and current_setting('t.snap') not like '%5551234567%', 'caller numbers are masked');
select is(jsonb_array_length((current_setting('t.snap')::jsonb) -> 'emergencies'), 1, 'open emergencies are listed');
select is(public.get_wallboard_snapshot('not-a-token'), null, 'malformed tokens return NULL');
select is(public.get_wallboard_snapshot(repeat('0', 64)), null, 'unknown tokens return NULL');

-- ------------------------------------------------------------------- revoke --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.id', (select id::text from public.wallboards limit 1), true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.revoke_wallboard(current_setting('t.id')::uuid), false, 'another account cannot revoke this wallboard');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.revoke_wallboard(current_setting('t.id')::uuid), true, 'owner can revoke');
select pg_temp.act_as_anon();
select is(public.get_wallboard_snapshot(current_setting('t.tok')), null, 'a revoked token immediately stops working');

select * from finish();
rollback;
