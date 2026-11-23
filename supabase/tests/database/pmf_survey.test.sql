-- PMF survey: eligibility, frequency cap, consent-adjacent opt-outs, redaction, segments, staff-only aggregates (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- ---- fixtures ---------------------------------------------------------------
-- o1: eligible (60 days old, 12 calls in 30d).  o2: too new.  o3: old but barely used.  o4: eligible, will choose "never".
-- s1: staff.  o1..o4 are plain owners.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'o1@test.dev'),
  ('00000000-0000-0000-0000-0000000000e2', 'o2@test.dev'),
  ('00000000-0000-0000-0000-0000000000e3', 'o3@test.dev'),
  ('00000000-0000-0000-0000-0000000000e4', 'o4@test.dev'),
  ('00000000-0000-0000-0000-0000000000f1', 's1@test.dev');
insert into profiles (id, email, role, is_staff, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'o1@test.dev', 'owner', false, now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000000e2', 'o2@test.dev', 'owner', false, now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000000e3', 'o3@test.dev', 'owner', false, now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000000e4', 'o4@test.dev', 'owner', false, now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000000f1', 's1@test.dev', 'owner', true,  now() - interval '400 days');
insert into calls (user_id) select '00000000-0000-0000-0000-0000000000e1' from generate_series(1, 12);
insert into calls (user_id) select '00000000-0000-0000-0000-0000000000e2' from generate_series(1, 12);
insert into calls (user_id) select '00000000-0000-0000-0000-0000000000e3' from generate_series(1, 3);
insert into calls (user_id) select '00000000-0000-0000-0000-0000000000e4' from generate_series(1, 12);

-- ---- 1. RLS and privileges ----------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.pmf_survey_responses'::regclass), 'RLS on pmf_survey_responses');
select ok((select relrowsecurity from pg_class where oid = 'public.pmf_survey_events'::regclass), 'RLS on pmf_survey_events');
select ok(not has_table_privilege('authenticated', 'public.pmf_survey_responses', 'select'), 'clients cannot read responses directly');
select ok(not has_table_privilege('authenticated', 'public.pmf_survey_events', 'insert'), 'clients cannot write events directly');
select ok(not has_function_privilege('authenticated', 'public._pmf_due(uuid,uuid)', 'execute'), 'eligibility helper is not callable by clients');

-- ---- 2. eligibility ------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
set local role authenticated;
select is((public.pmf_claim())->>'ok', 'false', 'account younger than 30 days is not asked');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
set local role authenticated;
select is((public.pmf_claim())->>'ok', 'false', 'usage below the threshold is not asked');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
set local role authenticated;
select is((public.pmf_claim())->>'ok', 'true', 'eligible account is asked');
select is((public.pmf_claim())->>'ok', 'false', 'frequency cap: not asked again right away');
select is((public.pmf_respond('bogus'))->>'reason', 'invalid_answer', 'unknown answer is rejected');
select is((public.pmf_respond('very_disappointed', 'Reach me at boss@example.com or 555-123-4567', 'faster setup'))->>'ok', 'true', 'valid answer is stored');
select is((public.pmf_respond('not_disappointed'))->>'reason', 'not_offered', 'the same offer cannot be answered twice');
select is((public.pmf_claim())->>'ok', 'false', 'not asked again after answering');
reset role;

select is((select usage_bucket from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e1'), 'regular', 'usage bucket is captured at answer time');
select is((select tenure_bucket from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e1'), '30_89d', 'tenure bucket is captured at answer time');
select ok((select main_benefit from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e1') like '%[email]%'
      and (select main_benefit from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e1') not like '%boss@example.com%', 'free text is redacted on the server');

-- ---- 3. respecting the person's choices -------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e4', true);
set local role authenticated;
select is((public.pmf_respond('very_disappointed'))->>'reason', 'not_offered', 'cannot answer a survey that was never offered');
select is((public.pmf_claim())->>'ok', 'true', 'second eligible account is asked');
select is((public.pmf_dismiss('never'))->>'ok', 'true', 'person chooses "don''t ask me again"');
select is((public.pmf_respond('very_disappointed'))->>'reason', 'not_offered', 'a dismissed survey cannot be answered afterwards');
reset role;
select is((select never_ask from feedback_survey_prefs where user_id = '00000000-0000-0000-0000-0000000000e4'), true, '"never" is stored in the shared survey preferences');
select is((select count(*)::int from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e4'), 0, 'dismissed survey stores no response');

-- ---- 4. staff aggregates -----------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
set local role authenticated;
select is((public.staff_pmf_summary(180, 'plan'))->0->>'segment', 'small_groups', 'groups with fewer than 5 responses are merged');
select throws_ok($$select public.staff_pmf_summary(180, 'email')$$, '22023', 'invalid_dimension', 'unknown dimension is rejected');
select is(jsonb_typeof(public.staff_retention_by_segment(12, 'plan')), 'array', 'retention view returns an array');
select throws_ok($$select public.staff_retention_by_segment(12, 'company')$$, '22023', 'invalid_dimension', 'retention rejects unknown dimension');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
set local role authenticated;
select throws_ok($$select public.staff_pmf_summary(180, 'all')$$, '42501', 'forbidden', 'customers cannot read PMF aggregates');
select throws_ok($$select public.staff_retention_by_segment(12, 'all')$$, '42501', 'forbidden', 'customers cannot read retention');
select is((public.export_my_pmf_data()->'responses'->0->>'answer'), 'very_disappointed', 'a person can export their own answer');
select is((public.delete_my_pmf_data())->>'ok', 'true', 'a person can delete their own PMF data');
reset role;
select is((select count(*)::int from pmf_survey_responses where user_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'deleted data is gone');

select * from finish();
rollback;
