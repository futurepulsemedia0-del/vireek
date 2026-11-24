-- Revenue recognition views (20290307000000): recognised vs deferred revenue from stored Stripe invoice events (pgTAP).
-- Run with:  supabase test db
-- Needs migrations 20281104000000_growth_analytics_phase2.sql (staff helpers) and 20290307000000_revenue_recognition_views.sql.
--
-- Fixture (all dates 2025, UTC, USD unless noted; amounts are Stripe minor units = cents):
--   in_a  monthly sub 10,000, 01 Jan -> 01 Feb, paid 01 Jan. Delivered TWICE (invoice.paid + invoice.payment_succeeded) -> counted once.
--   in_b  annual sub 120,000, 01 Jan 2025 -> 01 Jan 2026 (365 days), paid 01 Jan.   Jan = round(120000*31/365) = 10,192, Feb = 9,205.
--   in_c  annual sub 36,500, 16 Mar 2025 -> 16 Mar 2026 (365 days), paid 16 Mar.     100 cents/day: Mar = 1,600, Apr = 3,000.
--   in_d  renewal: sub line 24,900 (01 Feb -> 01 Mar) + overage line 2,500 (metadata vireek_overage_key, period 01 Jan -> 01 Feb), paid 01 Feb.
--   in_e  metered lines paid 02 Feb: 4,500 on a price mapped to results_based, 700 on an UNMAPPED metered price.
--   in_f  discount + tax: 10,000 - 2,000 discount = 8,000; 11,900 incl. 1,900 inclusive tax = 10,000; 5,000 with 950 EXCLUSIVE tax = 5,000.
--   in_g  late payment: 10,000 for April, paid 10 May -> April 0, May 10,000 (catch-up, deferred never negative).
--   in_h  invoice.payment_succeeded with status 'open' (not paid) and an invoice.created draft -> excluded.
--   in_i  lines.has_more = true (truncated)         in_j  total_excluding_tax disagrees with the lines by 1 cent
--   in_k  two lines the schedule must refuse: period starts in 1970, and a 10-year period
--   in_l  point-in-time line 3,000 on 15 Jun        in_m  EUR monthly 5,000        in_n  malformed lines (amount "abc", a non-object)
--   refunds: charge ch_1 (invoice-linked) 3,000 in Feb then cumulative 5,000 in Mar (inserted out of order); ch_2 (no invoice) 1,000 in Feb.
--   plus one credit_note.created and one invoice.voided event (the health view must report them as present, never as zero).
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000b0001', 'staff@rev.test'),
  ('00000000-0000-0000-0000-0000000b0002', 'tenant@rev.test');
insert into public.profiles (id, is_staff) values
  ('00000000-0000-0000-0000-0000000b0001', true),
  ('00000000-0000-0000-0000-0000000b0002', false)
on conflict (id) do update set is_staff = excluded.is_staff;

-- ---------- fixture helpers (session-local) ----------
create or replace function pg_temp.ep(p text) returns bigint language sql as $$ select extract(epoch from p::timestamptz)::bigint $$;

create or replace function pg_temp.line(
  p_id text, p_amount text, p_start text, p_end text, p_price text, p_usage text default null,
  p_meta jsonb default '{}'::jsonb, p_discount bigint default 0, p_tax jsonb default '[]'::jsonb
) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id,
    'amount', case when p_amount ~ '^-?[0-9]+$' then to_jsonb(p_amount::bigint) else to_jsonb(p_amount) end,
    'period', case when p_start is null then null else jsonb_build_object('start', pg_temp.ep(p_start), 'end', pg_temp.ep(p_end)) end,
    'price', jsonb_build_object('id', p_price, 'recurring', case when p_usage is null then jsonb_build_object('interval', 'month') else jsonb_build_object('usage_type', p_usage) end),
    'metadata', p_meta,
    'discount_amounts', case when p_discount > 0 then jsonb_build_array(jsonb_build_object('amount', p_discount)) else '[]'::jsonb end,
    'tax_amounts', p_tax,
    'proration', false));
$$;

