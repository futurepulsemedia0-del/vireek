-- Cross-tenant consent enforcement (pgTAP): fail-closed gate over sde_consents, revocation, unmapped flows,
-- client privilege lockdown, and structural proof that every cross-tenant builder consults the gate.
-- Migration under test: 20290305000000_cross_tenant_consent_enforcement.sql
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- profiles rows are created by the on_auth_user_created trigger (handle_new_user).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c0a1', 'a@xtl.test'),
  ('00000000-0000-0000-0000-00000000c0b1', 'b@xtl.test'),
  ('00000000-0000-0000-0000-00000000c0c1', 'c@xtl.test');

create or replace function pg_temp.def_has(p_fn text, p_needle text) returns boolean language sql as $$
  select coalesce(bool_or(position(p_needle in pg_get_functiondef(p.oid)) > 0), false)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_fn
$$;

-- ------------------------------------------------------------ registry/RLS --
select ok((select relrowsecurity from pg_class where oid = 'public.cross_tenant_flows'::regclass),
          'registry has RLS enabled');
select is((select count(*)::int from pg_policies where tablename = 'cross_tenant_flows'), 0,
          'registry has no client policy');
select is((select count(*)::int from public.cross_tenant_flows), 10, 'ten flows registered');
select is((select count(*)::int from public.cross_tenant_flows where sde_domain is null), 3,
          'exactly three flows are unmapped (fail-closed) until counsel/product map them');

-- ------------------------------------------------------------- privileges ---
select ok(not has_function_privilege('authenticated', 'public.xtl_contributes(uuid,text)', 'execute'),
          'authenticated cannot call xtl_contributes (would reveal other tenants'' consent)');
select ok(not has_function_privilege('anon', 'public.xtl_contributors(text)', 'execute'),
          'anon cannot call xtl_contributors');
select ok(has_function_privilege('service_role', 'public.xtl_contributors(text)', 'execute'),
          'service_role can call xtl_contributors');
select ok(not has_table_privilege('authenticated', 'public.cross_tenant_flows', 'select'),
          'authenticated cannot read the registry table');

-- ------------------------------------------------------ gate: fail-closed ---
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'benchmark_cohorts'), false,
          'no consent row => not contributing');
select is(public.xtl_contributes(null, 'benchmark_cohorts'), false, 'NULL user => false');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'no_such_flow'), false,
          'unknown flow => false');

-- --------------------------------------------------------- grant / revoke ---
insert into public.sde_consents (user_id, domain, status, terms_version, granted_at) values
  ('00000000-0000-0000-0000-00000000c0a1', 'outcomes', 'granted', 'test', now()),
  ('00000000-0000-0000-0000-00000000c0b1', 'failure',  'granted', 'test', now());

select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'benchmark_cohorts'), true,
          'outcomes consent => benchmark_cohorts');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'regional_demand'), true,
          'outcomes consent => regional_demand');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'failure_genome'), false,
          'outcomes consent does NOT cover failure flows (domains are independent)');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0b1', 'failure_genome'), true,
          'failure consent => failure_genome');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0b1', 'benchmark_cohorts'), false,
          'failure consent does NOT cover benchmark flows');
select is((select count(*)::int from public.xtl_contributors('benchmark_cohorts')), 1,
          'cohort contributor set contains only the consenting tenant');

-- Revocation removes the tenant from the very next evaluation (no cache).
update public.sde_consents set status = 'revoked', revoked_at = now()
 where user_id = '00000000-0000-0000-0000-00000000c0a1' and domain = 'outcomes';
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'benchmark_cohorts'), false,
          'revoked => immediately excluded');
select is((select count(*)::int from public.xtl_contributors('benchmark_cohorts')), 0,
          'revoked tenant absent from the contributor set');

-- Re-grant works (revoke is not terminal).
update public.sde_consents set status = 'granted', granted_at = now(), revoked_at = null
 where user_id = '00000000-0000-0000-0000-00000000c0a1' and domain = 'outcomes';
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0a1', 'benchmark_cohorts'), true,
          're-grant restores contribution');

-- ------------------------------------------------------ unmapped flows ------
insert into public.sde_consents (user_id, domain, status, terms_version, granted_at)
select '00000000-0000-0000-0000-00000000c0c1', d, 'granted', 'test', now()
from unnest(array['failure','equipment','pricing','labor','parts','outcomes']) d;
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0c1', 'vertical_intelligence'), false,
          'unmapped flow stays closed even with every domain granted');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0c1', 'causal_cohorts'), false,
          'causal_cohorts unmapped => closed');
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0c1', 'rebate_realization'), false,
          'rebate_realization unmapped => closed');
update public.cross_tenant_flows set sde_domain = 'outcomes' where flow_key = 'vertical_intelligence';
select is(public.xtl_contributes('00000000-0000-0000-0000-00000000c0c1', 'vertical_intelligence'), true,
          'operator remap (data change, no redeploy) opens the flow for consenting tenants');

-- ----------------------------------------- structural: builders use the gate -
select ok(pg_temp.def_has('refresh_benchmark_cohorts',    $$xtl_contributors('benchmark_cohorts')$$),     'refresh_benchmark_cohorts gated');
select ok(pg_temp.def_has('compute_platform_benchmarks',  $$xtl_contributors('platform_benchmarks')$$),   'compute_platform_benchmarks gated');
select ok(pg_temp.def_has('compute_regional_demand',      $$xtl_contributors('regional_demand')$$),       'compute_regional_demand gated');
select ok(pg_temp.def_has('refresh_outcome_benchmarks',   $$xtl_contributors('outcome_benchmarks')$$),    'refresh_outcome_benchmarks gated');
select ok(pg_temp.def_has('ob_is_participating',          $$xtl_contributes(public.get_account_owner_id(), 'outcome_benchmarks')$$), 'outcome benchmark read side gated');
select ok(pg_temp.def_has('refresh_service_loop_global_priors', $$xtl_contributors('service_loop_priors')$$), 'SIL priors gated');
select ok(pg_temp.def_has('fie_refresh_global_patterns',  $$xtl_contributors('fie_patterns')$$),          'FIE patterns gated');
select ok(pg_temp.def_has('refresh_failure_patterns',     $$xtl_contributors('failure_genome')$$),        'failure genome gated');
select ok(pg_temp.def_has('mine_vertical_intelligence',   $$xtl_contributors('vertical_intelligence')$$), 'vertical intelligence gated');
select ok(pg_temp.def_has('compute_causal_cohort_insights', $$xtl_contributors('causal_cohorts')$$),      'causal cohort gated');
select ok(pg_temp.def_has('rebate_network_realization',   $$xtl_contributors('rebate_realization')$$),    'rebate realization gated');
select ok(pg_temp.def_has('get_voice_pooled_prior', $$cs.pooled_priors_opt_in$$), 'voice pooled prior honours the contributor''s CURRENT opt-in');
select ok(not pg_temp.def_has('refresh_benchmark_cohorts', $$interval '14 days'$$),
          'benchmark history no longer retains rows built before a revocation');

select * from finish();
rollback;
