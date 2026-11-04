-- Voice-agent security controls (pgTAP). Run with:  supabase test db
-- Covers: kill switch, rate limiting, call state, OTP attempt/expiry/replay limits, known-details lockout,
-- confirm-before-write, canaries, immutable hash-chained audit, grants and RLS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@voice-sec.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-voice-sec.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'nobody@voice-sec.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do update set role = excluded.role;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- 64-char digests stand in for HMAC output
create or replace function pg_temp.dg(p text) returns text language sql as $$ select rpad(p, 64, '0') $$;

-- ------------------------------------------------------------- kill switch --
select is(public.voice_get_mode('00000000-0000-0000-0000-0000000000a1'), 'normal', 'default mode is normal');
select public.voice_set_mode('tenant', '00000000-0000-0000-0000-0000000000a1', 'restricted', 'test', null);
select is(public.voice_get_mode('00000000-0000-0000-0000-0000000000a1'), 'restricted', 'tenant restricted');
select is(public.voice_get_mode('00000000-0000-0000-0000-0000000000b1'), 'normal', 'other tenant unaffected');
select public.voice_set_mode('global', null, 'lockdown', 'incident', null);
select is(public.voice_get_mode('00000000-0000-0000-0000-0000000000b1'), 'lockdown', 'global lockdown reaches every tenant');
select is(public.voice_get_mode('00000000-0000-0000-0000-0000000000a1'), 'lockdown', 'most restrictive wins');
select public.voice_set_mode('global', null, 'normal', 'cleared', null);
select throws_ok($$select public.voice_set_mode('tenant', null, 'lockdown', 'x', null)$$, null, 'tenant scope needs user_id', 'tenant scope requires user');
select throws_ok($$select public.voice_set_mode('tenant', '00000000-0000-0000-0000-0000000000a1', 'panic', 'x', null)$$, null, 'invalid scope or mode', 'invalid mode rejected');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.voice_set_my_mode('lockdown', 'owner pressed kill switch')$$, 'owner can use the kill switch');
select is((select mode from public.voice_security_controls where scope = 'tenant'), 'lockdown', 'owner sees own control row');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$select public.voice_set_my_mode('normal', 'x')$$, '42501', 'not allowed', 'non-manager cannot flip the kill switch');
select pg_temp.reset_role();
select public.voice_set_mode('tenant', '00000000-0000-0000-0000-0000000000a1', 'normal', 'reset', null);

