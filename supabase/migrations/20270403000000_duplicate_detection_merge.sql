-- =============================================================
-- Duplicate detection + merge / 7-day unmerge — customers & leads
--
-- * Detection by normalised phone / email / address (SQL, scoped to the
--   account owner), with "not a duplicate" dismissals
-- * Merge re-parents ALL history: every FK (and every uuid column named
--   customer_id / lead_id) pointing at the merged-away record is
--   discovered from the catalog at merge time, so tables added later are
--   covered automatically
-- * Every moved row is written to a ledger, which makes the merge fully
--   reversible for 7 days; a daily job then finalises (deletes) the
--   merged-away record
-- * Merged-away rows are hidden from every existing query by a
--   RESTRICTIVE select policy (same technique as the trash)
--
-- Depends on: 20270402000000_trash_soft_delete.sql (deleted_at columns),
--   get_account_owner_id(), audit_log, has_active_legal_hold(),
--   profiles, team_members, custom_roles.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'deleted_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'deleted_at') THEN
    RAISE EXCEPTION 'Run the trash migration (20270402000000) first: customers/leads need deleted_at.';
  END IF;
END $$;

-- 1. Columns + hide merged-away rows ---------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'leads'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS merged_into_id uuid', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS merged_at timestamptz', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_merged_into ON public.%I (merged_into_id) WHERE merged_into_id IS NOT NULL', t, t);
    EXECUTE format('DROP POLICY IF EXISTS dup_hide_merged ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY dup_hide_merged ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (merged_into_id IS NULL)', t);
  END LOOP;
END $$;

-- A merged-away customer must not hold on to a phone/email the survivor now owns.
DROP INDEX IF EXISTS public.idx_customers_user_phone_unique;
CREATE UNIQUE INDEX idx_customers_user_phone_unique
  ON public.customers (user_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL;

DROP INDEX IF EXISTS public.idx_customers_user_email_unique;
CREATE UNIQUE INDEX idx_customers_user_email_unique
  ON public.customers (user_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL;

-- 2. Ledger tables ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.record_merges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('customers', 'leads')),
  survivor_id      uuid NOT NULL,
  merged_id        uuid NOT NULL,
  merged_by        uuid,
  merged_by_email  text,
  merged_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'merged' CHECK (status IN ('merged', 'unmerged', 'finalized')),
  survivor_before  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {before:{col:val}, after:{col:val}}
  merged_snapshot  jsonb NOT NULL,                       -- full merged-away row at merge time
  moved            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {table: rows moved}
  skipped          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {table: rows left behind (unique clash)}
  irreversible     text[] NOT NULL DEFAULT '{}',         -- tables moved without a ledger (no single-column PK)
  unmerged_at      timestamptz,
  unmerged_by      uuid
);
CREATE INDEX IF NOT EXISTS idx_record_merges_user_status ON public.record_merges (user_id, status, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_merges_expiry ON public.record_merges (expires_at) WHERE status = 'merged';

CREATE TABLE IF NOT EXISTS public.record_merge_moves (
  id          bigserial PRIMARY KEY,
  merge_id    uuid NOT NULL REFERENCES public.record_merges(id) ON DELETE CASCADE,
  table_name  text NOT NULL,
  column_name text NOT NULL,
  pk_column   text NOT NULL,
  pk_type     text NOT NULL,
  row_ids     text[] NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_record_merge_moves_merge ON public.record_merge_moves (merge_id);

CREATE TABLE IF NOT EXISTS public.duplicate_dismissals (
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('customers', 'leads')),
  a_id         uuid NOT NULL,
  b_id         uuid NOT NULL,
  dismissed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, a_id, b_id),
  CHECK (a_id < b_id)
);

ALTER TABLE public.record_merges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.record_merge_moves   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duplicate_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_record_merges ON public.record_merges;
CREATE POLICY select_own_record_merges ON public.record_merges
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client policies on the moves ledger or dismissals: RPC-only.

-- 3. Normalisers (IMMUTABLE, pure) -----------------------------------------
CREATE OR REPLACE FUNCTION public.dup_norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH d AS (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS x),
       n AS (SELECT CASE WHEN length(x) >= 10 THEN right(x, 10) ELSE x END AS x FROM d)
  SELECT CASE WHEN length(x) < 7 OR x ~ '^(\d)\1+$' THEN NULL ELSE x END FROM n
