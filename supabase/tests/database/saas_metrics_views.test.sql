-- SaaS metrics views (20290307000100): MRR, ARR, NRR, GRR, logo churn, CAC payback, "not available" rules (pgTAP).
-- Run with:  supabase test db
-- Needs migrations 20281103000000 + 20281104000000 (growth analytics), 20290301000100 (founder_cac_inputs) and 20290307000100.
--
-- Fixture (USD unless noted, all dates 2025 UTC, MRR in cents; ledger starts 2025-01-10):
--   A1  trial 10 Jan (0) -> active 20 Jan 10,000 (a trial that converts is a NEW logo then) -> 15 Feb upgrade 15,000 -> 10 Apr downgrade 12,000
--   A2  active 12 Jan 20,000 -> canceled 5 Mar (churn)
--   A3  trial 25 Jan (0) -> canceled 10 Feb: never paid, never a logo
--   A4  active 5 Feb 8,000 -> canceled 2 May (churn) -> NEW subscription 1 Jul 9,000 (reactivation, not a new logo)
--   A5  two concurrent subscriptions: 5,000 from 20 Feb, +3,000 from 2 Mar (account-level expansion)
--   A6  active 15 Jan 10,000 with an UNRESOLVED discount flag (stays)
--   A7  EUR: active 3 Feb 7,000 (own currency series)
--   A8  active 10 Mar 4,000 -> past_due 1 Jun (still counts) -> unpaid 1 Aug (0, churn) -> active again 1 Sep 4,000 (reactivation)
--   A9  active 20 Apr 6,000 (a new logo in a month with NO spend row)
-- Month-end USD MRR: Jan 40,000 | Feb 58,000 | Mar 45,000 | Apr 48,000 | May 40,000 | Jun 40,000 | Jul 49,000 | Aug 45,000 | Sep 49,000 | Jan-26 49,000
-- Spend: Jan 30,000 (usd) | Feb 20,000 + 10,000 (usd) and 5,000 (eur) | Mar 0 entered | Apr none | May 1,000 (no new logos).
-- Gross margin (manual): Jan 7,500 bp | Feb 0 bp (= not entered) | Mar 8,000 bp | Apr, May none.
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

insert into auth.users (id, email)
select ('00000000-0000-0000-0000-0000000c00' || lpad(n::text, 2, '0'))::uuid, 'm' || n || '@metrics.test' from generate_series(1, 10) n;
insert into public.profiles (id, is_staff)
select ('00000000-0000-0000-0000-0000000c00' || lpad(n::text, 2, '0'))::uuid, n = 10 from generate_series(1, 10) n
on conflict (id) do update set is_staff = excluded.is_staff;

create or replace function pg_temp.u(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000c00' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function pg_temp.f(
  p_evt text, p_sub text, p_user int, p_at text, p_status text, p_mrr bigint,
  p_cur text default 'usd', p_type text default 'customer.subscription.updated', p_disc boolean default false
) returns void language sql as $$
  insert into public.subscription_facts (stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, mrr_cents, currency, discount_unresolved)
  values (p_evt, p_sub, pg_temp.u(p_user), p_at::timestamptz, p_type, p_status, p_mrr, p_cur, p_disc);
$$;

