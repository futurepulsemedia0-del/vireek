-- Voice AI hardening: voice_webhook_events RLS, audit trail, calls upsert inference, dead-letter replay (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.voice_webhook_events (user_id, vapi_call_id, event_type, status, payload) values
  ('00000000-0000-0000-0000-0000000000a1', 'call-a', 'end-of-call-report', 'processing', '{}'),
  ('00000000-0000-0000-0000-0000000000a1', 'call-dead', 'end-of-call-report', 'dead',
     '{"caller_phone":"+15551230000","caller_name":"Ann","duration_seconds":61,"summary":"Leak"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'call-b', 'end-of-call-report', 'processing', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- audit trail
select is((select jsonb_array_length(status_history) from public.voice_webhook_events where vapi_call_id = 'call-a'), 1, 'insert records first status');
update public.voice_webhook_events set status = 'processed' where vapi_call_id = 'call-a';
select is((select status_history->1->>'status' from public.voice_webhook_events where vapi_call_id = 'call-a'), 'processed', 'status change appended to history');

-- unique key => duplicate delivery cannot create a second ledger row
select throws_ok($$insert into public.voice_webhook_events (user_id, vapi_call_id, event_type) values ('00000000-0000-0000-0000-0000000000a1','call-a','end-of-call-report')$$, '23505', null, 'duplicate (vapi_call_id,event_type) rejected');

-- calls upsert must be inferable (regression for the partial-index 42P10)
select lives_ok($$insert into public.calls (user_id, vapi_call_id) values ('00000000-0000-0000-0000-0000000000a1','v-1')
  on conflict (vapi_call_id) do update set caller_name = 'x'$$, 'ON CONFLICT (vapi_call_id) is inferable');
select lives_ok($$insert into public.calls (user_id, vapi_call_id) values ('00000000-0000-0000-0000-0000000000a1','v-1')
  on conflict (vapi_call_id) do update set caller_name = 'y'$$, 'second delivery merges, no error');
select is((select count(*)::int from public.calls where vapi_call_id = 'v-1'), 1, 'one call row after duplicate upsert');

-- RLS: tenant isolation + no client writes
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.voice_webhook_events), 2, 'owner A sees only own events');
select is((select count(*)::int from public.voice_webhook_events where vapi_call_id = 'call-b'), 0, 'owner A cannot see tenant B event');
select throws_ok($$insert into public.voice_webhook_events (user_id, vapi_call_id, event_type) values ('00000000-0000-0000-0000-0000000000a1','forged','end-of-call-report')$$, '42501', null, 'authenticated client cannot insert');
select throws_ok($$update public.voice_webhook_events set status = 'processed' where vapi_call_id = 'call-dead'$$, '42501', null, 'authenticated client cannot update');
select throws_ok($$select public.replay_dead_voice_events()$$, '42501', null, 'replay is service-role only');

reset role;
select is(public.replay_dead_voice_events(), 1, 'replay restores the dead-lettered call');

select * from finish();
rollback;