create or replace function pg_temp.put_invoice(
  p_evt text, p_type text, p_invoice text, p_status text, p_cur text, p_paid text, p_lines jsonb,
  p_total_ex bigint default null, p_has_more boolean default false
) returns void language sql as $$
  insert into public.billing_events (stripe_event_id, event_type, payload)
  values (p_evt, p_type, jsonb_build_object(
    'id', p_evt, 'type', p_type, 'created', pg_temp.ep(p_paid),
    'data', jsonb_build_object('object', jsonb_strip_nulls(jsonb_build_object(
      'id', p_invoice, 'status', p_status, 'currency', p_cur, 'customer', 'cus_rev_1', 'billing_reason', 'subscription_cycle',
      'total_excluding_tax', p_total_ex,
      'status_transitions', jsonb_build_object('paid_at', pg_temp.ep(p_paid)),
      'lines', jsonb_build_object('has_more', p_has_more, 'data', p_lines))))));
$$;

select pg_temp.put_invoice('ev_a1', 'invoice.payment_succeeded', 'in_a', 'paid', 'usd', '2025-01-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_a', '10000', '2025-01-01 00:00+00', '2025-02-01 00:00+00', 'price_sub_m')), 10000);
select pg_temp.put_invoice('ev_a2', 'invoice.paid', 'in_a', 'paid', 'usd', '2025-01-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_a', '10000', '2025-01-01 00:00+00', '2025-02-01 00:00+00', 'price_sub_m')), 10000);
select pg_temp.put_invoice('ev_b', 'invoice.payment_succeeded', 'in_b', 'paid', 'usd', '2025-01-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_b', '120000', '2025-01-01 00:00+00', '2026-01-01 00:00+00', 'price_sub_y')), 120000);
select pg_temp.put_invoice('ev_c', 'invoice.payment_succeeded', 'in_c', 'paid', 'usd', '2025-03-16 00:00+00',
  jsonb_build_array(pg_temp.line('li_c', '36500', '2025-03-16 00:00+00', '2026-03-16 00:00+00', 'price_sub_y')), 36500);
select pg_temp.put_invoice('ev_d', 'invoice.payment_succeeded', 'in_d', 'paid', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(
    pg_temp.line('li_d_sub', '24900', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m'),
    pg_temp.line('li_d_ovg', '2500', '2025-01-01 00:00+00', '2025-02-01 00:00+00', null, null, '{"vireek_overage_key":"overage:u1:2025-01"}')), 27400);
select pg_temp.put_invoice('ev_e', 'invoice.payment_succeeded', 'in_e', 'paid', 'usd', '2025-02-02 00:00+00',
  jsonb_build_array(
    pg_temp.line('li_e_res', '4500', '2025-01-01 00:00+00', '2025-02-01 00:00+00', 'price_results_m', 'metered'),
    pg_temp.line('li_e_oth', '700', '2025-01-01 00:00+00', '2025-02-01 00:00+00', 'price_other_metered', 'metered')), 5200);
select pg_temp.put_invoice('ev_f', 'invoice.payment_succeeded', 'in_f', 'paid', 'usd', '2025-03-01 00:00+00',
  jsonb_build_array(
    pg_temp.line('li_f_disc', '10000', '2025-03-01 00:00+00', '2025-04-01 00:00+00', 'price_sub_m', null, '{}', 2000),
    pg_temp.line('li_f_incl', '11900', '2025-03-01 00:00+00', '2025-04-01 00:00+00', 'price_sub_m', null, '{}', 0, '[{"amount":1900,"inclusive":true}]'),
    pg_temp.line('li_f_excl', '5000', '2025-03-01 00:00+00', '2025-04-01 00:00+00', 'price_sub_m', null, '{}', 0, '[{"amount":950,"inclusive":false}]')), 23000);
select pg_temp.put_invoice('ev_g', 'invoice.payment_succeeded', 'in_g', 'paid', 'usd', '2025-05-10 00:00+00',
  jsonb_build_array(pg_temp.line('li_g', '10000', '2025-04-01 00:00+00', '2025-05-01 00:00+00', 'price_sub_m')), 10000);
select pg_temp.put_invoice('ev_h1', 'invoice.payment_succeeded', 'in_h', 'open', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_h', '99999', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m')), 99999);
select pg_temp.put_invoice('ev_h2', 'invoice.created', 'in_h2', 'draft', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_h2', '88888', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m')), 88888);
select pg_temp.put_invoice('ev_i', 'invoice.payment_succeeded', 'in_i', 'paid', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_i', '1000', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m')), 1000, true);
select pg_temp.put_invoice('ev_j', 'invoice.payment_succeeded', 'in_j', 'paid', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_j', '10000', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m')), 9999);
select pg_temp.put_invoice('ev_k', 'invoice.payment_succeeded', 'in_k', 'paid', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(
    pg_temp.line('li_k_1970', '500', '1970-01-01 00:00+00', '1970-02-01 00:00+00', 'price_sub_m'),
    pg_temp.line('li_k_long', '600', '2025-02-01 00:00+00', '2035-02-01 00:00+00', 'price_sub_m')), 1100);