-- A1
select pg_temp.f('m1',  'sa', 1, '2025-01-10 09:00+00', 'trialing', 0, 'usd', 'customer.subscription.created');
select pg_temp.f('m2',  'sa', 1, '2025-01-20 09:00+00', 'active', 10000);
select pg_temp.f('m3',  'sa', 1, '2025-02-15 09:00+00', 'active', 15000);
select pg_temp.f('m4',  'sa', 1, '2025-04-10 09:00+00', 'active', 12000);
-- A2
select pg_temp.f('m5',  'sb', 2, '2025-01-12 09:00+00', 'active', 20000, 'usd', 'customer.subscription.created');
select pg_temp.f('m6',  'sb', 2, '2025-03-05 09:00+00', 'canceled', 0, 'usd', 'customer.subscription.deleted');
-- A3
select pg_temp.f('m7',  'sc', 3, '2025-01-25 09:00+00', 'trialing', 0, 'usd', 'customer.subscription.created');
select pg_temp.f('m8',  'sc', 3, '2025-02-10 09:00+00', 'canceled', 0, 'usd', 'customer.subscription.deleted');
-- A4
select pg_temp.f('m9',  'sd', 4, '2025-02-05 09:00+00', 'active', 8000, 'usd', 'customer.subscription.created');
select pg_temp.f('m10', 'sd', 4, '2025-05-02 09:00+00', 'canceled', 0, 'usd', 'customer.subscription.deleted');
select pg_temp.f('m11', 'se', 4, '2025-07-01 09:00+00', 'active', 9000, 'usd', 'customer.subscription.created');
-- A5
select pg_temp.f('m12', 'sf', 5, '2025-02-20 09:00+00', 'active', 5000, 'usd', 'customer.subscription.created');
select pg_temp.f('m13', 'sg', 5, '2025-03-02 09:00+00', 'active', 3000, 'usd', 'customer.subscription.created');
-- A6
select pg_temp.f('m14', 'sh', 6, '2025-01-15 09:00+00', 'active', 10000, 'usd', 'customer.subscription.created', true);
-- A7
select pg_temp.f('m15', 'si', 7, '2025-02-03 09:00+00', 'active', 7000, 'eur', 'customer.subscription.created');
-- A8
select pg_temp.f('m16', 'sj', 8, '2025-03-10 09:00+00', 'active', 4000, 'usd', 'customer.subscription.created');
select pg_temp.f('m17', 'sj', 8, '2025-06-01 09:00+00', 'past_due', 4000);
select pg_temp.f('m18', 'sj', 8, '2025-08-01 09:00+00', 'unpaid', 0);
select pg_temp.f('m19', 'sj', 8, '2025-09-01 09:00+00', 'active', 4000);
-- A9
select pg_temp.f('m20', 'sk', 9, '2025-04-20 09:00+00', 'active', 6000, 'usd', 'customer.subscription.created');

insert into public.growth_marketing_spend (channel, month, amount_cents, currency) values
  ('google', '2025-01-01', 30000, 'usd'),
  ('google', '2025-02-01', 20000, 'usd'), ('sales', '2025-02-01', 10000, 'usd'), ('google', '2025-02-01', 5000, 'eur'),
  ('google', '2025-03-01', 0, 'usd'),
  ('google', '2025-05-01', 1000, 'usd');
insert into public.founder_cac_inputs (month, spend_cents, gross_margin_bp, platform_fee_cents) values
  ('2025-01', 0, 7500, 0), ('2025-02', 0, 0, 0), ('2025-03', 0, 8000, 0);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------- structure and access ----------
select has_view('public', 'metrics_retention_monthly_v', 'retention view exists');
select has_function('public', 'staff_metrics_saas', array['date', 'date'], 'staff report exists');
select is(has_table_privilege('anon', 'public.metrics_mrr_monthly_v', 'SELECT'), false, 'anon cannot read the MRR view');
select is(has_table_privilege('authenticated', 'public.metrics_mrr_monthly_v', 'SELECT'), false, 'tenants cannot read the MRR view');
select is(has_table_privilege('authenticated', 'public.metrics_account_month_v', 'SELECT'), false, 'tenants cannot read per-account MRR');
select is(has_function_privilege('anon', 'public.staff_metrics_saas(date, date)', 'EXECUTE'), false, 'anon cannot run the report');

-- ---------- MRR and ARR ----------
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-01-01' and currency = 'usd'), 40000::bigint, 'Jan MRR: trial and never-paid trial count 0');
select is((select arr_cents from public.metrics_mrr_monthly_v where month = '2025-01-01' and currency = 'usd'), 480000::bigint, 'ARR = MRR x 12');
select is((select paying_accounts::int from public.metrics_mrr_monthly_v where month = '2025-01-01' and currency = 'usd'), 3, 'Jan paying accounts');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-02-01' and currency = 'usd'), 58000::bigint, 'Feb MRR includes the upgrade');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-02-01' and currency = 'eur'), 7000::bigint, 'EUR is its own series');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-03-01' and currency = 'usd'), 45000::bigint, 'Mar MRR: churn out, concurrent subscription in');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-06-01' and currency = 'usd'), 40000::bigint, 'past_due still counts as MRR');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-08-01' and currency = 'usd'), 45000::bigint, 'unpaid drops to 0 (churn)');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-09-01' and currency = 'usd'), 49000::bigint, 'reactivation brings MRR back');
select is((select subscriptions_with_unresolved_discount::int from public.metrics_mrr_monthly_v where month = '2025-03-01' and currency = 'usd'), 1, 'MRR with an unresolved discount is flagged, not hidden');
select is((select count(*)::int from public.metrics_mrr_monthly_v where month < '2025-01-01'), 0, 'months before the ledger are absent (not available), never 0');

