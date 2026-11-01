/*
  Trust layer: optimistic concurrency + tamper-evident audit trail.

  1. row_version (bigint) on shared records, bumped by trigger on every UPDATE.
     The app writes with `.eq('row_version', <version the user saw>)`; 0 rows
     back = someone else changed it (see src/lib/trust/conflict.ts).
  2. audit_log becomes append-only + hash-chained per account:
       seq / prev_hash / row_hash, server-captured ip_address + user_agent.
     Rows written before this migration keep seq = NULL (they are NOT covered
     by the chain; verification starts at the first protected row).
  3. verify_audit_chain()  — recomputes the chain, detects edits, gaps, tail truncation.
  4. get_record_history()  — per-record History tab (owner only, same as the
     existing audit_log SELECT policy).
  5. audit_row_change() / attach_row_audit() — DB-level before/after capture
     for columns you name (service_role / postgres only; nothing attached here).

  Safe to re-run. Rollback notes at the bottom.
*/

-- 1. Optimistic concurrency -------------------------------------------------

CREATE OR REPLACE FUNCTION public.bump_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Server-owned: ignore whatever the client sent.
  NEW.row_version := COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'leads', 'customers', 'quotes', 'invoices'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'trust_layer: table % not found, skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_bump_row_version ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_bump_row_version BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bump_row_version()', t);
  END LOOP;
END $$;

