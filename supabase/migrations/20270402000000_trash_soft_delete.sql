-- =============================================================
-- Trash / soft delete — customers, jobs, quotes, invoices, leads
--
-- * deleted_at / deleted_by on each table; 30-day restore window
-- * RESTRICTIVE select policy hides trashed rows from every existing
--   query automatically (no per-query `deleted_at is null` edits)
-- * All trash mutations go through SECURITY DEFINER RPCs that scope to
--   get_account_owner_id(), check permissions, and write audit_log rows
-- * Public quote / invoice links die while the document is in the trash
--   and come back on restore (token is swapped, not edited in place)
-- * Daily pg_cron purge, skipping accounts under a legal hold
--
-- Depends on: get_account_owner_id(), audit_log, has_active_legal_hold(),
--             profiles, team_members, custom_roles.
-- =============================================================

-- 1. Columns, trash indexes, hide-trashed policy ---------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'jobs', 'quotes', 'invoices', 'leads'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_by uuid', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_trash ON public.%I (user_id, deleted_at DESC) WHERE deleted_at IS NOT NULL',
      t, t
    );
    EXECUTE format('DROP POLICY IF EXISTS trash_hide_deleted ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY trash_hide_deleted ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (deleted_at IS NULL)',
      t
    );
  END LOOP;
END $$;

ALTER TABLE public.quotes   ADD COLUMN IF NOT EXISTS trashed_token uuid;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS trashed_token uuid;

