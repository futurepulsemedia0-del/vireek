/*
  # Portal token lifecycle — expiry, rotation, revocation, access log

  ## Problem
  `customers.portal_token` is a bearer credential with no expiry, no way to
  revoke it and no record of use. ~17 token-gated SECURITY DEFINER functions
  resolve it with `FROM customers WHERE portal_token = p_token`.

  ## Design (one credential column, one gate)
  * `customers.portal_token` stays the CURRENT credential, so every existing
    link, index and client keeps working. Nothing is renamed or dropped.
  * `customer_portal_tokens` keeps one row per token ever issued for a
    customer, stored as a SHA-256 hash (same pattern as dashboard_snapshots),
    with expiry / revocation / rotation state.
  * `portal_gate(token, surface)` is the single decision point. It returns the
    customer id only for a live token, and writes a bucketed access-log row.
  * Every function that used the raw lookup is re-pointed at the gate by the
    patcher in section 8, which FAILS THE WHOLE MIGRATION (it is transactional)
    if any token-gated function is left ungated. New functions must call
    `portal_gate` — see supabase/tests/database/portal_token_lifecycle.test.sql.

  ## Token states (all answer the caller with the same NULL/false)
  ok | ok_legacy | expired | revoked | rotated.  Unknown tokens are never logged
  (no tenant to attribute them to, and logging them would let anyone fill the table).

  ## Migration window for existing links
  Existing tokens are backfilled as `legacy` with no expiry. Until
  `portal_token_settings.legacy_cutoff_at` (default: 90 days after this
  migration) they keep working, and the first successful use UPGRADES them to
  the normal policy (idle expiry + absolute cap). After the cutoff, legacy
  tokens that were never used in the window stop working; owners issue a new
  link by rotating. Ops can move the cutoff with a plain UPDATE (see docs).

  ## Rollout / rollback
  Additive except for CREATE OR REPLACE of the gated functions and one storage
  policy. Rollback: re-run the original definitions from the earlier migrations
  (listed in docs/security/portal-token-lifecycle.md). The new tables can stay.

  [COUNSEL] The access log holds no IP address or user agent on purpose. Adding
  either needs a privacy review before it is stored.
*/

-- rollback: re-apply the previous definitions of the gated functions (20260925000000, 20261106000000,
-- 20261109000000, 20261210000000, 20270501000000, 20271001000000, 20271020000000, 20271021000000, 20271102000000,
-- 20271120000000, 20271210000000, 20280110000000, 20290301000000) and 20261210000000's storage policy; then
-- DROP TRIGGER trg_customers_portal_token_insert/_update ON customers. The new tables are additive and may stay.

