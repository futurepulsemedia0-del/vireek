-- Antitrust information-exchange guardrails (pgTAP): fail-closed evaluator, config-driven thresholds,
-- minimum cohort, single-tenant share, data lag, narrow-geography suppression, write gate, read gate,
-- purge, procurement k, audit immutability, privilege lockdown.
-- Migration under test: 20290306000000_antitrust_info_exchange_guardrails.sql
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ------------------------------------------------------------- structure ----
select ok((select relrowsecurity from pg_class where oid = 'public.ixg_guardrail_config'::regclass), 'config has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.ixg_metric_registry'::regclass), 'registry has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.ixg_guardrail_audit'::regclass), 'audit has RLS');
select is((select count(*)::int from pg_policies where tablename in ('ixg_guardrail_config', 'ixg_metric_registry', 'ixg_guardrail_audit')), 0,
          'no client policy on any ixg_* table');
select ok(not has_table_privilege('authenticated', 'public.ixg_guardrail_config', 'select'), 'authenticated cannot read config');
select ok(not has_table_privilege('authenticated', 'public.ixg_metric_registry', 'select'), 'authenticated cannot read registry');
select ok(not has_function_privilege('authenticated', 'public.ixg_evaluate(text,text,integer,text,numeric,date,date)', 'execute'),
          'authenticated cannot call the evaluator');
select ok(not has_function_privilege('anon', 'public.ixg_admin_overview()', 'execute'), 'anon cannot call the admin overview');

-- ------------------------------------------------------------------- seed ---
select is((select count(*)::int from public.ixg_guardrail_config where scope like 'tier:%'), 4, 'four tier rows seeded');
select is((select count(*)::int from public.ixg_metric_registry where flow_key = 'benchmark_cohorts'), 6,
          'all six benchmark_cohort_stats metrics are registered');
select ok(not exists (
  select 1 from public.ixg_metric_registry where counsel_status = 'approved'),
  'nothing ships pre-approved by counsel');
select is((select price_tier from public.ixg_metric_registry where flow_key = 'service_data_exchange' and metric_key = 'median_paid_ticket_cents'), 3,
          'median paid ticket is classified as direct price (tier 3)');

-- --------------------------------------------------------- geography class --
select is(public.ixg_geo_level('tx'), 'state', 'tx -> state');
select is(public.ixg_geo_level('Texas'), 'state', 'Texas -> state');
select is(public.ixg_geo_level('Midwest'), 'region', 'Midwest -> region');
select is(public.ixg_geo_level('austin, tx'), 'locality', 'austin, tx -> locality');
select is(public.ixg_geo_level('dallas'), 'locality', 'a bare city name is NOT classified as a state');
select is(public.ixg_geo_level('78701'), 'postal', 'zip -> postal');
select is(public.ixg_geo_level('dfw metro area'), 'metro', 'metro area -> metro');
select is(public.ixg_geo_level(null), 'postal', 'NULL -> finest level (fail closed)');
select is(public.ixg_geo_level('   '), 'postal', 'blank -> finest level (fail closed)');
select is(public.ixg_geo_rank('nonsense'), 99, 'unknown level ranks finer than any allowed level');

-- ------------------------------------------------------------- evaluator ----
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'no_such_metric', 50)), false, 'unregistered metric is blocked');
select is((select reasons::text[] from public.ixg_evaluate('benchmark_cohorts', 'no_such_metric', 50)), array['metric_not_registered']::text[], 'reason: metric_not_registered');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 5)), true, 'tier 0 at k=5 passes');
select is((select reasons::text[] from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 4)), array['cohort_below_minimum']::text[], 'tier 0 at k=4 blocked');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', null)), false, 'NULL cohort size is blocked');
select ok((select 'counsel_approval_required' = any(reasons) from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 500)),
          'price-adjacent metric needs counsel approval regardless of cohort size');

