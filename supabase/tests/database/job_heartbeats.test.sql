-- Job heartbeats, cron dispatch, missed-window alerts (pgTAP).
-- Run with:  supabase test db
-- NOT EXECUTED in the authoring environment (no Postgres available). The reconcile tests (31-33) are skipped
-- automatically when the pg_net response table is not writable by the test role.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'staff@jobhb.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'owner@jobhb.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000d1', 'owner', true),
  ('00000000-0000-0000-0000-0000000000d2', 'owner', false)
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- Deterministic: no destinations, no secrets, no base URL, so nothing real is ever called.
select set_config('app.settings.edge_function_base_url', '', true);
select set_config('app.settings.functions_url', '', true);
select set_config('app.settings.cron_secret', '', true);
select set_config('app.settings.job_alert_slack_webhook_url', '', true);
select set_config('app.settings.job_alert_pagerduty_routing_key', '', true);
select set_config('app.settings.job_deadman_ping_url', '', true);

-- ----------------------------------------------------------------- schema --
select has_table('public', 'job_heartbeats', 'job_heartbeats exists');
select has_table('public', 'job_heartbeat_alerts', 'job_heartbeat_alerts exists');
select ok((select relrowsecurity from pg_class where oid = 'public.job_heartbeats'::regclass), 'RLS enabled on job_heartbeats');
select ok((select relrowsecurity from pg_class where oid = 'public.job_heartbeat_alerts'::regclass), 'RLS enabled on job_heartbeat_alerts');
select is(
  (select count(*)::int from public.job_heartbeats
    where kind = 'edge' and job_name in ('c2c-sweep', 'webhook-outbox-worker', 'learning-policy-monitor',
                                         'agent-readiness-cron', 'growth-weekly-digest', 'automation-vip-customer-tag')),
  6, 'all six previously unscheduled jobs are registered');

-- ---------------------------------------------------------------- privileges --
select pg_temp.act_as_anon();
select throws_ok($$select * from public.job_heartbeats$$, '42501', null, 'anon cannot read job_heartbeats');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select throws_ok($$select * from public.job_heartbeats$$, '42501', null, 'authenticated users cannot read job_heartbeats');
select throws_ok($$select public.cron_dispatch('c2c-sweep')$$, '42501', null, 'authenticated users cannot dispatch jobs');
select throws_ok($$select public.cron_secret_value('cron_secret')$$, '42501', null, 'authenticated users cannot resolve secrets');
select pg_temp.reset_role();

-- ----------------------------------------------------------------- dispatch --
select throws_ok($$select public.cron_dispatch('nope')$$, '22023', 'unknown edge job: nope', 'unknown job is rejected');

select is(public.cron_dispatch('c2c-sweep'), null::bigint, 'dispatch without configuration returns NULL (and does not call out)');
select is((select last_error from public.job_heartbeats where job_name = 'c2c-sweep'),
          'edge_function_base_url_not_configured', 'missing base URL is recorded as a failure');
select set_config('app.settings.edge_function_base_url', 'http://example.invalid/functions/v1', true);
select public.cron_dispatch('c2c-sweep');
select is((select last_error from public.job_heartbeats where job_name = 'c2c-sweep'),
          'secret_not_configured:cron_secret', 'missing secret is recorded as a failure, never silently skipped');
select is((select consecutive_failures from public.job_heartbeats where job_name = 'c2c-sweep'), 2, 'failures are counted');

update public.job_heartbeats set enabled = false where job_name = 'c2c-sweep';
select public.cron_dispatch('c2c-sweep');
select is((select consecutive_failures from public.job_heartbeats where job_name = 'c2c-sweep'), 2, 'a disabled job is not dispatched and not counted');
update public.job_heartbeats set enabled = true where job_name = 'c2c-sweep';

-- ---------------------------------------------------------------- heartbeat --
select public.job_heartbeat_beat('c2c-sweep');
select is((select consecutive_failures from public.job_heartbeats where job_name = 'c2c-sweep'), 0, 'a successful beat resets failures');
select ok((select last_success_at is not null from public.job_heartbeats where job_name = 'c2c-sweep'), 'a successful beat records last_success_at');
select throws_ok($$select public.job_heartbeat_beat('nope')$$, '22023', 'unknown job: nope', 'a beat for an unknown job is rejected');