-- A trashed customer must not block creating a new one with the same
-- phone/email. (Restoring into a clash is reported, not forced.)
DROP INDEX IF EXISTS public.idx_customers_user_phone_unique;
CREATE UNIQUE INDEX idx_customers_user_phone_unique
  ON public.customers (user_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

DROP INDEX IF EXISTS public.idx_customers_user_email_unique;
CREATE UNIQUE INDEX idx_customers_user_email_unique
  ON public.customers (user_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- 2. Helpers --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trash_retention_days()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;

CREATE OR REPLACE FUNCTION public.trash_assert_kind(p_kind text)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('customers', 'jobs', 'quotes', 'invoices', 'leads') THEN
    RAISE EXCEPTION 'invalid_trash_kind' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trash_token_column(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'quotes' THEN 'quote_token' WHEN 'invoices' THEN 'invoice_token' END
$$;

-- View + restore: account owner, or a team member with can_view_billing
-- (directly or through a custom role). Mirrors the client gate in src/lib/trash.ts.
CREATE OR REPLACE FUNCTION public.can_manage_trash()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE (
              tm.user_id = auth.uid()
              OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
            )
        AND (
              COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
              OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
            )
    );
$$;

-- 3. Soft delete (any account member, same reach as today's DELETE policy)
CREATE OR REPLACE FUNCTION public.soft_delete_records(p_kind text, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tok   text;
  v_set   text;
  v_n     integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.trash_assert_kind(p_kind);
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'too_many_ids' USING ERRCODE = '22023'; END IF;

  v_tok := public.trash_token_column(p_kind);
  v_set := 'deleted_at = now(), deleted_by = auth.uid()';
  IF v_tok IS NOT NULL THEN
    v_set := v_set || format(', trashed_token = %I, %I = gen_random_uuid()', v_tok, v_tok);
  END IF;

  EXECUTE format($q$
    WITH upd AS (
      UPDATE public.%I SET %s
      WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL
      RETURNING id
    ), aud AS (
      INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
      SELECT $2, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
             'trash.soft_delete', $3, upd.id::text
      FROM upd
      RETURNING 1
    )
    SELECT count(*) FROM aud
  $q$, p_kind, v_set) INTO v_n USING p_ids, v_owner, p_kind;

  RETURN v_n;
END $$;

-- 4. Restore ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restore_records(p_kind text, p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner     uuid := public.get_account_owner_id();
  v_tok       text;
  v_set       text;
  v_id        uuid;
  v_rows      integer;
  v_restored  integer := 0;
  v_conflicts integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_trash() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.trash_assert_kind(p_kind);
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN jsonb_build_object('restored', 0, 'conflicts', 0);
  END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'too_many_ids' USING ERRCODE = '22023'; END IF;

  v_tok := public.trash_token_column(p_kind);
  v_set := 'deleted_at = NULL, deleted_by = NULL';
  IF v_tok IS NOT NULL THEN
    v_set := v_set || format(', %I = COALESCE(trashed_token, %I), trashed_token = NULL', v_tok, v_tok);
  END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.%I SET %s WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL',
        p_kind, v_set
      ) USING v_id, v_owner;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        v_restored := v_restored + 1;
        INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
        VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
                'trash.restore', p_kind, v_id::text);
      END IF;
    EXCEPTION WHEN unique_violation THEN
      v_conflicts := v_conflicts + 1; -- e.g. a customer with the same phone/email now exists
    END;
  END LOOP;

  RETURN jsonb_build_object('restored', v_restored, 'conflicts', v_conflicts);
END $$;

-- 5. Permanent delete (account owner only, blocked by legal hold) ---------
CREATE OR REPLACE FUNCTION public.purge_records(p_kind text, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n     integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.trash_assert_kind(p_kind);
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'too_many_ids' USING ERRCODE = '22023'; END IF;
  IF public.has_active_legal_hold(v_owner) THEN
    RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000';
  END IF;

  EXECUTE format($q$
    WITH del AS (
      DELETE FROM public.%I
      WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NOT NULL
      RETURNING id
    ), aud AS (
      INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
      SELECT $2, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
             'trash.purge', $3, del.id::text
      FROM del
      RETURNING 1
    )
    SELECT count(*) FROM aud
  $q$, p_kind) INTO v_n USING p_ids, v_owner, p_kind;

  RETURN v_n;
END $$;

-- 6. Listing ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_trash(
  p_kind   text    DEFAULT NULL,
  p_search text    DEFAULT NULL,
  p_limit  integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  kind text, id uuid, title text, subtitle text,
  deleted_at timestamptz, deleted_by_email text, purge_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_like  text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_trash() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NOT NULL THEN PERFORM public.trash_assert_kind(p_kind); END IF;
  IF NULLIF(btrim(p_search), '') IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN QUERY
  SELECT t.kind, t.id, t.title, t.subtitle, t.deleted_at, u.email::text,
         t.deleted_at + make_interval(days => public.trash_retention_days())
  FROM (
    SELECT 'customers'::text AS kind, c.id, c.name AS title,
           COALESCE(NULLIF(concat_ws(' · ', c.phone, c.email), ''), 'Customer') AS subtitle,
           c.deleted_at, c.deleted_by
    FROM public.customers c WHERE c.user_id = v_owner AND c.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'jobs', j.id, j.customer_name,
           COALESCE(NULLIF(concat_ws(' · ', j.service_type, j.address), ''), 'Job'),
           j.deleted_at, j.deleted_by
    FROM public.jobs j WHERE j.user_id = v_owner AND j.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'quotes', q.id, q.customer_name, concat_ws(' · ', 'Quote', q.status),
           q.deleted_at, q.deleted_by
    FROM public.quotes q WHERE q.user_id = v_owner AND q.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'invoices', i.id, i.customer_name,
           concat_ws(' · ', COALESCE(i.invoice_number, 'Invoice'), i.status),
           i.deleted_at, i.deleted_by
    FROM public.invoices i WHERE i.user_id = v_owner AND i.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'leads', l.id, l.name,
           COALESCE(NULLIF(concat_ws(' · ', l.service_interested, l.phone), ''), 'Lead'),
           l.deleted_at, l.deleted_by
    FROM public.leads l WHERE l.user_id = v_owner AND l.deleted_at IS NOT NULL
  ) t
  LEFT JOIN auth.users u ON u.id = t.deleted_by
  WHERE (p_kind IS NULL OR t.kind = p_kind)
    AND (v_like IS NULL OR t.title ILIKE v_like OR t.subtitle ILIKE v_like)
  ORDER BY t.deleted_at DESC, t.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END $$;

CREATE OR REPLACE FUNCTION public.trash_counts()
RETURNS TABLE (kind text, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_trash() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT 'customers'::text, count(*) FROM public.customers WHERE user_id = v_owner AND deleted_at IS NOT NULL
  UNION ALL SELECT 'jobs',     count(*) FROM public.jobs     WHERE user_id = v_owner AND deleted_at IS NOT NULL
  UNION ALL SELECT 'quotes',   count(*) FROM public.quotes   WHERE user_id = v_owner AND deleted_at IS NOT NULL
  UNION ALL SELECT 'invoices', count(*) FROM public.invoices WHERE user_id = v_owner AND deleted_at IS NOT NULL
  UNION ALL SELECT 'leads',    count(*) FROM public.leads    WHERE user_id = v_owner AND deleted_at IS NOT NULL;
END $$;

-- 7. Purge cron: permanently remove items trashed > retention days ago -----
CREATE OR REPLACE FUNCTION public.purge_expired_trash(p_batch integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t       text;
  v_n     integer;
  v_total integer := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'jobs', 'quotes', 'invoices', 'leads'] LOOP
    EXECUTE format($q$
      WITH doomed AS (
        SELECT x.id FROM public.%1$I x
        WHERE x.deleted_at IS NOT NULL
          AND x.deleted_at < now() - make_interval(days => $1)
          AND NOT public.has_active_legal_hold(x.user_id)
        ORDER BY x.deleted_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      ), del AS (
        DELETE FROM public.%1$I d USING doomed WHERE d.id = doomed.id
        RETURNING d.id, d.user_id
      ), aud AS (
        INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
        SELECT user_id, NULL, 'system:trash-purge', 'trash.purge_expired', $3, id::text FROM del
        RETURNING 1
      )
      SELECT count(*) FROM aud
    $q$, t) INTO v_n USING public.trash_retention_days(), p_batch, t;
    v_total := v_total + COALESCE(v_n, 0);
  END LOOP;
  RETURN v_total;
END $$;

-- 8. Grants ----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.soft_delete_records(text, uuid[])      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_records(text, uuid[])          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_records(text, uuid[])            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_trash(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trash_counts()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_trash()                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_expired_trash(integer)           FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.soft_delete_records(text, uuid[])      TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_records(text, uuid[])          TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_records(text, uuid[])            TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_trash(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trash_counts()                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_trash()                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_trash(integer)           TO service_role;

-- 9. Schedule (03:15 UTC daily). No-op where pg_cron isn't enabled. --------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'trash-purge-daily';
    PERFORM cron.schedule('trash-purge-daily', '15 3 * * *', 'select public.purge_expired_trash()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled — schedule select public.purge_expired_trash() daily yourself.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule trash purge: %', SQLERRM;
END $$;