-- approve avg_ticket_cents (needs a reviewer by constraint)
select throws_ok(
  $$update public.ixg_metric_registry set counsel_status = 'approved' where flow_key = 'benchmark_cohorts' and metric_key = 'avg_ticket_cents'$$,
  '23514', null, 'cannot mark approved without reviewer and date');
update public.ixg_metric_registry
   set counsel_status = 'approved', counsel_reviewed_by = 'test-counsel', counsel_reviewed_at = now()
 where flow_key = 'benchmark_cohorts' and metric_key = 'avg_ticket_cents';
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 8)), true, 'approved tier 2 passes at k=8');
select is((select reasons::text[] from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 7)), array['cohort_below_minimum']::text[], 'tier 2 needs k >= 8 even when approved');

-- narrow geography
select is((select reasons::text[] from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 50, 'locality')), array['geography_too_narrow']::text[],
          'approved price-adjacent metric is suppressed at locality level');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 50, 'state')), true, 'same metric at state level passes');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_ticket_cents', 50, 'garbage')), false, 'unknown geography level is blocked');

-- single-tenant share (additive metric)
select ok((select 'share_unknown' = any(reasons) from public.ixg_evaluate('regional_demand', 'current_week_calls', 50, 'locality', null)),
          'additive metric without a share is blocked (cannot prove dominance)');
select ok((select 'single_tenant_share_exceeded' = any(reasons) from public.ixg_evaluate('regional_demand', 'current_week_calls', 50, 'locality', 60)),
          'share above cap is blocked');
select is((select allowed from public.ixg_evaluate('regional_demand', 'current_week_calls', 50, 'locality', 50)), true, 'share exactly at cap passes');

-- data lag (config-driven)
update public.ixg_guardrail_config set data_lag_days = 30 where scope = 'tier:0';
select ok((select 'data_too_recent' = any(reasons) from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 50, 'national', null, current_date)),
          'lag 30: data ending today is blocked');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 50, 'national', null, current_date - 30)), true,
          'lag 30: data ending 30 days ago passes');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 50, 'national', null, null)), false,
          'lag > 0 and unknown data date is blocked');
select is(public.ixg_window_end('benchmark_cohorts', 'avg_call_score', date '2030-06-30'), date '2030-05-31', 'ixg_window_end applies the configured lag');
update public.ixg_guardrail_config set data_lag_days = 0 where scope = 'tier:0';
select is(public.ixg_window_end('benchmark_cohorts', 'no_such_metric', date '2030-06-30'), date '2030-06-30' - 730,
          'ixg_window_end for an unregistered metric falls back to the oldest window');

-- config missing => closed; flow override wins
delete from public.ixg_guardrail_config where scope = 'tier:0';
select ok((select 'config_missing' = any(reasons) from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 1000)), 'missing config row => blocked');
insert into public.ixg_guardrail_config (scope, min_cohort_size, max_single_share_pct, data_lag_days, min_geo_level)
  values ('flow:benchmark_cohorts', 12, 100, 0, 'national');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 11)), false, 'flow override: k=11 < 12 blocked');
select is((select allowed from public.ixg_evaluate('benchmark_cohorts', 'avg_call_score', 12)), true, 'flow override: k=12 passes');
delete from public.ixg_guardrail_config where scope = 'flow:benchmark_cohorts';
insert into public.ixg_guardrail_config (scope, min_cohort_size, max_single_share_pct, data_lag_days, min_geo_level)
  values ('tier:0', 5, 100, 0, 'postal');

-- config CHECK constraints
select throws_ok($$insert into public.ixg_guardrail_config (scope, min_cohort_size, max_single_share_pct, data_lag_days, min_geo_level) values ('tier:1x', 5, 50, 0, 'state')$$, '23514', null, 'bad scope rejected');
select throws_ok($$update public.ixg_guardrail_config set min_cohort_size = 2 where scope = 'tier:1'$$, '23514', null, 'k below 3 rejected');

