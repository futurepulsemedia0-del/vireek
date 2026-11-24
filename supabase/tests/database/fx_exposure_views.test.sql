-- Currency exposure views (20290307000000): revenue run-rate / collected / cost by currency, exposure summary,
-- no conversion, USD-only cost, NULL (not 0) for unrecorded cost, invoice de-duplication, provider_invoices never
-- added to the ledger, staff-only access (pgTAP). NOT executed by the author (no Postgres in the authoring
-- sandbox). Run with:  supabase test db
--
-- Dates are relative to now() because the summary window is "the last three completed UTC months".
-- pg_temp.m(n, d) = start of the month n months ago (UTC) + d days.
--
-- Fixture
--   subscriptions (subscription_facts, latest fact per subscription wins)
--     sub_a  USD  active    5,000 then 10,000   (U1)   -> USD run-rate 10,000
--     sub_b  EUR  active    8,000               (U2)
--     sub_c  EUR  past_due  2,000               (U1)   -> EUR run-rate 10,000, 2 subscriptions, 2 accounts
--     sub_d  CAD  canceled  0                   (U2)   -> CAD present with a MEASURED zero
--     sub_e  NULL active    100                 (U2)   -> UNSPECIFIED
--   invoices (billing_events)
--     in_fx_1  USD 12,000 tax 2,000, last month, delivered as BOTH invoice.paid and invoice.payment_succeeded
--     in_fx_2  eur  8,000, last month (lower-case currency)
--     in_fx_3  USD, last month, payload WITHOUT amount_paid
--     in_fx_4  eur  5,000, two months ago
--     in_fx_5  USD    999, current month (outside the summary window)
--   cost (cost_ledger, micro-USD)
--     last month: 1,000,000 (provider_reported) + 2,000,000 (estimated) = 300 cents, 200 of them estimated
--     two months ago: 500,000 = 50 cents;  current month: 700,000 (outside the window)
--   provider_invoices: vapi, last month, 12.34 USD (reconciliation reference only)
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

create or replace function pg_temp.m(n int, d int) returns timestamptz language sql as $$
  select ((date_trunc('month', now() at time zone 'utc') - make_interval(months => n) + make_interval(days => d)) at time zone 'utc')
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000fa01', 'u1@fx.test'),
  ('00000000-0000-0000-0000-00000000fa02', 'u2@fx.test'),
  ('00000000-0000-0000-0000-00000000fa03', 'staff@fx.test'),
  ('00000000-0000-0000-0000-00000000fa04', 'plain@fx.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000fa01'), ('00000000-0000-0000-0000-00000000fa02'),
  ('00000000-0000-0000-0000-00000000fa03'), ('00000000-0000-0000-0000-00000000fa04')
on conflict (id) do nothing;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000fa03';

insert into public.subscription_facts (stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, currency, mrr_cents) values
  ('evt_fx_a1', 'sub_fx_a', '00000000-0000-0000-0000-00000000fa01', pg_temp.m(3, 1), 'customer.subscription.created', 'active',   'usd',  5000),
  ('evt_fx_a2', 'sub_fx_a', '00000000-0000-0000-0000-00000000fa01', pg_temp.m(2, 1), 'customer.subscription.updated', 'active',   'usd', 10000),
  ('evt_fx_b1', 'sub_fx_b', '00000000-0000-0000-0000-00000000fa02', pg_temp.m(2, 2), 'customer.subscription.created', 'active',   'eur',  8000),
  ('evt_fx_c1', 'sub_fx_c', '00000000-0000-0000-0000-00000000fa01', pg_temp.m(2, 3), 'customer.subscription.created', 'past_due', 'eur',  2000),
  ('evt_fx_d1', 'sub_fx_d', '00000000-0000-0000-0000-00000000fa02', pg_temp.m(2, 4), 'customer.subscription.deleted', 'canceled', 'cad',     0),
  ('evt_fx_e1', 'sub_fx_e', '00000000-0000-0000-0000-00000000fa02', pg_temp.m(2, 5), 'customer.subscription.created', 'active',   null,    100);