-- consistency with the existing period summary (one number, one definition)
select is((select (e ->> 'closing_mrr_cents')::bigint from jsonb_array_elements(public.growth_period_summary('2025-03-01', '2025-04-01')) e where e ->> 'currency' = 'usd'),
  (select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-03-01' and currency = 'usd'), 'month-end MRR equals growth_period_summary closing MRR');
select is((select (e ->> 'opening_mrr_cents')::bigint from jsonb_array_elements(public.growth_period_summary('2025-03-01', '2025-04-01')) e where e ->> 'currency' = 'usd'),
  (select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-02-01' and currency = 'usd'), 'opening MRR equals the previous month-end MRR');
select is((select (e ->> 'cohort_closing_cents')::bigint from jsonb_array_elements(public.growth_period_summary('2025-03-01', '2025-04-01')) e where e ->> 'currency' = 'usd'),
  (select closing_mrr_cents from public.metrics_retention_monthly_v where month = '2025-03-01' and currency = 'usd' and window_months = 1), 'cohort closing MRR equals growth_period_summary');

-- ---------- retention, 1-month window ----------
select is((select availability from public.metrics_retention_monthly_v where month = '2025-01-01' and currency = 'usd' and window_months = 1), 'not_available_history_too_short', 'a window that starts before the ledger is not available');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-01-01' and currency = 'usd' and window_months = 1) is null, true, 'not available is NULL, not 0');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-02-01' and currency = 'usd' and window_months = 1), 11250, 'Feb NRR above 100% (upgrade): 45,000 / 40,000');
select is((select grr_bp from public.metrics_retention_monthly_v where month = '2025-02-01' and currency = 'usd' and window_months = 1), 10000, 'Feb GRR is capped at 100% (expansion excluded)');
select is((select logo_churn_bp from public.metrics_retention_monthly_v where month = '2025-02-01' and currency = 'usd' and window_months = 1), 0, 'Feb logo churn is a measured 0');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-03-01' and currency = 'usd' and window_months = 1), 7069, 'Mar NRR = 41,000 / 58,000 (the new logo is not in the cohort)');
select is((select grr_bp from public.metrics_retention_monthly_v where month = '2025-03-01' and currency = 'usd' and window_months = 1), 6552, 'Mar GRR = 38,000 / 58,000');
select is((select logo_churn_bp from public.metrics_retention_monthly_v where month = '2025-03-01' and currency = 'usd' and window_months = 1), 2000, 'Mar logo churn = 1 of 5 cohort accounts');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-04-01' and currency = 'usd' and window_months = 1), 9333, 'Apr: downgrade is contraction (a new logo in the month is excluded)');
select is((select nrr_bp || '/' || grr_bp from public.metrics_retention_monthly_v where month = '2025-05-01' and currency = 'usd' and window_months = 1), '8333/8333', 'May: churn of one account');
select is((select logo_churn_bp from public.metrics_retention_monthly_v where month = '2025-05-01' and currency = 'usd' and window_months = 1), 1667, 'May logo churn = 1 of 6');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-07-01' and currency = 'usd' and window_months = 1), 10000, 'Jul: a reactivation is not retention (account was not in the cohort)');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-08-01' and currency = 'usd' and window_months = 1), 9184, 'Aug: unpaid account counts as churn');
select is((select nrr_bp from public.metrics_retention_monthly_v where month = '2025-09-01' and currency = 'usd' and window_months = 1), 10000, 'Sep: second reactivation also stays out of the cohort');
select is((select availability from public.metrics_retention_monthly_v where month = '2025-02-01' and currency = 'eur' and window_months = 1), 'not_available_no_cohort', 'empty cohort -> not available');