-- ------------------------------------------------------------------- alerts --
select lives_ok($$select public.job_heartbeat_evaluate()$$, 'evaluate runs without destinations configured');
select is((select count(*)::int from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 0,
          'a healthy job has no open alert');

update public.job_heartbeats set last_success_at = now() - interval '1 hour' where job_name = 'c2c-sweep';
select public.job_heartbeat_evaluate();
select is((select count(*)::int from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 1,
          'a job that missed its window opens an alert');
select is((select reason from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 'missed_window',
          'the alert reason is missed_window');
select public.job_heartbeat_evaluate();
select is((select count(*)::int from public.job_heartbeat_alerts where job_name = 'c2c-sweep'), 1,
          'evaluating again does not open a second alert');

select public.job_heartbeat_beat('c2c-sweep');
select public.job_heartbeat_evaluate();
select is((select count(*)::int from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 0,
          'recovery closes the alert');
select ok((select bool_and(resolved_at is not null) from public.job_heartbeat_alerts where job_name = 'c2c-sweep'), 'the resolved alert is stamped');

update public.job_heartbeats set consecutive_failures = 3, last_success_at = now() where job_name = 'c2c-sweep';
select public.job_heartbeat_evaluate();
select is((select reason from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 'repeated_failures',
          'three consecutive failures of a frequent job open a repeated_failures alert');

update public.job_heartbeats set enabled = false where job_name = 'c2c-sweep';
select public.job_heartbeat_evaluate();
select is((select count(*)::int from public.job_heartbeat_alerts where job_name = 'c2c-sweep' and resolved_at is null), 0,
          'disabling a job on purpose resolves its alert');
update public.job_heartbeats set enabled = true where job_name = 'c2c-sweep';

-- ----------------------------------------------------------- staff overview --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select throws_ok($$select * from public.job_heartbeats_overview()$$, '42501', null, 'non-staff cannot read the overview');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select ok((select count(*) from public.job_heartbeats_overview()) >= 7, 'staff can read the overview (6 edge jobs + the evaluator)');
select pg_temp.reset_role();
select pg_temp.act_as_anon();
select throws_ok($$select * from public.job_heartbeats_overview()$$, '42501', null, 'anon cannot call the overview');
select pg_temp.reset_role();

-- ---------------------------------------------- reconcile (needs pg_net table) --
create temp table pg_temp.ctx as
  select (to_regclass('net._http_response') is not null
          and has_table_privilege(current_user, 'net._http_response', 'INSERT')) as can;

select skip('net._http_response is not writable in this environment', 3) where not (select can from pg_temp.ctx);

do $$
begin
  if (select can from pg_temp.ctx) then
    update public.job_heartbeats
       set last_request_id = 999001, last_dispatched_at = now() - interval '10 seconds', last_result_at = null, consecutive_failures = 0
     where job_name = 'c2c-sweep';
    insert into net._http_response (id, status_code, created) values (999001, 200, now());
    perform public.job_heartbeat_reconcile();
  end if;
end $$;
select is((select last_status_code from public.job_heartbeats where job_name = 'c2c-sweep'), 200, 'a 2xx response is recorded as success')
  where (select can from pg_temp.ctx);

do $$
begin
  if (select can from pg_temp.ctx) then
    update public.job_heartbeats
       set last_request_id = 999002, last_dispatched_at = now() - interval '5 seconds', last_result_at = null
     where job_name = 'c2c-sweep';
    insert into net._http_response (id, status_code, created) values (999002, 500, now());
    perform public.job_heartbeat_reconcile();
  end if;
end $$;
select is((select consecutive_failures from public.job_heartbeats where job_name = 'c2c-sweep'), 1, 'a 5xx response counts as a failure')
  where (select can from pg_temp.ctx);
select is((select last_error from public.job_heartbeats where job_name = 'c2c-sweep'), 'http_500', 'the failure keeps a short, secret-free reason')
  where (select can from pg_temp.ctx);

select * from finish();
rollback;