insert into public.billing_events (stripe_event_id, event_type, payload, created_at) values
  ('evt_fx_i1a', 'invoice.paid', jsonb_build_object('id', 'evt_fx_i1a', 'created', extract(epoch from pg_temp.m(1, 10))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_1', 'currency', 'usd', 'amount_paid', 12000, 'tax', 2000))), pg_temp.m(1, 10)),
  ('evt_fx_i1b', 'invoice.payment_succeeded', jsonb_build_object('id', 'evt_fx_i1b', 'created', extract(epoch from pg_temp.m(1, 10))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_1', 'currency', 'usd', 'amount_paid', 12000, 'tax', 2000))), pg_temp.m(1, 10)),
  ('evt_fx_i2', 'invoice.paid', jsonb_build_object('id', 'evt_fx_i2', 'created', extract(epoch from pg_temp.m(1, 11))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_2', 'currency', 'eur', 'amount_paid', 8000))), pg_temp.m(1, 11)),
  ('evt_fx_i3', 'invoice.paid', jsonb_build_object('id', 'evt_fx_i3', 'created', extract(epoch from pg_temp.m(1, 12))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_3', 'currency', 'usd'))), pg_temp.m(1, 12)),
  ('evt_fx_i4', 'invoice.paid', jsonb_build_object('id', 'evt_fx_i4', 'created', extract(epoch from pg_temp.m(2, 12))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_4', 'currency', 'eur', 'amount_paid', 5000))), pg_temp.m(2, 12)),
  ('evt_fx_i5', 'invoice.paid', jsonb_build_object('id', 'evt_fx_i5', 'created', extract(epoch from pg_temp.m(0, 1))::bigint,
     'data', jsonb_build_object('object', jsonb_build_object('id', 'in_fx_5', 'currency', 'usd', 'amount_paid', 999))), pg_temp.m(0, 1));

insert into public.cost_ledger (account_id, provider, resource_type, component, cost_micro, basis, kind, source, ref, occurred_at) values
  (null, 'vapi',   'voice_minutes', 'voice_platform', 1000000, 'provider_reported', 'usage', 'fx-test', 'fx-c1', pg_temp.m(1, 5)),
  (null, 'openai', 'llm_tokens',    'llm',            2000000, 'estimated',         'usage', 'fx-test', 'fx-c2', pg_temp.m(1, 6)),
  (null, 'openai', 'llm_tokens',    'llm',             500000, 'estimated',         'usage', 'fx-test', 'fx-c3', pg_temp.m(2, 6)),
  (null, 'openai', 'llm_tokens',    'llm',             700000, 'estimated',         'usage', 'fx-test', 'fx-c4', pg_temp.m(0, 1));
insert into public.provider_invoices (provider, period_month, invoiced_usd) values
  ('vapi', pg_temp.m(1, 0)::date, 12.34);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Structure and access ---------------------------------------------------------------------------------------
select has_view('public', 'fx_exposure_summary_v', 'fx_exposure_summary_v exists');
select has_function('public', 'staff_fx_exposure', array['integer'], 'staff_fx_exposure exists');
select is(has_table_privilege('anon', 'public.fx_revenue_run_rate_v', 'SELECT'), false, 'anon cannot read the views');
select is(has_table_privilege('authenticated', 'public.fx_collected_by_currency_month_v', 'SELECT'), false, 'tenants cannot read the views');
select is(has_function_privilege('anon', 'public.staff_fx_exposure(integer)', 'EXECUTE'), false, 'anon cannot run the report');
select is(has_table_privilege('service_role', 'public.fx_exposure_summary_v', 'SELECT'), true, 'service_role can read the views');

-- Revenue run-rate -------------------------------------------------------------------------------------------
select is((select mrr_minor from public.fx_revenue_run_rate_v where currency = 'USD'), 10000::bigint, 'latest fact per subscription wins (10,000, not 5,000 or 15,000)');
select is((select mrr_minor from public.fx_revenue_run_rate_v where currency = 'EUR'), 10000::bigint, 'EUR run-rate sums active and past_due subscriptions');
select is((select past_due_mrr_minor from public.fx_revenue_run_rate_v where currency = 'EUR'), 2000::bigint, 'past-due part is reported separately');
select is((select accounts from public.fx_revenue_run_rate_v where currency = 'EUR'), 2, 'EUR run-rate comes from two accounts');
select is((select mrr_minor || '/' || subscriptions from public.fx_revenue_run_rate_v where currency = 'CAD'), '0/0', 'a canceled-only currency shows a measured zero');
select is((select mrr_minor from public.fx_revenue_run_rate_v where currency = 'UNSPECIFIED'), 100::bigint, 'a NULL currency is shown as UNSPECIFIED, never merged into USD');
select is((select share_of_subscriptions_pct from public.fx_exposure_summary_v where currency = 'EUR'), 50.0::numeric, 'EUR is 2 of 4 live subscriptions (a count, no FX needed)');

-- Collected by month -----------------------------------------------------------------------------------------
select is((select invoices from public.fx_collected_by_currency_month_v where currency = 'USD' and month = pg_temp.m(1, 0)::date), 2,
  'invoice.paid and invoice.payment_succeeded for one invoice count once (2 USD invoices, not 3)');
select is((select collected_minor from public.fx_collected_by_currency_month_v where currency = 'USD' and month = pg_temp.m(1, 0)::date), 12000::bigint,
  'a payload without amount_paid adds nothing and is not zero-filled');
select is((select invoices_without_amount from public.fx_collected_by_currency_month_v where currency = 'USD' and month = pg_temp.m(1, 0)::date), 1,
  'the missing amount is counted so it is visible');
select is((select tax_minor from public.fx_collected_by_currency_month_v where currency = 'USD' and month = pg_temp.m(1, 0)::date), 2000::bigint,
  'tax is reported when the payload carries it');
select is((select collected_minor from public.fx_collected_by_currency_month_v where currency = 'EUR' and month = pg_temp.m(1, 0)::date), 8000::bigint,
  'lower-case Stripe currency codes are normalised');
select is((select collected_minor from public.fx_exposure_summary_v where currency = 'USD'), 12000::bigint,
  'the current (incomplete) month is outside the summary window');

-- Cost -------------------------------------------------------------------------------------------------------
select is((select amount_minor from public.fx_cost_by_currency_month_v where source = 'cost_ledger' and month = pg_temp.m(1, 0)::date), 300::bigint,
  'ledger cost converts micro-USD to cents (3,000,000 / 10,000)');
select is((select estimated_minor from public.fx_cost_by_currency_month_v where source = 'cost_ledger' and month = pg_temp.m(1, 0)::date), 200::bigint,
  'the estimated share is shown');
select is((select amount_minor from public.fx_cost_by_currency_month_v where source = 'provider_invoices' and month = pg_temp.m(1, 0)::date), 1234::bigint,
  'provider invoices appear as their own source');
select is((select avg_monthly_cost_minor from public.fx_exposure_summary_v where currency = 'USD'), 175::bigint,
  'average monthly USD cost = (300 + 50) / 2 months, provider_invoices NOT added');
select is((select avg_monthly_cost_minor from public.fx_exposure_summary_v where currency = 'EUR'), null::bigint,
  'a currency with no recorded cost shows NULL, not 0');
select is((select exposure_state from public.fx_exposure_summary_v where currency = 'EUR'), 'revenue_only_no_recorded_cost', 'EUR state: revenue only, no recorded cost');
select is((select exposure_state from public.fx_exposure_summary_v where currency = 'USD'), 'revenue_and_cost_recorded', 'USD state: revenue and cost recorded');

-- Staff RPC --------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000fa03');
select is(jsonb_array_length(public.staff_fx_exposure() -> 'exposure'), 4, 'one exposure row per currency (USD, EUR, CAD, UNSPECIFIED); nothing combined');
select ok((public.staff_fx_exposure() ->> 'conversion') like 'none%', 'the report states that no conversion was applied');
select throws_ok($$ select public.staff_fx_exposure(0) $$, '22023', null, 'p_months below 1 is rejected');
select throws_ok($$ select public.staff_fx_exposure(37) $$, '22023', null, 'p_months above 36 is rejected');

select pg_temp.act_as('00000000-0000-0000-0000-00000000fa04');
select throws_ok($$ select public.staff_fx_exposure() $$, '42501', null, 'a non-staff user is refused');

select * from finish();
rollback;
