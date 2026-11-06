-- Call-to-cash slice 1: flag gating, transition enforcement, immutable log, operator lock,
-- voice idempotency, override path, RLS/tenant isolation, workflow health (pgTAP).
-- Place at: supabase/tests/database/c2c_state_machine.test.sql   Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@c2c.test'),
  ('00000000-0000-0000-0000-0000000000c9', 'owner@other-c2c.test');

insert into public.jobs (id, user_id, customer_name, job_status) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c1', 'Flag Off Co', 'completed'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000c1', 'Alice',       'scheduled'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000000c1', 'Lock Test',    'scheduled'),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-0000000000c9', 'Other Tenant', 'scheduled');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- 1. Flag OFF: nothing enforced, nothing logged
select lives_ok($$update public.jobs set job_status = 'scheduled' where id = '00000000-0000-0000-0000-00000000e001'$$,
  'flag off: completed -> scheduled is not rejected');
select is((select count(*)::int from public.job_transition_log), 0, 'flag off: no transition log rows');

-- Turn the flag on for tenant c1 only (master enabled, rollout 0, per-tenant override on)
update public.feature_flags set enabled = true where key = 'c2c_orchestration';
insert into public.feature_flag_overrides (flag_id, tenant_id, state)
select id, '00000000-0000-0000-0000-0000000000c1', 'on' from public.feature_flags where key = 'c2c_orchestration';

select ok(public.c2c_orchestration_enabled('00000000-0000-0000-0000-0000000000c1'), 'flag on for c1');
select ok(not public.c2c_orchestration_enabled('00000000-0000-0000-0000-0000000000c9'), 'flag still off for other tenant');

-- 2. Legal transition is allowed and logged with a trace id
update public.jobs set job_status = 'en_route' where id = '00000000-0000-0000-0000-00000000e002';
select is((select count(*)::int from public.job_transition_log
            where job_id = '00000000-0000-0000-0000-00000000e002' and from_status = 'scheduled' and to_status = 'en_route' and trace_id is not null),
          1, 'legal transition logged with trace id');

-- 3. Illegal transition rejected by the database
update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-00000000e002';
select throws_ok($$update public.jobs set job_status = 'scheduled' where id = '00000000-0000-0000-0000-00000000e002'$$,
  '23514', null, 'completed -> scheduled rejected');
select is((select job_status from public.jobs where id = '00000000-0000-0000-0000-00000000e002'), 'completed',
  'rejected transition left the row unchanged');

-- 4. Other tenant is not governed while its flag is off
select lives_ok($$update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-00000000e0b1'$$,
  'unflagged tenant unaffected');

-- 5. Log is append-only
select throws_ok($$update public.job_transition_log set reason = 'x'$$, 'P0001', null, 'log update rejected');
select throws_ok($$delete from public.job_transition_log$$, 'P0001', null, 'log delete rejected');

-- 6. Operator takeover blocks automation, release restores it
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select isnt((select public.takeover_job_workflow('00000000-0000-0000-0000-00000000e003', 'customer called, handling by hand')), null, 'takeover returns lock id');
reset role;
select throws_ok($$update public.jobs set job_status = 'en_route' where id = '00000000-0000-0000-0000-00000000e003'$$,
  '55006', null, 'system/automation write rejected while locked');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select ok((select public.release_job_workflow('00000000-0000-0000-0000-00000000e003')), 'release succeeds');
reset role;
select lives_ok($$update public.jobs set job_status = 'en_route' where id = '00000000-0000-0000-0000-00000000e003'$$,
  'automation write allowed after release');

-- 7. Cross-tenant takeover impossible
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c9');
select throws_ok($$select public.takeover_job_workflow('00000000-0000-0000-0000-00000000e002', 'not mine to take')$$,
  'P0002', null, 'other tenant cannot take over my job');
select is((select count(*)::int from public.job_transition_log), 0, 'RLS: other tenant sees none of my log rows');
reset role;

-- 8. Voice idempotency: same call + tool call id cannot create a second job
insert into public.jobs (user_id, customer_name, voice_idempotency_key)
values ('00000000-0000-0000-0000-0000000000c1', 'Voice Caller', 'call_1:tool_1');
select throws_ok($$insert into public.jobs (user_id, customer_name, voice_idempotency_key)
                   values ('00000000-0000-0000-0000-0000000000c1', 'Voice Caller', 'call_1:tool_1')$$,
  '23505', null, 'replayed tool call cannot create a duplicate job');

select * from finish();
rollback;
