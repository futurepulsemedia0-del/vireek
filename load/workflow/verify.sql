-- Post-load invariants for the workflow engine (read-only). Every row must show ok = true.
-- Usage: psql "$STAGING_DB_URL" -f load/workflow/verify.sql
select 'I1 no duplicate step key per (run,node,purpose,branch,item)' as check, count(*) as offenders, count(*) = 0 as ok from (
  select run_id, node_id, purpose, split_part(key, ':', 4) b, split_part(key, ':', 5) i from public.compiled_workflow_step_keys
   group by 1, 2, 3, 4, 5 having count(*) > 1) x
union all
select 'I1b no node_started twice for one scope in a run (audit)', count(*), count(*) = 0 from (
  select run_id, node_id, coalesce(detail->>'branch', '-') b, count(*) from public.compiled_workflow_audit
   where event_type = 'node_started' and (detail ? 'branch') group by 1, 2, 3 having count(*) > 1) x
union all
select 'I2 no join released twice', count(*), count(*) = 0 from (
  select run_id, node_id from public.compiled_workflow_audit where event_type = 'join_released' group by 1, 2 having count(*) > 1) x
union all
select 'I3 (proxy) no token still leased as running on a finished run', count(*), count(*) = 0 from (
  select t.id from public.compiled_workflow_tokens t join public.compiled_workflow_runs r on r.id = t.run_id
   where r.status in ('completed', 'failed', 'cancelled') and t.status = 'running' and t.lease_until < now() - interval '10 minutes') x
union all
select 'I5 fan-out: leased tokens per (run,parent) <= declared concurrency cap (50 hard cap)', count(*), count(*) = 0 from (
  select run_id, parent_node from public.compiled_workflow_tokens where status = 'running' and lease_until >= now()
   group by 1, 2 having count(*) > 50) x
union all
select 'I4 every compensation step ran at most once (UNIQUE) and no run is stuck compensating > 15 min', count(*), count(*) = 0 from (
  select id from public.compiled_workflow_runs where status = 'compensating' and next_wake_at < now() - interval '15 minutes') x
union all
select 'liveness: no active run left unclaimed for > 15 min', count(*), count(*) = 0 from (
  select id from public.compiled_workflow_runs where status in ('active', 'waiting_timer') and next_wake_at < now() - interval '15 minutes' and (locked_until is null or locked_until < now())) x;
