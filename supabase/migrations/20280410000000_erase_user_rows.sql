/*
  Catalog-driven account erasure (gap E4).
  OWNED_TABLES in edge functions covers ~15 tables; this function deletes the user's rows from EVERY
  public base table that has a uuid `user_id` column, so newly added tables are covered automatically.

  Safety:
    * service_role only (EXECUTE revoked from everyone else); SECURITY DEFINER with fixed search_path.
    * refuses to run while a legal hold is active.
    * up to 5 passes so FK ordering resolves itself; tables that still fail are RETURNED in `blocked`
      (never silently skipped) so the caller can retry or alert.
    * evidence/ledger tables are excluded by default (p_exclude) — counsel must decide retention of
      audit/deletion records. Edit the default list deliberately.
  NOT EXECUTED in authoring: run on a staging copy first.
*/

CREATE OR REPLACE FUNCTION public.erase_user_rows(
  p_user uuid,
  p_exclude text[] DEFAULT ARRAY['deletion_requests','data_subject_requests','audit_log','audit_chain_heads','data_retention_policies']
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_pass int;
  v_rows bigint;
  v_deleted jsonb := '{}'::jsonb;
  v_blocked jsonb;
  v_progress boolean;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'p_user is required' USING ERRCODE = '22023';
  END IF;
  IF public.has_active_legal_hold(p_user, NULL) THEN
    RAISE EXCEPTION 'Active legal hold: erasure refused' USING ERRCODE = 'P0001';
  END IF;

  FOR v_pass IN 1..5 LOOP
    v_progress := false;
    v_blocked := '{}'::jsonb;
    FOR r IN
      SELECT c.table_name::text AS t
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public'
         AND c.column_name = 'user_id'
         AND c.data_type = 'uuid'
         AND NOT (c.table_name = ANY (p_exclude))
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', r.t) USING p_user;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
          v_progress := true;
          v_deleted := jsonb_set(v_deleted, ARRAY[r.t], to_jsonb(COALESCE((v_deleted ->> r.t)::bigint, 0) + v_rows));
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_blocked := v_blocked || jsonb_build_object(r.t, SQLERRM);
      END;
    END LOOP;
    EXIT WHEN v_blocked = '{}'::jsonb OR NOT v_progress;
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'blocked', v_blocked);
END;
$$;

REVOKE ALL ON FUNCTION public.erase_user_rows(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_user_rows(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.erase_user_rows(uuid, text[]) IS
  'Deletes a user''s rows from every public table with a uuid user_id column. service_role only. Returns {deleted:{table:n}, blocked:{table:error}}.';
