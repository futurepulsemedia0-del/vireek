-- Run with psql, NOT as a Supabase migration (CONCURRENTLY cannot run inside a transaction):
--   psql "$DATABASE_URL" -f supabase/ops/20261102_db_perf_ops.sql      (no BEGIN; each statement autocommits)
-- Run the sections you need one at a time, off-peak.

-- A. Verify before anything else ---------------------------------------------------------------
-- A1. volatility must be 's' (stable). 'v' means the STABLE fix did not apply.
--   select provolatile from pg_proc where oid = 'public.get_account_owner_id()'::regprocedure;
-- A2. is the 90-day position-log purge really scheduled? (the repo only documents it in a comment)
--   select jobname, schedule, command from cron.job;
-- A3. BRIN only pays off when rows arrive in time order. Need correlation close to 1 (> 0.9);
--     otherwise replace USING brin(...) below with a plain btree index.
--   select tablename, attname, correlation from pg_stats
--   where schemaname='public' and tablename in ('vehicle_position_log','vehicle_telemetry_pings') and attname='recorded_at';

-- B. Indexes the retention deletes need (no standalone recorded_at index exists today) --------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicle_position_log_recorded_brin
  ON public.vehicle_position_log USING brin (recorded_at) WITH (pages_per_range = 32);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicle_telemetry_pings_recorded_brin
  ON public.vehicle_telemetry_pings USING brin (recorded_at) WITH (pages_per_range = 32);
-- If a CONCURRENTLY build is interrupted it leaves an INVALID index: find it with
--   select indexrelid::regclass from pg_index where not indisvalid;   then DROP INDEX CONCURRENTLY it and retry.

-- C. RLS InitPlan rewrite (dry-run first, then small batches) --------------------------------------
-- Snapshot first (rollback source):  create table perf_policy_backup as select * from pg_policies where schemaname='public';
--   select * from perf.rewrite_rls_initplan(false, 500);        -- report only
--   select * from perf.rewrite_rls_initplan(true, 25);          -- repeat until it returns no rows
-- Rollback of one policy: ALTER POLICY <name> ON public.<table> USING (<qual from perf_policy_backup>) WITH CHECK (<with_check>);

-- D. Retention (decide the keep intervals first; deletes are permanent) ------------------------------
--   call perf.purge_old_rows('vehicle_telemetry_pings', interval '45 days');
--   call perf.purge_old_rows('vehicle_position_log',    interval '90 days');
--   call perf.purge_old_rows('telemetry_readings',      interval '30 days');
-- To schedule (after B and one manual run):
--   select cron.schedule('perf-purge-telemetry', '30 3 * * *', $$call perf.purge_old_rows('vehicle_telemetry_pings', interval '45 days')$$);

-- E. Evidence queries (each returns rows to act on) --------------------------------------------------
--   select * from perf.top_queries limit 20;
--   select * from perf.duplicate_indexes;
--   select * from perf.unused_indexes limit 50;      -- trust only if stats_since is > 30 days old
--   select * from perf.missing_fk_indexes;
--   select * from perf.table_health limit 30;
-- Drop an index proven redundant (one at a time):  DROP INDEX CONCURRENTLY IF EXISTS public.<name>;
