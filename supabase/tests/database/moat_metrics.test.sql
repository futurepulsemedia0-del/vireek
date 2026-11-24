-- Moat metrics (pgTAP). NOT RUN by the author (no Postgres was available): run with `supabase test db`.
-- Requires 20290311000000_moat_metrics.sql and its dependencies (see the header of that migration).
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- ------------------------------------------------------------------ objects --
select has_view('public', 'moat_accounts_v',            'accounts view exists');
select has_view('public', 'moat_integrations_v',        'integrations view exists');
select has_view('public', 'moat_history_v',             'history view exists');
select has_view('public', 'moat_automations_v',         'automations view exists');
select has_view('public', 'moat_switching_cost_v',      'switching-cost view exists');
select has_view('public', 'moat_prediction_accuracy_v', 'prediction-accuracy view exists');
select has_view('public', 'moat_cohort_contribution_v', 'cohort-contribution view exists');
select has_view('public', 'moat_network_effect_v',      'network-effect view exists');
select has_function('public', 'staff_moat_metrics', array['integer', 'boolean'], 'RPC exists');

-- ---------------------------------------------------------- tenant boundary --
-- Cross-tenant views are not readable by clients; the RPC is not callable by anon.
select is(
  (select count(*) from unnest(array[
     'public.moat_accounts_v', 'public.moat_integrations_v', 'public.moat_history_v', 'public.moat_automations_v',
     'public.moat_switching_cost_v', 'public.moat_prediction_accuracy_v', 'public.moat_cohort_contribution_v',
     'public.moat_network_effect_v']) v
    where has_table_privilege('authenticated', v, 'SELECT') or has_table_privilege('anon', v, 'SELECT')),
  0::bigint, 'no moat view is readable by authenticated or anon');
select is(has_function_privilege('anon', 'public.staff_moat_metrics(integer, boolean)', 'EXECUTE'), false, 'anon cannot run the RPC');

-- A signed-in non-staff user and an unauthenticated caller are rejected.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
select throws_ok($$select public.staff_moat_metrics(30, true)$$, '42501', 'forbidden', 'non-staff is rejected');
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.staff_moat_metrics(30, true)$$, '42501', 'forbidden', 'unauthenticated is rejected');

-- ----------------------------------------------------------------- fixtures --
-- e1: account with data. e2: empty account. e3: platform staff (must not be counted as an account).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner@moat.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'empty@moat.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'staff@moat.test');
insert into public.profiles (id, email)
  select id, email from auth.users where id in (
    '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3')
  on conflict (id) do nothing;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000e3';

-- Integrations for e1: xero and quickbooks count once each even though quickbooks is in two tables;
-- a webhook and a disconnected provider do not count.
insert into public.integrations (user_id, integration_type, status) values
  ('00000000-0000-0000-0000-0000000000e1', 'xero',            'connected'),
  ('00000000-0000-0000-0000-0000000000e1', 'quickbooks',      'connected'),
  ('00000000-0000-0000-0000-0000000000e1', 'webhook',         'connected'),
  ('00000000-0000-0000-0000-0000000000e1', 'google_calendar', 'disconnected');
insert into public.qbo_connections (user_id, realm_id) values ('00000000-0000-0000-0000-0000000000e1', '1234567');

-- Automations for e1: one active install (the paused one does not count) and one enabled dispatch rule.
insert into public.automation_installs (user_id, template_slug, status) values
  ('00000000-0000-0000-0000-0000000000e1', 'moat-test-a', 'active'),
  ('00000000-0000-0000-0000-0000000000e1', 'moat-test-b', 'paused');
insert into public.dispatch_rules (user_id, rule_type, name, enabled) values
  ('00000000-0000-0000-0000-0000000000e1', 'zone', 'Zone', true);

-- History for e1: oldest record is a customer created on a fixed date.
insert into public.customers (user_id, name, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'Moat Test Customer', '2020-01-15 00:00:00+00');

