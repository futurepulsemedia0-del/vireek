-- =============================================================
-- DB performance foundations (additive; no row is modified on apply)
--   1. get_account_owner_id() -> STABLE  (a later CREATE OR REPLACE silently reset it to VOLATILE)
--   2. schema perf: diagnostics views (duplicate/unused/FK-unindexed indexes, table health, top queries)
--   3. perf.rewrite_rls_initplan(): dry-run-first rewrite of RLS policies so auth.uid()/auth.jwt()/
--      get_account_owner_id() are evaluated once per statement (InitPlan) instead of per row
--   4. perf.purge_old_rows(): batched, committing retention for 3 verified append-only telemetry tables
-- Nothing here is scheduled or applied automatically. See supabase/ops/20261102_db_perf_ops.sql.
-- =============================================================

-- 1. Volatility ------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.get_account_owner_id()') IS NOT NULL THEN
    ALTER FUNCTION public.get_account_owner_id() STABLE;
  END IF;
END $$;

-- 2. Schema + extension ----------------------------------------
CREATE SCHEMA IF NOT EXISTS perf;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not enabled here (%): perf.top_queries will not be created', SQLERRM;
END $$;

CREATE OR REPLACE VIEW perf.duplicate_indexes AS
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       array_agg(i.indexrelid::regclass::text ORDER BY i.indexrelid) AS indexes,
       bool_or(i.indisprimary OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)) AS any_backs_constraint,
       pg_size_pretty(sum(pg_relation_size(i.indexrelid))) AS total_size
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND i.indisvalid
GROUP BY n.nspname, c.relname, i.indrelid, i.indisunique,
         i.indkey::text, i.indclass::text, i.indcollation::text, i.indoption::text,
         coalesce(pg_get_expr(i.indexprs, i.indrelid), ''),
         coalesce(pg_get_expr(i.indpred, i.indrelid), '')
HAVING count(*) > 1;

CREATE OR REPLACE VIEW perf.unused_indexes AS
SELECT s.schemaname AS schema_name,
       s.relname AS table_name,
       s.indexrelname AS index_name,
       s.idx_scan,
       pg_relation_size(s.indexrelid) AS size_bytes,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       (SELECT d.stats_reset FROM pg_stat_database d WHERE d.datname = current_database()) AS stats_since
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.schemaname = 'public'
  AND s.idx_scan = 0
  AND NOT i.indisunique AND NOT i.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC;

CREATE OR REPLACE VIEW perf.missing_fk_indexes AS
SELECT c.conrelid::regclass::text AS table_name,
       c.conname AS constraint_name,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f'
  AND c.connamespace = 'public'::regnamespace
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
      AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] @> c.conkey
  );

CREATE OR REPLACE VIEW perf.table_health AS
SELECT s.schemaname AS schema_name,
       s.relname AS table_name,
       s.n_live_tup,
       s.n_dead_tup,
       round(100.0 * s.n_dead_tup / greatest(s.n_live_tup + s.n_dead_tup, 1), 1) AS dead_pct,
       s.last_autovacuum,
       s.last_autoanalyze,
       pg_total_relation_size(s.relid) AS total_bytes,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size
FROM pg_stat_user_tables s
WHERE s.schemaname = 'public'
ORDER BY pg_total_relation_size(s.relid) DESC;

DO $$
DECLARE v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_stat_statements';
  IF v_schema IS NULL THEN RETURN; END IF;
  EXECUTE format($v$
    CREATE OR REPLACE VIEW perf.top_queries AS
    SELECT queryid, calls,
           round(total_exec_time::numeric, 1) AS total_ms,
           round(mean_exec_time::numeric, 2)  AS mean_ms,
           round(stddev_exec_time::numeric, 2) AS stddev_ms,
           rows, shared_blks_read, shared_blks_hit,
           left(query, 300) AS query
    FROM %I.pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    ORDER BY total_exec_time DESC
    LIMIT 100
  $v$, v_schema);
END $$;