select pg_temp.put_invoice('ev_l', 'invoice.payment_succeeded', 'in_l', 'paid', 'usd', '2025-06-15 00:00+00',
  jsonb_build_array(pg_temp.line('li_l', '3000', '2025-06-15 00:00+00', '2025-06-15 00:00+00', 'price_sub_m')), 3000);
select pg_temp.put_invoice('ev_m', 'invoice.payment_succeeded', 'in_m', 'paid', 'eur', '2025-01-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_m', '5000', '2025-01-01 00:00+00', '2025-02-01 00:00+00', 'price_sub_m')), 5000);
select pg_temp.put_invoice('ev_n', 'invoice.payment_succeeded', 'in_n', 'paid', 'usd', '2025-02-01 00:00+00',
  jsonb_build_array(pg_temp.line('li_n_bad', 'abc', '2025-02-01 00:00+00', '2025-03-01 00:00+00', 'price_sub_m'), '5'::jsonb));

-- refunds: out of order on purpose (the later cumulative event is inserted first)
insert into public.billing_events (stripe_event_id, event_type, payload) values
  ('ev_r1b', 'charge.refunded', jsonb_build_object('created', pg_temp.ep('2025-03-05 00:00+00'), 'data', jsonb_build_object('object',
     jsonb_build_object('id', 'ch_1', 'currency', 'usd', 'amount_refunded', 5000, 'invoice', 'in_b')))),
  ('ev_r1a', 'charge.refunded', jsonb_build_object('created', pg_temp.ep('2025-02-10 00:00+00'), 'data', jsonb_build_object('object',
     jsonb_build_object('id', 'ch_1', 'currency', 'usd', 'amount_refunded', 3000, 'invoice', 'in_b')))),
  ('ev_r2', 'charge.refunded', jsonb_build_object('created', pg_temp.ep('2025-02-12 00:00+00'), 'data', jsonb_build_object('object',
     jsonb_build_object('id', 'ch_2', 'currency', 'usd', 'amount_refunded', 1000, 'invoice', null)))),
  ('ev_cn', 'credit_note.created', '{"data":{"object":{"id":"cn_1"}}}'::jsonb),
  ('ev_void', 'invoice.voided', '{"data":{"object":{"id":"in_void"}}}'::jsonb);

-- mapping: only the Results Plan price is known to SQL
insert into public.revenue_price_stream_map (stripe_price_id, stream, note) values ('price_results_m', 'results_based', 'fixture');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------- structure and access ----------
select has_view('public', 'revenue_recognition_monthly_v', 'monthly view exists');
select has_function('public', 'staff_revenue_recognition', array['date', 'date'], 'staff report exists');
select is(has_table_privilege('anon', 'public.revenue_recognition_monthly_v', 'SELECT'), false, 'anon cannot read the monthly view');
select is(has_table_privilege('authenticated', 'public.revenue_recognition_monthly_v', 'SELECT'), false, 'tenants cannot read the monthly view');
select is(has_table_privilege('authenticated', 'public.revenue_paid_invoices_v', 'SELECT'), false, 'tenants cannot read raw invoice payloads');
select is(has_table_privilege('authenticated', 'public.revenue_price_stream_map', 'SELECT'), false, 'tenants cannot read the stream map');
select is(has_function_privilege('anon', 'public.staff_revenue_recognition(date, date)', 'EXECUTE'), false, 'anon cannot run the report');

