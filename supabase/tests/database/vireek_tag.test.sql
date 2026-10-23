-- Vireek Tag: RLS / RPC / rotation / rate-limit tests (pgTAP).  Run: supabase test db
-- If your customers/equipment tables have extra NOT NULL columns, add them to the fixtures below.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.customers (id, user_id, name, phone) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', '+15550100001');
insert into public.equipment (id, user_id, customer_id, equipment_type, make, model, serial_number) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Furnace', 'Carrier', '59TP6', 'SN-TAG-0001');
insert into public.business_profile (user_id, booking_slug, booking_enabled)
  values ('00000000-0000-0000-0000-0000000000a1', 'acme-hvac', true)
  on conflict (user_id) do update set booking_slug = 'acme-hvac', booking_enabled = true;

create temp table ctx (k text primary key, v text);
grant all on ctx to public;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.act_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$
begin execute 'reset role'; end $$;

-- 1-3 inventory + isolation ---------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(jsonb_array_length(public.generate_equipment_tags(3, 'Batch A')->'tags'), 3, 'owner can generate a batch of tags');
select pg_temp.reset();
insert into ctx select 't1', token from public.equipment_tags order by token limit 1;
insert into ctx select 't1id', id::text from public.equipment_tags where token = (select v from ctx where k = 't1');
insert into ctx select 'u2id', id::text from public.equipment_tags where token <> (select v from ctx where k = 't1') limit 1;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.equipment_tags), 0, 'another account sees none of the tags');
select pg_temp.reset();
select pg_temp.act_anon();
select throws_ok('select count(*) from public.equipment_tags', '42501', null, 'anon cannot read the tags table');
select pg_temp.reset();

-- 4-6 assignment --------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.assign_equipment_tag((select v from ctx where k = 't1'), '00000000-0000-0000-0000-0000000000e1')->>'equipment_id',
          '00000000-0000-0000-0000-0000000000e1', 'owner binds a tag to equipment');
select throws_ok($$select public.assign_equipment_tag((select v from ctx where k = 't1'), '00000000-0000-0000-0000-0000000000e1')$$,
          'P0001', 'TAG_ALREADY_ASSIGNED', 'a tag cannot be assigned twice');
select pg_temp.reset();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.assign_equipment_tag((select v from ctx where k = 't1'), '00000000-0000-0000-0000-0000000000e1')$$,
          'P0001', 'TAG_NOT_FOUND', 'another account cannot touch the tag (and learns nothing)');
select pg_temp.reset();

-- 7-10 public resolve ---------------------------------------------------------------------------
select pg_temp.act_anon();
select is(public.resolve_equipment_tag((select v from ctx where k = 't1'), 'session-one-aaaa')->>'state', 'active', 'anon resolves an active tag');
select isnt(public.resolve_equipment_tag((select v from ctx where k = 't1'), 'session-one-aaaa')->'passport'->'passport'->>'serial', 'SN-TAG-0001', 'public view masks the serial');
select is(position('Pat Customer' in public.resolve_equipment_tag((select v from ctx where k = 't1'), 'session-one-aaaa')::text), 0, 'public view never contains the customer name');
select is(public.resolve_equipment_tag('ZZZZZZZZZZZZZZZZ')->>'found', 'false', 'unknown token is not found');
select pg_temp.reset();

-- 11 analytics dedupe ---------------------------------------------------------------------------
select is((select count(*)::int from public.equipment_tag_events where action = 'scan' and outcome = 'active'), 1,
          'repeat scans in one session are counted once');

-- 12-19 public service request + abuse protection -----------------------------------------------
select pg_temp.act_anon();
select is(public.submit_tag_service_request((select v from ctx where k = 't1'), 'Pat Customer', '+15550100001', null, 'No heat', 'urgent', 'session-one-aaaa', null)->>'ok',
          'true', 'anon can request service');
select pg_temp.reset();
select is((select count(*)::int from public.leads where user_id = '00000000-0000-0000-0000-0000000000a1' and service_interested = 'Service request (Vireek Tag)'), 1,
          'the request became a lead');
select pg_temp.act_anon();
select is(public.submit_tag_service_request((select v from ctx where k = 't1'), 'Bot', '+15550100002', null, 'spam', 'soon', 'session-bot-aaaa', 'http://spam.test')->>'ok',
          'true', 'honeypot answers ok');
select pg_temp.reset();
select is((select count(*)::int from public.leads where user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'honeypot stored nothing');
select pg_temp.act_anon();
select throws_ok($$select public.submit_tag_service_request((select v from ctx where k = 't1'), 'Pat Customer', null, null, 'x', 'soon', 'session-one-aaaa', null)$$,
          'P0001', null, 'a request without any contact is rejected');
select lives_ok($$select public.submit_tag_service_request((select v from ctx where k = 't1'), 'Pat Customer', '+15550100001', null, 'again', 'soon', 'session-one-aaaa', null)$$, 'second request ok');
select lives_ok($$select public.submit_tag_service_request((select v from ctx where k = 't1'), 'Pat Customer', '+15550100001', null, 'again', 'soon', 'session-one-aaaa', null)$$, 'third request ok');
select throws_ok($$select public.submit_tag_service_request((select v from ctx where k = 't1'), 'Pat Customer', '+15550100001', null, 'again', 'soon', 'session-one-aaaa', null)$$,
          'P0001', 'TAG_RATE_LIMITED', 'the same visitor is rate limited');
select pg_temp.reset();

-- 20-25 rotation + revoke -----------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select isnt(public.rotate_equipment_tag((select v from ctx where k = 't1id')::uuid, 'lost')->>'token', null, 'rotation returns a fresh token');
select pg_temp.reset();
insert into ctx select 'n1', token from public.equipment_tags where rotated_from_id = (select v from ctx where k = 't1id')::uuid;
select pg_temp.act_anon();
select is(public.resolve_equipment_tag((select v from ctx where k = 't1'), 'session-two-bbbb')->>'state', 'rotated', 'the old token now resolves as replaced');
select is((public.resolve_equipment_tag((select v from ctx where k = 't1'), 'session-two-bbbb')->'passport')::text, null::text, 'a replaced token leaks no machine data');
select pg_temp.reset();
select is((select count(*)::int from public.equipment_tags where status = 'active'), 1, 'exactly one active tag per passport');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select public.rotate_equipment_tag((select v from ctx where k = 't1id')::uuid, 'lost')$$, 'P0001', 'TAG_NOT_ACTIVE', 'a retired tag cannot be rotated again');
select is(public.revoke_equipment_tag((select v from ctx where k = 'u2id')::uuid)->>'status', 'revoked', 'unused stock can be revoked');

-- 26 analytics ----------------------------------------------------------------------------------
select is((public.get_tag_analytics(30)->'totals'->>'stale_scans')::int, 1, 'analytics count scans of retired tags');

-- 27-29 quick job -------------------------------------------------------------------------------
select is(public.create_job_from_tag((select v from ctx where k = 'n1'), 'Furnace repair')->>'existing', 'false', 'quick job is created from a tag');
select is(public.create_job_from_tag((select v from ctx where k = 'n1'), 'Furnace repair')->>'existing', 'true', 'a double tap does not duplicate the job');
select pg_temp.reset();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.create_job_from_tag((select v from ctx where k = 'n1'), 'Furnace repair')$$, 'P0001', 'TAG_FORBIDDEN', 'another company cannot create jobs from your tag');
select pg_temp.reset();

select * from finish();
rollback;
