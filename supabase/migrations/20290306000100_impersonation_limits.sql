/*
# Staff impersonation: enforced limits

Read first: docs/security/staff-impersonate-grant-gate.md ("Known limit": the magic link produced an ordinary owner
session, expires_at was only recorded). Requires 20290306000000_membership_identity_unification.sql (get_account_owner_id()
now delegates to _membership_owner_id()).

## How it works
1. staff-impersonate creates the session row (unchanged) and returns a one-time magic link.
2. When that link is consumed, Supabase Auth calls public.custom_access_token_hook(). The hook binds the FIRST magic-link
   token of the target user to the open session row (auth_session_id) and stamps the JWT with
       "imp": { "sid": <session row>, "staff": <staff id>, "exp": <unix> }   and caps the token's own "exp" at expires_at.
   Every later token (refresh) of that auth session carries the same claim; once the row is ended/expired the hook
   REFUSES to mint a token, so the session cannot be refreshed past expiry.
3. Server-side enforcement does not trust the claim's own "exp": public.impersonation_expired() re-checks the row.
   - get_account_owner_id() returns NULL for an expired/ended impersonation => every policy built on it denies.
   - RESTRICTIVE policies block credential/secret tables entirely and money tables for writes while impersonating.
   - can_export_data() is false while impersonating.
   - The sweeper (pg_cron, every minute) and the RPCs close sessions and DELETE the underlying auth.sessions row, so
     GoTrue-validated calls (all edge functions use auth.getUser(jwt)) stop at once, not at access-token expiry.
4. Edge functions that move money / touch credentials / export data call _shared/security/impersonation.ts, which blocks and
   writes staff_audit_log + the customer's audit_log (a DB exception would roll its own audit row back, so blocking
   audits are written from the edge layer).

## Operator steps (not done by SQL)
- Enable the hook: supabase/config.toml [auth.hook.custom_access_token] (local) and Dashboard > Authentication > Hooks
  (hosted) -> Postgres function public.custom_access_token_hook.   [VERIFY] on a staging project.
- Then set IMPERSONATION_CLAIMS_ENABLED=true on the staff-impersonate function. Until then it refuses to start sessions
  (fail closed: an unmarked session would be indistinguishable from the owner's).
- [VERIFY] the exact authentication_method value GoTrue passes for a magic-link verification; the list below is a constant.

## Rollback
Disable the hook, drop the RESTRICTIVE policies named imp_block_*, re-run 20281103000000 / 20290306000000 definitions of
get_account_owner_id()/can_export_data(). Added columns are harmless.
*/

-- ---------------------------------------------------------------------------
-- 1. Session table: bind to the Supabase auth session, record why it ended
-- ---------------------------------------------------------------------------
ALTER TABLE public.staff_impersonation_sessions
  ADD COLUMN IF NOT EXISTS auth_session_id uuid,
  ADD COLUMN IF NOT EXISTS bound_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_reason text;

-- Close what can no longer be valid, then keep only one open session per target (the newest).
UPDATE public.staff_impersonation_sessions
   SET ended_at = expires_at, end_reason = 'expired'
 WHERE ended_at IS NULL AND expires_at <= now();

