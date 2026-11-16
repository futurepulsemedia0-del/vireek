-- Activation funnel: RLS, forgery resistance, idempotency, staff gate (pgTAP). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@act.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@act.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@act.test');
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@act.test', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@act.test', 'owner'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@act.test', 'owner');
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000c1';

select is((select count(*)::int from public.activation_events where event = 'signup' and account_owner_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'signup row created by trigger');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select lives_ok($$select public.record_activation_event('first_test_call')$$, 'owner records a client event');
select lives_ok($$select public.record_activation_event('first_test_call')$$, 'duplicate is a no-op');
select is((select count(*)::int from public.activation_events where event = 'first_test_call'), 1, 'exactly one row after duplicate');
select throws_ok($$select public.record_activation_event('first_invoice_paid')$$, '22023', 'event_not_allowed', 'server-only event cannot be forged by client');
select throws_ok($$insert into public.activation_events (account_owner_id, event) values ('00000000-0000-0000-0000-0000000000a1','first_booking')$$, '42501', null, 'direct insert denied');
select is((select count(*)::int from public.activation_events where account_owner_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'cannot read another tenant');
select throws_ok($$select * from public.staff_activation_funnel(30)$$, '42501', 'forbidden', 'non-staff cannot read funnel');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select ok((select count(*) from public.staff_activation_funnel(30)) = 7, 'staff gets 7 funnel steps');

select * from finish();
rollback;
