-- Release safety: kill switches, two-person approval, staged rollouts, AI versions, app policy (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff1@vireek.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'staff2@vireek.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'owner@acme.test');
update public.profiles set is_staff = true where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');

insert into public.feature_flags (key, name, risk) values
  ('t_high', 'High risk flag', 'high'),
  ('t_low', 'Low risk flag', 'low'),
  ('t_canary', 'Canary flag', 'low');
insert into public.feature_flags (key, name, enabled, rollout_pct, targeting) values
  ('t_plan', 'Plan targeted', true, 100, '{"plans": ["professional"]}');

select set_config('t.owners', (select count(*)::text from public.profiles where role = 'owner'), true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- ------------------------------------------------------------ authorization --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select public.staff_set_kill_switch('outbound_dialer', null, true, 'not allowed')$$, '42501', null, 'non-staff cannot stop a kill switch');
select is((select count(*) from public.kill_switches), 0::bigint, 'non-staff read no kill switches (RLS)');
select throws_ok($$select public.kill_switch_snapshot()$$, '42501', null, 'authenticated cannot read the edge snapshot');
select throws_ok($$select public.staff_list_kill_switches()$$, '42501', null, 'non-staff cannot list kill switches');

-- ------------------------------------------------------------- kill switches --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.kill_switches), 8::bigint, 'all eight capabilities are seeded');
select throws_ok($$select public.staff_set_kill_switch('outbound_dialer', null, true, '')$$, '22023', null, 'a stop needs a reason');
select lives_ok($$select public.staff_set_kill_switch('outbound_dialer', null, true, 'drill: bad release')$$, 'staff can stop globally in one call');
select is((select stopped from public.kill_switches where key = 'outbound_dialer'), true, 'the switch is stopped');
select throws_ok($$select public.staff_set_kill_switch('outbound_dialer', null, false, 'resume alone')$$, '42501', null, 'resuming a critical switch alone is refused');

select set_config('t.req', (select public.staff_request_kill_switch_resume('outbound_dialer', 'fixed and verified'))::text, true);
select throws_ok(format($$select public.staff_decide_kill_switch_resume(%L, true)$$, current_setting('t.req')), '42501', null, 'the requester cannot approve their own resume');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.staff_decide_kill_switch_resume(current_setting('t.req')::uuid, true), 'approved', 'a second staff member approves the resume');
select is((select stopped from public.kill_switches where key = 'outbound_dialer'), false, 'the switch is running again');

select lives_ok($$select public.staff_set_kill_switch('sms_campaigns', '00000000-0000-0000-0000-0000000000a3', true, 'one account stop')$$, 'staff can stop one account');
select pg_temp.act_service();
select ok((public.kill_switch_snapshot() -> 'orgs') @> '[{"key":"sms_campaigns","tenant_id":"00000000-0000-0000-0000-0000000000a3"}]'::jsonb, 'snapshot lists the per-org stop');
select is(jsonb_array_length(public.kill_switch_snapshot() -> 'global'), 0, 'snapshot has no global stops after the resume');
select ok(exists (select 1 from public.kill_switch_drills_overdue() k where k = 'voice_cloning'), 'never-drilled switches are reported overdue');

