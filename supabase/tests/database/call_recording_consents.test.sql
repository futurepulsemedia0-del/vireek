-- Call recording consent ledger: RLS, grants, immutability, constraints, by-state view (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- O = tenant owner under test, X = owner of another tenant.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@crc.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'other@crc.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false),
  ('00000000-0000-0000-0000-0000000000c1', 'owner', false)
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- Seed (service side): one pending row from a California area code, one finalized refusal with unknown state.
insert into public.call_recording_consents
  (user_id, vapi_call_id, business_country, caller_state, caller_state_source, profile_jurisdiction, profile_mode, effective_mode,
   language, language_supported, gate_mode, would_block, decision, recording_enabled_requested, spoken_kind)
values
  ('00000000-0000-0000-0000-0000000000b1', 'call-pending', 'US', 'CA', 'area_code_heuristic', 'US', 'notice', 'opt_in',
   'en', true, 'enforce', true, 'no_recording_consent_gate', false, 'transcript_consent_ask');
insert into public.call_recording_consents
  (user_id, vapi_call_id, business_country, profile_jurisdiction, profile_mode, effective_mode,
   language, language_supported, gate_mode, would_block, decision, recording_enabled_requested, spoken_kind, consent_outcome, finalized_at)
values
  ('00000000-0000-0000-0000-0000000000b1', 'call-declined', 'US', 'US', 'notice', 'notice',
   'en', true, 'enforce', false, 'record_after_notice', true, 'recording_notice', 'declined', now());

-- ---------------------------------------------------------------- structure --
select has_table('public', 'call_recording_consents', 'table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.call_recording_consents'::regclass), 'RLS is enabled');
select ok(not has_table_privilege('anon', 'public.call_recording_consents', 'SELECT'), 'anon has no SELECT');
select ok(not has_table_privilege('authenticated', 'public.call_recording_consents', 'INSERT'), 'authenticated has no INSERT');
select ok(not has_table_privilege('authenticated', 'public.call_recording_consents', 'UPDATE'), 'authenticated has no UPDATE');
select ok(not has_table_privilege('authenticated', 'public.call_recording_consents', 'DELETE'), 'authenticated has no DELETE');
select ok(has_table_privilege('authenticated', 'public.call_recording_consents', 'SELECT'), 'authenticated has SELECT (RLS filters)');
select has_view('public', 'call_recording_consents_by_state', 'by-state view exists');

-- ------------------------------------------------------------------ isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.call_recording_consents), 2, 'owner sees own rows');
select is((select count(*)::int from public.call_recording_consents_by_state), 2, 'owner view has one group per state/outcome shape (CA, unknown)');
select throws_ok($$insert into public.call_recording_consents
  (user_id, vapi_call_id, profile_jurisdiction, profile_mode, effective_mode, language, language_supported, gate_mode, would_block, decision, recording_enabled_requested, spoken_kind)
  values ('00000000-0000-0000-0000-0000000000b1', 'x', 'US', 'notice', 'notice', 'en', true, 'shadow', false, 'record_after_notice', true, 'none')$$,
  '42501', null, 'a signed-in owner cannot write the ledger');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.call_recording_consents), 0, 'another tenant sees nothing');

-- ---------------------------------------------------------- service-side rules --
select pg_temp.reset_role();
select lives_ok($$update public.call_recording_consents set consent_outcome = 'granted', finalized_at = now(), recording_stored = false, transcript_stored = true
  where vapi_call_id = 'call-pending'$$, 'a pending row can be finalized once');
select throws_ok($$update public.call_recording_consents set notice_text = 'edited' where vapi_call_id = 'call-pending'$$,
  'P0001', 'call_recording_consent_is_immutable', 'a finalized row cannot be rewritten');
select lives_ok($$update public.call_recording_consents set provider_deletion_required = true where vapi_call_id = 'call-declined'$$,
  'the provider-deletion flag may still be set after finalizing');
select throws_ok($$insert into public.call_recording_consents
  (user_id, vapi_call_id, profile_jurisdiction, profile_mode, effective_mode, language, language_supported, gate_mode, would_block, decision, recording_enabled_requested, spoken_kind)
  values ('00000000-0000-0000-0000-0000000000b1', 'call-x', 'US', 'notice', 'notice', 'en', true, 'shadow', false, 'bogus', true, 'none')$$,
  '23514', null, 'an unknown decision is rejected');
select throws_ok($$insert into public.call_recording_consents
  (user_id, vapi_call_id, profile_jurisdiction, profile_mode, effective_mode, language, language_supported, gate_mode, would_block, decision, recording_enabled_requested, spoken_kind)
  values ('00000000-0000-0000-0000-0000000000b1', 'call-declined', 'US', 'notice', 'notice', 'en', true, 'shadow', false, 'record_after_notice', true, 'none')$$,
  '23505', null, 'one row per call');

select * from finish();
rollback;