-- 2. Audit log: columns, chain heads ---------------------------------------

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS prev_hash bytea,
  ADD COLUMN IF NOT EXISTS row_hash bytea,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_user_seq
  ON public.audit_log (user_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_target
  ON public.audit_log (user_id, target_table, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_meta_target_ids
  ON public.audit_log USING gin ((metadata -> 'target_ids'));

CREATE TABLE IF NOT EXISTS public.audit_chain_heads (
  user_id   uuid PRIMARY KEY,
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash bytea  NOT NULL DEFAULT '\x'::bytea
);
ALTER TABLE public.audit_chain_heads ENABLE ROW LEVEL SECURITY; -- no policies: only the SECURITY DEFINER trigger touches it
REVOKE ALL ON public.audit_chain_heads FROM PUBLIC, anon, authenticated;

-- Canonical, unambiguous serialisation (JSON array text is deterministic for jsonb).
CREATE OR REPLACE FUNCTION public.audit_canonical(r public.audit_log)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_array(
    r.user_id, r.seq, r.actor_id, r.actor_email, r.action, r.target_table, r.target_id,
    r.metadata, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.ip_address, r.user_agent
  )::text;
$$;

CREATE OR REPLACE FUNCTION public.audit_log_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_head public.audit_chain_heads;
  v_hdrs jsonb;
BEGIN
  INSERT INTO public.audit_chain_heads (user_id) VALUES (NEW.user_id) ON CONFLICT (user_id) DO NOTHING;
  -- Row lock serialises concurrent inserts for the same account, so seq has no gaps or forks.
  SELECT * INTO v_head FROM public.audit_chain_heads WHERE user_id = NEW.user_id FOR UPDATE;

  -- Where the request came from, captured server-side (never client-supplied).
  BEGIN
    v_hdrs := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_hdrs := NULL;
  END;
  NEW.ip_address := NULLIF(left(btrim(split_part(COALESCE(v_hdrs ->> 'cf-connecting-ip', v_hdrs ->> 'x-forwarded-for', ''), ',', 1)), 64), '');
  NEW.user_agent := NULLIF(left(COALESCE(v_hdrs ->> 'user-agent', ''), 300), '');

  NEW.seq       := v_head.last_seq + 1;
  NEW.prev_hash := v_head.last_hash;
  NEW.row_hash  := sha256(NEW.prev_hash || convert_to(public.audit_canonical(NEW), 'UTF8'));

  UPDATE public.audit_chain_heads SET last_seq = NEW.seq, last_hash = NEW.row_hash WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_chain ON public.audit_log;
CREATE TRIGGER trg_audit_log_chain BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();

CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON public.audit_log;
CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM PUBLIC, anon, authenticated;

-- 3. Verification ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.verify_audit_chain(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_target uuid := COALESCE(p_user_id, auth.uid());
  r public.audit_log;
  v_expected_seq bigint := NULL;
  v_prev bytea := '\x'::bytea;
  v_n bigint := 0;
  v_head public.audit_chain_heads;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  -- End users may only verify their own account; service_role/postgres (auth.uid() IS NULL) may verify any.
  IF auth.uid() IS NOT NULL AND v_target IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  FOR r IN SELECT * FROM public.audit_log WHERE user_id = v_target AND seq IS NOT NULL ORDER BY seq LOOP
    IF v_expected_seq IS NULL THEN v_expected_seq := r.seq; END IF;
    IF v_n = 0 AND r.seq <> 1 THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'missing_head'::text; RETURN;
    END IF;
    IF r.seq <> v_expected_seq THEN
      RETURN QUERY SELECT false, v_n, v_expected_seq, 'gap'::text; RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'broken_link'::text; RETURN;
    END IF;
    IF r.row_hash IS DISTINCT FROM sha256(r.prev_hash || convert_to(public.audit_canonical(r), 'UTF8')) THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'row_modified'::text; RETURN;
    END IF;
    v_prev := r.row_hash;
    v_expected_seq := r.seq + 1;
    v_n := v_n + 1;
  END LOOP;

  SELECT * INTO v_head FROM public.audit_chain_heads WHERE user_id = v_target;
  IF FOUND AND (v_head.last_seq <> COALESCE(v_expected_seq - 1, 0) OR v_head.last_hash IS DISTINCT FROM v_prev) THEN
    RETURN QUERY SELECT false, v_n, v_head.last_seq, 'tail_truncated'::text; RETURN;
  END IF;

  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_audit_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_audit_chain(uuid) TO authenticated, service_role;

-- 4. Per-record history (owner only — same reach as the audit_log SELECT policy)

CREATE OR REPLACE FUNCTION public.get_record_history(p_table text, p_id text, p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, created_at timestamptz, actor_email text, action text, metadata jsonb, ip_address text, user_agent text, seq bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_table NOT IN ('jobs', 'leads', 'customers', 'quotes', 'invoices', 'calls') THEN
    RAISE EXCEPTION 'unsupported table' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR length(p_id) > 64 THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;

  RETURN QUERY
  SELECT a.id, a.created_at, a.actor_email, a.action, a.metadata, a.ip_address, a.user_agent, a.seq
    FROM public.audit_log a
   WHERE a.user_id = auth.uid()            -- owner only, mirrors owner_select_audit_log
     AND a.target_table = p_table
     AND (a.target_id = p_id OR (a.metadata -> 'target_ids') ? p_id)
   ORDER BY a.created_at DESC, a.seq DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.get_record_history(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_record_history(text, text, integer) TO authenticated;

-- 5. DB-level before/after capture (opt-in per table) ----------------------

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_changes jsonb;
  v_owner uuid := COALESCE(v_new ->> 'user_id', v_old ->> 'user_id')::uuid;
BEGIN
  SELECT jsonb_object_agg(c, jsonb_build_object('from', v_old -> c, 'to', v_new -> c))
    INTO v_changes
    FROM unnest(TG_ARGV) AS c
   WHERE v_old -> c IS DISTINCT FROM v_new -> c;

  IF v_changes IS NOT NULL AND v_owner IS NOT NULL THEN
    PERFORM public.log_audit_event(v_owner, TG_TABLE_NAME || '.updated', TG_TABLE_NAME, COALESCE(v_new ->> 'id', v_old ->> 'id'), jsonb_build_object('changes', v_changes));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_row_audit(p_table text, p_columns text[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE c text;
BEGIN
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN RAISE EXCEPTION 'table % not found', p_table; END IF;
  FOREACH c IN ARRAY p_columns LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = p_table AND column_name = c) THEN
      RAISE EXCEPTION 'column %.% not found', p_table, c;
    END IF;
  END LOOP;
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_row_change ON public.%I', p_table);
  EXECUTE format(
    'CREATE TRIGGER trg_audit_row_change AFTER UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(%s)',
    p_table, (SELECT string_agg(quote_literal(x), ', ') FROM unnest(p_columns) x)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_row_audit(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_row_audit(text, text[]) TO service_role;

/*
  ROLLBACK (manual, if ever needed):
    DROP TRIGGER trg_audit_log_chain, trg_audit_log_append_only, trg_audit_log_no_truncate ON public.audit_log;
    DROP TRIGGER trg_bump_row_version ON public.<table>;  -- per table
    (columns can stay; they are additive)
*/
