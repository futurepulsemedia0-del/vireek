-- API usage plans: admission (rate + quota), flag gating, overage maths, access control (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------- fixtures --
-- S = staff, A = account on the 'starter' plan (default plan: developer, 10 000 / month), B = another account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff@aup.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'a@aup.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'b@aup.test');
insert into public.profiles (id, role, is_staff, plan) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', true, 'starter'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false, 'starter'),
  ('00000000-0000-0000-0000-0000000000c1', 'owner', false, 'starter')
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff, plan = excluded.plan;

insert into public.api_keys (id, user_id, name, key_hash, key_prefix, scopes, mode) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'live key', repeat('a', 64), 'vrk_live_aaaa', '{jobs:read}', 'live'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'test key', repeat('b', 64), 'vrk_test_bbbb', '{jobs:read}', 'test'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c1', 'b live key', repeat('c', 64), 'vrk_live_cccc', '{jobs:read}', 'live');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;

-- ---------------------------------------------------------------- catalog --
select is((select count(*)::int from public.api_usage_plans), 5, 'five plans are seeded');
select is((select monthly_quota from public.api_usage_plans where slug = 'legacy'), null::bigint, 'legacy plan is unlimited');
select ok((select bool_and(is_proposed) from public.api_usage_plans where slug <> 'legacy'), 'every non-legacy plan is marked proposed');
select throws_like($$insert into public.api_usage_plans (slug, name, rate_limit_per_minute, monthly_quota, overage_policy) values ('bad_meter', 'Bad', 60, null, 'meter')$$, '%meter_needs_quota%', 'a metered plan must have a quota');
select is(public.api_overage_cost_cents(1001, 30), 60::bigint, 'overage cost rounds up to started blocks of 1,000');
select is(public.api_overage_cost_cents(0, 30), 0::bigint, 'no overage costs nothing');

-- ---------------------------------------------------------------- flag OFF = legacy behaviour --
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'allowed')::boolean, true, 'flag off: request admitted');
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') -> 'plan') = 'null'::jsonb, true, 'flag off: no plan reported');
select is((select count(*)::int from public.api_usage_counters), 0, 'flag off: nothing is counted');
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'rate_limit')::int, 120, 'flag off: platform default rate limit');
select is((public.api_v1_admit('00000000-0000-0000-0000-00000000dead') ->> 'reason'), 'unknown_key', 'unknown key is reported');

-- ---------------------------------------------------------------- flag ON for account A --
insert into public.feature_flag_overrides (flag_id, tenant_id, state)
select id, '00000000-0000-0000-0000-0000000000b1', 'on' from public.feature_flags where key = 'api_usage_plans';

select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'plan'), 'developer', 'flag on: starter account gets the developer plan');
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'rate_limit')::int, 60, 'flag on: plan rate limit applies');
select is((select sum(requests)::int from public.api_usage_counters where user_id = '00000000-0000-0000-0000-0000000000b1'), 2, 'flag on: live requests are counted');
select pg_temp.reset_role();
select public.api_v1_admit('50000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.api_usage_counters where api_key_id = '50000000-0000-0000-0000-000000000002'), 0, 'test-mode keys are never counted');

-- a staff per-key override still wins over the plan
-- (the override column is service-role-only, enforced by prevent_api_key_tampering)
select set_config('request.jwt.claims', '{"role":"service_role"}', true), set_config('request.jwt.claim.role', 'service_role', true);
update public.api_keys set rate_limit_per_minute = 200 where id = '50000000-0000-0000-0000-000000000001';
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'rate_limit')::int, 200, 'key override beats the plan limit');
update public.api_keys set rate_limit_per_minute = null where id = '50000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claims', '{}', true), set_config('request.jwt.claim.role', '', true);

-- quota exhaustion on a block plan (10 000)
update public.api_usage_counters set requests = 10000 where api_key_id = '50000000-0000-0000-0000-000000000001';
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'reason'), 'quota_exceeded', 'block plan: 429 quota_exceeded at the quota');
select ok((public.api_v1_admit('50000000-0000-0000-0000-000000000001') ->> 'retry_after')::int between 1 and 2678400, 'retry_after points at the next UTC month');

-- account B has no override: flag off, unaffected by A's usage
select is((public.api_v1_admit('50000000-0000-0000-0000-000000000003') ->> 'allowed')::boolean, true, 'other accounts are unaffected');

-- ---------------------------------------------------------------- access control --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_like($$select public.get_api_plan_usage('00000000-0000-0000-0000-0000000000b1')$$, '%API_USAGE_FORBIDDEN%', 'an account cannot read another account''s plan usage');
select throws_like($$select public.api_v1_admit('50000000-0000-0000-0000-000000000003')$$, '%permission denied%', 'admission is not callable by tenants');
select throws_like($$select public.assign_api_usage_plan('00000000-0000-0000-0000-0000000000c1', 'partner', null)$$, '%Staff only%', 'tenants cannot assign plans to themselves');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((public.get_api_plan_usage('00000000-0000-0000-0000-0000000000b1') ->> 'total_requests')::int, 10000, 'owner reads their own usage');

select * from finish();
rollback;
