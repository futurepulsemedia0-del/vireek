-- Heat-index reminders: opt-in rules, tenant isolation, no client writes, idempotent ack (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- ---- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@heat.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@heat.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-heat.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@heat.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');

-- ---- structure ---------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.safety_heat_watches'::regclass), 'watches have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.safety_heat_events'::regclass), 'events have RLS');
select ok(public.safety_heat_intervals_ok('{"low":0,"caution":60,"high":30,"very_high":20,"extreme":15}'::jsonb), 'default intervals are valid');
select ok(not public.safety_heat_intervals_ok('{"low":0,"caution":4,"high":30,"very_high":20,"extreme":15}'::jsonb), 'interval below 5 is rejected');
select ok(not public.safety_heat_intervals_ok('{"low":0,"caution":60}'::jsonb), 'missing tiers are rejected');
select ok(not public.safety_heat_intervals_ok('{"low":0,"caution":"x","high":30,"very_high":20,"extreme":15}'::jsonb), 'non-numeric interval is rejected without erroring');

-- ---- the technician cannot turn the company switch on ----------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
set local role authenticated;
select throws_ok($$select public.heat_save_settings('{"enabled":true}'::jsonb)$$, '42501', null, 'a technician cannot change company heat settings');
select is((public.heat_start_watch('78701')) ->> 'error', 'heat_disabled', 'cannot start while the company has not turned heat reminders on');
reset role;

-- ---- owner turns it on --------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select is((public.heat_save_settings('{"enabled":true}'::jsonb)) ->> 'enabled', 'true', 'owner can turn heat reminders on');
select throws_ok($$select public.heat_save_settings('{"water_every_min":{"low":0,"caution":4,"high":30,"very_high":20,"extreme":15}}'::jsonb)$$, '22023', null, 'invalid interval is refused');
reset role;

-- ---- technician must opt in themselves ------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
set local role authenticated;
select is((public.heat_start_watch('78701')) ->> 'error', 'not_opted_in', 'company on is not enough: the technician must opt in');
select is((public.heat_set_optin(true)) ->> 'my_opted_in', 'true', 'technician opts in');
select is((public.heat_start_watch('787')) ->> 'error', 'bad_zip', 'a bad ZIP is refused');
create temp table _w as select (public.heat_start_watch('78701')) as r;
select is((select r ->> 'existing' from _w), 'false', 'first start creates a watch');
select is((public.heat_start_watch('78701')) ->> 'existing', 'true', 'starting twice returns the same watch (idempotent)');
select throws_ok($$insert into safety_heat_watches (user_id, team_member_id, zip) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c3', '78701')$$, '42501', null, 'clients cannot write watches directly');
reset role;

-- ---- ack is idempotent and restarts the cycle once --------------------------
insert into safety_heat_events (id, user_id, watch_id, kind, tier, dedupe_key)
select '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', (r ->> 'watch_id')::uuid, 'water_prompt', 'high', 'water:1' from _w;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
set local role authenticated;
select is((public.heat_ack('00000000-0000-0000-0000-0000000000e1')) ->> 'changed', 'true', 'first ack changes state');
select is((public.heat_ack('00000000-0000-0000-0000-0000000000e1')) ->> 'changed', 'false', 'second ack changes nothing');
reset role;

-- ---- tenant isolation -------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select is((select count(*)::int from safety_heat_watches), 0, 'another account sees no watches');

select * from finish();
rollback;
