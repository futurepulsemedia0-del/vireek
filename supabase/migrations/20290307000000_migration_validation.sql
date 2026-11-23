/*
  # Competitor-switching migration program

  Adds:
  - migration_checklist_progress : per account + source, which MANUAL checklist steps are ticked.
  - migration_control_totals     : numbers read off the old system's reports, compared with zero tolerance.
  - migration_validation_snapshot(p_source) : one read-only aggregate query behind the post-import
    validation report (counts, unmatched records, duplicates, money totals).

  Security: tenant = public.get_account_owner_id(). Writes and the snapshot are limited to people who may run
  data imports (public.can_run_data_imports()). The snapshot is SECURITY INVOKER, so RLS on customers / jobs /
  external_* still applies on top of the explicit owner filter. Purely additive and idempotent.

  Rollback: DROP FUNCTION public.migration_validation_snapshot(text);
            DROP TABLE public.migration_control_totals, public.migration_checklist_progress;
*/

CREATE TABLE IF NOT EXISTS public.migration_checklist_progress (
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source text NOT NULL CHECK (source IN ('service_titan', 'jobber', 'housecall_pro', 'csv')),
  step_id text NOT NULL CHECK (step_id ~ '^[a-z0-9_]{1,64}$'),
  done_by uuid DEFAULT auth.uid(),
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, step_id)
);

CREATE TABLE IF NOT EXISTS public.migration_control_totals (
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source text NOT NULL CHECK (source IN ('service_titan', 'jobber', 'housecall_pro', 'csv')),
  totals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(totals) = 'object' AND octet_length(totals::text) <= 4096),
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);

ALTER TABLE public.migration_checklist_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_control_totals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_migration_checklist_progress" ON public.migration_checklist_progress;
CREATE POLICY "select_own_migration_checklist_progress" ON public.migration_checklist_progress
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_migration_checklist_progress" ON public.migration_checklist_progress;
CREATE POLICY "insert_own_migration_checklist_progress" ON public.migration_checklist_progress
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports());

DROP POLICY IF EXISTS "delete_own_migration_checklist_progress" ON public.migration_checklist_progress;
CREATE POLICY "delete_own_migration_checklist_progress" ON public.migration_checklist_progress
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports());

DROP POLICY IF EXISTS "select_own_migration_control_totals" ON public.migration_control_totals;
CREATE POLICY "select_own_migration_control_totals" ON public.migration_control_totals
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_migration_control_totals" ON public.migration_control_totals;
CREATE POLICY "insert_own_migration_control_totals" ON public.migration_control_totals
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports());

DROP POLICY IF EXISTS "update_own_migration_control_totals" ON public.migration_control_totals;
CREATE POLICY "update_own_migration_control_totals" ON public.migration_control_totals
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports());

-- -------------------------------------------------------------------------------------------------
-- Post-import validation snapshot (read-only)
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.migration_validation_snapshot(p_source text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_customers jsonb;
  v_jobs jsonb;
  v_invoices jsonb;
  v_lines jsonb;
  v_payments jsonb;
  v_equipment jsonb;
  v_dup_total integer;
  v_dups jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_run_data_imports() THEN
    RAISE EXCEPTION 'Only the account owner or a member who can edit the business profile may view migration validation' USING ERRCODE = '42501';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('service_titan', 'jobber', 'housecall_pro', 'csv') THEN
    RAISE EXCEPTION 'Unknown source' USING ERRCODE = '22023';
  END IF;

  -- Duplicate groups among ALL of the account's customers that contain at least one imported customer.
  WITH c AS (
    SELECT id, name, coalesce(external_source = p_source, false) AS imported,
      nullif(lower(btrim(email)), '') AS k_email,
      CASE WHEN length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 7
           THEN right(regexp_replace(phone, '\D', '', 'g'), 10) END AS k_phone,
      CASE WHEN nullif(btrim(coalesce(address, '')), '') IS NOT NULL
           THEN lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) || '|' || lower(regexp_replace(btrim(address), '\s+', ' ', 'g')) END AS k_addr
    FROM customers WHERE user_id = v_owner
  ), keys AS (
    SELECT 'email'::text AS kind, k_email AS k, id, name, imported FROM c WHERE k_email IS NOT NULL
    UNION ALL SELECT 'phone', k_phone, id, name, imported FROM c WHERE k_phone IS NOT NULL
    UNION ALL SELECT 'name_address', k_addr, id, name, imported FROM c WHERE k_addr IS NOT NULL
  ), grp AS (
    SELECT kind, k, count(*)::int AS size FROM keys GROUP BY kind, k
    HAVING count(*) > 1 AND bool_or(imported)
  )
  SELECT (SELECT count(*)::int FROM grp),
         coalesce((SELECT jsonb_agg(g.obj) FROM (
           SELECT jsonb_build_object('kind', gr.kind, 'size', gr.size, 'members', (
             SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'imported', m.imported))
             FROM (SELECT * FROM keys kk WHERE kk.kind = gr.kind AND kk.k = gr.k ORDER BY kk.name LIMIT 20) m
           )) AS obj
           FROM grp gr ORDER BY gr.size DESC, gr.kind, gr.k LIMIT 50
         ) g), '[]'::jsonb)
    INTO v_dup_total, v_dups;

  SELECT jsonb_build_object('imported', count(*), 'duplicate_groups_total', v_dup_total, 'duplicate_groups', v_dups)
    INTO v_customers FROM customers WHERE user_id = v_owner AND external_source = p_source;

  SELECT jsonb_build_object(
      'imported', count(*),
      'unlinked_customer', count(*) FILTER (WHERE customer_id IS NULL),
      'without_amount', count(*) FILTER (WHERE invoice_amount IS NULL),
      'revenue_cents', coalesce(sum(round(invoice_amount * 100)), 0)::bigint)
    INTO v_jobs FROM jobs WHERE user_id = v_owner AND external_source = p_source;

  SELECT jsonb_build_object(
      'count', count(*),
      'unlinked_customer', count(*) FILTER (WHERE customer_id IS NULL),
      'unlinked_job', count(*) FILTER (WHERE job_source_id IS NOT NULL AND job_id IS NULL),
      'total_cents', coalesce(sum(total_cents), 0)::bigint,
      'balance_cents', coalesce(sum(balance_cents), 0)::bigint,
      'totals_unverified', count(*) FILTER (WHERE totals_verified IS FALSE))
    INTO v_invoices FROM external_invoices WHERE user_id = v_owner AND source_system = p_source;

  SELECT jsonb_build_object('count', count(*))
    INTO v_lines FROM external_invoice_lines WHERE user_id = v_owner AND source_system = p_source;

  SELECT jsonb_build_object(
      'count', count(*),
      'sum_cents', coalesce(sum(amount_cents), 0)::bigint,
      'unlinked_invoice', count(*) FILTER (WHERE invoice_id IS NULL))
    INTO v_payments FROM external_payments WHERE user_id = v_owner AND source_system = p_source;

  SELECT jsonb_build_object('count', count(*))
    INTO v_equipment FROM equipment WHERE user_id = v_owner AND external_source = p_source;

  RETURN jsonb_build_object('source', p_source, 'customers', v_customers, 'jobs', v_jobs, 'invoices', v_invoices,
                            'line_items', v_lines, 'payments', v_payments, 'equipment', v_equipment);
END;
$$;

REVOKE ALL ON FUNCTION public.migration_validation_snapshot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.migration_validation_snapshot(text) TO authenticated;