$$;

CREATE OR REPLACE FUNCTION public.dup_norm_email(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(btrim(coalesce(p, ''))) >= 5 AND p LIKE '%@%' THEN lower(btrim(p)) END
$$;

CREATE OR REPLACE FUNCTION public.dup_norm_address(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH a AS (SELECT regexp_replace(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9 ]+', ' ', 'g')), '\s+', ' ', 'g') AS x),
       c AS (
         SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
                  x,
                  '\mstreet\M', 'st', 'g'), '\mavenue\M', 'ave', 'g'), '\mroad\M', 'rd', 'g'), '\mdrive\M', 'dr', 'g'),
                  '\mlane\M', 'ln', 'g'), '\mboulevard\M', 'blvd', 'g'), '\mcourt\M', 'ct', 'g') AS x
         FROM a
       )
  SELECT CASE WHEN length(x) >= 8 AND x ~ '\d' AND x ~ '[a-z]' THEN x END FROM c
$$;

-- 4. Permission + dependents discovery -------------------------------------
-- Same gate as the client (src/lib/duplicates.ts): owner or can_view_billing.
CREATE OR REPLACE FUNCTION public.can_manage_duplicates()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE (tm.user_id = auth.uid()
             OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND (COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
             OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true')
    );
$$;

-- Every public table column that points at a customer / lead: real foreign
-- keys plus bare uuid columns literally named customer_id / lead_id.
CREATE OR REPLACE FUNCTION public.dup_dependents(p_kind text)
RETURNS TABLE (table_name text, column_name text, pk_column text, pk_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH parent AS (
    SELECT CASE p_kind WHEN 'customers' THEN 'public.customers'::regclass
                       WHEN 'leads'     THEN 'public.leads'::regclass END AS rel,
           CASE p_kind WHEN 'customers' THEN 'customer_id' ELSE 'lead_id' END AS conv
  ), fk AS (
    SELECT c.conrelid AS relid, a.attname AS col
    FROM parent p
    JOIN pg_constraint c ON c.confrelid = p.rel AND c.contype = 'f' AND cardinality(c.conkey) = 1
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  ), named AS (
    SELECT cl.oid AS relid, a.attname AS col
    FROM parent p
    JOIN pg_namespace n ON n.nspname = 'public'
    JOIN pg_class cl ON cl.relnamespace = n.oid AND cl.relkind = 'r'
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
                       AND a.attname = p.conv AND a.atttypid = 'uuid'::regtype
  ), cols AS (
    SELECT relid, col FROM fk UNION SELECT relid, col FROM named
  )
  SELECT cl.relname::text, cols.col::text, pk.attname::text, format_type(pk.atttypid, NULL)::text
  FROM cols
  JOIN pg_class cl ON cl.oid = cols.relid AND cl.relkind = 'r'
  JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_index i ON i.indrelid = cl.oid AND i.indisprimary AND i.indnatts = 1
  LEFT JOIN pg_attribute pk ON pk.attrelid = cl.oid AND pk.attnum = i.indkey[0]
  WHERE cl.relname NOT IN ('record_merges', 'record_merge_moves', 'duplicate_dismissals', 'audit_log')
  ORDER BY cl.relname, cols.col
$$;

-- 5. Detection -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_duplicate_pairs(
  p_kind text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0
)
RETURNS TABLE (
  kind text, a_id uuid, b_id uuid, reasons text[], confidence text, score integer,
  a jsonb, b jsonb, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_addr  text;
  v_json  text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('customers', 'leads') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'customers' THEN
    v_addr := 'address';
    v_json := 'jsonb_build_object(''id'',id,''name'',name,''phone'',phone,''email'',email,''address'',address,''customer_type'',customer_type,''created_at'',created_at)';
  ELSE
    v_addr := 'NULL::text';
    v_json := 'jsonb_build_object(''id'',id,''name'',name,''phone'',phone,''email'',email,''service_interested'',service_interested,''notes'',notes,''stage'',stage,''created_at'',created_at)';
  END IF;

  -- Keys shared by more than 8 records are placeholders (e.g. a fake number), not duplicates.
  RETURN QUERY EXECUTE format($q$
    WITH base AS (
      SELECT t.id, lower(btrim(t.name)) AS nk,
             public.dup_norm_phone(t.phone)   AS pk,
             public.dup_norm_email(t.email)   AS ek,
             public.dup_norm_address(%2$s)    AS ak,
             (%3$s)                           AS j
      FROM public.%1$I t
      WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.merged_into_id IS NULL
    ), keys AS (
      SELECT 'phone'::text AS reason, pk AS k, id FROM base WHERE pk IS NOT NULL
      UNION ALL SELECT 'email', ek, id FROM base WHERE ek IS NOT NULL
      UNION ALL SELECT 'address', ak, id FROM base WHERE ak IS NOT NULL
    ), shared AS (
      SELECT reason, k FROM keys GROUP BY reason, k HAVING count(*) BETWEEN 2 AND 8
    ), pairs AS (
      SELECT x.id AS a_id, y.id AS b_id, x.reason
      FROM keys x
      JOIN shared s ON s.reason = x.reason AND s.k = x.k
      JOIN keys y ON y.reason = x.reason AND y.k = x.k AND x.id < y.id
    ), agg AS (
      SELECT a_id, b_id, array_agg(DISTINCT reason ORDER BY reason) AS reasons
      FROM pairs GROUP BY a_id, b_id
    ), scored AS (
      SELECT g.a_id, g.b_id, g.reasons,
             (CASE WHEN 'phone'   = ANY(g.reasons) THEN 50 ELSE 0 END
            + CASE WHEN 'email'   = ANY(g.reasons) THEN 50 ELSE 0 END
            + CASE WHEN 'address' = ANY(g.reasons) THEN 25 ELSE 0 END
            + CASE WHEN ba.nk = bb.nk THEN 20 ELSE 0 END)::integer AS score,
             ba.j AS a, bb.j AS b
      FROM agg g
      JOIN base ba ON ba.id = g.a_id
      JOIN base bb ON bb.id = g.b_id
      WHERE NOT EXISTS (
        SELECT 1 FROM public.duplicate_dismissals d
        WHERE d.user_id = $1 AND d.kind = $2 AND d.a_id = g.a_id AND d.b_id = g.b_id)
    )
    SELECT $2::text, s.a_id, s.b_id, s.reasons,
           CASE WHEN s.reasons && ARRAY['phone', 'email'] THEN 'high' ELSE 'medium' END::text,
           s.score, s.a, s.b, count(*) OVER ()
    FROM scored s
    ORDER BY s.score DESC, s.a_id, s.b_id
    LIMIT $3 OFFSET $4
  $q$, p_kind, v_addr, v_json)
  USING v_owner, p_kind, LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50), GREATEST(COALESCE(p_offset, 0), 0);
END $$;

CREATE OR REPLACE FUNCTION public.duplicate_counts()
RETURNS TABLE (kind text, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE k text; v bigint;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  FOREACH k IN ARRAY ARRAY['customers', 'leads'] LOOP
    SELECT COALESCE(max(f.total_count), 0) INTO v FROM public.find_duplicate_pairs(k, 1, 0) f;
    kind := k; n := v; RETURN NEXT;
  END LOOP;
END $$;

-- How much history hangs off one record (for the side-by-side view).
CREATE OR REPLACE FUNCTION public.duplicate_related_counts(p_kind text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d       record;
  v_n     bigint;
  v_out   jsonb := '{}'::jsonb;
  v_ok    boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('customers', 'leads') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND user_id = $2)', p_kind)
    INTO v_ok USING p_id, v_owner;
  IF NOT v_ok THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  FOR d IN SELECT * FROM public.dup_dependents(p_kind) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', d.table_name, d.column_name) INTO v_n USING p_id;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_object(d.table_name, COALESCE((v_out ->> d.table_name)::bigint, 0) + v_n);
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION public.dismiss_duplicate_pair(p_kind text, p_a uuid, p_b uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cnt   integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('customers', 'leads') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN RAISE EXCEPTION 'same_record' USING ERRCODE = '22023'; END IF;
  EXECUTE format('SELECT count(*) FROM public.%I WHERE id = ANY($1) AND user_id = $2', p_kind)
    INTO v_cnt USING ARRAY[p_a, p_b], v_owner;
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.duplicate_dismissals (user_id, kind, a_id, b_id, dismissed_by)
  VALUES (v_owner, p_kind, LEAST(p_a, p_b), GREATEST(p_a, p_b), auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          'duplicates.dismiss', p_kind, LEAST(p_a, p_b)::text || ',' || GREATEST(p_a, p_b)::text);
END $$;

-- 6. Merge -----------------------------------------------------------------
-- p_choices: {column: 'survivor' | 'merged' | 'both'} ('both' only for notes).
-- Columns not listed keep the survivor's value.
CREATE OR REPLACE FUNCTION public.merge_records(
  p_kind text, p_survivor uuid, p_merged uuid, p_choices jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner    uuid := public.get_account_owner_id();
  v_email    text;
  v_allowed  text[];
  v_merge    uuid := gen_random_uuid();
  v_s        jsonb;
  v_m        jsonb;
  v_before   jsonb := '{}'::jsonb;
  v_after    jsonb := '{}'::jsonb;
  v_moved    jsonb := '{}'::jsonb;
  v_skipped  jsonb := '{}'::jsonb;
  v_irrev    text[] := '{}';
  v_expires  timestamptz := now() + interval '7 days';
  v_col      text;
  v_choice   text;
  v_new      text;
  v_cur      text;
  v_n        bigint;
  v_ids      text[];
  v_locked   integer;
  d          record;
  r          record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('customers', 'leads') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_survivor IS NULL OR p_merged IS NULL OR p_survivor = p_merged THEN
    RAISE EXCEPTION 'same_record' USING ERRCODE = '22023';
  END IF;

  v_allowed := CASE p_kind
    WHEN 'customers' THEN ARRAY['name', 'phone', 'email', 'address', 'customer_type']
    ELSE ARRAY['name', 'phone', 'email', 'service_interested', 'notes'] END;
  v_email := (SELECT email FROM auth.users WHERE id = auth.uid());

  -- Lock both rows in a stable order so concurrent merges can't deadlock.
  EXECUTE format(
    'SELECT count(*) FROM (SELECT id FROM public.%I WHERE id = ANY($1) AND user_id = $2
       AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id FOR UPDATE) x', p_kind)
    INTO v_locked USING ARRAY[p_survivor, p_merged], v_owner;
  IF v_locked <> 2 THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_kind) INTO v_s USING p_survivor;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_kind) INTO v_m USING p_merged;

  -- Resolve the field choices up front (validates input before anything changes).
  FOR v_col, v_choice IN SELECT key, value FROM jsonb_each_text(COALESCE(p_choices, '{}'::jsonb)) LOOP
    IF NOT v_col = ANY (v_allowed) THEN RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023'; END IF;
    IF v_choice NOT IN ('survivor', 'merged', 'both') OR (v_choice = 'both' AND v_col <> 'notes') THEN
      RAISE EXCEPTION 'invalid_choice' USING ERRCODE = '22023';
    END IF;
    v_new := CASE v_choice
      WHEN 'merged' THEN v_m ->> v_col
      WHEN 'both'   THEN concat_ws(E'\n\n', NULLIF(v_s ->> v_col, ''), NULLIF(v_m ->> v_col, ''))
      ELSE v_s ->> v_col END;
    IF v_new IS DISTINCT FROM (v_s ->> v_col) THEN
      v_before := v_before || jsonb_build_object(v_col, v_s -> v_col);
      v_after  := v_after  || jsonb_build_object(v_col, v_new);
    END IF;
  END LOOP;

  INSERT INTO public.record_merges
    (id, user_id, kind, survivor_id, merged_id, merged_by, merged_by_email, expires_at, survivor_before, merged_snapshot)
  VALUES
    (v_merge, v_owner, p_kind, p_survivor, p_merged, auth.uid(), v_email, v_expires,
     jsonb_build_object('before', v_before, 'after', v_after), v_m);

  -- 1) hide the merged-away record first (frees its unique phone/email) ...
  EXECUTE format('UPDATE public.%I SET merged_into_id = $1, merged_at = now() WHERE id = $2', p_kind)
    USING p_survivor, p_merged;

  -- 2) ... then apply the chosen field values to the survivor.
  FOR v_col IN SELECT jsonb_object_keys(v_after) LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2', p_kind, v_col) USING v_after ->> v_col, p_survivor;
  END LOOP;

  -- 3) re-parent every dependent row, recording each moved id for the undo.
  FOR d IN SELECT * FROM public.dup_dependents(p_kind) LOOP
    v_ids := NULL;
    IF d.pk_column IS NULL THEN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2', d.table_name, d.column_name, d.column_name)
        USING p_survivor, p_merged;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        v_moved := v_moved || jsonb_build_object(d.table_name, COALESCE((v_moved ->> d.table_name)::bigint, 0) + v_n);
        v_irrev := array_append(v_irrev, d.table_name);
      END IF;
    ELSE
      BEGIN
        EXECUTE format(
          'WITH m AS (UPDATE public.%1$I SET %2$I = $1 WHERE %2$I = $2 RETURNING %3$I::text AS pk)
           SELECT array_agg(pk) FROM m', d.table_name, d.column_name, d.pk_column)
          INTO v_ids USING p_survivor, p_merged;
      EXCEPTION WHEN unique_violation THEN
        -- The survivor already has an equivalent row (e.g. same equipment serial): move what fits, leave the rest.
        v_ids := '{}';
        FOR r IN EXECUTE format('SELECT %I::text AS pk FROM public.%I WHERE %I = $1', d.pk_column, d.table_name, d.column_name)
                 USING p_merged LOOP
          BEGIN
            EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I::text = $2 AND %I = $3',
                           d.table_name, d.column_name, d.pk_column, d.column_name)
              USING p_survivor, r.pk, p_merged;
            v_ids := array_append(v_ids, r.pk);
          EXCEPTION WHEN unique_violation THEN
            v_skipped := v_skipped || jsonb_build_object(d.table_name, COALESCE((v_skipped ->> d.table_name)::bigint, 0) + 1);
          END;
        END LOOP;
      END;
      IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
        INSERT INTO public.record_merge_moves (merge_id, table_name, column_name, pk_column, pk_type, row_ids)
        VALUES (v_merge, d.table_name, d.column_name, d.pk_column, d.pk_type, v_ids);
        v_moved := v_moved || jsonb_build_object(d.table_name, COALESCE((v_moved ->> d.table_name)::bigint, 0) + cardinality(v_ids));
      END IF;
    END IF;
  END LOOP;

  UPDATE public.record_merges
     SET moved = v_moved, skipped = v_skipped, irreversible = v_irrev
   WHERE id = v_merge;

  DELETE FROM public.duplicate_dismissals
   WHERE user_id = v_owner AND kind = p_kind AND (a_id = p_merged OR b_id = p_merged);

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), v_email, 'duplicates.merge', p_kind, p_survivor::text || '<-' || p_merged::text);

  RETURN jsonb_build_object('merge_id', v_merge, 'moved', v_moved, 'skipped', v_skipped,
                            'irreversible', to_jsonb(v_irrev), 'expires_at', v_expires);
