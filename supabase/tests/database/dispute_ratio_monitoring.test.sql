-- Dispute-ratio monitoring (20290306000100): denominator rules, thresholds, min-sample guard, platform aggregate,
-- staff gates, alert dedupe + notifications, tenant isolation (RLS), privilege boundaries.
-- NOT executed by the author (no Postgres in the authoring sandbox) — run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000006a1', 'a@dr.test'), ('00000000-0000-0000-0000-0000000006b1', 'b@dr.test'), ('00000000-0000-0000-0000-0000000006c1', 'c@dr.test'),
  ('00000000-0000-0000-0000-0000000006e1', 'staff@dr.test'), ('00000000-0000-0000-0000-0000000006f1', 'stranger@dr.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000006a1', 'owner'), ('00000000-0000-0000-0000-0000000006b1', 'owner'), ('00000000-0000-0000-0000-0000000006c1', 'owner'), ('00000000-0000-0000-0000-0000000006e1', 'owner'), ('00000000-0000-0000-0000-0000000006f1', 'member')
on conflict (id) do update set role = excluded.role;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000006e1';

-- Tenant A, current month: 100 paid card payments (+1 bank, +1 unpaid that must NOT count), 1 dispute -> 1.000%
insert into public.payment_requests (user_id, customer_name, amount, status, paid_at)
  select '00000000-0000-0000-0000-0000000006a1', 'c' || g, 50, 'paid', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '2 days' from generate_series(1, 100) g;
insert into public.payment_requests (user_id, customer_name, amount, status, paid_at, payment_rail)
  values ('00000000-0000-0000-0000-0000000006a1', 'bank', 50, 'paid', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '2 days', 'bank');
insert into public.payment_requests (user_id, customer_name, amount, status)
  values ('00000000-0000-0000-0000-0000000006a1', 'unpaid', 50, 'sent');
insert into public.stripe_disputes (user_id, stripe_dispute_id, amount_cents, status, opened_at)
  values ('00000000-0000-0000-0000-0000000006a1', 'dp_dr_a1', 5000, 'needs_response', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '3 days');
-- Tenant A, previous month: 50 payments, no disputes -> ok
insert into public.payment_requests (user_id, customer_name, amount, status, paid_at)
  select '00000000-0000-0000-0000-0000000006a1', 'p' || g, 50, 'paid', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') - interval '28 days' from generate_series(1, 50) g;

-- Tenant B: 10 payments, 2 disputes -> below the minimum sample
insert into public.payment_requests (user_id, customer_name, amount, status, paid_at)
  select '00000000-0000-0000-0000-0000000006b1', 'b' || g, 50, 'paid', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '2 days' from generate_series(1, 10) g;
insert into public.stripe_disputes (user_id, stripe_dispute_id, amount_cents, status, opened_at)
  values ('00000000-0000-0000-0000-0000000006b1', 'dp_dr_b1', 5000, 'needs_response', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '3 days'),
         ('00000000-0000-0000-0000-0000000006b1', 'dp_dr_b2', 5000, 'needs_response', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '3 days');

-- Tenant C: 400 payments, 2 disputes -> exactly 0.500% = warning
insert into public.payment_requests (user_id, customer_name, amount, status, paid_at)
  select '00000000-0000-0000-0000-0000000006c1', 'k' || g, 50, 'paid', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '2 days' from generate_series(1, 400) g;
insert into public.stripe_disputes (user_id, stripe_dispute_id, amount_cents, status, opened_at)
  values ('00000000-0000-0000-0000-0000000006c1', 'dp_dr_c1', 5000, 'needs_response', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '3 days'),
         ('00000000-0000-0000-0000-0000000006c1', 'dp_dr_c2', 5000, 'needs_response', (date_trunc('month', timezone('UTC', now())) at time zone 'UTC') + interval '3 days');

-- make sure the seeded placeholder thresholds are in place for the assertions
update public.dispute_ratio_thresholds set warning_pct = 0.5, critical_pct = 0.75, min_transactions = 20, verified = false where scope = 'tenant_default';
update public.dispute_ratio_thresholds set warning_pct = 0.5, critical_pct = 0.75, min_transactions = 200, verified = false where scope = 'platform';

