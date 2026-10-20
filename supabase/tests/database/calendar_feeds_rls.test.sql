-- ICS calendar feeds: RLS / RPC authorization tests (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (admin), T1/T2 technicians, X = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'tech2@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech1@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'tech2@acme.test', 'Tina Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ owner creates --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.biz', (public.calendar_feed_ensure('business')).id::text, true);
select ok(current_setting('t.biz')::uuid is not null, 'owner can create the business feed');
select is((public.calendar_feed_ensure('business')).id, current_setting('t.biz')::uuid, 'creating the business feed twice is idempotent');
select matches((select token from public.calendar_feeds where id = current_setting('t.biz')::uuid), '^[0-9a-f]{64}$',
  'the token is 64 lowercase hex characters');
select set_config('t.f3', (public.calendar_feed_ensure('technician', '00000000-0000-0000-0000-0000000000c3')).id::text, true);
select ok(current_setting('t.f3')::uuid is not null, 'owner can create a technician feed');
select throws_ok($$ select public.calendar_feed_ensure('technician') $$, '22023', null, 'a technician feed requires a team member');
select throws_ok($$ select public.calendar_feed_ensure('nonsense') $$, '22023', null, 'unknown scope is rejected');
select throws_ok($$ select public.calendar_feed_ensure('business', '00000000-0000-0000-0000-0000000000c3') $$, '42501', null,
  'a business feed cannot be tied to a team member');
select is((select count(*) from public.calendar_feeds)::int, 2, 'owner sees both feeds');

-- ------------------------------------------------------------ manager (admin) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$ select public.calendar_feed_ensure('technician', '00000000-0000-0000-0000-0000000000c4') $$,
  'manager can create a feed for any technician in the account');
select is((select count(*) from public.calendar_feeds)::int, 3, 'manager sees the business feed and all technician feeds');
select is((public.calendar_feed_overview() ->> 'can_manage')::boolean, true, 'overview reports manager rights');
select is(jsonb_array_length(public.calendar_feed_overview() -> 'members'), 3, 'manager overview lists the whole roster');

-- ----------------------------------------------------------------- technician --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.calendar_feeds)::int, 1, 'technician sees only his own feed');
select is((select team_member_id from public.calendar_feeds), '00000000-0000-0000-0000-0000000000c3'::uuid, 'and it is his own');
select is((public.calendar_feed_ensure('technician', '00000000-0000-0000-0000-0000000000c3')).id, current_setting('t.f3')::uuid,
  'technician gets his existing feed back (idempotent)');
select throws_ok($$ select public.calendar_feed_ensure('technician', '00000000-0000-0000-0000-0000000000c4') $$, '42501', null,
  'technician cannot create a colleague''s feed');
select throws_ok($$ select public.calendar_feed_ensure('business') $$, '42501', null, 'technician cannot create the business feed');
select is((public.calendar_feed_overview() ->> 'can_manage')::boolean, false, 'overview reports no manager rights');
select is(jsonb_array_length(public.calendar_feed_overview() -> 'members'), 0, 'technician overview hides the roster');
select throws_ok($$ insert into public.calendar_feeds (user_id, scope) values ('00000000-0000-0000-0000-0000000000a1', 'business') $$, '42501', null,
  'clients cannot insert into the table directly');
select throws_ok($$ update public.calendar_feeds set enabled = false $$, '42501', null, 'clients cannot update the table directly');

-- regenerate: own feed works, token changes, old token is gone
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.old', (select token from public.calendar_feeds where id = current_setting('t.f3')::uuid), true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select isnt((public.calendar_feed_regenerate(current_setting('t.f3')::uuid)).token, current_setting('t.old'), 'technician can rotate his own link');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.calendar_feeds where token = current_setting('t.old'))::int, 0, 'the old token no longer exists after rotation');
select ok((select rotated_at is not null and access_count = 0 from public.calendar_feeds where id = current_setting('t.f3')::uuid),
  'rotation stamps rotated_at and resets usage');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok(format($$ select public.calendar_feed_regenerate(%L) $$, current_setting('t.f3')), '42501', null,
  'a technician cannot rotate a colleague''s link');
select throws_ok(format($$ select public.calendar_feed_update(%L, false, null) $$, current_setting('t.biz')), '42501', null,
  'a technician cannot pause the business feed');

-- update: privacy + pause, validated
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((public.calendar_feed_update(current_setting('t.f3')::uuid, false, 'busy')).detail_level, 'busy', 'technician can set his feed to busy-only and pause it');
select throws_ok(format($$ select public.calendar_feed_update(%L, null, 'everything') $$, current_setting('t.f3')), '22023', null,
  'invalid detail level is rejected');

-- ------------------------------------------------------- another account / anon --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.calendar_feeds)::int, 0, 'another account sees none of our feeds');
select throws_ok($$ select public.calendar_feed_ensure('technician', '00000000-0000-0000-0000-0000000000c3') $$, '42501', null,
  'another account cannot create a feed for our technician');

select set_config('role', 'anon', true);
select throws_ok($$ select * from public.calendar_feeds $$, '42501', null, 'anon cannot read feeds (tokens)');

select * from finish();
rollback;
