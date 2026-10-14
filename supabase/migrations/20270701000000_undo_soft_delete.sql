/*
# Undo for destructive actions: soft delete + restore + audit

Backs the dashboard's 10-second "Undo" toast.

- jobs, leads, customers, quotes, invoices, calls get deleted_at / deleted_by /
  delete_batch_id. A RESTRICTIVE select policy hides soft-deleted rows from every
  client query, join, count and realtime feed, so no page needs a new filter.
- soft_delete_records() / restore_records() are the ONLY write path (SECURITY
  DEFINER). They scope by the same owner rule as each table's existing DELETE
  policy (quotes: auth.uid(); everything else: get_account_owner_id()), isolate
  failures per row, and write the audit_log entry themselves.
- Public share tokens (invoice_token, quote_token, portal_token) are rotated on
  delete and restored on undo, so a deleted record's public link stops working
  without touching any public RPC.
- Unique indexes on customers (phone/email) and invoices (number) become
  partial (deleted_at IS NULL) so a deleted row cannot block re-creating the value.
- purge_soft_deleted() hard-deletes rows after the retention window (service_role only).
- log_bulk_audit_event() whitelist extended with the undo / status_change actions.

Additive except two index rebuilds and one function replacement (same signature).
*/

-- ============================================================================
-- 1. Columns, hidden-by-default policy
-- ============================================================================
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'leads', 'customers', 'quotes', 'invoices', 'calls'] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
         ADD COLUMN IF NOT EXISTS deleted_by uuid,
         ADD COLUMN IF NOT EXISTS delete_batch_id uuid', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (delete_batch_id) WHERE deleted_at IS NOT NULL',
      'idx_' || t || '_soft_deleted', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS hide_soft_deleted ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY hide_soft_deleted ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (deleted_at IS NULL)', t);
  END LOOP;
END $$;