-- ---------- only paid invoices, each once ----------
select is((select count(*)::int from public.revenue_paid_invoices_v), 13, '13 paid invoices (double delivery collapsed; open + draft excluded)');
select is((select count(*)::int from public.revenue_paid_invoices_v where invoice_id = 'in_a'), 1, 'in_a delivered twice is one invoice');
select is((select count(*)::int from public.revenue_invoice_lines_v where invoice_id = 'in_a'), 1, 'in_a has one line, not two');
select is((select count(*)::int from public.revenue_paid_invoices_v where invoice_id in ('in_h', 'in_h2')), 0, 'unpaid status and draft invoices never count');

-- ---------- net amount maths ----------
select is((select net_cents from public.revenue_invoice_lines_v where line_id = 'li_f_disc'), 8000::bigint, 'discount is deducted');
select is((select net_cents from public.revenue_invoice_lines_v where line_id = 'li_f_incl'), 10000::bigint, 'tax INCLUDED in the price is deducted');
select is((select net_cents from public.revenue_invoice_lines_v where line_id = 'li_f_excl'), 5000::bigint, 'tax ADDED on top is not part of the line amount');

-- ---------- classification ----------
select is((select stream from public.revenue_invoice_lines_v where line_id = 'li_d_ovg'), 'usage_overage', 'overage marker -> usage_overage');
select is((select stream from public.revenue_invoice_lines_v where line_id = 'li_e_res'), 'results_based', 'mapped metered price -> results_based');
select is((select stream from public.revenue_invoice_lines_v where line_id = 'li_e_oth'), 'metered_unmapped', 'unmapped metered price is surfaced, not guessed');
select is((select stream from public.revenue_invoice_lines_v where line_id = 'li_a'), 'subscription', 'ordinary recurring line -> subscription');

-- ---------- ratable recognition ----------
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_a' and month = '2025-01-01'), 10000::bigint, 'monthly sub fully recognised in its month');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_b' and month = '2025-01-01'), 10192::bigint, 'annual: January = round(120000 x 31/365)');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_b' and month = '2025-02-01'), 9205::bigint, 'annual: February is the difference of cumulatives');
select is((select deferred_end_cents from public.revenue_recognition_schedule_v where line_id = 'li_b' and month = '2025-01-01'), 109808::bigint, 'annual: deferred at end of January');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_c' and month = '2025-03-01'), 1600::bigint, 'mid-month start: 16 of 365 days');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_c' and month = '2025-04-01'), 3000::bigint, 'mid-month start: April = 30 days');
select is((select count(*)::int from (
    select line_id, max(net_cents) as net, sum(recognised_cents) as rec from public.revenue_recognition_schedule_v group by line_id
  ) t where rec <> net), 0, 'months add up to the net amount for every line (no rounding drift)');

-- ---------- payment timing ----------
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_g' and month = '2025-04-01'), 0::bigint, 'late payment: nothing recognised before the payment month');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_g' and month = '2025-05-01'), 10000::bigint, 'late payment: elapsed service caught up in the payment month');
select is((select count(*)::int from public.revenue_recognition_monthly_v where deferred_close_cents < 0), 0, 'deferred revenue is never negative');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_d_ovg' and month = '2025-01-01'), 0::bigint, 'overage for January is not recognised in January (billed in arrears)');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_d_ovg' and month = '2025-02-01'), 2500::bigint, 'overage is recognised in the month it was paid');
select is((select recognised_cents from public.revenue_recognition_schedule_v where line_id = 'li_l' and month = '2025-06-01'), 3000::bigint, 'point-in-time line is recognised in full in its month');

