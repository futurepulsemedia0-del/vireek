-- Nexus tracker: ledger ingestion rules, dedupe, append-only, RLS/privileges, staff gating, windows, audit (pgTAP).
-- Run with:  supabase test db
-- Needs migration 20290304000000_nexus_tracker.sql (and billing_events, is_vireek_staff, staff_audit_log).
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'tenant@acme.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '90 days', false),
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '90 days', true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.act_as(uuid) to public;

-- helper: build a Stripe-shaped invoice event payload
create or replace function pg_temp.inv(p_id text, p_amount bigint, p_cur text, p_addr jsonb, p_paid timestamptz, p_extra jsonb default '{}'::jsonb, p_live boolean default true)
returns jsonb language sql as $$
  select jsonb_build_object(
    'livemode', p_live,
    'created', extract(epoch from p_paid)::bigint,
    'data', jsonb_build_object('object', jsonb_strip_nulls(jsonb_build_object(
      'id', p_id, 'customer', 'cus_x', 'amount_paid', p_amount, 'currency', p_cur,
      'customer_address', p_addr,
      'status_transitions', jsonb_build_object('paid_at', extract(epoch from p_paid)::bigint)
    )) || p_extra));
$$;

-- ---------- fixtures (inserting into billing_events fires the ingest trigger) ----------
insert into public.billing_events (stripe_event_id, event_type, payload) values
  ('ev1',  'invoice.paid',              pg_temp.inv('in_1', 10000, 'usd', '{"country":"US","state":"CA"}', '2028-03-10 12:00+00', '{"tax":800}')),
  ('ev1b', 'invoice.payment_succeeded', pg_temp.inv('in_1', 10000, 'usd', '{"country":"US","state":"CA"}', '2028-03-10 12:00+00', '{"tax":800}')),
  ('ev2',  'invoice.paid',              pg_temp.inv('in_2', 2000,  'usd', '{"country":"US","state":"California"}', '2028-03-11 12:00+00')),
  ('ev3',  'invoice.paid',              pg_temp.inv('in_3', 3000,  'gbp', '{"country":"GB","state":"ENG"}', '2028-03-12 12:00+00')),
  ('ev4',  'invoice.paid',              pg_temp.inv('in_4', 4000,  'usd', null, '2028-03-13 12:00+00')),
  ('ev5',  'invoice.paid',              pg_temp.inv('in_5', 5000,  'usd', '{"country":"US","state":"TX"}', '2028-03-14 12:00+00', '{}', false)),
  ('ev6',  'invoice.paid',              pg_temp.inv('in_6', 0,     'usd', '{"country":"US","state":"TX"}', '2028-03-15 12:00+00')),
  ('ev7',  'invoice.payment_failed',    pg_temp.inv('in_7', 7000,  'usd', '{"country":"US","state":"TX"}', '2028-03-16 12:00+00')),
  ('ev9',  'invoice.paid',              pg_temp.inv('in_9', 9000,  'eur', '{"country":"DE"}', '2028-03-17 12:00+00', '{"total_taxes":[{"amount":1500},{"amount":400}]}')),
  ('ev10', 'invoice.paid',              pg_temp.inv('in_10', 5000, 'usd', '{"country":"US","state":"NY"}', '2027-11-01 12:00+00')),
  ('ev11', 'invoice.paid',              pg_temp.inv('in_11', 6000, 'usd', '{"country":"US","state":"TX"}', '2026-01-01 12:00+00'));