-- ---------------------------------------------------------------------------
-- 1. Policy (service-role only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_token_settings (
  singleton            boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  idle_ttl_days        integer NOT NULL DEFAULT 180  CHECK (idle_ttl_days BETWEEN 30 AND 1825),
  absolute_ttl_days    integer NOT NULL DEFAULT 730  CHECK (absolute_ttl_days BETWEEN 30 AND 3650),
  legacy_cutoff_at     timestamptz,
  log_retention_days   integer NOT NULL DEFAULT 90   CHECK (log_retention_days BETWEEN 7 AND 1095),
  max_rotations_per_hour integer NOT NULL DEFAULT 10 CHECK (max_rotations_per_hour BETWEEN 1 AND 100),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (absolute_ttl_days >= idle_ttl_days)
);

INSERT INTO public.portal_token_settings (singleton, legacy_cutoff_at)
VALUES (true, now() + interval '90 days')
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.portal_token_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_token_settings FROM PUBLIC, anon, authenticated;
-- No policies: only service_role / the SECURITY DEFINER functions below read it.

-- Who may manage portal links: the account owner, or an owner/admin/billing manager.
CREATE OR REPLACE FUNCTION public.portal_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.get_account_owner_id() IS NOT NULL
     AND (auth.uid() = public.get_account_owner_id() OR public.identity_is_manager());
$$;
REVOKE ALL ON FUNCTION public.portal_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_can_manage() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Token history (hash only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_portal_tokens (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,                       -- tenant = account owner id
  customer_id          uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  token_hash           text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz,                         -- rolling idle expiry; NULL = legacy, not yet upgraded
  absolute_expires_at  timestamptz,                         -- hard cap; NULL = legacy, not yet upgraded
  legacy               boolean NOT NULL DEFAULT false,
  upgraded_at          timestamptz,
  is_current           boolean NOT NULL DEFAULT true,
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  revoked_by           uuid,
  revoke_reason        text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 200),
  rotated_at           timestamptz,
  rotated_by           uuid,
  rotate_reason        text CHECK (rotate_reason IS NULL OR char_length(rotate_reason) <= 40),
  rotate_note          text CHECK (rotate_note IS NULL OR char_length(rotate_note) <= 200)
);

-- Exactly one current token per customer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_portal_tokens_current
  ON public.customer_portal_tokens (customer_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_customer_portal_tokens_owner
  ON public.customer_portal_tokens (user_id, customer_id, issued_at DESC);

ALTER TABLE public.customer_portal_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_portal_tokens FROM PUBLIC, anon, authenticated;
-- token_hash is never selectable by clients.
GRANT SELECT (id, user_id, customer_id, issued_at, expires_at, absolute_expires_at, legacy, upgraded_at,
              is_current, last_used_at, revoked_at, revoked_by, revoke_reason, rotated_at, rotated_by,
              rotate_reason, rotate_note)
  ON public.customer_portal_tokens TO authenticated;

DROP POLICY IF EXISTS "managers_select_own_portal_tokens" ON public.customer_portal_tokens;
CREATE POLICY "managers_select_own_portal_tokens" ON public.customer_portal_tokens
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.portal_can_manage());
-- No INSERT/UPDATE/DELETE policies: every write goes through the functions below.

-- ---------------------------------------------------------------------------
-- 3. Access log (bucketed: one row per token+surface+outcome+minute)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_portal_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL,
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  token_id      uuid NOT NULL REFERENCES public.customer_portal_tokens(id) ON DELETE CASCADE,
  surface       text NOT NULL CHECK (surface ~ '^[a-z0-9_]{1,64}$'),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'ok_legacy', 'expired', 'revoked', 'rotated')),
  bucket        timestamptz NOT NULL,
  hit_count     integer NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_id, surface, outcome, bucket)
);

CREATE INDEX IF NOT EXISTS idx_portal_access_log_owner
  ON public.customer_portal_access_log (user_id, customer_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_access_log_retention
  ON public.customer_portal_access_log (last_seen_at);

ALTER TABLE public.customer_portal_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_portal_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_portal_access_log TO authenticated;

DROP POLICY IF EXISTS "managers_select_own_portal_access_log" ON public.customer_portal_access_log;
CREATE POLICY "managers_select_own_portal_access_log" ON public.customer_portal_access_log
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.portal_can_manage());

-- ---------------------------------------------------------------------------
-- 4. Keep the history in step with customers.portal_token
--    (new customer, owner rotation, soft-delete rotation, undo/restore)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_portal_token_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash   text;
  v_now    timestamptz := now();
  v_idle   integer;
  v_abs    integer;
  v_reason text;
  v_note   text;
BEGIN
  IF NEW.portal_token IS NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_hash := encode(sha256(convert_to(NEW.portal_token::text, 'UTF8')), 'hex');
  SELECT s.idle_ttl_days, s.absolute_ttl_days INTO v_idle, v_abs
  FROM public.portal_token_settings s WHERE s.singleton;
  v_idle := COALESCE(v_idle, 180);
  v_abs  := COALESCE(v_abs, 730);

  IF TG_OP = 'UPDATE' THEN
    v_reason := COALESCE(NULLIF(current_setting('vireek.portal_token_reason', true), ''), 'external_rotation');
    v_note   := NULLIF(left(current_setting('vireek.portal_token_note', true), 200), '');
    UPDATE public.customer_portal_tokens
       SET is_current = false, rotated_at = v_now, rotated_by = auth.uid(),
           rotate_reason = left(v_reason, 40), rotate_note = v_note
     WHERE customer_id = NEW.id AND is_current;
  END IF;

  -- A token that returns (undo of a soft delete) is reinstated, never duplicated.
  -- A revoked token stays revoked: revoked_at is deliberately left alone.
  INSERT INTO public.customer_portal_tokens
    (user_id, customer_id, token_hash, issued_at, expires_at, absolute_expires_at, legacy, is_current)
  VALUES
    (NEW.user_id, NEW.id, v_hash, v_now, v_now + make_interval(days => v_idle),
     v_now + make_interval(days => v_abs), false, true)
  ON CONFLICT (token_hash) DO UPDATE
     SET is_current = true, rotated_at = NULL, rotated_by = NULL, rotate_reason = NULL, rotate_note = NULL
   WHERE public.customer_portal_tokens.customer_id = NEW.id;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.customer_portal_token_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_customers_portal_token_insert ON public.customers;
