-- Labor-compliance signals (20290307000000): tenant isolation, permission gates, validation, review reset,
-- audit trail (pgTAP). NOT executed by the author (no Postgres in the authoring sandbox). Run with:  supabase test db
-- [COUNSEL] [VERIFY] only the data plumbing is tested here — never any statement about what a law requires.
begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@lab.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@lab.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@lab.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'viewer@lab.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@lab.test', 'Mo Manager', 'manager',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": true, "can_view_billing": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@lab.test', 'Tia Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'viewer@lab.test', 'Vic Viewer', 'member',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{"can_edit_business_profile": false, "can_view_billing": true}');

insert into public.employees (id, user_id, team_member_id, full_name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c3', 'Tia Tech'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b1', null, 'Other Tenant Worker');

insert into public.time_shifts (id, user_id, team_member_id, employee_id, work_date, status, clock_in_at, clock_out_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c3',
   '00000000-0000-0000-0000-0000000000e1', '2027-03-01', 'closed', '2027-03-01 08:00:00+00', '2027-03-01 18:00:00+00');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------------------------------------------------------------- read gate
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(jsonb_array_length(public.labor_signals_overview('2027-02-24', '2027-03-31')->'employees'), 1, 'owner sees only their own employees');
select is(jsonb_array_length(public.labor_signals_overview('2027-02-24', '2027-03-31')->'shifts'), 1, 'owner overview includes the shift');
select is((public.labor_signals_overview('2027-02-24', '2027-03-31')->>'can_edit')::boolean, true, 'owner can edit');
select throws_ok($$ select public.labor_signals_overview('2027-01-01', '2027-12-31') $$, '22023', null, 'a range over 120 days is refused');
select throws_ok($$ select public.labor_signals_overview('2027-03-31', '2027-03-01') $$, '22023', null, 'a reversed range is refused');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ select public.labor_signals_overview('2027-02-24', '2027-03-31') $$, '42501', null, 'technician cannot read the overview');
select is((select count(*)::int from public.labor_worker_classifications), 0, 'technician sees no classification rows');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((public.labor_signals_overview('2027-02-24', '2027-03-31')->>'can_edit')::boolean, false, 'billing-only member can view but not edit');
select throws_ok($$ select public.set_worker_classification('00000000-0000-0000-0000-0000000000e1', 'exempt_recorded', null) $$, '42501', null, 'billing-only member cannot set a classification');
select throws_ok($$ select public.save_labor_rule_config('prevailing_wage', 'FED', true, '{"check_missing_classification":true,"check_rate_below_table":true}'::jsonb) $$, '42501', null, 'billing-only member cannot save rules');

-- ---------------------------------------------------------------- classification
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$ select public.set_worker_classification('00000000-0000-0000-0000-0000000000e1', 'contractor_recorded', 'Per signed agreement') $$, 'manager can record a classification');
select is((select classification from public.labor_worker_classifications where employee_id = '00000000-0000-0000-0000-0000000000e1'), 'contractor_recorded', 'classification is stored');
select is((public.labor_signals_overview('2027-02-24', '2027-03-31')->'employees'->0->>'classification'), 'contractor_recorded', 'overview returns the recorded classification');
select throws_ok($$ select public.set_worker_classification('00000000-0000-0000-0000-0000000000e1', 'definitely_exempt', null) $$, '22023', null, 'unknown classification is refused');
select throws_ok($$ select public.set_worker_classification('00000000-0000-0000-0000-0000000000e2', 'hourly_recorded', null) $$, 'P0002', null, 'cannot classify another tenant''s employee');
select lives_ok($$ select public.set_worker_classification('00000000-0000-0000-0000-0000000000e1', 'hourly_recorded', null) $$, 'a classification can be changed (idempotent upsert)');
select is((select count(*)::int from public.labor_worker_classifications where employee_id = '00000000-0000-0000-0000-0000000000e1'), 1, 'still one row per employee');

-- ---------------------------------------------------------------- rule config
select lives_ok($$ select public.save_labor_rule_config('overtime', 'CA', true,
  '{"workweek_start_dow":1,"weekly_threshold_hours":40,"daily_ot_after_hours":8,"daily_dt_after_hours":12,"seventh_day_signal":true,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb,
  'Starter citation [VERIFY]', 'https://example.org/source') $$, 'manager can save overtime rules');