-- ---------- monthly roll-forward ----------
select is((select recognised_cents from public.revenue_recognition_monthly_v where month = '2025-01-01' and currency = 'usd' and stream = 'subscription'), 20192::bigint, 'Jan subscription recognised = 10,000 + 10,192');
select is((select billed_cents from public.revenue_recognition_monthly_v where month = '2025-01-01' and currency = 'usd' and stream = 'subscription'), 130000::bigint, 'Jan subscription billed = 10,000 + 120,000');
select is((select recognised_cents from public.revenue_recognition_monthly_v where month = '2025-03-01' and currency = 'usd' and stream = 'subscription'), 34792::bigint, 'Mar subscription recognised');
select is((select deferred_close_cents from public.revenue_recognition_monthly_v where month = '2025-03-01' and currency = 'usd' and stream = 'subscription'), 125311::bigint, 'Mar deferred close = billed to date 214,400 - recognised to date 89,089');
select is((select count(*)::int from (
    select month, open_c, lag(close_c) over (partition by currency, stream order by month) as prev_close, lag(month) over (partition by currency, stream order by month) as prev_month
    from (select month, currency, stream, deferred_open_cents as open_c, deferred_close_cents as close_c from public.revenue_recognition_monthly_v) q
  ) z where prev_month = (month - interval '1 month')::date and open_c <> prev_close), 0, 'opening deferred equals the previous closing deferred');
select is((select recognised_cents from public.revenue_recognition_monthly_v where month = '2025-01-01' and currency = 'eur'), 5000::bigint, 'EUR is its own series, never added to USD');
select is((select count(*)::int from public.revenue_recognition_monthly_v where is_partial and month < '2026-01-01'), 0, 'past months are not partial');

-- ---------- exclusions and malformed data never abort the report ----------
select is((select count(*)::int from public.revenue_invoice_lines_v where exclusion_reason is not null), 3, 'three unusable lines are excluded (1970 period, 10-year period, amount "abc")');
select is((select count(*)::int from public.revenue_recognition_schedule_v where invoice_id in ('in_k', 'in_n')), 0, 'excluded lines never reach the schedule');
select is((select invoices_lines_truncated::int from public.revenue_data_health_v), 1, 'health: truncated line list reported');
select is((select invoices_mismatch::int from public.revenue_data_health_v), 1, 'health: one invoice disagrees with its own total by 1 cent');
select is((select invoices_reconciled::int from public.revenue_data_health_v), 10, 'health: ten invoices reconcile to total_excluding_tax');
select is((select invoices_reconciliation_unavailable::int from public.revenue_data_health_v), 1, 'health: a missing total is "unavailable", not a pass');
select is((select credit_note_events::int || '/' || void_or_uncollectible_events::int || '/' || lines_metered_unmapped::int from public.revenue_data_health_v), '1/1/1', 'health: credit notes, voids and unmapped metered lines are visible');

-- ---------- refunds ----------
select is((select refunds_invoice_cents from public.revenue_refunds_monthly_v where month = '2025-02-01' and currency = 'usd'), 3000::bigint, 'Feb invoice refund = first cumulative amount');
select is((select refunds_invoice_cents from public.revenue_refunds_monthly_v where month = '2025-03-01' and currency = 'usd'), 2000::bigint, 'Mar refund = delta of the cumulative amount (out-of-order delivery)');
select is((select refunds_unlinked_cents from public.revenue_refunds_monthly_v where month = '2025-02-01' and currency = 'usd'), 1000::bigint, 'refund with no invoice is reported separately');

-- ---------- staff access ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000b0002');
select throws_ok($$ select public.staff_revenue_recognition('2025-01-01', '2025-12-31') $$, '42501', null, 'a tenant cannot run the report');
select throws_ok($$ select public.staff_revenue_stream_map_set('price_x', 'results_based', null) $$, '42501', null, 'a tenant cannot change the stream map');

select pg_temp.act_as('00000000-0000-0000-0000-0000000b0001');
select is(jsonb_array_length(public.staff_revenue_recognition('2025-01-01', '2025-03-31') -> 'monthly') > 0, true, 'staff gets monthly rows');
select throws_ok($$ select public.staff_revenue_recognition('2025-12-31', '2025-01-01') $$, '22023', null, 'inverted range is rejected');
select throws_ok($$ select public.staff_revenue_stream_map_set('not-a-price', 'results_based', null) $$, '22023', null, 'invalid price id is rejected');
select throws_ok($$ select public.staff_revenue_stream_map_set('price_ok', 'free_money', null) $$, '22023', null, 'unknown stream is rejected');

select * from finish();
rollback;