-- ------------------------------------------------------- high-risk flag guard --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$update public.feature_flags set enabled = true where key = 't_high'$$, '42501', null, 'staff cannot enable a high-risk flag directly');
select throws_ok($$update public.feature_flags set risk = 'low' where key = 't_high'$$, '42501', null, 'staff cannot lower the risk class to bypass the guard');
select lives_ok($$update public.feature_flags set enabled = true where key = 't_low'$$, 'low-risk flags keep the direct path');
select set_config('t.freq', (select public.staff_request_flag_change('t_high', true, 10, 'ship to 10 percent'))::text, true);
select throws_ok(format($$select public.staff_decide_flag_change(%L, true)$$, current_setting('t.freq')), '42501', null, 'the requester cannot approve their own flag change');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.staff_decide_flag_change(current_setting('t.freq')::uuid, true), 'approved', 'a second person approves the flag change');
select is((select rollout_pct from public.feature_flags where key = 't_high'), 10, 'the approved change was applied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$update public.feature_flags set enabled = false where key = 't_high'$$, 'reducing exposure never needs approval');

-- ------------------------------------------------------------- impact + eval --
select is((select total_tenants from public.staff_flag_impact('t_plan', true, 100)), current_setting('t.owners')::integer, 'impact preview counts every account');
select pg_temp.act_service();
select is(public.flag_evaluate('t_plan', '00000000-0000-0000-0000-0000000000a3'), false, 'plan targeting excludes a starter account');
select is(public.flag_evaluate('does_not_exist', '00000000-0000-0000-0000-0000000000a3'), false, 'an unknown flag evaluates to false');
reset role;
update public.profiles set plan = 'professional' where id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.act_service();
select is(public.flag_evaluate('t_plan', '00000000-0000-0000-0000-0000000000a3'), true, 'plan targeting includes a professional account');

-- --------------------------------------------------------------- rollouts --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.staff_start_rollout('t_canary', 'edge_function', 'canary v2', '{}'::jsonb)) ->> 'status', 'applied', 'a rollout starts at 1 percent');
select is((select rollout_pct from public.feature_flags where key = 't_canary'), 1, 'the canary flag is live at 1 percent');
select throws_ok($$select public.staff_advance_rollout('t_canary', 5)$$, 'P0001', null, 'advancing needs a fresh promote decision (health gate)');
select pg_temp.act_service();
select lives_ok($$select public.release_record_decision('t_canary', 'promote', 0, '[]'::jsonb)$$, 'the guard records a promote decision');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.staff_advance_rollout('t_canary', 5)) ->> 'status', 'applied', 'advance succeeds once the gate passed');
select pg_temp.act_service();
select lives_ok($$select public.release_record_health('t_canary', 'canary', 1000, 20, 400, 0, 0)$$, 'health samples are recorded');
select is((public.release_health_summary('t_canary', 30) -> 'canary' ->> 'requests')::integer, 1000, 'the summary aggregates canary requests');
select is(public.release_auto_rollback('t_canary', 'SLO breach'), true, 'auto-rollback acts');
select is((select enabled from public.feature_flags where key = 't_canary'), false, 'auto-rollback switched the flag off');
select is((select status from public.release_rollouts where flag_key = 't_canary'), 'rolled_back', 'the rollout is closed as rolled back');
select is(public.release_auto_rollback('t_canary', 'again'), false, 'auto-rollback is idempotent');

-- ------------------------------------------------------------ AI versions --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select public.staff_ai_create_version('prompt', 't_task', '{"nope": 1}'::jsonb)$$, '22023', null, 'invalid payloads are refused');
select is(public.staff_ai_create_version('prompt', 't_task', '{"system_suffix": "Be concise."}'::jsonb), 1, 'a draft version is created');
select lives_ok($$select public.staff_ai_start_shadow('prompt', 't_task', 1, 5)$$, 'shadow mode starts');
select throws_ok($$select public.staff_ai_promote('prompt', 't_task', 1)$$, 'P0001', null, 'promotion is refused without enough shadow evidence');
select pg_temp.act_service();
select public.ai_record_shadow_result('prompt', 't_task', 1, true, true, 100, 105, 0.9) from generate_series(1, 200);
select lives_ok($$select public.ai_record_eval('prompt', 't_task', 1, 0.95)$$, 'an eval score is recorded');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.staff_ai_promote('prompt', 't_task', 1)$$, 'promotion succeeds when every threshold passes');
select pg_temp.act_service();
select is(public.ai_resolve_versions('prompt', 't_task') -> 'active' ->> 'version', '1', 'the resolver serves the active version');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.staff_ai_rollback('prompt', 't_task', 'regression found'), null::integer, 'rollback with no earlier version returns to the code defaults');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.staff_set_kill_switch('ai_model_prompt_versions', null, true, 'drill')$$, 'the AI versions kill switch can be stopped');
select pg_temp.act_service();
select is((public.ai_resolve_versions('prompt', 't_task') ->> 'stopped')::boolean, true, 'a stopped switch makes the resolver return nothing');

-- ------------------------------------------------------------- app policy --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select rollout_pct from public.get_app_release_policy_v2('android')), 100, 'policy v2 exposes the rollout percentage');
select is((public.staff_set_app_release_policy('android', '0.0.0', '1.2.0', 25, 'New release', 'stage the prompt')) ->> 'status', 'applied', 'staging the soft prompt applies directly');
select is((public.staff_set_app_release_policy('android', '9.9.9', '9.9.9', 100, null, 'force everyone')) ->> 'status', 'pending_approval', 'raising the minimum version needs approval');
select set_config('t.areq', (select id::text from public.release_change_requests where kind = 'app_policy' and status = 'pending'), true);
select throws_ok(format($$select public.staff_decide_app_policy(%L, true)$$, current_setting('t.areq')), '42501', null, 'the requester cannot approve their own policy change');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.staff_decide_app_policy(current_setting('t.areq')::uuid, true), 'approved', 'a second person approves the policy');
reset role;
select is((select min_version from public.app_release_policy where platform = 'android'), '9.9.9', 'the approved minimum version is live');

select * from finish();
rollback;
