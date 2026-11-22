/*
  # Breach scoping scan (read-only)

  public.breach_scan_table(table, tenant column, time column, window, mode, limit)
  returns the tenants that have rows in ONE table, with a row count per tenant. It backs the staff-only breach scoping tool
  (supabase/functions/breach-admin). It is generic on purpose: the allowlist of tables / columns / data categories lives in
  supabase/functions/_shared/breach/registry.ts, and the edge function only passes registry values. As defence in depth the
  function itself refuses anything that is not a real public table, a uuid tenant column and a timestamp column, and quotes
  every identifier with format(%I).

  Properties
    * STABLE, SELECT-only dynamic SQL: it cannot modify data.
    * SECURITY DEFINER (must see every tenant), so EXECUTE is granted to service_role ONLY.
    * statement_timeout 30s; at most p_limit + 1 tenants are returned (the caller uses the extra row to flag truncation).
    * Modes: 'existing_at_end'     rows whose time column is <= window end (data that existed when the window closed,
                                   assuming it was not deleted since: it cannot see deleted rows)
             'created_in_window'   rows whose time column is inside [from, to]
      Neither mode sees rows that were only UPDATED in the window; see docs/runbooks/breach-notification.md.
*/

-- rollback: DROP FUNCTION public.breach_scan_table(text, text, text, timestamptz, timestamptz, text, integer);

CREATE OR REPLACE FUNCTION public.breach_scan_table(
  p_table      text,
  p_tenant_col text,
  p_time_col   text,
  p_from       timestamptz,
  p_to         timestamptz,
  p_mode       text DEFAULT 'existing_at_end',
  p_limit      integer DEFAULT 5000
) RETURNS TABLE (tenant_id uuid, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_sql   text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('existing_at_end', 'created_in_window') THEN
    RAISE EXCEPTION 'invalid mode' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '3660 days' THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = p_table AND c.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'unknown table' USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_tenant_col AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'unknown tenant column' USING ERRCODE = '42703';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_time_col
       AND data_type IN ('timestamp with time zone', 'timestamp without time zone')
  ) THEN
    RAISE EXCEPTION 'unknown time column' USING ERRCODE = '42703';
  END IF;

  v_sql := format(
    'SELECT %1$I::uuid AS tenant_id, count(*)::bigint AS row_count FROM public.%2$I WHERE %1$I IS NOT NULL AND %3$I IS NOT NULL AND $1::timestamptz IS NOT NULL AND %3$I <= $2',
    p_tenant_col, p_table, p_time_col
  );
  IF p_mode = 'created_in_window' THEN
    v_sql := v_sql || format(' AND %I >= $1', p_time_col);
  END IF;
  v_sql := v_sql || ' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $3';

  RETURN QUERY EXECUTE v_sql USING p_from, p_to, v_limit + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.breach_scan_table(text, text, text, timestamptz, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.breach_scan_table(text, text, text, timestamptz, timestamptz, text, integer) TO service_role;
