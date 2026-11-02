-- One bounded batch of retention work for data-retention-sweep (called in a loop by the edge function).
-- Replaces unbounded PostgREST DELETE/UPDATE ... RETURNING id. service_role only.
CREATE OR REPLACE FUNCTION public.sweep_owned_rows(
  p_table text,
  p_user_id uuid,
  p_date_column text,
  p_cutoff timestamptz,
  p_pii_columns text[] DEFAULT NULL,
  p_batch integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n integer;
  v_col text;
  v_set text;
  v_notnull text;
BEGIN
  IF p_batch < 1 OR p_batch > 50000 THEN
    RAISE EXCEPTION 'p_batch must be between 1 and 50000';
  END IF;
  -- the table must be a public base table that has id, user_id and the date column
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p_table
        AND column_name IN ('id', 'user_id', p_date_column)) < (CASE WHEN p_date_column IN ('id', 'user_id') THEN 2 ELSE 3 END)
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = p_table AND table_type = 'BASE TABLE') THEN
    RAISE EXCEPTION 'table % is not sweepable', p_table;
  END IF;

  IF p_pii_columns IS NULL OR cardinality(p_pii_columns) = 0 THEN
    EXECUTE format(
      'DELETE FROM public.%1$I WHERE id IN (SELECT id FROM public.%1$I WHERE user_id = $1 AND %2$I < $2 LIMIT $3)',
      p_table, p_date_column)
    USING p_user_id, p_cutoff, p_batch;
  ELSE
    FOREACH v_col IN ARRAY p_pii_columns LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = p_table AND column_name = v_col) THEN
        RAISE EXCEPTION 'column % does not exist on %', v_col, p_table;
      END IF;
    END LOOP;
    SELECT string_agg(format('%I = NULL', c), ', '), string_agg(format('%I IS NOT NULL', c), ' OR ')
      INTO v_set, v_notnull FROM unnest(p_pii_columns) AS c;
    EXECUTE format(
      'UPDATE public.%1$I SET %3$s WHERE id IN (SELECT id FROM public.%1$I WHERE user_id = $1 AND %2$I < $2 AND (%4$s) LIMIT $3)',
      p_table, p_date_column, v_set, v_notnull)
    USING p_user_id, p_cutoff, p_batch;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.sweep_owned_rows(text, uuid, text, timestamptz, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_owned_rows(text, uuid, text, timestamptz, text[], integer) TO service_role;