-- ============================================================================
-- 2. Unique values must not be held hostage by deleted rows
-- ============================================================================
DROP INDEX IF EXISTS public.idx_customers_user_phone_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_phone_unique
  ON public.customers (user_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

DROP INDEX IF EXISTS public.idx_customers_user_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_email_unique
  ON public.customers (user_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;

DROP INDEX IF EXISTS public.idx_invoices_number;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number
  ON public.invoices (user_id, invoice_number) WHERE invoice_number IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- 3. Batches (one per soft-delete call) — the handle the Undo toast holds
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.soft_delete_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- account scope used for the delete
  actor_id uuid NOT NULL,
  target_table text NOT NULL,
  target_ids uuid[] NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, -- id -> { "token": <previous public token> }
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone', 'purged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_soft_delete_batches_user_created
  ON public.soft_delete_batches (user_id, created_at DESC);

ALTER TABLE public.soft_delete_batches ENABLE ROW LEVEL SECURITY;

-- Read-only for the account owner (future "Recently deleted" screen). No client writes.
DROP POLICY IF EXISTS "owner_select_soft_delete_batches" ON public.soft_delete_batches;
CREATE POLICY "owner_select_soft_delete_batches"
  ON public.soft_delete_batches FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- 4. soft_delete_records()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.soft_delete_records(
  p_table text,
  p_ids uuid[],
  p_labels text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_scope uuid;
  v_ids uuid[];
  v_id uuid;
  v_batch uuid := gen_random_uuid();
  v_token_col text;
  v_token uuid;
  v_deleted uuid[] := '{}';
  v_failed jsonb := '[]'::jsonb;
  v_snapshot jsonb := '{}'::jsonb;
  v_n integer;
  v_email text;
  v_set text := '';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_table NOT IN ('jobs', 'leads', 'customers', 'quotes', 'invoices', 'calls') THEN
    RAISE EXCEPTION 'invalid table';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_ids, '{}'::uuid[])) AS x);
  IF coalesce(array_length(v_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object('undo_id', NULL, 'deleted', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;
  IF array_length(v_ids, 1) > 1000 THEN
    RAISE EXCEPTION 'too many records (max 1000 per call)';
  END IF;

  -- Mirror each table's existing DELETE policy so soft delete never widens access.
  v_scope := CASE WHEN p_table = 'quotes' THEN v_uid ELSE public.get_account_owner_id() END;
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  v_token_col := CASE p_table
    WHEN 'invoices'  THEN 'invoice_token'
    WHEN 'quotes'    THEN 'quote_token'
    WHEN 'customers' THEN 'portal_token'
    ELSE NULL
  END;
  IF v_token_col IS NOT NULL THEN
    v_set := format(', %I = gen_random_uuid()', v_token_col);
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    BEGIN
      v_token := NULL;
      IF v_token_col IS NOT NULL THEN
        EXECUTE format(
          'SELECT %I FROM public.%I WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE',
          v_token_col, p_table)
          INTO v_token USING v_id, v_scope;
      END IF;

      EXECUTE format(
        'UPDATE public.%I SET deleted_at = now(), deleted_by = $1, delete_batch_id = $2%s
          WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL',
        p_table, v_set)
        USING v_uid, v_batch, v_id, v_scope;
      GET DIAGNOSTICS v_n = ROW_COUNT;

      IF v_n = 1 THEN
        v_deleted := v_deleted || v_id;
        IF v_token IS NOT NULL THEN
          v_snapshot := v_snapshot || jsonb_build_object(v_id::text, jsonb_build_object('token', v_token));
        END IF;
      ELSE
        v_failed := v_failed || jsonb_build_array(
          jsonb_build_object('id', v_id, 'reason', 'Not found or you do not have permission.'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', SQLERRM));
    END;
  END LOOP;

  IF coalesce(array_length(v_deleted, 1), 0) > 0 THEN
    INSERT INTO public.soft_delete_batches (id, user_id, actor_id, target_table, target_ids, snapshot)
    VALUES (v_batch, v_scope, v_uid, p_table, v_deleted, v_snapshot);

    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

    INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
    VALUES (
      v_scope, v_uid, v_email, 'soft_delete', p_table,
      left(array_to_string(v_deleted[1:20], ','), 1000)
        || CASE WHEN array_length(v_deleted, 1) > 20
                THEN ' (+' || (array_length(v_deleted, 1) - 20) || ' more)' ELSE '' END,
      jsonb_build_object(
        'count', array_length(v_deleted, 1),
        'requested', array_length(v_ids, 1),
        'failed', jsonb_array_length(v_failed),
        'undo_id', v_batch,
        'soft', true,
        'labels', to_jsonb(coalesce(p_labels[1:50], '{}'::text[])),
        'target_ids', to_jsonb(v_deleted[1:500]),
        'truncated', array_length(v_deleted, 1) > 500
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'undo_id', CASE WHEN coalesce(array_length(v_deleted, 1), 0) > 0 THEN v_batch ELSE NULL END,
    'deleted', to_jsonb(v_deleted),
    'failed', v_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_records(text, uuid[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_records(text, uuid[], text[]) TO authenticated;

-- ============================================================================
-- 5. restore_records() — the inverse. Idempotent; partial restores are reported.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.restore_records(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_scope uuid;
  v_b public.soft_delete_batches%ROWTYPE;
  v_id uuid;
  v_token_col text;
  v_token uuid;
  v_restored uuid[] := '{}';
  v_failed jsonb := '[]'::jsonb;
  v_n integer;
  v_email text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_b FROM public.soft_delete_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('restored', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;

  v_scope := CASE WHEN v_b.target_table = 'quotes' THEN v_uid ELSE public.get_account_owner_id() END;
  IF v_scope IS NULL OR v_scope <> v_b.user_id THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_b.status <> 'applied' THEN
    RETURN jsonb_build_object('restored', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;

  v_token_col := CASE v_b.target_table
    WHEN 'invoices'  THEN 'invoice_token'
    WHEN 'quotes'    THEN 'quote_token'
    WHEN 'customers' THEN 'portal_token'
    ELSE NULL
  END;

  FOREACH v_id IN ARRAY v_b.target_ids LOOP
    BEGIN
      v_token := NULLIF(v_b.snapshot -> v_id::text ->> 'token', '')::uuid;

      IF v_token_col IS NULL THEN
        EXECUTE format(
          'UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL, delete_batch_id = NULL
            WHERE id = $1 AND user_id = $2 AND delete_batch_id = $3',
          v_b.target_table)
          USING v_id, v_b.user_id, p_batch_id;
      ELSE
        EXECUTE format(
          'UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL, delete_batch_id = NULL,
                 %I = COALESCE($4, %I)
            WHERE id = $1 AND user_id = $2 AND delete_batch_id = $3',
          v_b.target_table, v_token_col, v_token_col)
          USING v_id, v_b.user_id, p_batch_id, v_token;
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;

      IF v_n = 1 THEN
        v_restored := v_restored || v_id;
      ELSE
        v_failed := v_failed || jsonb_build_array(
          jsonb_build_object('id', v_id, 'reason', 'No longer in the deleted state.'));
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        v_failed := v_failed || jsonb_build_array(jsonb_build_object(
          'id', v_id,
          'reason', 'Another record now uses the same phone, email or number.'));
      WHEN OTHERS THEN
        v_failed := v_failed || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', SQLERRM));
    END;
  END LOOP;

  IF jsonb_array_length(v_failed) = 0 THEN
    UPDATE public.soft_delete_batches SET status = 'undone', undone_at = now() WHERE id = p_batch_id;
  END IF;

  IF coalesce(array_length(v_restored, 1), 0) > 0 THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

    INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
    VALUES (
      v_b.user_id, v_uid, v_email, 'undo_delete', v_b.target_table,
      left(array_to_string(v_restored[1:20], ','), 1000)
        || CASE WHEN array_length(v_restored, 1) > 20
                THEN ' (+' || (array_length(v_restored, 1) - 20) || ' more)' ELSE '' END,
      jsonb_build_object(
        'count', array_length(v_restored, 1),
        'failed', jsonb_array_length(v_failed),
        'undo_id', p_batch_id,
        'target_ids', to_jsonb(v_restored[1:500]),
        'truncated', array_length(v_restored, 1) > 500
      )
    );
  END IF;

  RETURN jsonb_build_object('restored', to_jsonb(v_restored), 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_records(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_records(uuid) TO authenticated;

-- ============================================================================
-- 6. purge_soft_deleted() — retention. service_role only (cron / edge function).
--    Hard deletes cascade exactly as the old DELETE did, but only after the window.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.purge_soft_deleted(p_retention interval DEFAULT interval '30 days')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t text;
  v_n integer;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF p_retention < interval '1 day' THEN
    RAISE EXCEPTION 'retention must be at least 1 day';
  END IF;

  FOREACH t IN ARRAY ARRAY['jobs', 'leads', 'customers', 'quotes', 'invoices', 'calls'] LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE deleted_at IS NOT NULL AND deleted_at < now() - $1', t)
        USING p_retention;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_out := v_out || jsonb_build_object(t, v_n);
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_object(t, 'error: ' || SQLERRM);
    END;
  END LOOP;

  UPDATE public.soft_delete_batches
     SET status = 'purged'
   WHERE status = 'applied' AND created_at < now() - p_retention;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_soft_deleted(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_soft_deleted(interval) TO service_role;

-- Optional (needs the pg_cron extension): nightly purge at 03:15 UTC.
-- SELECT cron.schedule('purge-soft-deleted', '15 3 * * *', $$ SELECT public.purge_soft_deleted(interval '30 days') $$);

-- ============================================================================
-- 7. Audit helper: allow the new client-logged actions (same signature as before)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.log_bulk_audit_event(
  p_action text,
  p_target_table text,
  p_target_ids text[],
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_email text;
  v_ids text[] := p_target_ids[1:500];
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_action NOT IN (
    'bulk_delete','bulk_status_change','bulk_assign','bulk_tag_add','bulk_tag_remove','bulk_export',
    'status_change','undo_status_change','undo_assign','undo_tags'
  ) THEN
    RAISE EXCEPTION 'invalid bulk audit action';
  END IF;
  IF p_target_table NOT IN ('jobs','leads','customers','quotes','invoices','calls') THEN
    RAISE EXCEPTION 'invalid bulk audit table';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
  VALUES (
    v_owner, auth.uid(), v_email, p_action, p_target_table,
    left(array_to_string(v_ids[1:20], ','), 1000)
      || CASE WHEN coalesce(array_length(p_target_ids, 1), 0) > 20
           THEN ' (+' || (array_length(p_target_ids, 1) - 20) || ' more)' ELSE '' END,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('target_ids', to_jsonb(v_ids))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_bulk_audit_event(text, text, text[], jsonb) TO authenticated;