-- ---------- ingestion rules ----------
select is((select count(*)::int from public.nexus_revenue_facts), 7, 'only live, paid, positive invoices of the two paid event types are ingested');
select is((select count(*)::int from public.nexus_revenue_facts where stripe_invoice_id = 'in_1'), 1, 'invoice.paid + invoice.payment_succeeded for one invoice count once');
select is((select tax_cents::int from public.nexus_revenue_facts where stripe_invoice_id = 'in_9'), 1900, 'tax falls back to the sum of total_taxes[].amount');
select is((select address_status || ':' || coalesce(state, 'null') from public.nexus_revenue_facts where stripe_invoice_id = 'in_2'), 'us_state_unresolved:null', 'US state that is not a 2-letter code is never guessed');
select is((select address_status || ':' || coalesce(country, 'null') from public.nexus_revenue_facts where stripe_invoice_id = 'in_4'), 'no_address:null', 'missing billing address is kept as unattributed, not guessed');
select is((select coalesce(state, 'null') from public.nexus_revenue_facts where stripe_invoice_id = 'in_3'), 'null', 'non-US state is not stored');
select is((select count(*)::int from public.nexus_revenue_facts where stripe_invoice_id in ('in_5', 'in_6', 'in_7')), 0, 'test-mode, zero-amount and non-paid events are ignored');
select lives_ok($$ insert into public.billing_events (stripe_event_id, event_type, payload) values ('ev8', 'invoice.paid', '{"data":{"object":"x"}}'::jsonb) $$, 'a malformed payload can never fail the webhook insert');
select throws_ok($$ update public.nexus_revenue_facts set gross_cents = 1 where stripe_invoice_id = 'in_1' $$, '42501', null, 'ledger is append-only (update)');
select throws_ok($$ delete from public.nexus_revenue_facts where stripe_invoice_id = 'in_1' $$, '42501', null, 'ledger is append-only (delete)');
select is((select nexus_backfill()), 0, 'backfill is idempotent: replaying history adds nothing');

-- ---------- RLS / privileges ----------
select is((select relrowsecurity from pg_class where oid = 'public.nexus_revenue_facts'::regclass), true, 'RLS is enabled on the ledger');
select is(has_table_privilege('authenticated', 'public.nexus_revenue_facts', 'select'), false, 'authenticated has no table privilege');
select is(has_function_privilege('anon', 'public.staff_nexus_revenue(date)', 'execute'), false, 'anon cannot execute the staff RPC');
select is(has_function_privilege('authenticated', 'public.nexus_backfill()', 'execute'), false, 'authenticated cannot run the service-only backfill');

-- ---------- tenant (non-staff) ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.staff_nexus_revenue(null) $$, '42501', null, 'tenant cannot read the nexus report');
select throws_ok($$ select * from public.nexus_revenue_facts $$, '42501', null, 'tenant cannot read the ledger directly');
select throws_ok($$ select public.staff_nexus_log_export(5) $$, '42501', null, 'tenant cannot write export audit rows');
reset role;

-- ---------- staff ----------
-- Claims stay set after `reset role`, so auth.uid() is the staff user while the temp table is created with full privileges.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
reset role;
create temp table t_report as select public.staff_nexus_revenue('2028-06-30') as r;
select is((select (e->'windows'->'rolling_12m'->>'gross_cents')::int from t_report, jsonb_array_elements(r->'rows') e where e->>'country' = 'US' and e->>'state' = 'CA'), 10000, 'rolling 12m gross for US-CA');
select is((select (e->'windows'->'rolling_12m'->>'tax_cents')::int from t_report, jsonb_array_elements(r->'rows') e where e->>'country' = 'US' and e->>'state' = 'CA'), 800, 'tax is reported separately');
select is((select (e->'windows'->'calendar_year'->>'gross_cents')::int + (e->'windows'->'prior_calendar_year'->>'gross_cents')::int from t_report, jsonb_array_elements(r->'rows') e where e->>'country' = 'US' and e->>'state' = 'NY'), 5000, 'NY sale from last year is in prior_calendar_year, not calendar_year');
select is((select count(*)::int from t_report, jsonb_array_elements(r->'rows') e where e->>'state' = 'TX'), 0, 'sales older than the windows are not returned');
select is((select r->'coverage'->>'billing_invoices_seen' from t_report), (select r->'coverage'->>'ledger_invoices' from t_report), 'coverage reconciles: invoices seen in billing_events = invoices in ledger');
select throws_ok($$ select public.staff_nexus_revenue(current_date + 5) $$, '22023', null, 'a future as-of date is rejected');
select lives_ok($$ select public.staff_nexus_log_export(12) $$, 'staff can record a CSV export');

-- ---------- audit ----------
select is((select count(*)::int from public.staff_audit_log where metadata ->> 'view' = 'nexus_tracker' and staff_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'reading the report is audit-logged once (deduped per minute)');
select is((select (metadata ->> 'rows')::int from public.staff_audit_log where metadata ->> 'view' = 'nexus_export' limit 1), 12, 'the export is audit-logged with its row count');

select * from finish();
rollback;
