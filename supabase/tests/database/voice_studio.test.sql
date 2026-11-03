-- Voice Studio: tenant isolation, server-owned writes, vote integrity, experiment stats (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.business_locations (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Acme North'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b1', 'Other Main');

insert into public.voice_studio_profiles (user_id, scenario, voice_key) values
  ('00000000-0000-0000-0000-0000000000a1', 'default', 'sarah-warm-f-us'),
  ('00000000-0000-0000-0000-0000000000b1', 'default', 'miles-confident-m-us');

insert into public.voice_clone_consents (id, user_id, signed_by, voice_owner_name, relationship, consent_version, consent_sha256, attested, liveness_phrase) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
   'Bob Other', 'self', 'v1', repeat('a', 64), true, 'amber river cedar delta');

insert into public.voice_experiments (id, user_id, name, status, arms) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Warm vs confident', 'running',
   '[{"key":"a","weight":1,"voiceKey":"sarah-warm-f-us"},{"key":"b","weight":1,"voiceKey":"miles-confident-m-us"}]');

insert into public.voice_experiment_assignments (experiment_id, user_id, call_id, arm_key) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'a'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'call-2', 'a'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'call-3', 'b');

insert into public.calls (user_id, vapi_call_id, duration_seconds, booking_outcome) values
  ('00000000-0000-0000-0000-0000000000a1', 'call-1', 120, 'booked'),
  ('00000000-0000-0000-0000-0000000000a1', 'call-2', 5, 'not_booked'),
  ('00000000-0000-0000-0000-0000000000a1', 'call-3', 90, 'not_booked');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.voice_studio_profiles), 1, 'owner sees only their own voice profile');
select throws_ok($$ insert into public.voice_studio_profiles (user_id, scenario, voice_key) values ('00000000-0000-0000-0000-0000000000b1', 'sales', 'sarah-warm-f-us') $$,
  '42501', null, 'owner cannot write a profile into another tenant');
select throws_ok($$ insert into public.voice_studio_profiles (user_id, location_id, scenario, voice_key) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', 'sales', 'sarah-warm-f-us') $$,
  '42501', null, 'owner cannot attach a profile to another tenant''s location');
select lives_ok($$ insert into public.voice_studio_profiles (user_id, location_id, scenario, voice_key) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'emergency', 'maya-calm-f-uk') $$,
  'owner can attach a profile to their own location');
select is((select count(*)::int from public.voice_clone_consents), 0, 'owner cannot read another tenant''s consent records');
select throws_ok($$ insert into public.voice_clone_consents (user_id, signed_by, voice_owner_name, relationship, consent_version, consent_sha256, attested, liveness_phrase) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'Ann Owner', 'self', 'v1', repeat('b', 64), true, 'amber river cedar delta') $$,
  '42501', null, 'clients cannot forge consent records');
select throws_ok($$ update public.voice_experiments set status = 'completed' $$,
  '42501', null, 'clients cannot change experiments directly');
select throws_ok($$ insert into public.voice_studio_preview_log (user_id, voice_key, chars, ok) values ('00000000-0000-0000-0000-0000000000a1', 'sarah-warm-f-us', 10, true) $$,
  '42501', null, 'clients cannot write the preview log');

select is((select n_calls from public.voice_experiment_stats('00000000-0000-0000-0000-0000000000c1') where arm = 'a'), 2::bigint, 'stats count calls per arm');
select is((select n_bookings from public.voice_experiment_stats('00000000-0000-0000-0000-0000000000c1') where arm = 'a'), 1::bigint, 'stats count bookings');
select is((select n_hangups from public.voice_experiment_stats('00000000-0000-0000-0000-0000000000c1') where arm = 'a'), 1::bigint, 'stats count short unbooked calls as hang-ups');

select lives_ok($$ insert into public.voice_ab_votes (session_id, voice_key) values ('k3m9x2ab-01', 'sarah-warm-f-us') $$, 'a member can vote once');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select * from public.voice_experiment_stats('00000000-0000-0000-0000-0000000000c1') $$,
  '42501', null, 'another tenant cannot read experiment stats');

reset role;
select throws_ok($$ insert into public.voice_ab_votes (user_id, voter_id, session_id, voice_key) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'k3m9x2ab-01', 'miles-confident-m-us') $$,
  '23505', null, 'one vote per voter per session');

select * from finish();
rollback;