UPDATE public.staff_impersonation_sessions s
   SET ended_at = now(), end_reason = 'superseded'
 WHERE s.ended_at IS NULL
   AND s.id NOT IN (
     SELECT DISTINCT ON (target_account_id) id
       FROM public.staff_impersonation_sessions
      WHERE ended_at IS NULL
      ORDER BY target_account_id, started_at DESC
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_imp_open_per_target
  ON public.staff_impersonation_sessions (target_account_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_imp_auth_session
  ON public.staff_impersonation_sessions (auth_session_id) WHERE auth_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Audit vocabulary
-- ---------------------------------------------------------------------------
ALTER TABLE public.staff_audit_log DROP CONSTRAINT IF EXISTS staff_audit_log_action_check;
ALTER TABLE public.staff_audit_log ADD CONSTRAINT staff_audit_log_action_check CHECK (action IN (
  'explorer_list', 'account_view', 'impersonation_start', 'impersonation_end', 'impersonation_denied',
  'impersonation_bound', 'impersonation_expired', 'impersonation_blocked'
));

-- ---------------------------------------------------------------------------
-- 3. Request-level helpers
-- ---------------------------------------------------------------------------
-- True when the caller's JWT carries the impersonation marker (set only by the access-token hook).
CREATE OR REPLACE FUNCTION public.is_impersonating()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT (auth.jwt() -> 'imp') IS NOT NULL;
$$;
GRANT EXECUTE ON FUNCTION public.is_impersonating() TO anon, authenticated, service_role;

-- True when the JWT is marked as impersonation but its session row is missing, ended or past expires_at.
-- Does not trust the claim's own exp.
CREATE OR REPLACE FUNCTION public.impersonation_expired()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN (auth.jwt() -> 'imp') IS NULL THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM staff_impersonation_sessions s
       WHERE s.id = NULLIF(auth.jwt() -> 'imp' ->> 'sid', '')::uuid
         AND s.ended_at IS NULL
         AND s.expires_at > now()
    )
  END;
$$;
GRANT EXECUTE ON FUNCTION public.impersonation_expired() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assert_not_impersonating(p_action text DEFAULT 'this action')
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF public.is_impersonating() THEN
    RAISE EXCEPTION 'Not available during a support session: %', p_action USING ERRCODE = '42501';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.assert_not_impersonating(text) TO authenticated, service_role;

-- Kill switch: an expired/ended impersonation resolves to NO account, so every policy built on it denies.
CREATE OR REPLACE FUNCTION public.get_account_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.impersonation_expired() THEN NULL
    ELSE public._membership_owner_id(auth.uid())
  END;
$$;
GRANT EXECUTE ON FUNCTION public.get_account_owner_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Closing a session (single code path: staff end, banner end, sweeper, link failure)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._impersonation_close(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.staff_impersonation_sessions%ROWTYPE;
  v_action text;
BEGIN
  UPDATE staff_impersonation_sessions
     SET ended_at = CASE WHEN p_reason = 'expired' THEN LEAST(now(), expires_at) ELSE now() END,
         end_reason = p_reason
   WHERE id = p_id AND ended_at IS NULL
   RETURNING * INTO v;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v.auth_session_id IS NOT NULL THEN
    BEGIN
      DELETE FROM auth.sessions WHERE id = v.auth_session_id;  -- also invalidates its refresh tokens
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'impersonation: could not revoke auth session %: %', v.auth_session_id, SQLERRM;
    END;
  END IF;

  v_action := CASE WHEN p_reason = 'expired' THEN 'impersonation_expired' ELSE 'impersonation_end' END;
  INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, metadata)
  VALUES (v.staff_id, NULL, v_action, v.target_account_id,
          jsonb_build_object('session_id', v.id, 'reason', p_reason, 'auth_session_revoked', v.auth_session_id IS NOT NULL));
  INSERT INTO audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v.target_account_id, v.staff_id, 'Vireek Support',
          CASE WHEN p_reason = 'expired' THEN 'staff_impersonation_expired' ELSE 'staff_impersonation_ended' END,
          'profiles', v.target_account_id::text);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public._impersonation_close(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._impersonation_close(uuid, text) TO service_role;

-- Edge function (service_role) entry point.
CREATE OR REPLACE FUNCTION public.impersonation_close(p_session uuid, p_reason text DEFAULT 'staff_ended')
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._impersonation_close(
    p_session,
    CASE WHEN p_reason IN ('staff_ended', 'link_failed', 'superseded', 'expired') THEN p_reason ELSE 'staff_ended' END);
$$;
REVOKE ALL ON FUNCTION public.impersonation_close(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.impersonation_close(uuid, text) TO service_role;

-- Banner "End support session": callable with the impersonated token itself; acts only on the session in its own claim.
CREATE OR REPLACE FUNCTION public.impersonation_end_current()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sid uuid := NULLIF(auth.jwt() -> 'imp' ->> 'sid', '')::uuid;
BEGIN
  IF v_sid IS NULL THEN
    RETURN false;
  END IF;
  RETURN public._impersonation_close(v_sid, 'banner_ended');
END;
$$;
REVOKE ALL ON FUNCTION public.impersonation_end_current() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.impersonation_end_current() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Auth hook: mark + bind + cap + refuse-after-expiry
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- [VERIFY] authentication_method values GoTrue reports when a magic link is verified.
  c_bind_methods constant text[] := ARRAY['magiclink', 'otp'];
  v_uid uuid := NULLIF(event ->> 'user_id', '')::uuid;
  v_claims jsonb := COALESCE(event -> 'claims', '{}'::jsonb);
  v_sid uuid := NULLIF(v_claims ->> 'session_id', '')::uuid;
  v_method text := event ->> 'authentication_method';
  v_row staff_impersonation_sessions%ROWTYPE;
  v_found boolean := false;
  v_cap bigint;
  v_token_exp bigint;
  c_denied constant jsonb := jsonb_build_object('error',
    jsonb_build_object('http_code', 403, 'message', 'The support session has ended.'));
BEGIN
  IF v_uid IS NULL THEN
    RETURN event;
  END IF;

  IF v_sid IS NOT NULL THEN
    SELECT * INTO v_row FROM staff_impersonation_sessions WHERE auth_session_id = v_sid;
    v_found := FOUND;
  END IF;

  IF v_found THEN
    -- Already-bound session (refresh): never mint a token past the end.
    IF v_row.ended_at IS NOT NULL OR v_row.expires_at <= now() THEN
      RETURN c_denied;
    END IF;
  ELSIF v_sid IS NOT NULL AND v_method = ANY (c_bind_methods) THEN
    -- First magic-link token of the target user while a support session is open and not yet bound.
    SELECT * INTO v_row
      FROM staff_impersonation_sessions
     WHERE target_account_id = v_uid
       AND ended_at IS NULL
       AND auth_session_id IS NULL
       AND expires_at > now()
     ORDER BY started_at DESC
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF FOUND THEN
      UPDATE staff_impersonation_sessions SET auth_session_id = v_sid, bound_at = now() WHERE id = v_row.id;
      INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, metadata)
      VALUES (v_row.staff_id, NULL, 'impersonation_bound', v_row.target_account_id,
              jsonb_build_object('session_id', v_row.id, 'auth_session_id', v_sid, 'method', v_method));
      v_found := true;
    END IF;
  END IF;

  IF NOT v_found THEN
    RETURN event;
  END IF;

  v_cap := floor(extract(epoch FROM v_row.expires_at))::bigint;
  v_claims := v_claims || jsonb_build_object('imp', jsonb_build_object(
    'sid', v_row.id, 'staff', v_row.staff_id, 'exp', v_cap));

  -- Defence in depth: the access token itself never outlives the support session. [VERIFY] GoTrue signs the hook's exp.
  v_token_exp := NULLIF(v_claims ->> 'exp', '')::bigint;
  IF v_token_exp IS NULL OR v_token_exp > v_cap THEN
    v_claims := jsonb_set(v_claims, '{exp}', to_jsonb(v_cap));
  END IF;

  RETURN jsonb_set(event, '{claims}', v_claims);
EXCEPTION WHEN OTHERS THEN
  -- A hook bug must not lock every customer out, but it must never yield an UNMARKED support session.
  IF v_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM staff_impersonation_sessions WHERE target_account_id = v_uid AND ended_at IS NULL
  ) THEN
    RETURN c_denied;
  END IF;
  RETURN event;
