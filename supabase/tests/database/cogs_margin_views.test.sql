-- COGS and margin views (20290305000100): cost per call-minute, per AI action, gross margin by plan,
-- no double counting, staff-only access (pgTAP). NOT executed by the author (no Postgres in the
-- authoring sandbox). Run with:  supabase test db
--
-- Fixture (month 2026-10, all amounts in micro-USD = 1e-6 USD):
--   A  starter, subscribed   call 10 min costed 2,000,000 (one row estimated) + call 5 min with NO ledger row
--                            AI: 3 actions x 100,000 + one -50,000 correction; one SMS row 40,000
--   B  professional, subscribed   call 20 min costed 3,000,000; no AI
--   C  starter WITHOUT subscription (= free tier)   one AI action 500,000
--   D  enterprise via tier override, no usage (quoted price -> revenue must be NULL, never 0)
--   S  staff account
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f0a1', 'a@cogs.test'),
  ('00000000-0000-0000-0000-00000000f0b1', 'b@cogs.test'),
  ('00000000-0000-0000-0000-00000000f0c1', 'c@cogs.test'),
  ('00000000-0000-0000-0000-00000000f0d1', 'd@cogs.test'),
  ('00000000-0000-0000-0000-00000000f0e1', 'staff@cogs.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000f0a1'), ('00000000-0000-0000-0000-00000000f0b1'),
  ('00000000-0000-0000-0000-00000000f0c1'), ('00000000-0000-0000-0000-00000000f0d1'),
  ('00000000-0000-0000-0000-00000000f0e1')
on conflict (id) do nothing;
update public.profiles set role = 'owner', plan = 'starter', stripe_subscription_id = 'sub_cogs_a' where id = '00000000-0000-0000-0000-00000000f0a1';
update public.profiles set role = 'owner', plan = 'professional', stripe_subscription_id = 'sub_cogs_b' where id = '00000000-0000-0000-0000-00000000f0b1';
update public.profiles set role = 'owner', plan = 'starter', stripe_subscription_id = null where id = '00000000-0000-0000-0000-00000000f0c1';
update public.profiles set role = 'owner', plan = 'starter', plan_tier_override = 'enterprise' where id = '00000000-0000-0000-0000-00000000f0d1';
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000f0e1';

insert into public.calls (id, user_id, call_datetime, duration_seconds, vapi_call_id) values
  ('00000000-0000-0000-0000-00000000f1a1', '00000000-0000-0000-0000-00000000f0a1', '2026-10-05 10:00:00+00', 600, 'cogs-call-a1'),
  ('00000000-0000-0000-0000-00000000f1a2', '00000000-0000-0000-0000-00000000f0a1', '2026-10-06 10:00:00+00', 300, 'cogs-call-a2'),
  ('00000000-0000-0000-0000-00000000f1b1', '00000000-0000-0000-0000-00000000f0b1', '2026-10-07 10:00:00+00', 1200, 'cogs-call-b1');

insert into public.cost_ledger (account_id, provider, resource_type, component, cost_micro, basis, kind, call_id, task_type, source, ref, occurred_at, reason) values
  ('00000000-0000-0000-0000-00000000f0a1', 'vapi', 'voice_minutes', 'voice_platform', 1200000, 'provider_reported', 'usage', 'cogs-call-a1', null, 'cogs-test', 'a1-voice', '2026-10-05 10:10:00+00', null),
  ('00000000-0000-0000-0000-00000000f0a1', 'vapi', 'llm_tokens', 'llm', 800000, 'estimated', 'usage', 'cogs-call-a1', null, 'cogs-test', 'a1-llm', '2026-10-05 10:10:00+00', null),
  ('00000000-0000-0000-0000-00000000f0a1', 'openai', 'llm_tokens', 'llm', 100000, 'estimated', 'usage', null, 'summarize', 'cogs-test', 'a-ai-1', '2026-10-10 12:00:00+00', null),
  ('00000000-0000-0000-0000-00000000f0a1', 'openai', 'llm_tokens', 'llm', 100000, 'estimated', 'usage', null, 'summarize', 'cogs-test', 'a-ai-2', '2026-10-10 12:01:00+00', null),
  ('00000000-0000-0000-0000-00000000f0a1', 'openai', 'llm_tokens', 'llm', 100000, 'estimated', 'usage', null, 'summarize', 'cogs-test', 'a-ai-3', '2026-10-10 12:02:00+00', null),
  ('00000000-0000-0000-0000-00000000f0a1', 'openai', 'llm_tokens', 'llm', -50000, 'estimated', 'correction', null, 'summarize', 'cogs-test', 'a-ai-corr', '2026-10-11 09:00:00+00', 'offsetting correction for fixture'),
  ('00000000-0000-0000-0000-00000000f0a1', 'twilio', 'sms_segments', 'sms_segment', 40000, 'estimated', 'usage', null, null, 'cogs-test', 'a-sms-1', '2026-10-12 09:00:00+00', null),
  ('00000000-0000-0000-0000-00000000f0b1', 'vapi', 'voice_minutes', 'voice_platform', 3000000, 'provider_reported', 'usage', 'cogs-call-b1', null, 'cogs-test', 'b1-voice', '2026-10-07 10:30:00+00', null),
  ('00000000-0000-0000-0000-00000000f0c1', 'openai', 'llm_tokens', 'llm', 500000, 'estimated', 'usage', null, 'summarize', 'cogs-test', 'c-ai-1', '2026-10-13 08:00:00+00', null);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Structure and access ---------------------------------------------------------------------------------------