CREATE TRIGGER trg_customers_portal_token_insert
  AFTER INSERT ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.customer_portal_token_sync();

DROP TRIGGER IF EXISTS trg_customers_portal_token_update ON public.customers;
CREATE TRIGGER trg_customers_portal_token_update
  AFTER UPDATE OF portal_token ON public.customers
  FOR EACH ROW
  WHEN (OLD.portal_token IS DISTINCT FROM NEW.portal_token)
  EXECUTE FUNCTION public.customer_portal_token_sync();

-- Backfill: every existing link keeps working (legacy, upgraded on first use).
INSERT INTO public.customer_portal_tokens
  (user_id, customer_id, token_hash, issued_at, expires_at, absolute_expires_at, legacy, is_current)
SELECT c.user_id, c.id, encode(sha256(convert_to(c.portal_token::text, 'UTF8')), 'hex'),
       COALESCE(c.created_at, now()), NULL, NULL, true, true
FROM public.customers c
WHERE c.portal_token IS NOT NULL AND c.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The gate
--    Returns the customer id for a live token, otherwise NULL (same answer for
--    expired / revoked / rotated / unknown). Callers MUST use it as
--      WHERE id = (SELECT public.portal_gate(p_token, '<surface>'))
--    The scalar sub-select makes it an InitPlan: evaluated once per statement,
--    and the result can drive an index scan even though the gate is VOLATILE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_gate(p_token uuid, p_surface text DEFAULT 'portal')
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash    text;
  v_t       public.customer_portal_tokens%ROWTYPE;
  v_s       public.portal_token_settings%ROWTYPE;
  v_surface text;
  v_outcome text;
  v_now     timestamptz := now();
  v_idle    interval;
  v_abs     interval;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  v_surface := CASE WHEN p_surface ~ '^[a-z0-9_]{1,64}$' THEN p_surface ELSE 'unknown' END;
  v_hash := encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex');

  SELECT * INTO v_t FROM public.customer_portal_tokens WHERE token_hash = v_hash;
  IF NOT FOUND THEN
    -- Self-heal a token that predates (or bypassed) the sync trigger so an
    -- existing link is never broken by bookkeeping. Fails closed on conflict.
    INSERT INTO public.customer_portal_tokens
      (user_id, customer_id, token_hash, issued_at, legacy, is_current)
    SELECT c.user_id, c.id, v_hash, v_now, true, true
    FROM public.customers c
    WHERE c.portal_token = p_token AND c.user_id IS NOT NULL
    ON CONFLICT DO NOTHING;
    SELECT * INTO v_t FROM public.customer_portal_tokens WHERE token_hash = v_hash;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT * INTO v_s FROM public.portal_token_settings WHERE singleton;

  v_outcome := CASE
    WHEN v_t.revoked_at IS NOT NULL THEN 'revoked'
    WHEN NOT v_t.is_current THEN 'rotated'
    WHEN v_t.absolute_expires_at IS NOT NULL AND v_t.absolute_expires_at <= v_now THEN 'expired'
    WHEN v_t.expires_at IS NULL THEN
      CASE WHEN v_s.legacy_cutoff_at IS NOT NULL AND v_s.legacy_cutoff_at <= v_now THEN 'expired' ELSE 'ok_legacy' END
    WHEN v_t.expires_at <= v_now THEN 'expired'
    ELSE 'ok'
  END;

  INSERT INTO public.customer_portal_access_log (user_id, customer_id, token_id, surface, outcome, bucket)
  VALUES (v_t.user_id, v_t.customer_id, v_t.id, v_surface, v_outcome, date_trunc('minute', v_now))
  ON CONFLICT (token_id, surface, outcome, bucket)
  DO UPDATE SET hit_count = public.customer_portal_access_log.hit_count + 1, last_seen_at = v_now;

  IF v_outcome NOT IN ('ok', 'ok_legacy') THEN
    RETURN NULL;
  END IF;

  v_idle := make_interval(days => COALESCE(v_s.idle_ttl_days, 180));
  v_abs  := make_interval(days => COALESCE(v_s.absolute_ttl_days, 730));

  -- Upgrade a legacy token on first use; otherwise slide the idle expiry (at most
  -- one write per minute, and only once ~30 days of the idle window are gone).
  UPDATE public.customer_portal_tokens t
     SET last_used_at = v_now,
         upgraded_at = CASE WHEN v_outcome = 'ok_legacy' THEN v_now ELSE t.upgraded_at END,
         absolute_expires_at = CASE WHEN v_outcome = 'ok_legacy' THEN v_now + v_abs ELSE t.absolute_expires_at END,
         expires_at = CASE
           WHEN v_outcome = 'ok_legacy' THEN LEAST(v_now + v_idle, v_now + v_abs)
           WHEN t.expires_at < v_now + (v_idle - interval '30 days')
             THEN LEAST(v_now + v_idle, COALESCE(t.absolute_expires_at, v_now + v_idle))
           ELSE t.expires_at END
   WHERE t.id = v_t.id
     AND (v_outcome = 'ok_legacy' OR t.last_used_at IS NULL OR t.last_used_at < v_now - interval '1 minute');

  RETURN v_t.customer_id;