-- ------------------------------------------------------------- write gate ---
insert into public.benchmark_cohort_stats (industry, size_tier, metric, unit, direction, period_start, period_end, contributor_count, avg_value, p10, p25, p50, p75, p90)
values ('ixg-test', 'all', 'avg_call_score', 'score', 'higher_is_better', current_date - 30, current_date, 5, 80, 60, 70, 80, 90, 95);
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test' and metric = 'avg_call_score'), 1, 'write gate: allowed row is stored');

insert into public.benchmark_cohort_stats (industry, size_tier, metric, unit, direction, period_start, period_end, contributor_count, avg_value, p10, p25, p50, p75, p90)
values ('ixg-test', 'all', 'avg_ticket_cents', 'cents', 'higher_is_better', current_date - 30, current_date, 7, 90000, 1, 2, 3, 4, 5);
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test' and metric = 'avg_ticket_cents'), 0,
          'write gate: approved tier 2 metric with k=7 is silently skipped');
select ok(exists (select 1 from public.ixg_guardrail_audit where metric_key = 'avg_ticket_cents' and 'cohort_below_minimum' = any(reasons)),
          'write gate: the suppression is audited with its reason');

insert into public.benchmark_cohort_stats (industry, size_tier, metric, unit, direction, period_start, period_end, contributor_count, avg_value, p10, p25, p50, p75, p90)
values ('ixg-test', 'all', 'avg_ticket_cents', 'cents', 'higher_is_better', current_date - 30, current_date, 8, 90000, 1, 2, 3, 4, 5);
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test' and metric = 'avg_ticket_cents'), 1, 'write gate: k=8 stored');

update public.ixg_metric_registry set counsel_status = 'rejected' where flow_key = 'benchmark_cohorts' and metric_key = 'avg_call_score';
insert into public.benchmark_cohort_stats (industry, size_tier, metric, unit, direction, period_start, period_end, contributor_count, avg_value, p10, p25, p50, p75, p90)
values ('ixg-test2', 'all', 'avg_call_score', 'score', 'higher_is_better', current_date - 30, current_date, 9, 80, 60, 70, 80, 90, 95);
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test2'), 0, 'write gate: counsel-rejected metric is never stored');
update public.ixg_metric_registry set counsel_status = 'unreviewed' where flow_key = 'benchmark_cohorts' and metric_key = 'avg_call_score';

-- ------------------------------------------------------------- read gate ----
set local role authenticated;
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test'), 2, 'read gate: tenant sees both allowed rows');
reset role;
update public.ixg_guardrail_config set min_cohort_size = 6 where scope = 'tier:0';
set local role authenticated;
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test' and metric = 'avg_call_score'), 0,
          'read gate: raising k hides already-stored rows immediately');
reset role;
update public.ixg_guardrail_config set min_cohort_size = 5 where scope = 'tier:0';

-- regional demand: k, narrow geography
insert into public.regional_demand_snapshots (industry, region_key, region_label, sample_size, period_start, period_end)
values ('ixg-test', 'austin, tx', 'Austin, Tx', 5, current_date - 14, current_date),
       ('ixg-test', '78701', '78701', 9, current_date - 14, current_date),
       ('ixg-test', 'tx', 'Tx', 5, current_date - 14, current_date),
       ('ixg-test', 'houston, tx', 'Houston, Tx', 4, current_date - 14, current_date);
set local role authenticated;
select is((select array_agg(region_key order by region_key) from public.regional_demand_snapshots where industry = 'ixg-test'),
          array['austin, tx', 'tx']::text[], 'regional read gate: zip-level and k=4 segments are hidden');
reset role;

-- purge
update public.ixg_guardrail_config set min_cohort_size = 6 where scope = 'tier:0';
select ok(public.ixg_purge_published() >= 2, 'purge removes stored rows that no longer pass (benchmark k=5 row and zip segment)');
select is((select count(*)::int from public.benchmark_cohort_stats where industry = 'ixg-test' and metric = 'avg_call_score'), 0, 'purge: benchmark row removed');
select is((select count(*)::int from public.regional_demand_snapshots where industry = 'ixg-test' and region_key = '78701'), 0, 'purge: zip-level regional row removed');
update public.ixg_guardrail_config set min_cohort_size = 5 where scope = 'tier:0';

