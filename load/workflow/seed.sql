-- Seeds N test-mode runs of an existing ACTIVE compiled workflow on STAGING so overlapping executor ticks have work.
-- Usage: psql "$STAGING_DB_URL" -v runs=500 -v workflow_id="'<uuid of an active parallel/foreach workflow>'" -f load/workflow/seed.sql
-- mode='test' means actions are simulated: nothing is sent to real customers. NEVER run against production.
\set ON_ERROR_STOP on
insert into public.compiled_workflow_runs (workflow_id, user_id, mode, status, current_node, state, next_wake_at)
select w.id, w.user_id, 'test', 'active', (w.graph->>'entry'), '{}'::jsonb, now()
  from public.compiled_workflows w, generate_series(1, :runs) g
 where w.id = :workflow_id::uuid and w.status = 'active';
select count(*) as seeded from public.compiled_workflow_runs where status = 'active' and mode = 'test' and workflow_id = :workflow_id::uuid;