-- 3. RLS InitPlan rewrite --------------------------------------
-- Pure text transform on pg_policies expressions. Already-wrapped calls are protected first, so it is idempotent.
CREATE OR REPLACE FUNCTION perf.wrap_auth_calls(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE
    replace(replace(replace(replace(
    replace(replace(replace(replace(
    replace(replace(replace(replace(
      replace(p, 'public.get_account_owner_id()', 'get_account_owner_id()'),
      '( SELECT auth.uid() AS uid)',   '~~P_UID~~'),
      '( SELECT auth.jwt() AS jwt)',   '~~P_JWT~~'),
      '( SELECT auth.role() AS role)', '~~P_ROLE~~'),
      '( SELECT get_account_owner_id() AS get_account_owner_id)', '~~P_OWNER~~'),
      'auth.uid()',  '( SELECT auth.uid() AS uid)'),
      'auth.jwt()',  '( SELECT auth.jwt() AS jwt)'),
      'auth.role()', '( SELECT auth.role() AS role)'),
      'get_account_owner_id()', '( SELECT get_account_owner_id() AS get_account_owner_id)'),
      '~~P_UID~~',   '( SELECT auth.uid() AS uid)'),
      '~~P_JWT~~',   '( SELECT auth.jwt() AS jwt)'),
      '~~P_ROLE~~',  '( SELECT auth.role() AS role)'),
      '~~P_OWNER~~', '( SELECT get_account_owner_id() AS get_account_owner_id)')
  END
$$;

-- p_apply=false (default) only reports. Run in small batches, off-peak. A policy whose table is locked
-- longer than 3s is reported as 'skipped' and picked up by the next call.
CREATE OR REPLACE FUNCTION perf.rewrite_rls_initplan(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 25,
  p_table text DEFAULT NULL
)
RETURNS TABLE (table_name text, policy_name text, status text)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
SET lock_timeout = '3s'
AS $$
DECLARE
  r record;
  v_sql text;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 500';
  END IF;
  FOR r IN
    SELECT p.tablename, p.policyname, p.qual, p.with_check
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND (p_table IS NULL OR p.tablename = p_table)
      AND ((p.qual IS NOT NULL AND perf.wrap_auth_calls(p.qual) IS DISTINCT FROM p.qual)
        OR (p.with_check IS NOT NULL AND perf.wrap_auth_calls(p.with_check) IS DISTINCT FROM p.with_check))
    ORDER BY p.tablename, p.policyname
    LIMIT p_limit
  LOOP
    table_name := r.tablename;
    policy_name := r.policyname;
    IF NOT p_apply THEN
      status := 'would_rewrite';
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_sql := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF r.qual IS NOT NULL THEN
      v_sql := v_sql || ' USING (' || perf.wrap_auth_calls(r.qual) || ')';
    END IF;
    IF r.with_check IS NOT NULL THEN
      v_sql := v_sql || ' WITH CHECK (' || perf.wrap_auth_calls(r.with_check) || ')';
    END IF;
    BEGIN
      EXECUTE v_sql;
      status := 'rewritten';
    EXCEPTION WHEN OTHERS THEN
      status := 'skipped: ' || SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END $$;

-- 4. Batched retention ------------------------------------------
-- Procedure (not function) so every batch commits; no SET clause, because SET would forbid COMMIT.
-- Call from pg_cron or psql only: CALL perf.purge_old_rows('vehicle_position_log', interval '90 days');
CREATE OR REPLACE PROCEDURE perf.purge_old_rows(
  p_table text,
  p_keep interval,
  p_batch integer DEFAULT 5000,
  p_max_batches integer DEFAULT 200
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_col text;
  v_n bigint;
  v_total bigint := 0;
  i integer;
BEGIN
  v_col := CASE p_table
    WHEN 'vehicle_position_log'    THEN 'recorded_at'
    WHEN 'vehicle_telemetry_pings' THEN 'recorded_at'
    WHEN 'telemetry_readings'      THEN 'ts'
  END;
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'table % is not allowed', p_table;
  END IF;
  IF p_keep < interval '7 days' THEN
    RAISE EXCEPTION 'keep interval must be at least 7 days';
  END IF;
  IF p_batch < 100 OR p_batch > 50000 OR p_max_batches < 1 OR p_max_batches > 10000 THEN
    RAISE EXCEPTION 'p_batch must be 100..50000 and p_max_batches 1..10000';
  END IF;

  FOR i IN 1..p_max_batches LOOP
    EXECUTE format(
      'DELETE FROM public.%1$I WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.%1$I WHERE %2$I < now() - $1 LIMIT $2))',
      p_table, v_col)
    USING p_keep, p_batch;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
    COMMIT;
    EXIT WHEN v_n < p_batch;
  END LOOP;
  RAISE NOTICE 'purged % rows from %', v_total, p_table;
END $$;

-- 5. Lock the schema down ---------------------------------------
REVOKE ALL ON SCHEMA perf FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA perf FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA perf FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL PROCEDURES IN SCHEMA perf FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA perf TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA perf TO service_role;
