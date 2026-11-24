-- Homeowner payment protection (20290312000100). NOT executed by the author (no Postgres in the authoring sandbox).
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000e001', 'pp-owner@test.invalid');
insert into public.profiles (id) values ('00000000-0000-0000-0000-00000000e001') on conflict (id) do nothing;
insert into public.jobs (id, user_id, customer_name) values
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e001', 'Test Homeowner'),
  ('00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000e001', 'Second Homeowner');

-- fail-closed controls
select is(public.pp_is_enabled(), false, 'disabled by default');
select throws_ok($$update public.payment_protection_controls set enabled = true$$, '23514', null, 'cannot enable without licensing ref, max amount and release window');
select is((select enabled from public.feature_flags where key = 'homeowner_payment_protection'), false, 'client flag defaults OFF');

insert into public.payment_protection_holds (id, user_id, job_id, amount_cents, stripe_account_id)
values ('00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', 10000, 'acct_test');

-- one live hold per job
select throws_ok($$insert into public.payment_protection_holds (user_id, job_id, amount_cents, stripe_account_id)
  values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', 500, 'acct_test')$$, '23505', null, 'second live hold for the same job is refused');

-- happy path
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'send_request', 'contractor', null, 'send')->>'state', 'awaiting_authorization', 'draft -> awaiting_authorization');
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'authorized', 'homeowner', null, 'authorized',
  jsonb_build_object('payment_intent_id', 'pi_test', 'capture_before', now() + interval '5 days'))->>'state', 'held', 'authorization recorded');
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'authorized', 'homeowner', null, 'authorized')->>'status', 'duplicate', 'same idempotency key is a no-op');
select throws_ok($$select public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'homeowner_confirm', 'homeowner', null, 'x1')$$, 'P0001', null, 'cannot confirm before completion is claimed');
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'claim_completion', 'contractor', null, 'claim')->>'state', 'completion_claimed', 'completion claimed');
select throws_ok($$select public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'auto_release', 'contractor', null, 'x2')$$, 'P0001', null, 'contractor cannot release their own funds');
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'homeowner_confirm', 'homeowner', null, 'confirm')->>'state', 'capturing', 'homeowner confirms -> capturing');
select is((select capture_amount_cents from public.payment_protection_holds where id = '00000000-0000-0000-0000-00000000e201'), 10000::bigint, 'full amount targeted for capture');
select is(public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'capture_succeeded', 'system', null, 'cap', jsonb_build_object('amount_captured_cents', 10000))->>'state', 'released', 'capture recorded -> released');
select throws_ok($$select public.pp_apply_transition('00000000-0000-0000-0000-00000000e201', 'request_void', 'contractor', null, 'x3')$$, 'P0001', null, 'terminal state accepts nothing');

-- dispute path with immutable evidence
insert into public.payment_protection_holds (id, user_id, job_id, amount_cents, stripe_account_id, state, payment_intent_id, capture_before)
values ('00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e102', 5000, 'acct_test', 'held', 'pi_test2', now() + interval '3 days');
select is(public.pp_open_dispute('00000000-0000-0000-0000-00000000e202', 'work_incomplete', 'The unit still does not cool at all.')->>'state', 'disputed', 'homeowner dispute from held');
select is((select length(evidence_sha256) from public.payment_protection_disputes where hold_id = '00000000-0000-0000-0000-00000000e202'), 64, 'evidence snapshot is hashed');
select throws_ok($$update public.payment_protection_disputes set statement = 'edited statement here' where hold_id = '00000000-0000-0000-0000-00000000e202'$$, '42501', null, 'dispute evidence is immutable');
select throws_ok($$update public.payment_protection_events set event = 'tampered'$$, '42501', null, 'events are append-only');

select * from finish();
rollback;