END $$;

-- 7. Unmerge (within 7 days) -----------------------------------------------
CREATE OR REPLACE FUNCTION public.unmerge_records(p_merge_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner    uuid := public.get_account_owner_id();
  v_email    text;
  r          record;
  mv         record;
  v_col      text;
  v_cur      jsonb;
  v_restored jsonb := '{}'::jsonb;
  v_n        bigint;
  v_found    boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_email := (SELECT email FROM auth.users WHERE id = auth.uid());

  SELECT * INTO r FROM public.record_merges WHERE id = p_merge_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'merged' THEN RAISE EXCEPTION 'not_active' USING ERRCODE = '55000'; END IF;
  IF now() >= r.expires_at THEN RAISE EXCEPTION 'merge_window_closed' USING ERRCODE = '55000'; END IF;

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND user_id = $2)', r.kind)
    INTO v_found USING r.survivor_id, v_owner;
  IF NOT v_found THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  -- a) put back survivor fields we changed, unless they were edited since.
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', r.kind) INTO v_cur USING r.survivor_id;
  FOR v_col IN SELECT jsonb_object_keys(r.survivor_before -> 'after') LOOP
    IF (v_cur ->> v_col) IS NOT DISTINCT FROM (r.survivor_before -> 'after' ->> v_col) THEN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2', r.kind, v_col)
        USING r.survivor_before -> 'before' ->> v_col, r.survivor_id;
    END IF;
  END LOOP;

  -- b) bring the merged-away record back.
  BEGIN
    EXECUTE format('UPDATE public.%I SET merged_into_id = NULL, merged_at = NULL WHERE id = $1', r.kind)
      USING r.merged_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'unmerge_conflict' USING ERRCODE = '23505';
  END;

  -- c) hand the history back, but only rows that are still on the survivor.
  FOR mv IN SELECT * FROM public.record_merge_moves WHERE merge_id = p_merge_id LOOP
    IF mv.pk_type = 'uuid' THEN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = ANY($2::uuid[]) AND %I = $3',
                     mv.table_name, mv.column_name, mv.pk_column, mv.column_name)
        USING r.merged_id, mv.row_ids, r.survivor_id;
    ELSE
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I::text = ANY($2) AND %I = $3',
                     mv.table_name, mv.column_name, mv.pk_column, mv.column_name)
        USING r.merged_id, mv.row_ids, r.survivor_id;
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_restored := v_restored || jsonb_build_object(mv.table_name, COALESCE((v_restored ->> mv.table_name)::bigint, 0) + v_n);
    END IF;
  END LOOP;

  DELETE FROM public.record_merge_moves WHERE merge_id = p_merge_id;
  UPDATE public.record_merges SET status = 'unmerged', unmerged_at = now(), unmerged_by = auth.uid() WHERE id = p_merge_id;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), v_email, 'duplicates.unmerge', r.kind, r.survivor_id::text || '<-' || r.merged_id::text);

  RETURN jsonb_build_object('restored', v_restored, 'not_restored', to_jsonb(r.irreversible),
                            'kind', r.kind, 'survivor_id', r.survivor_id, 'merged_id', r.merged_id);