END;
$$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
END
$grants$;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sweeper: close and revoke everything past expires_at (every minute when pg_cron exists)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.impersonation_sweep_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT id FROM staff_impersonation_sessions WHERE ended_at IS NULL AND expires_at <= now() LOOP
    IF public._impersonation_close(r.id, 'expired') THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.impersonation_sweep_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.impersonation_sweep_expired() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'impersonation-sweep';
    PERFORM cron.schedule('impersonation-sweep', '* * * * *', 'SELECT public.impersonation_sweep_expired()');
  END IF;
END
$cron$;

-- ---------------------------------------------------------------------------
-- 7. Money / credential / export blocks inside the database
-- ---------------------------------------------------------------------------
-- 7a. Exports
CREATE OR REPLACE FUNCTION public.can_export_data()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT public.is_impersonating() AND CASE
    -- Not a team member -> account owner (has own profile row).
    WHEN NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid())
      THEN EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    -- Team member: custom role value wins when it defines the flag,
    -- otherwise fall back to the member's own permission flags.
    ELSE COALESCE((
      SELECT CASE
        WHEN cr.permissions ? 'can_export_data'
          THEN (cr.permissions ->> 'can_export_data') = 'true'
        ELSE COALESCE((tm.permissions ->> 'can_export_data') = 'true', false)
      END
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false)
  END;
$$;
GRANT EXECUTE ON FUNCTION public.can_export_data() TO authenticated;

-- 7b. Credentials and secrets: no read, no write while impersonating (any public table with RLS on whose name ends like this).
DO $cred$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
       AND c.relname ~ '(_secrets|_credentials|api_keys|_access_tokens)$'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS imp_block_all ON public.%I', r.relname);
    EXECUTE format(
      'CREATE POLICY imp_block_all ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (NOT public.is_impersonating()) WITH CHECK (NOT public.is_impersonating())', r.relname);
  END LOOP;
END
$cred$;

-- 7c. Money: reads stay available to support, writes are blocked. Tables that do not exist (or have no RLS) are skipped.
DO $money$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts', 'bank_payment_methods', 'stripe_connect_accounts', 'instant_payouts',
    'pay_payout_accounts', 'referral_payouts', 'spiff_payouts', 'payroll_exports', 'data_exports'
  ]
  LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    CONTINUE WHEN NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || t));
    EXECUTE format('DROP POLICY IF EXISTS imp_block_ins ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS imp_block_upd ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS imp_block_del ON public.%I', t);
    EXECUTE format('CREATE POLICY imp_block_ins ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT public.is_impersonating())', t);
    EXECUTE format('CREATE POLICY imp_block_upd ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT public.is_impersonating()) WITH CHECK (NOT public.is_impersonating())', t);
    EXECUTE format('CREATE POLICY imp_block_del ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT public.is_impersonating())', t);
  END LOOP;
END
$money$;
