-- Offboarding + win-back: consent, 2-message cap, claim ordering, at-most-once delivery, unsubscribe,
-- reactivation attribution, RLS isolation, append-only trail and staff-only RPCs (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- ---- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1@test.dev'),
  ('00000000-0000-0000-0000-0000000000c2', 'c2@test.dev'),
  ('00000000-0000-0000-0000-0000000000c3', 'c3@test.dev'),
  ('00000000-0000-0000-0000-0000000000d1', 'admin@test.dev'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff@test.dev');
insert into profiles (id, email, role, is_staff, status, subscription_status) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1@test.dev', 'owner', false, 'suspended', 'suspended'),
  ('00000000-0000-0000-0000-0000000000c2', 'c2@test.dev', 'owner', false, 'suspended', 'suspended'),
  ('00000000-0000-0000-0000-0000000000c3', 'c3@test.dev', 'owner', false, 'suspended', 'suspended'),
  ('00000000-0000-0000-0000-0000000000d1', 'admin@test.dev', 'admin', false, 'active', 'active'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff@test.dev', 'owner', true, 'active', 'active');

select set_config('request.jwt.claim.sub', '', true);

-- ---- 1. open case: idempotent per open case ------------------------------------
select isnt(public.offboarding_open_case('00000000-0000-0000-0000-0000000000c1', 'too_expensive', 'professional', now() + interval '10 days'), null, 'case opened');
select public.offboarding_open_case('00000000-0000-0000-0000-0000000000c1', 'too_expensive', 'professional', now() + interval '12 days');
select is((select count(*)::int from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'a second cancellation call does not create a second open case');
select is((select count(*)::int from winback_events where event = 'case_opened' and user_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'case_opened is logged once');

-- ---- 2. consent needs the kill switch on, an owner, and an open case -------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
set local role authenticated;
select throws_ok($$select public.offboarding_set_winback_consent(true)$$, 'P0001', null::text, 'opt-in is refused while win-back is disabled');
reset role;

update offboarding_settings set winback_enabled = true;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;
select throws_ok($$select public.offboarding_set_winback_consent(true)$$, '42501', null::text, 'a non-owner cannot consent on behalf of the account');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
set local role authenticated;
select throws_ok($$select public.offboarding_set_winback_consent(true)$$, 'P0002', null::text, 'opt-in without an open case is refused');
reset role;

-- ---- 3. opt-in creates exactly two messages; the cap is a database constraint -----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
set local role authenticated;
select lives_ok($$select public.offboarding_set_winback_consent(true)$$, 'owner opts in');
select is((select (public.offboarding_my_case() ->> 'winback_opted_in')::boolean), true, 'case reports the opt-in');
reset role;
select is((select count(*)::int from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c1'), 2, 'exactly two messages scheduled');
select is((select (scheduled_for > now() + interval '10 days') from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c1' and m.seq = 1), true, 'message 1 is scheduled after access ends, never before');
select throws_ok($$insert into winback_messages (case_id, seq, scheduled_for) select id, 3, now() from offboarding_cases limit 1$$, '23514', null::text, 'a third message is rejected by the CHECK');
select throws_ok($$insert into winback_messages (case_id, seq, scheduled_for) select id, 1, now() from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c1'$$, '23505', null::text, 'a duplicate sequence number is rejected by the UNIQUE');
select is((select count(*)::int from winback_events where event = 'opted_in' and user_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'opt-in is in the funnel log');

-- ---- 4. tenant isolation + no client writes ----------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
set local role authenticated;
select is((select count(*)::int from offboarding_cases), 0, 'another account sees none of the cases');
select is(public.offboarding_my_case(), null, 'another account gets no case from the RPC');
select throws_ok($$insert into offboarding_cases (user_id, access_ends_at) values ('00000000-0000-0000-0000-0000000000c3', now())$$, '42501', null::text, 'clients cannot insert cases');
select throws_ok($$select public.winback_claim_due(5)$$, '42501', null::text, 'claim is service-role only');
select throws_ok($$select public.winback_unsubscribe(gen_random_uuid())$$, '42501', null::text, 'unsubscribe RPC is service-role only');
reset role;
set local role anon;
select throws_ok($$select public.offboarding_my_case()$$, '42501', null::text, 'anonymous callers cannot call owner RPCs');
reset role;

-- ---- 5. claim ordering: nothing before the case has ended, seq 2 only after seq 1 sent ----
update winback_messages set scheduled_for = now() - interval '1 hour' where case_id in (select id from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.winback_claim_due(10)), 0, 'nothing is claimed while the cancellation is still running');

update offboarding_cases set access_ends_at = now() - interval '2 days' where user_id = '00000000-0000-0000-0000-0000000000c1';
select is((select (public.offboarding_reconcile() ->> 'ended')::int), 1, 'reconcile ends the case once access is over');

update offboarding_settings set winback_enabled = false;
select is((select count(*)::int from public.winback_claim_due(10)), 0, 'kill switch off => nothing is claimed');
update offboarding_settings set winback_enabled = true;

select is((select array_agg(seq order by seq) from public.winback_claim_due(10)), array[1]::smallint[], 'only message 1 is claimable first');
select is((select count(*)::int from public.winback_claim_due(10)), 0, 'a claimed message is never claimed twice (no concurrent double send)');

select public.winback_finish((select id from winback_messages where seq = 1 and status = 'sending'), 'sent');
select is((select array_agg(seq order by seq) from public.winback_claim_due(10)), array[2]::smallint[], 'message 2 becomes claimable only after message 1 was sent');
select public.winback_finish((select id from winback_messages where seq = 2 and status = 'sending'), 'sent');
select is((select count(*)::int from winback_messages where status = 'sent'), 2, 'both messages are recorded as sent, no more can exist');

-- ---- 6. reactivation attribution ---------------------------------------------------
update profiles set status = 'active', subscription_status = 'active' where id = '00000000-0000-0000-0000-0000000000c1';
select is((select (public.offboarding_reconcile() ->> 'reactivated')::int), 1, 'reconcile marks the returning account');
select is((select attributed_seq from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c1'), 2::smallint, 'a return inside the window is credited to the last sent message');

-- ---- 7. unsubscribe: idempotent, cancels everything unsent ---------------------------
select public.offboarding_open_case('00000000-0000-0000-0000-0000000000c2', 'other', 'starter', now() - interval '1 day');
select public.offboarding_reconcile();
insert into winback_messages (case_id, seq, scheduled_for) select id, 1, now() - interval '1 minute' from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c2';
update offboarding_cases set winback_consent_at = now(), winback_consent_version = 'winback-v1' where user_id = '00000000-0000-0000-0000-0000000000c2';
select is(public.winback_unsubscribe((select unsubscribe_token from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c2')), true, 'unsubscribe by token works');
select is(public.winback_unsubscribe((select unsubscribe_token from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c2')), true, 'unsubscribe is idempotent');
select is((select count(*)::int from winback_events where event = 'unsubscribed' and user_id = '00000000-0000-0000-0000-0000000000c2'), 1, 'only one unsubscribed event is logged');
select is((select m.status from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c2' and m.seq = 1), 'cancelled', 'the unsent message is cancelled');
select is(public.winback_unsubscribe(gen_random_uuid()), false, 'an unknown token changes nothing');

-- ---- 8. failure handling -----------------------------------------------------------------------
select public.offboarding_open_case('00000000-0000-0000-0000-0000000000c3', 'switching', 'starter', now() - interval '1 day');
select public.offboarding_reconcile();
update offboarding_cases set winback_consent_at = now() where user_id = '00000000-0000-0000-0000-0000000000c3';
insert into winback_messages (case_id, seq, scheduled_for) select id, 1, now() - interval '1 minute' from offboarding_cases where user_id = '00000000-0000-0000-0000-0000000000c3';
select count(*) from public.winback_claim_due(10);
select public.winback_finish((select m.id from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c3'), 'failed', 'provider 500');
select is((select m.status from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c3'), 'scheduled', 'a known provider failure is retried');
update winback_messages set attempts = 2 where status = 'scheduled';
select count(*) from public.winback_claim_due(10);
select public.winback_finish((select m.id from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c3'), 'failed', 'provider 500');
select is((select m.status from winback_messages m join offboarding_cases c on c.id = m.case_id where c.user_id = '00000000-0000-0000-0000-0000000000c3'), 'failed', 'after 3 attempts the message stays failed');
select throws_ok($$select public.winback_finish(gen_random_uuid(), 'bogus')$$, '22023', null::text, 'unknown outcome is rejected');

-- ---- 9. append-only trail -------------------------------------------------------------------------
select throws_ok($$update winback_events set event = 'sent'$$, '42501', null::text, 'events cannot be updated');
select throws_ok($$delete from winback_events$$, '42501', null::text, 'events cannot be deleted');

-- ---- 10. staff-only overview and audited settings ----------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
set local role authenticated;
select throws_ok($$select public.staff_offboarding_overview(30)$$, '42501', null::text, 'non-staff cannot read the overview');
select throws_ok($$select public.staff_offboarding_update_settings(true, 7, 30, 30)$$, '42501', null::text, 'non-staff cannot change settings');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select cmp_ok((select (public.staff_offboarding_overview(30) -> 'funnel' ->> 'cases')::int), '>=', 3, 'staff see the funnel');
select lives_ok($$select public.staff_offboarding_update_settings(false, 10, 40, 20)$$, 'staff can change settings');
reset role;
select is((select count(*)::int from audit_log where action = 'offboarding_settings_updated'), 1, 'the settings change is audited');

select * from finish();
rollback;