END;
$$;
-- Not callable from the API: only the definer functions that embed it may use it
-- (a public gate would be a token oracle and a way to extend expiry).
REVOKE ALL ON FUNCTION public.portal_gate(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Owner / manager actions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_token_rotate(p_customer_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cap   integer;
  v_new   uuid;
  v_row   public.customer_portal_tokens%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.portal_can_manage() THEN
    RAISE EXCEPTION 'Not allowed to manage portal links' USING ERRCODE = '42501';
  END IF;

  -- Serialises concurrent rotate/revoke on the same customer.
  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id AND user_id = v_owner AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.max_rotations_per_hour INTO v_cap FROM public.portal_token_settings s WHERE s.singleton;
  IF (SELECT count(*) FROM public.customer_portal_tokens t
       WHERE t.customer_id = p_customer_id AND t.rotated_at > now() - interval '1 hour') >= COALESCE(v_cap, 10) THEN
    RAISE EXCEPTION 'Too many link changes for this customer. Try again later.' USING ERRCODE = '54000';
  END IF;

  PERFORM set_config('vireek.portal_token_reason', 'owner_rotation', true);
  PERFORM set_config('vireek.portal_token_note', left(COALESCE(btrim(p_reason), ''), 200), true);

  UPDATE public.customers SET portal_token = gen_random_uuid()
   WHERE id = p_customer_id AND user_id = v_owner
   RETURNING portal_token INTO v_new;

  PERFORM set_config('vireek.portal_token_reason', '', true);
  PERFORM set_config('vireek.portal_token_note', '', true);

  SELECT * INTO v_row FROM public.customer_portal_tokens
   WHERE customer_id = p_customer_id AND is_current;

  RETURN jsonb_build_object(
    'token', v_new,
    'token_id', v_row.id,
    'expires_at', v_row.expires_at,
    'absolute_expires_at', v_row.absolute_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_token_revoke(p_customer_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n     integer;
BEGIN
  IF v_owner IS NULL OR NOT public.portal_can_manage() THEN
    RAISE EXCEPTION 'Not allowed to manage portal links' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.customer_portal_tokens
     SET revoked_at = now(), revoked_by = auth.uid(),
         revoke_reason = NULLIF(left(btrim(COALESCE(p_reason, '')), 200), '')
   WHERE customer_id = p_customer_id AND user_id = v_owner AND is_current AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Idempotent: revoking an already-revoked link reports revoked = false.
  RETURN jsonb_build_object('revoked', v_n > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.portal_token_rotate(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_token_revoke(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_token_rotate(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_token_revoke(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Retention (service role / scheduler)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_portal_access_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer;
  v_n    integer;
BEGIN
  SELECT s.log_retention_days INTO v_days FROM public.portal_token_settings s WHERE s.singleton;
  DELETE FROM public.customer_portal_access_log
   WHERE last_seen_at < now() - make_interval(days => COALESCE(v_days, 90));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_portal_access_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_portal_access_log() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-portal-access-log') THEN
    PERFORM cron.schedule('purge-portal-access-log', '17 3 * * *', 'select public.purge_portal_access_log()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped for purge-portal-access-log: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 7b. Storage: the business must still read triage media uploaded under a token
--     that has since been rotated (the folder name is the token that was live then).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_folder_belongs_to_owner(p_folder text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_folder IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.customer_portal_tokens t
    WHERE t.token_hash = encode(sha256(convert_to(p_folder, 'UTF8')), 'hex')
      AND t.user_id = public.get_account_owner_id()
  );
$$;
REVOKE ALL ON FUNCTION public.portal_folder_belongs_to_owner(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_folder_belongs_to_owner(text) TO authenticated;

DROP POLICY IF EXISTS "business_read_own_emergency_triage_media" ON storage.objects;
CREATE POLICY "business_read_own_emergency_triage_media"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'emergency-triage-media'
  AND public.portal_folder_belongs_to_owner((storage.foldername(name))[1])
);

-- ---------------------------------------------------------------------------
-- 8. Re-point every token-gated function at the gate.
--    Works from the LIVE definitions (pg_get_functiondef), so it also covers any
--    drift from the repo. Literal contract being rewritten:
--       [alias.]portal_token = p_token | p_portal_token
--    becomes
--       [alias.|customers.]id = (SELECT public.portal_gate(<param>, '<function name>'))
--    Fails the migration if a candidate is not SECURITY DEFINER or if anything is
--    still ungated afterwards.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_def   text;
  v_new   text;
  v_bad   text;
  c_pat   constant text := '\mportal_token\s*=\s*(p_token|p_portal_token)\M';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND p.proname <> 'portal_gate'
      AND p.prosrc ~ c_pat
      AND p.prosrc !~ 'portal_gate\('
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'portal lifecycle: % is token-gated but not SECURITY DEFINER; review manually', r.sig;
    END IF;

    v_def := pg_get_functiondef(r.oid);
    -- 1) qualified:  c.portal_token = p_token
    v_new := regexp_replace(
      v_def,
      '\m([a-z_][a-z0-9_]*)\.portal_token\s*=\s*(p_token|p_portal_token)\M',
      '\1.id = (SELECT public.portal_gate(\2, ''' || left(r.proname, 64) || '''))',
      'g');
    -- 2) unqualified: portal_token = p_token  (single-table statements)
    v_new := regexp_replace(
      v_new,
      '(^|[^.a-z0-9_])portal_token\s*=\s*(p_token|p_portal_token)\M',
      '\1customers.id = (SELECT public.portal_gate(\2, ''' || left(r.proname, 64) || '''))',
      'g');

    IF v_new = v_def OR v_new !~ 'portal_gate\(' THEN
      RAISE EXCEPTION 'portal lifecycle: could not rewrite %', r.sig;
    END IF;

    EXECUTE v_new;
    -- The gate writes the access log, so a formerly STABLE function must be VOLATILE.
    EXECUTE format('ALTER FUNCTION %s VOLATILE', r.sig);
  END LOOP;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.proname <> 'portal_gate'
    AND p.prosrc ~ c_pat
    AND p.prosrc !~ 'portal_gate\(';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'portal lifecycle: still ungated: %', v_bad;
  END IF;
END $$;

COMMENT ON FUNCTION public.portal_gate(uuid, text) IS
  'Single decision point for customers.portal_token. Returns the customer id for a live token, NULL otherwise; writes customer_portal_access_log. Use as WHERE id = (SELECT public.portal_gate(p_token, ''surface'')).';
COMMENT ON TABLE public.customer_portal_tokens IS
  'One row per portal token ever issued (SHA-256 hash only). customers.portal_token remains the current credential.';