-- ----------------------------------------------------------- rate limiting --
select is(public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k1', 2, 3600), true, 'rate 1/2');
select is(public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k1', 2, 3600), true, 'rate 2/2');
select is(public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k1', 2, 3600), false, 'rate 3/2 refused');
select is(public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k2', 2, 3600), true, 'other key unaffected');
select is(public.voice_rate_consume('00000000-0000-0000-0000-0000000000b1', 'k1', 2, 3600), true, 'other tenant unaffected');
select throws_ok($$select public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k', 1, 0)$$, null, 'invalid rate parameters', 'bad window rejected');

-- --------------------------------------------------------------- call state --
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-1') ->> 'locked')::boolean, false, 'new call is not locked');
select public.voice_call_state_bump('00000000-0000-0000-0000-0000000000a1', 'call-1', '{"denied":1,"injection":1,"Bad Key!":5}', 30, false, false);
select public.voice_call_state_bump('00000000-0000-0000-0000-0000000000a1', 'call-1', '{"denied":2}', 20, true, false);
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-1') -> 'counters' ->> 'denied')::int, 3, 'counters accumulate atomically');
select is(public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-1') -> 'counters' ? 'Bad Key!', false, 'invalid counter keys are ignored');
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-1') ->> 'riskScore')::int, 30, 'risk keeps the maximum');
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-1') ->> 'restricted')::boolean, true, 'restricted flag is sticky');

-- ------------------------------------------------------------------- OTP ----
select is((public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-2', '00000000-0000-0000-0000-00000000cc01', pg_temp.dg('aa'), 'caller-h', 300, 3, 5) ->> 'ok')::boolean, true, 'otp issued');
select is((public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-2', '00000000-0000-0000-0000-00000000cc01', pg_temp.dg('bb'), 'caller-h', 300, 3, 5) ->> 'ok')::boolean, true, 'second otp issued');
select is((public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-2', pg_temp.dg('aa'), 3) ->> 'reason'), 'mismatch', 'superseded code can no longer be used');
select is((public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-2', pg_temp.dg('bb'), 3) ->> 'ok')::boolean, true, 'correct code accepted');
select is((public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-2', pg_temp.dg('bb'), 3) ->> 'reason'), 'no_challenge', 'a code is single-use (no replay)');
select isnt((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-2') ->> 'otpPassedAt'), null, 'otp factor recorded on the call');
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-3') ->> 'otpPassedAt'), null, 'another call is not verified by it');

select public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-4', '00000000-0000-0000-0000-00000000cc02', pg_temp.dg('cc'), 'caller-h2', 300, 3, 5);
select public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-4', pg_temp.dg('x1'), 3);
select public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-4', pg_temp.dg('x2'), 3);
select public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-4', pg_temp.dg('x3'), 3);
select is((public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-4', pg_temp.dg('cc'), 3) ->> 'reason'), 'too_many_attempts', '4th attempt (even with the right code) locks the call');
select is((public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-4', '00000000-0000-0000-0000-00000000cc02', pg_temp.dg('dd'), 'caller-h2', 300, 3, 5) ->> 'reason'), 'locked', 'locked call gets no new codes');
select is((select count(*)::int from public.voice_security_audit where user_id = '00000000-0000-0000-0000-0000000000a1' and code = 'too_many_attempts'), 1, 'lockout is audited');

select public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-5', '00000000-0000-0000-0000-00000000cc03', pg_temp.dg('e1'), 'caller-h3', 300, 2, 5);
select public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-5', '00000000-0000-0000-0000-00000000cc03', pg_temp.dg('e2'), 'caller-h3', 300, 2, 5);
select is((public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-5', '00000000-0000-0000-0000-00000000cc03', pg_temp.dg('e3'), 'caller-h3', 300, 2, 5) ->> 'reason'), 'too_many_challenges', 'per-call challenge limit');
select is((select string_agg(public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'bomb-' || g, '00000000-0000-0000-0000-00000000cc09', pg_temp.dg('f' || g), 'caller-x' || g, 300, 3, 2) ->> 'reason', ',' order by g) from generate_series(1, 4) g), 'issued,issued,number_daily_limit,number_daily_limit', 'SMS-bombing a customer across calls is capped per customer');

-- ------------------------------------------------------------ known details --
select public.voice_kd_record('00000000-0000-0000-0000-0000000000a1', 'call-6', '00000000-0000-0000-0000-00000000cc01', false, 3);
select public.voice_kd_record('00000000-0000-0000-0000-0000000000a1', 'call-6', '00000000-0000-0000-0000-00000000cc01', false, 3);
select is((public.voice_kd_record('00000000-0000-0000-0000-0000000000a1', 'call-6', '00000000-0000-0000-0000-00000000cc01', false, 3) ->> 'locked')::boolean, true, '3 failed detail checks lock the call');
select public.voice_kd_record('00000000-0000-0000-0000-0000000000a1', 'call-7', '00000000-0000-0000-0000-00000000cc01', true, 3);
select public.voice_otp_issue('00000000-0000-0000-0000-0000000000a1', 'call-7', '00000000-0000-0000-0000-00000000cc02', pg_temp.dg('g1'), 'caller-y', 300, 3, 5);
select public.voice_otp_check('00000000-0000-0000-0000-0000000000a1', 'call-7', pg_temp.dg('g1'), 3);
select is((public.voice_call_state_get('00000000-0000-0000-0000-0000000000a1', 'call-7') ->> 'kdPassedAt'), null, 'factors for DIFFERENT customers never combine (kd cleared)');

-- ------------------------------------------------------- confirm-before-write --
create temp table pa as select public.voice_pending_create('00000000-0000-0000-0000-0000000000a1', 'call-8', 'reschedule_appointment', pg_temp.dg('h1'), 'summary', 120) as id;
select is(public.voice_pending_consume('00000000-0000-0000-0000-0000000000a1', 'call-8', 'reschedule_appointment', pg_temp.dg('h1'), (select id from pa), 600000), 'too_soon', 'cannot be confirmed instantly');
select is(public.voice_pending_consume('00000000-0000-0000-0000-0000000000a1', 'call-8', 'reschedule_appointment', pg_temp.dg('h2'), (select id from pa), 0), 'mismatch', 'changed parameters cannot ride on an old confirmation');
select is(public.voice_pending_consume('00000000-0000-0000-0000-0000000000a1', 'call-9', 'reschedule_appointment', pg_temp.dg('h1'), (select id from pa), 0), 'missing', 'confirmation is bound to its call');
select is(public.voice_pending_consume('00000000-0000-0000-0000-0000000000a1', 'call-8', 'reschedule_appointment', pg_temp.dg('h1'), (select id from pa), 0), 'ok', 'valid confirmation succeeds once');
select is(public.voice_pending_consume('00000000-0000-0000-0000-0000000000a1', 'call-8', 'reschedule_appointment', pg_temp.dg('h1'), (select id from pa), 0), 'missing', 'confirmation is one-shot');

-- ----------------------------------------------------------------- canaries --
select public.voice_canary_register('00000000-0000-0000-0000-0000000000a1', 'phone', pg_temp.dg('canary1'));
select is(public.voice_canary_hit('00000000-0000-0000-0000-0000000000a1', array[pg_temp.dg('canary1')]), true, 'registered decoy is detected');
select is(public.voice_canary_hit('00000000-0000-0000-0000-0000000000a1', array[pg_temp.dg('nope')]), false, 'ordinary value is not');
select is(public.voice_canary_hit('00000000-0000-0000-0000-0000000000b1', array[pg_temp.dg('canary1')]), false, 'canaries are tenant-scoped');

-- -------------------------------------------------------------------- audit --
select public.voice_audit_append('00000000-0000-0000-0000-0000000000a1', 'tool_denied', 'low', 'call-10', 'lookup_customer', 'deny', 'cross_customer', '{"n":1}');
select public.voice_audit_append('00000000-0000-0000-0000-0000000000a1', 'canary_hit', 'critical', 'call-10', 'book_appointment', 'deny', 'canary', '{}');
select public.voice_audit_append('00000000-0000-0000-0000-0000000000b1', 'tool_denied', 'low', 'call-11', 'lookup_customer', 'deny', 'cross_customer', '{}');
select is((public.voice_audit_verify_chain('00000000-0000-0000-0000-0000000000a1') ->> 'ok')::boolean, true, 'untouched chain verifies');
select throws_ok($$update public.voice_security_audit set code = 'x'$$, '42501', 'voice_security_audit is append-only', 'UPDATE is rejected');
select throws_ok($$delete from public.voice_security_audit$$, '42501', 'voice_security_audit is append-only', 'DELETE is rejected');
select throws_ok($$truncate public.voice_security_audit$$, '42501', 'voice_security_audit is append-only', 'TRUNCATE is rejected');
select ok(exists (select 1 from public.ai_security_events where user_id = '00000000-0000-0000-0000-0000000000a1' and source = 'voice-security' and severity = 'critical'), 'critical audit rows raise an AI Security Center event');

alter table public.voice_security_audit disable trigger voice_audit_no_update_delete;
update public.voice_security_audit set code = 'tampered' where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'tool_denied';
alter table public.voice_security_audit enable trigger voice_audit_no_update_delete;
select is((public.voice_audit_verify_chain('00000000-0000-0000-0000-0000000000a1') ->> 'ok')::boolean, false, 'a tampered row breaks the chain');
select is((public.voice_audit_verify_chain('00000000-0000-0000-0000-0000000000b1') ->> 'ok')::boolean, true, 'other tenant chain is independent');

-- ------------------------------------------------------------ grants and RLS --
select set_config('voice_test.own_rows', (select count(*)::text from public.voice_security_audit where user_id = '00000000-0000-0000-0000-0000000000a1'), false);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.voice_security_audit), current_setting('voice_test.own_rows')::int, 'owner sees exactly their own tenant audit rows, none of the other tenant');
select throws_ok($$select public.voice_rate_consume('00000000-0000-0000-0000-0000000000a1', 'k', 1, 60)$$, '42501', null, 'clients cannot call service-only RPCs');
select throws_ok($$insert into public.voice_security_audit (user_id, at, kind, severity, decision, code, prev_hash, hash) values ('00000000-0000-0000-0000-0000000000a1', now(), 'x', 'low', 'info', 'x', 'p', 'h')$$, '42501', null, 'clients cannot write the audit table');
select pg_temp.reset_role();

select * from finish();
rollback;