-- ---------------------------------------------------------------- tenant view
select is((select txn_count from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006a1' and month = date_trunc('month', timezone('UTC', now()))::date), 100,
  'denominator = paid card payments only (bank rail and unpaid excluded)');
select is((select ratio_pct from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006a1' and month = date_trunc('month', timezone('UTC', now()))::date), 1.000::numeric,
  'ratio = 1 dispute / 100 payments = 1.000%');
select is((select level from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006a1' and month = date_trunc('month', timezone('UTC', now()))::date), 'critical', 'A is critical');
select is((select level from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006b1' and month = date_trunc('month', timezone('UTC', now()))::date), 'insufficient_data', 'B: 10 payments is below the minimum sample');
select is((select level from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006c1' and month = date_trunc('month', timezone('UTC', now()))::date), 'warning', 'C: exactly 0.500% is a warning (inclusive threshold)');
select is((select level from public.dispute_ratio_monthly_v where user_id = '00000000-0000-0000-0000-0000000006a1' and month = (date_trunc('month', timezone('UTC', now())) - interval '1 month')::date), 'ok', 'A previous month is ok');

-- classifier parity with the TypeScript mirror
select is(public.dispute_ratio_level(1, 200, 0.5, 0.75, 20), 'warning', 'level(): 0.50% inclusive');
select is(public.dispute_ratio_level(5, 19, 0.5, 0.75, 20), 'insufficient_data', 'level(): minimum sample guard');

-- ---------------------------------------------------------------- alerts
select is(public.dispute_ratio_check_alerts(), '{"tenant_alerts": 2, "platform_alerts": 1}'::jsonb, 'first run: A critical + C warning + platform critical');
select is(public.dispute_ratio_check_alerts(), '{"tenant_alerts": 0, "platform_alerts": 0}'::jsonb, 'second run is a no-op (dedupe)');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000006a1' and action_url = '/dashboard/disputes'), 1, 'A got exactly one notification');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000006b1'), 0, 'B (insufficient data) got none');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000006e1' and action_url = '/staff/dispute-ratio'), 1, 'staff got the platform alert');

-- ---------------------------------------------------------------- RLS / tenant isolation
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000006a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000006a1","role":"authenticated"}', true);
select is((select count(*)::int from public.dispute_ratio_monthly_v where user_id <> '00000000-0000-0000-0000-0000000006a1'), 0, 'A never sees another tenant''s rows');
select throws_ok($$select * from public.dispute_ratio_platform_monthly(3)$$, '42501', 'forbidden', 'non-staff cannot read the platform aggregate');
select throws_ok($$select public.set_dispute_ratio_thresholds('platform', 1, 2, 10, false)$$, '42501', 'forbidden', 'non-staff cannot change thresholds');
select throws_ok($$select public.dispute_ratio_check_alerts()$$, '42501', null, 'authenticated cannot run the alert job');
select throws_ok($$select * from public.dispute_ratio_alerts$$, '42501', null, 'authenticated cannot read the alert table');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000006f1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000006f1","role":"authenticated"}', true);
select is((select count(*)::int from public.dispute_ratio_monthly_v), 0, 'a user without data sees nothing');

-- ---------------------------------------------------------------- platform aggregate + threshold writer (staff)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000006e1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000006e1","role":"authenticated"}', true);
select is((select ratio_pct from public.dispute_ratio_platform_monthly(3) where month = date_trunc('month', timezone('UTC', now()))::date), 0.980::numeric,
  'platform ratio = 5 disputes / 510 payments = 0.980%');
select throws_ok($$select public.set_dispute_ratio_thresholds('platform', 2, 1, 10, false)$$, '22023', 'invalid_thresholds', 'critical below warning is rejected');
select lives_ok($$select public.set_dispute_ratio_thresholds('platform', 2, 3, 200, true)$$, 'staff can change thresholds');
select is((select level || '/' || thresholds_verified::text from public.dispute_ratio_platform_monthly(3) where month = date_trunc('month', timezone('UTC', now()))::date), 'ok/true',
  'new thresholds take effect immediately and the verified flag persists');
reset role;

select * from finish();
rollback;