select is((select counsel_status from public.labor_rule_configs where topic = 'overtime' and user_id = '00000000-0000-0000-0000-0000000000a1'), 'needs_counsel', 'a new rule starts as needs_counsel');
select is((select verified_on is null from public.labor_rule_configs where topic = 'overtime' and user_id = '00000000-0000-0000-0000-0000000000a1'), true, 'and starts unverified');
select throws_ok($$ select public.save_labor_rule_config('overtime', 'CA', true, '{"workweek_start_dow":1,"weekly_threshold_hours":40,"daily_ot_after_hours":8,"daily_dt_after_hours":8,"seventh_day_signal":false,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb) $$, '22023', null, 'second daily tier must be above the first');
select throws_ok($$ select public.save_labor_rule_config('overtime', 'CA', true, '{"workweek_start_dow":1,"weekly_threshold_hours":40,"seventh_day_signal":false,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25,"surprise":1}'::jsonb) $$, '22023', null, 'unknown parameter keys are refused');
select throws_ok($$ select public.save_labor_rule_config('overtime', 'CA', true, '{"workweek_start_dow":9,"weekly_threshold_hours":40,"seventh_day_signal":false,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb) $$, '22023', null, 'out-of-range values are refused');
select throws_ok($$ select public.save_labor_rule_config('prevailing_wage', 'FED', true, '{"check_missing_classification":false,"check_rate_below_table":false}'::jsonb) $$, '22023', null, 'at least one wage-table check must be on');
select throws_ok($$ select public.save_labor_rule_config('overtime', 'ca', true, '{}'::jsonb) $$, '22023', null, 'jurisdiction code format is enforced');
select throws_ok($$ select public.save_labor_rule_config('overtime', 'CA', true, '{"workweek_start_dow":1,"weekly_threshold_hours":40,"seventh_day_signal":false,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb, null, 'javascript:alert(1)') $$, '22023', null, 'source link must be http(s)');

-- review records + reset on change
select throws_ok($$ select public.record_labor_rule_review('prevailing_wage', 'Counsel LLP', null) $$, 'P0002', null, 'cannot record a review for a rule that was never saved');
select lives_ok($$ select public.record_labor_rule_review('overtime', 'Counsel LLP', '2027-02-01', 'ok') $$, 'a person can record counsel review and verification');
select is((select counsel_status from public.labor_rule_configs where topic = 'overtime' and user_id = '00000000-0000-0000-0000-0000000000a1'), 'counsel_reviewed', 'counsel review is recorded');
select throws_ok($$ select public.record_labor_rule_review('overtime', null, '2999-01-01') $$, '22023', null, 'a future verification date is refused');
select throws_ok($$ select public.record_labor_rule_review('overtime', null, null) $$, '22023', null, 'recording nothing is refused');
select public.save_labor_rule_config('overtime', 'CA', false,
  '{"workweek_start_dow":1,"weekly_threshold_hours":40,"daily_ot_after_hours":8,"daily_dt_after_hours":12,"seventh_day_signal":true,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb);
select is((select counsel_status from public.labor_rule_configs where topic = 'overtime' and user_id = '00000000-0000-0000-0000-0000000000a1'), 'counsel_reviewed', 'toggling only "enabled" keeps the review');
select public.save_labor_rule_config('overtime', 'CA', true,
  '{"workweek_start_dow":1,"weekly_threshold_hours":44,"daily_ot_after_hours":8,"daily_dt_after_hours":12,"seventh_day_signal":true,"open_shift_alert_hours":16,"payroll_gap_tolerance_hours":0.25}'::jsonb);
select is((select counsel_status || ':' || coalesce(verified_on::text, 'null') from public.labor_rule_configs where topic = 'overtime' and user_id = '00000000-0000-0000-0000-0000000000a1'), 'needs_counsel:null', 'changing the numbers clears both review records');

-- ---------------------------------------------------------------- signal reviews
select lives_ok($$ select public.review_labor_signal('weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e1:2027-03-01', 'sent_to_counsel', 'asked') $$, 'a signal can be reviewed');
select is((select status from public.labor_signal_reviews where signal_key = 'weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e1:2027-03-01'), 'sent_to_counsel', 'review is stored');
select is((public.labor_signals_overview('2027-02-24', '2027-03-31')->'reviews'->0->>'status'), 'sent_to_counsel', 'overview returns the review');
select throws_ok($$ select public.review_labor_signal('break_meal_missing:00000000-0000-0000-0000-0000000000e1:2027-03-01', 'acknowledged') $$, '22023', null, 'break signals are not reviewed here (they have their own workflow)');
select throws_ok($$ select public.review_labor_signal('weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e2:2027-03-01', 'acknowledged') $$, 'P0002', null, 'a key naming another tenant''s employee is refused');
select throws_ok($$ select public.review_labor_signal('not a key', 'acknowledged') $$, '22023', null, 'malformed key is refused');
select throws_ok($$ select public.review_labor_signal('weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e1:2027-13-45', 'acknowledged') $$, '22023', null, 'impossible date in a key is refused');
select public.review_labor_signal('weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e1:2027-03-01', 'open');
select is((select count(*)::int from public.labor_signal_reviews), 0, 'reopening a signal removes the review');
select is((select count(*)::int from public.labor_audit_log where action in ('classification_set', 'rule_saved', 'rule_review_recorded', 'signal_reviewed')) >= 8, true, 'every change left an audit row');

-- ---------------------------------------------------------------- other tenant + direct writes
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.labor_rule_configs), 0, 'another account cannot read this account''s rules');
select is((select count(*)::int from public.labor_worker_classifications), 0, 'nor its classifications');
select throws_ok($$ select public.review_labor_signal('weekly_hours_above_threshold:00000000-0000-0000-0000-0000000000e1:2027-03-01', 'acknowledged') $$, 'P0002', null, 'nor review its signals');
select throws_ok($$ insert into public.labor_rule_configs (user_id, topic, jurisdiction, params) values ('00000000-0000-0000-0000-0000000000b1', 'overtime', 'FED', '{}'::jsonb) $$, '42501', null, 'tables cannot be written directly from the client');
select throws_ok($$ select public.labor_validate_params('overtime', '{}'::jsonb) $$, '42501', null, 'the internal validator is not callable by clients');

select * from finish();
rollback;