-- ----------------------------------------------------- batch check RPC ------
select is(
  (select jsonb_array_length(public.ixg_check_rows('benchmark_cohorts', '[{"key":1,"metric":"avg_call_score","cohort_size":5},{"key":2,"metric":"nope","cohort_size":50}]'::jsonb))),
  2, 'batch check returns one verdict per item');
select is(
  (public.ixg_check_rows('benchmark_cohorts', '[{"key":1,"metric":"avg_call_score","cohort_size":5},{"key":2,"metric":"nope","cohort_size":50}]'::jsonb) -> 1 ->> 'allowed')::boolean,
  false, 'batch check: unregistered metric blocked');
select is(
  (public.ixg_check_rows('benchmark_cohorts', '[{"key":"x","metric":"avg_call_score","cohort_size":"abc"}]'::jsonb) -> 0 -> 'reasons' ->> 0),
  'malformed_item', 'batch check: malformed item is blocked, not an exception');
select throws_ok($$select public.ixg_check_rows('benchmark_cohorts', '{"a":1}'::jsonb)$$, '22023', null, 'batch check: non-array input is rejected');
select is(
  (public.ixg_check_rows('regional_demand', '[{"key":1,"metric":"current_week_calls","cohort_size":9,"geo_text":"austin, tx","max_share_pct":30}]'::jsonb) -> 0 ->> 'allowed')::boolean,
  true, 'batch check: regional additive metric with share under cap passes');
select is(
  (public.ixg_check_rows('regional_demand', '[{"key":1,"metric":"current_week_calls","cohort_size":9,"geo_text":"78701","max_share_pct":30}]'::jsonb) -> 0 -> 'reasons' ->> 0),
  'geography_too_narrow', 'batch check: zip-level geography is suppressed for tier 1');

-- ------------------------------------------------ dominance (SQL function) --
select ok(not has_function_privilege('authenticated', 'public.ixg_regional_dominated_segments()', 'execute'), 'authenticated cannot call the dominance function');
select ok(not has_function_privilege('authenticated', 'public.ixg_regional_segment_shares()', 'execute'), 'authenticated cannot read per-segment shares');
select ok(not has_function_privilege('authenticated', 'public.ixg_check_rows(text,jsonb)', 'execute'), 'authenticated cannot call the batch check');
select is((select count(*)::int from public.ixg_regional_dominated_segments()), 0, 'dominance: no consenting tenants => no segments');

-- ------------------------------------------------------- procurement k ------
select is(public.pn_min_cohort(), 3, 'procurement keeps k = 3 via its flow override');
update public.ixg_guardrail_config set min_cohort_size = 7 where scope = 'flow:procurement_network';
select is(public.pn_min_cohort(), 7, 'procurement k follows config');
delete from public.ixg_guardrail_config where scope = 'flow:procurement_network';
select is(public.pn_min_cohort(), 10, 'override removed: falls back to the tier 3 minimum');
delete from public.ixg_guardrail_config where scope like 'tier:%';
select is(public.pn_min_cohort(), 2147483647, 'no config at all: procurement pools can never become visible (fail closed)');

-- ----------------------------------------------------------------- audit ----
select throws_ok($$update public.ixg_guardrail_audit set flow_key = 'x'$$, 'P0001', 'ixg_guardrail_audit is append-only', 'audit rows cannot be updated');
select throws_ok($$delete from public.ixg_guardrail_audit$$, 'P0001', 'ixg_guardrail_audit is append-only', 'audit rows cannot be deleted');

-- ------------------------------------------------------------ admin RPC -----
set local role authenticated;
select throws_ok($$select public.ixg_admin_overview()$$, '42501', 'not authorized', 'a non-staff tenant cannot read the overview');
reset role;


select * from finish();
rollback;