select has_view('public', 'cogs_plan_month_v', 'cogs_plan_month_v exists');
select has_function('public', 'staff_cogs_by_plan', array['date'], 'staff_cogs_by_plan exists');
select is((public.cogs_plan_catalog() -> 'starter' ->> 'monthlyCents')::int, 9900, 'catalog mirror carries the starter list price');
select is(has_table_privilege('anon', 'public.cogs_tenant_month_v', 'SELECT'), false, 'anon cannot read the views');
select is(has_table_privilege('authenticated', 'public.cogs_tenant_month_v', 'SELECT'), false, 'tenants cannot read the views');
select is(has_function_privilege('anon', 'public.staff_cogs_by_plan(date)', 'EXECUTE'), false, 'anon cannot run the report');

-- Per-tenant maths (superuser reads the views directly) -------------------------------------------------------
select is((select voice_cost_per_min_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  200000.00::numeric, 'cost per call-minute divides by COSTED minutes only (2,000,000 / 10 min)');
select is((select call_cost_coverage_pct from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  50.0::numeric, 'coverage shows 1 of 2 calls costed');
select is((select calls_costed::int || '/' || calls_total::int from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  '1/2', 'costed vs total calls');
select is((select ai_actions::int from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  3, 'a correction row is not counted as an AI action');
select is((select ai_cost_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  250000::bigint, 'the correction nets against AI cost (300,000 - 50,000)');
select is((select ai_cost_per_action_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  83333.33::numeric, 'AI cost per action');
select is((select other_cost_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  40000::bigint, 'non-call, non-LLM usage lands in other_variable');
select is((select total_cost_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0a1' and month = '2026-10-01'),
  2290000::bigint, 'voice + AI + other = total, nothing counted twice');
select is((select total_cost_micro || '/' || ai_cost_micro from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0b1' and month = '2026-10-01'),
  '3000000/0', 'in-call LLM cost stays in the call, never in the AI-action bucket');
select is((select ai_actions::int from public.cogs_tenant_month_v
            where account_id = '00000000-0000-0000-0000-00000000f0c1' and month = '2026-10-01'),
  1, 'free-tier AI usage is attributed to the free tier');

-- Plan resolution -------------------------------------------------------------------------------------------------
select is((select plan_tier from public.cogs_tenant_plan_v where account_id = '00000000-0000-0000-0000-00000000f0a1'), 'starter', 'subscribed starter');
select is((select plan_tier from public.cogs_tenant_plan_v where account_id = '00000000-0000-0000-0000-00000000f0c1'), 'free', 'starter without a subscription is the free tier');
select is((select is_billed from public.cogs_tenant_plan_v where account_id = '00000000-0000-0000-0000-00000000f0c1'), false, 'free tier is not billed');
select is((select count(*)::int from public.cogs_tenant_plan_v where account_id = '00000000-0000-0000-0000-00000000f0e1'), 0, 'staff accounts are excluded');

-- Gross margin by plan -----------------------------------------------------------------------------------------------
select is((select subscription_revenue_cents from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'starter'),
  (select tenants_billed * 9900 from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'starter'),
  'starter revenue = billed tenants x catalog list price');
select is((select gross_margin_cents from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'starter'),
  (select round(subscription_revenue_cents - total_cost_micro / 10000.0, 2) from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'starter'),
  'gross margin = revenue - cost (micro-USD converted to cents)');
select ok((select total_cost_micro from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'starter') >= 2290000,
  'starter plan cost includes tenant A');
select ok((select subscription_revenue_cents is null and gross_margin_pct is null from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'enterprise'),
  'a quoted plan has NULL revenue and margin, never 0');
select ok((select subscription_revenue_cents is null from public.cogs_plan_month_v where month = '2026-10-01' and plan_tier = 'free'),
  'the free tier has no list price, so no revenue figure');

-- Staff RPCs ----------------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000f0c1');
select throws_ok($$ select public.staff_cogs_by_plan('2026-10-01') $$, '42501', null, 'tenant cannot run staff_cogs_by_plan');
select throws_ok($$ select public.staff_cogs_tenants('2026-10-01', 10) $$, '42501', null, 'tenant cannot run staff_cogs_tenants');
select throws_ok($$ select public.staff_cogs_ai_actions('2026-10-01') $$, '42501', null, 'tenant cannot run staff_cogs_ai_actions');

select pg_temp.act_as('00000000-0000-0000-0000-00000000f0e1');
select is(public.staff_cogs_by_plan('2026-10-15') ->> 'month', '2026-10-01', 'any day normalises to the first of the month');
select throws_ok($$ select public.staff_cogs_by_plan(null) $$, '22023', null, 'a month is required');
select throws_ok($$ select public.staff_cogs_by_plan('2099-01-01') $$, '22023', null, 'far-future months are rejected');
select is(jsonb_array_length(public.staff_cogs_tenants('2026-10-01', 0) -> 'tenants'), 1, 'limit is clamped to at least 1');
select ok((select count(*) from jsonb_array_elements(public.staff_cogs_ai_actions('2026-10-01') -> 'actions') a
            where a ->> 'plan_tier' = 'starter' and a ->> 'task_type' = 'summarize' and (a ->> 'ai_actions')::int >= 3) = 1,
  'AI actions by plan and task include starter / summarize');

select * from finish();
rollback;
