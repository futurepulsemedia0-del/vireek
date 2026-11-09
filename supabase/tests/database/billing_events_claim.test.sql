-- billing_events claim/complete state machine (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is(public.claim_billing_event('evt_test_1', 'invoice.payment_failed', '{}'::jsonb), 'new', 'first delivery is new');
select is(public.claim_billing_event('evt_test_1', 'invoice.payment_failed', '{}'::jsonb), 'in_progress', 'concurrent delivery is in_progress');

select public.complete_billing_event('evt_test_1', 'boom');
select is((select status from public.billing_events where stripe_event_id = 'evt_test_1'), 'failed', 'handler failure is recorded');
select is(public.claim_billing_event('evt_test_1', 'invoice.payment_failed', '{}'::jsonb), 'retry', 'failed event is retried');
select is((select attempts from public.billing_events where stripe_event_id = 'evt_test_1'), 2, 'attempts incremented on retry');

select public.complete_billing_event('evt_test_1', null);
select is(public.claim_billing_event('evt_test_1', 'invoice.payment_failed', '{}'::jsonb), 'duplicate', 'processed event is a duplicate');

select ok(
  not has_function_privilege('authenticated', 'public.claim_billing_event(text,text,jsonb)', 'execute'),
  'authenticated users cannot claim billing events'
);

select * from finish();
rollback;