-- Resolved predictions for e1: (0.9,yes) (0.8,yes) (0.2,no) (0.1,no)
--   Brier = (0.01 + 0.04 + 0.04 + 0.01) / 4 = 0.025 ; base rate 0.5 ; skill = 1 - 0.025 / 0.25 = 0.9
insert into public.prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, outcome, outcome_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'lead_books', 'v1', 'leads', 'm1', 0.9, true,  now()),
  ('00000000-0000-0000-0000-0000000000e1', 'lead_books', 'v1', 'leads', 'm2', 0.8, true,  now()),
  ('00000000-0000-0000-0000-0000000000e1', 'lead_books', 'v1', 'leads', 'm3', 0.2, false, now()),
  ('00000000-0000-0000-0000-0000000000e1', 'lead_books', 'v1', 'leads', 'm4', 0.1, false, now());

-- e1 has opted in to cross-tenant learning; e2 has no settings row (defaults apply).
insert into public.outcome_learning_settings (user_id, capture_enabled, share_cross_tenant) values
  ('00000000-0000-0000-0000-0000000000e1', true, true);

-- -------------------------------------------------------------- switching cost --
select is((select integrations_n from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e1'),
          2, 'e1: connected providers counted once each; webhook and disconnected excluded');
select is((select integrations_n from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e2'),
          0, 'e2: no integrations shows 0, not NULL');
select is((select count(*) from public.moat_accounts_v where user_id = '00000000-0000-0000-0000-0000000000e3'),
          0::bigint, 'platform staff is not an eligible account');
select is((select installs_active_n from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e1'),
          1, 'e1: paused install is not counted');
select is((select automations_n from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e1'),
          2, 'e1: automations_n is the plain sum of active installs, live workflows and enabled dispatch rules');
select is((select first_record_at from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e1'),
          '2020-01-15 00:00:00+00'::timestamptz, 'e1: first record is the oldest of customers, jobs and calls');
select is((select first_record_at from public.moat_switching_cost_v where user_id = '00000000-0000-0000-0000-0000000000e2'),
          null::timestamptz, 'e2: no records means NULL history, not 0 days');

-- ---------------------------------------------------------- network effect --
select is((select round(brier, 4) from public.moat_prediction_accuracy_v
            where user_id = '00000000-0000-0000-0000-0000000000e1' and predictor_key = 'prediction_log:lead_books'),
          0.0250::numeric, 'e1: Brier score of the fixture predictions');
select is((select round(brier_skill, 4) from public.moat_prediction_accuracy_v
            where user_id = '00000000-0000-0000-0000-0000000000e1' and predictor_key = 'prediction_log:lead_books'),
          0.9000::numeric, 'e1: Brier skill against the account base rate');
select is((select share_cross_tenant from public.moat_cohort_contribution_v where user_id = '00000000-0000-0000-0000-0000000000e1'),
          true, 'e1: opt-in is read from outcome_learning_settings');
select is((select share_cross_tenant from public.moat_cohort_contribution_v where user_id = '00000000-0000-0000-0000-0000000000e2'),
          false, 'e2: no settings row means not sharing');
select is((select benchmark_participating from public.moat_cohort_contribution_v where user_id = '00000000-0000-0000-0000-0000000000e2'),
          true, 'e2: benchmark participation defaults to true, as ob_is_participating() does');
select is((select count(*) from public.moat_network_effect_v
            where user_id = '00000000-0000-0000-0000-0000000000e1' and predictor_key = 'prediction_log:lead_books' and share_cross_tenant),
          1::bigint, 'accuracy and contribution are joined per account and predictor');

-- --------------------------------------------------------------- staff RPC --
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}', true);

select lives_ok($$select public.staff_moat_metrics(1, false)$$, 'staff can run the RPC');
select is((public.staff_moat_metrics(1, false) -> 'switching_cost' ->> 'accounts_n')::bigint,
          (select count(*) from public.moat_accounts_v), 'RPC account count equals the eligible-account view');
select is((select (x ->> 'accounts_used_n')::integer
             from jsonb_array_elements(public.staff_moat_metrics(1, false) -> 'network_effect') x
            where x ->> 'predictor_key' = 'prediction_log:lead_books' and x ->> 'model_version' = 'v1'),
          1, 'RPC network-effect row counts the fixture account as used');
select throws_ok($$select public.staff_moat_metrics(0, true)$$, '22023', 'p_min_n must be between 1 and 100000', 'invalid p_min_n is rejected');
select is(position('00000000-0000-0000-0000-0000000000e1' in public.staff_moat_metrics(1, false)::text), 0,
          'RPC output contains no account identifiers');

select * from finish();
rollback;
