-- PCI pay-by-phone: DB-level invariants (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner');

-- ---- scrubbing triggers ----
select is(public.pci_redact_text('card 4111 1111 1111 1111 ok'), 'card [REDACTED-CARD] ok', 'Luhn-valid PAN redacted');
select is(public.pci_redact_text('call 555 123 4567 order 1761000000000'), 'call 555 123 4567 order 1761000000000', 'phones/timestamps untouched');
select ok(public.pci_redact_text('the cvv is 123 thanks') like '%[REDACTED-CVV]%', 'cvv redacted');

insert into public.calls (id, user_id, transcript, summary) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'my card is 4111-1111-1111-1111', 'paid by card 5555555555554444');
select ok((select transcript from public.calls where id = '00000000-0000-0000-0000-0000000000c1') not like '%4111%', 'calls.transcript scrubbed');
select ok((select summary from public.calls where id = '00000000-0000-0000-0000-0000000000c1') not like '%5555%', 'calls.summary scrubbed');
select ok((select pci_spoken_card_detected from public.calls where id = '00000000-0000-0000-0000-0000000000c1'), 'call flagged for audio purge');

insert into public.live_calls (id, last_line_preview) values ('00000000-0000-0000-0000-0000000000d1', 'it is 4111111111111111');
insert into public.live_call_lines (content) values ('number 4111111111111111');
select ok((select last_line_preview from public.live_calls) not like '%4111%', 'live_calls preview scrubbed');
select ok((select content from public.live_call_lines) not like '%4111%', 'live_call_lines scrubbed');

-- ---- sessions ----
insert into public.phone_payment_sessions (id, user_id, vapi_call_id, provider_call_sid, channel, amount_cents, expires_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'v1', 'CA' || repeat('a', 32), 'staff', 12500, now() + interval '10 minutes');

select throws_ok($$update public.phone_payment_sessions set status = 'capturing' where id = '00000000-0000-0000-0000-0000000000f1'$$,
  null, null, 'cannot skip straight to capturing');
update public.phone_payment_sessions set status = 'recording_paused', recording_paused_at = now() where id = '00000000-0000-0000-0000-0000000000f1';
update public.phone_payment_sessions set status = 'capturing' where id = '00000000-0000-0000-0000-0000000000f1';
select is((select status from public.phone_payment_sessions where id = '00000000-0000-0000-0000-0000000000f1'), 'capturing', 'capture allowed after verified pause');
select throws_ok($$insert into public.phone_payment_sessions (user_id, vapi_call_id, provider_call_sid, channel, amount_cents, expires_at, status)
  values ('00000000-0000-0000-0000-0000000000a1', 'v2', 'CA' || repeat('b', 32), 'ai_agent', 5000, now(), 'capturing')$$,
  '23514', null, 'CHECK: capturing requires recording_paused_at');
select throws_ok($$insert into public.phone_payment_sessions (user_id, vapi_call_id, provider_call_sid, channel, amount_cents, expires_at, card_last4)
  values ('00000000-0000-0000-0000-0000000000a1', 'v3', 'CA' || repeat('c', 32), 'staff', 5000, now(), '4111111111111111')$$,
  '23514', null, 'a full card number cannot be stored as last4');
select throws_ok($$insert into public.phone_payment_sessions (user_id, vapi_call_id, provider_call_sid, channel, amount_cents, expires_at)
  values ('00000000-0000-0000-0000-0000000000a1', 'v1', 'CA' || repeat('d', 32), 'staff', 5000, now())$$,
  '23505', null, 'one active session per call');

-- ---- audit chain ----
insert into public.phone_payment_audit_events (session_id, user_id, event_type, actor_type, metadata)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'session_requested', 'staff', '{"amount_cents":12500}'),
       ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'recording_paused', 'system', '{}');
select ok((select valid from public.verify_phone_payment_audit_chain('00000000-0000-0000-0000-0000000000f1')), 'chain verifies');
select throws_ok($$insert into public.phone_payment_audit_events (session_id, user_id, event_type, actor_type, metadata)
  values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'capture_failed', 'provider', '{"reason":"card 4111111111111111"}')$$,
  '23514', null, 'audit trail rejects card data');
select throws_ok($$update public.phone_payment_audit_events set actor_type = 'staff'$$, '23514', null, 'audit rows cannot be updated');
select throws_ok($$delete from public.phone_payment_audit_events$$, '23514', null, 'audit rows cannot be deleted');

select * from finish();
rollback;
