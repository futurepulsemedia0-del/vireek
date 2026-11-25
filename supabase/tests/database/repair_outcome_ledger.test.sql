-- Repair Outcome Ledger: tenant isolation, grants, censoring guards, shadow-mode refusal (pgTAP).
-- Run with:  supabase test db        (NOT RUN in the authoring environment: no Postgres available there)
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- fixtures: O = owner, Y = another tenant's owner, TECH = O's technician (team member + auth user)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@ledger.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'other@ledger.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'tech@ledger.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false),
  ('00000000-0000-0000-0000-0000000000c1', 'owner', false)
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff;
insert into public.team_members (id, account_owner_id, member_email, invite_status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', 'tech@ledger.test', 'accepted');
insert into public.jobs (id, user_id, customer_name, job_status, completed_at, assigned_technician_id) values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000000b1', 'Fixture Customer', 'completed',
   now() - interval '2 days', '00000000-0000-0000-0000-0000000000d1');

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
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- ------------------------------------------------------------ structure / grants
select has_table('public', 'repair_cases', '1 repair_cases exists');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.repair_cases'::regclass, 'public.repair_outcomes'::regclass, 'public.repair_labels'::regclass,
  'public.repair_root_cause_taxonomy'::regclass, 'public.repair_ledger_settings'::regclass, 'public.repair_ledger_secrets'::regclass)),
  '2 RLS enabled on all six ledger tables');
select ok(not has_table_privilege('anon', 'public.repair_cases', 'SELECT'), '3 anon cannot read repair_cases');
select ok(not has_table_privilege('authenticated', 'public.repair_cases', 'INSERT'), '4 authenticated cannot INSERT repair_cases directly');
select ok(not has_table_privilege('authenticated', 'public.repair_cases', 'UPDATE'), '5 authenticated cannot UPDATE repair_cases');
select ok(not has_table_privilege('authenticated', 'public.repair_cases', 'DELETE'), '6 authenticated cannot DELETE repair_cases');
select ok(not has_table_privilege('authenticated', 'public.repair_ledger_secrets', 'SELECT'), '7 the pseudonym salt table is unreadable by clients');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'repair_ledger_secrets'), 0, '8 the salt table has no policy at all');
select is((select count(*)::int from public.repair_root_cause_taxonomy where version = 1 and trade = '*' and kind in ('unknown', 'multiple', 'no_fault_found')), 3, '9 taxonomy has explicit unknown / multiple / no_fault_found');
select ok(has_table_privilege('authenticated', 'public.repair_root_cause_taxonomy', 'SELECT'), '10 taxonomy is readable');
select ok(not has_table_privilege('authenticated', 'public.repair_root_cause_taxonomy', 'INSERT'), '11 taxonomy is not client-writable');

-- ------------------------------------------------------------ shadow mode: flag off refuses and writes nothing
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'refrigerant_leak')$$,
  '55000', 'ledger_disabled', '12 capture refuses while the flag is off');
select pg_temp.reset_role();
select is((select count(*)::int from public.repair_cases), 0, '13 the refused attempt wrote no row');

-- ------------------------------------------------------------ flag, authorization, validation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.repair_ledger_set_enabled(true), true, '14 the owner can enable capture');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select public.repair_ledger_set_enabled(true);
select throws_ok($$select public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'refrigerant_leak')$$,
  '42501', 'job_not_found', '15 another tenant cannot record on this job (same error as "not there")');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'not_in_taxonomy')$$,
  '22023', 'invalid_root_cause', '16 a code outside the taxonomy is rejected');
select throws_ok($$select public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'refrigerant_leak', null, null, null, 'unknown',
  '[{"code":"no_cool","source":"customer","note":"free text"}]'::jsonb)$$,
  '22023', 'invalid_symptoms', '17 free-text keys inside symptoms are rejected');
select lives_ok($$select public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'refrigerant_leak', 'heat pump', 'acme', 'x100', '5_10y',
  '[{"code":"no_cool","source":"customer"}]'::jsonb, array['capacitor'])$$, '18 a valid case is recorded');
select is((public.repair_ledger_record_case('00000000-0000-0000-0000-000000000a01', 'hvac', 'refrigerant_leak') ->> 'created'), 'false', '19 a retry is idempotent');
select is((select count(*)::int from public.repair_cases), 1, '20 exactly one case exists for the owner');

-- ------------------------------------------------------------ pseudonym, isolation, append-only
select pg_temp.reset_role();
select matches((select technician_pseudonym from public.repair_cases limit 1), '^[0-9a-f]{24}$', '21 technician appears only as a 24-hex pseudonym');
select isnt((select technician_pseudonym from public.repair_cases limit 1), '00000000-0000-0000-0000-0000000000d1', '22 the pseudonym is not the technician id');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.repair_cases), 0, '23 another tenant sees no cases');
select throws_ok($$insert into public.repair_cases (user_id, job_id, trade, taxonomy_version, claimed_root_cause_id, claim_kind, technician_pseudonym, completed_at)
  select '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000a01', 'hvac', 1, id, 'cause', repeat('a', 24), now() from public.repair_root_cause_taxonomy limit 1$$,
  '42501', null, '24 clients cannot insert cases directly');
select pg_temp.reset_role();
select throws_ok($$update public.repair_cases set trade = 'plumbing'$$, '55000', 'repair_cases is append-only', '25 cases are append-only for every role');

-- ------------------------------------------------------------ service-only functions
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.repair_ledger_refresh_outcomes('00000000-0000-0000-0000-0000000000b1')$$, '42501', null, '26 clients cannot run the outcome refresh');
select throws_ok($$select public.repair_ledger_pseudonym('00000000-0000-0000-0000-0000000000b1', 'tech:x')$$, '42501', null, '27 clients cannot derive pseudonyms');
select pg_temp.reset_role();
select lives_ok($$select public.repair_ledger_refresh_outcomes('00000000-0000-0000-0000-0000000000b1')$$, '28 the service can refresh outcomes');
select is((select count(*)::int from public.repair_outcomes where censored and event = 'none_observed'), 3,
  '29 a 2-day-old repair is censored in all three windows (never a success)');

-- ------------------------------------------------------------ censoring guards in the database
select throws_ok($$insert into public.repair_outcomes (user_id, case_id, window_days, event, censored, observed_until, link_basis)
  select user_id, id, 14, 'none_observed', false, completed_at, 'none' from public.repair_cases limit 1$$,
  '23514', null, '30 an uncensored "none" without full observation is rejected');
select throws_ok($$insert into public.repair_labels (user_id, case_id, window_days, label, confidence, method_version)
  select user_id, id, 30, 'first_visit_success', 0.6, 'test_v1' from public.repair_cases limit 1$$,
  '23514', null, '31 a success label on a censored outcome is rejected');

-- ------------------------------------------------------------ pooling and quality
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.repair_ledger_pooled_rates()), 0, '32 no consent, no pooled data (flow has no SDE domain)');
select ok((public.repair_ledger_quality(90) ->> 'coverage_pct') is null, '33 quality reports null, not an invented percentage, below the minimum n');

select * from finish();
rollback;