-- ---------- retention, 12-month window ----------
select is((select availability from public.metrics_retention_monthly_v where month = '2025-12-01' and currency = 'usd' and window_months = 12), 'not_available_history_too_short', '12-month window starting before the ledger is not available');
select is((select nrr_bp || '/' || grr_bp || '/' || logo_churn_bp from public.metrics_retention_monthly_v where month = '2026-01-01' and currency = 'usd' and window_months = 12), '5500/5000/3333', '12-month NRR / GRR / logo churn (cohort = accounts paying at the end of Jan 2025)');

-- ---------- CAC payback ----------
select is((select cac_cents || '/' || payback_months from public.metrics_cac_payback_monthly_v where month = '2025-01-01' and currency = 'usd'), '10000/1.00', 'Jan: CAC 30,000 / 3 logos; payback = 30,000 / (40,000 x 75%) = 1.00 month');
select is((select availability from public.metrics_cac_payback_monthly_v where month = '2025-02-01' and currency = 'usd'), 'not_available_no_gross_margin', '0 bp is "not entered", not a margin');
select is((select cac_cents from public.metrics_cac_payback_monthly_v where month = '2025-02-01' and currency = 'usd'), 15000::bigint, 'CAC is still shown when only the margin is missing (sum over channels)');
select is((select payback_months is null from public.metrics_cac_payback_monthly_v where month = '2025-02-01' and currency = 'usd'), true, 'payback is NULL without a margin');
select is((select availability from public.metrics_cac_payback_monthly_v where month = '2025-02-01' and currency = 'eur'), 'not_available_no_gross_margin', 'EUR month is evaluated on its own spend and logos');
select is((select payback_months from public.metrics_cac_payback_monthly_v where month = '2025-03-01' and currency = 'usd'), 0.00::numeric, 'an entered spend of 0 is a measured zero, not "not available"');
select is((select availability from public.metrics_cac_payback_monthly_v where month = '2025-04-01' and currency = 'usd'), 'not_available_no_spend', 'new logo but no spend row -> not available (never a free logo)');
select is((select availability from public.metrics_cac_payback_monthly_v where month = '2025-05-01' and currency = 'usd'), 'not_available_no_new_logos', 'spend but no new logo -> not available (no divide by zero)');
select is((select count(*)::int from public.metrics_cac_payback_monthly_v where month in ('2025-07-01', '2025-09-01')), 0, 'reactivations are not new logos, so those months have no CAC row');

-- ---------- refunds do not touch MRR ----------
select lives_ok($$ insert into public.billing_events (stripe_event_id, event_type, payload)
  values ('ev_metrics_refund', 'charge.refunded', '{"data":{"object":{"id":"ch_x","amount_refunded":5000,"currency":"usd"}}}') $$, 'a refund event is stored');
select is((select count(*)::int from public.subscription_facts), 20, 'a refund adds no subscription fact');
select is((select mrr_cents from public.metrics_mrr_monthly_v where month = '2025-01-01' and currency = 'usd'), 40000::bigint, 'a refund does not change MRR');

-- ---------- data health ----------
select is((select history_start::text from public.metrics_data_health_v), '2025-01-10 09:00:00+00', 'history start is reported');
select is((select spend_rows::int || '/' || gross_margin_months::int from public.metrics_data_health_v), '6/2', 'spend rows and months with a real margin are counted (0 bp excluded)');

-- ---------- staff access ----------
select pg_temp.act_as(pg_temp.u(1));
select throws_ok($$ select public.staff_metrics_saas('2025-01-01', '2025-12-31') $$, '42501', null, 'a tenant cannot run the report');

select pg_temp.act_as(pg_temp.u(10));
select is(jsonb_array_length(public.staff_metrics_saas('2025-01-01', '2025-03-31') -> 'mrr') > 0, true, 'staff gets MRR rows');
select throws_ok($$ select public.staff_metrics_saas('2025-12-31', '2025-01-01') $$, '22023', null, 'inverted range is rejected');

select * from finish();
rollback;