END $$;

CREATE OR REPLACE FUNCTION public.list_recent_merges(p_limit integer DEFAULT 20)
RETURNS TABLE (
  id uuid, kind text, survivor_id uuid, merged_id uuid, survivor_name text, merged_name text,
  merged_at timestamptz, expires_at timestamptz, merged_by_email text, moved_total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.id, m.kind, m.survivor_id, m.merged_id,
         COALESCE(c.name, l.name), m.merged_snapshot ->> 'name',
         m.merged_at, m.expires_at, m.merged_by_email,
         (SELECT COALESCE(sum(value::bigint), 0)::bigint FROM jsonb_each_text(m.moved))
  FROM public.record_merges m
  LEFT JOIN public.customers c ON m.kind = 'customers' AND c.id = m.survivor_id
  LEFT JOIN public.leads l     ON m.kind = 'leads'     AND l.id = m.survivor_id
  WHERE m.user_id = v_owner AND m.status = 'merged' AND m.expires_at > now()
  ORDER BY m.merged_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
END $$;

-- 8. Finalise: after the 7-day window, delete the merged-away record --------
CREATE OR REPLACE FUNCTION public.finalize_expired_merges(p_batch integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       record;
  v_total integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.record_merges m
    WHERE m.status = 'merged' AND m.expires_at <= now()
      AND NOT public.has_active_legal_hold(m.user_id)
    ORDER BY m.expires_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE id = $1 AND merged_into_id = $2', r.kind) USING r.merged_id, r.survivor_id;
    DELETE FROM public.record_merge_moves WHERE merge_id = r.id;
    UPDATE public.record_merges SET status = 'finalized' WHERE id = r.id;
    INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
    VALUES (r.user_id, NULL, 'system:merge-finalize', 'duplicates.merge_finalize', r.kind, r.merged_id::text);
    v_total := v_total + 1;
  END LOOP;
  RETURN v_total;
END $$;

-- 9. Grants ----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.can_manage_duplicates()                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dup_dependents(text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.find_duplicate_pairs(text, integer, integer)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.duplicate_counts()                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.duplicate_related_counts(text, uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dismiss_duplicate_pair(text, uuid, uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merge_records(text, uuid, uuid, jsonb)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unmerge_records(uuid)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_recent_merges(integer)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_expired_merges(integer)              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.can_manage_duplicates()                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_duplicate_pairs(text, integer, integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_counts()                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_related_counts(text, uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_duplicate_pair(text, uuid, uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_records(text, uuid, uuid, jsonb)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.unmerge_records(uuid)                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_recent_merges(integer)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_expired_merges(integer)              TO service_role;
GRANT SELECT ON public.record_merges TO authenticated;

-- 10. Schedule (03:25 UTC daily). No-op where pg_cron isn't enabled. --------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'merge-finalize-daily';
    PERFORM cron.schedule('merge-finalize-daily', '25 3 * * *', 'select public.finalize_expired_merges()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled — schedule select public.finalize_expired_merges() daily yourself.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule merge finalize: %', SQLERRM;
END $$;
