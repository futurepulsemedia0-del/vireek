-- Shadow Mode live-listen: ledger, consent backstop, grants, tenant isolation, idempotency, retention (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner-a@live.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner-b@live.test');

-- trial A: eligible (all consent facts true, CA + NANP_UNLISTED cleared). trial B: nothing cleared.
insert into public.shadow_trials (id, user_id, replay_attested, caller_disclosure_configured, staff_notified, telephony_supports_fork, counsel_cleared_states)
values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', true, true, true, true, '{CA,NANP_UNLISTED}'),
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', true, true, true, false, '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
create or replace function pg_temp.act_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true); -- back to the session (superuser) role
end $$;

-- ------------------------------------------------------------------ defaults --
select is((select enabled from public.feature_flags where key = 'shadow_live_listen'), false, 'the flag ships OFF');
select is((select rollout_pct from public.feature_flags where key = 'shadow_live_listen'), 0, 'the flag ships at 0 %');
select is((select risk from public.feature_flags where key = 'shadow_live_listen'), 'critical', 'the flag is critical (second approver for exposure)');
select is((select risk from public.kill_switches where key = 'shadow_live_listen'), 'critical', 'the kill switch exists and is critical');
select is((select mode from public.shadow_trials where id = '10000000-0000-0000-0000-0000000000a1'), 'replay', 'trials remain replay-only');

-- ----------------------------------------------------- service-only RPC grants --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.shadow_live_record('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','c1','0123','CA','authorized',null,'{}'::jsonb,30)$$,
  '42501', null, 'an authenticated tenant cannot call shadow_live_record');
select throws_ok($$select public.shadow_live_purge_expired()$$, '42501', null, 'an authenticated tenant cannot purge');
select throws_ok($$insert into public.shadow_live_sessions (user_id, trial_id, call_ref, status, block_reason, purge_after) values ('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','x','blocked','r', now())$$,
  '42501', null, 'a tenant cannot insert sessions directly');

-- ------------------------------------------------------------- record: success --
select pg_temp.act_service();
select set_config('t.s1', (select public.shadow_live_record('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','call-1','0123','CA','authorized',null,
  '{"replay_attested":true,"caller_disclosure_configured":true,"staff_notified":true,"telephony_supports_fork":true}'::jsonb, 30))::text, true);
select is((select status from public.shadow_live_sessions where id = current_setting('t.s1')::uuid), 'authorized', 'an eligible trial + cleared state authorizes a session');
select is((select count(*) from public.shadow_live_events where session_id = current_setting('t.s1')::uuid), 1::bigint, 'one audit event is written');
select is(public.shadow_live_record('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','call-1','0123','CA','authorized',null,
  '{"replay_attested":true,"caller_disclosure_configured":true,"staff_notified":true,"telephony_supports_fork":true}'::jsonb, 30),
  current_setting('t.s1')::uuid, 'a retry is idempotent (same id)');
select is((select count(*) from public.shadow_live_events where session_id = current_setting('t.s1')::uuid), 1::bigint, 'a retry writes no second audit event');

-- ---------------------------------------------------- record: consent backstop --
select throws_ok($$select public.shadow_live_record('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','call-2','0123','NY','authorized',null,'{}'::jsonb,30)$$,
  '42501', null, 'an uncleared jurisdiction cannot be authorized');
select throws_ok($$select public.shadow_live_record('00000000-0000-0000-0000-0000000000b2','10000000-0000-0000-0000-0000000000b1','call-3','0123','CA','authorized',null,'{}'::jsonb,30)$$,
  '42501', null, 'a trial without fork support / cleared states cannot be authorized');
select throws_ok($$select public.shadow_live_record('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000b1','call-4','0123','CA','blocked','x','{}'::jsonb,30)$$,
  'P0002', null, 'a trial of another account is rejected');
select throws_ok($$insert into public.shadow_live_sessions (user_id, trial_id, call_ref, status, jurisdiction, consent_snapshot, purge_after)
  values ('00000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000a1','raw','authorized','CA','{"replay_attested":true}', now())$$,
  '23514', null, 'the CHECK refuses a non-blocked row with missing consent facts');

-- ------------------------------------------------------------------ isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
select is((select count(*) from public.shadow_live_sessions), 0::bigint, 'another tenant sees none of account A''s sessions');
select is((select count(*) from public.shadow_live_events), 0::bigint, 'another tenant sees none of account A''s events');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.shadow_live_sessions), 1::bigint, 'the owner sees their own session');

-- --------------------------------------------------- end, audit immutability, purge --
select pg_temp.act_service();
select is(public.shadow_live_end(current_setting('t.s1')::uuid, 'kill_switch'), true, 'an open session can be ended by the kill switch');
select is((select status from public.shadow_live_sessions where id = current_setting('t.s1')::uuid), 'killed', 'kill_switch end marks the session killed');
select throws_ok($$delete from public.shadow_live_events$$, '42501', null, 'audit events are append-only');

select pg_temp.act_admin();
update public.shadow_live_sessions set purge_after = now() - interval '1 day';
select pg_temp.act_service();
select is(public.shadow_live_purge_expired(), 1, 'retention purge removes the expired session row');

select * from finish();
rollback;
