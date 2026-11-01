/*
  # Security events: tamper-evident account-security feed + alert dispatch + server-side step-up

  What this adds
  - public.security_events: one row per security-relevant account change (password / email / MFA /
    recovery codes / API keys). Feeds (a) the email + in-app + push alert, (b) the user's Activity page,
    (c) the "suspicious activity" banner.
  - Capture is done by SECURITY DEFINER triggers on auth.users, auth.mfa_factors and public.api_keys, so
    it cannot be skipped by a client and works no matter which code path changed the data.
  - Dispatch to the `security-event-notify` edge function uses pg_net, exactly like send-comment-email
    (needs app.settings.edge_function_base_url + app.settings.push_dispatch_secret; no-ops until set).
  - public.has_recent_auth(): reads the JWT `amr` claim; used here to enforce STEP-UP for API key
    create / revoke on the server (a client-only check would be bypassable).

  Security model
  - security_events is readable only by its own user. No INSERT/UPDATE/DELETE for anon/authenticated.
  - meta is a small, whitelisted JSON object (key name/prefix, masked email, factor type). Never secrets.
  - A failure inside any trigger NEVER blocks the underlying auth / API-key operation (logged as WARNING).
  - Triggers skip users that are being deleted (cascade) so account deletion cannot be blocked.

  Rollback
    DROP TRIGGER trg_security_events_auth_users ON auth.users;
    DROP TRIGGER trg_security_events_mfa_update ON auth.mfa_factors;
    DROP TRIGGER trg_security_events_mfa_delete ON auth.mfa_factors;
    DROP TRIGGER trg_security_events_api_keys_ins ON public.api_keys;
    DROP TRIGGER trg_security_events_api_keys_rev ON public.api_keys;
    DROP TRIGGER trg_require_recent_auth_api_keys ON public.api_keys;   -- turns step-up enforcement off
    (the table and functions can stay; they are inert without the triggers)
*/

CREATE TABLE IF NOT EXISTS public.security_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event             text NOT NULL CHECK (event IN (
                      'password_changed', 'email_changed', 'mfa_enrolled', 'mfa_disabled',
                      'recovery_codes_regenerated', 'api_key_created', 'api_key_revoked')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(meta) = 'object' AND pg_column_size(meta) < 2048),
  dedupe_key        text UNIQUE,
  notify_claimed_at timestamptz,
  notified_at       timestamptz,
  acknowledged_at   timestamptz
);

CREATE INDEX IF NOT EXISTS security_events_user_time_idx ON public.security_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS security_events_unack_idx ON public.security_events (user_id) WHERE acknowledged_at IS NULL;

ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_events FROM anon, authenticated;
GRANT SELECT ON public.security_events TO authenticated;

DROP POLICY IF EXISTS "select_own_security_events" ON public.security_events;
CREATE POLICY "select_own_security_events"
  ON public.security_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- record_security_event: single entry point (idempotent via dedupe_key) + dispatch.
-- `p_notify_email` (email_changed only) is the PREVIOUS address; it travels only in the dispatch
-- request body and is never stored.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_security_event(
  p_user_id      uuid,
  p_event        text,
  p_meta         jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key   text DEFAULT NULL,
  p_notify_email text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id     uuid;
  v_base   text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.push_dispatch_secret', true);
  v_body   jsonb;
BEGIN
  INSERT INTO public.security_events (user_id, event, meta, dedupe_key)
  VALUES (p_user_id, p_event, COALESCE(p_meta, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN NULL; -- duplicate; already recorded and dispatched
  END IF;

  IF v_base IS NULL OR v_base = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN v_id;
  END IF;

  v_body := jsonb_build_object('event_id', v_id);
  IF p_notify_email IS NOT NULL THEN
    v_body := v_body || jsonb_build_object('notify_email', p_notify_email);
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := v_base || '/security-event-notify',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
      body    := v_body
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'record_security_event dispatch failed: %', SQLERRM;
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_security_event(uuid, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_security_event(uuid, text, jsonb, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Triggers. Each wraps its work so a failure can never block the underlying operation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.security_events_on_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_minute text := to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI');
BEGIN
  BEGIN
    IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password
       AND COALESCE(NEW.encrypted_password, '') <> '' THEN
      PERFORM public.record_security_event(NEW.id, 'password_changed', '{}'::jsonb, 'pw:' || NEW.id || ':' || v_minute);
    END IF;

    IF NEW.email IS DISTINCT FROM OLD.email AND COALESCE(OLD.email, '') <> '' THEN
      PERFORM public.record_security_event(
        NEW.id,
        'email_changed',
        jsonb_build_object('new_email_masked', left(COALESCE(NEW.email, ''), 1) || '***@' || split_part(COALESCE(NEW.email, ''), '@', 2)),
        'em:' || NEW.id || ':' || v_minute,
        OLD.email
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'security_events_on_auth_user failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_events_auth_users ON auth.users;
CREATE TRIGGER trg_security_events_auth_users
  AFTER UPDATE OF encrypted_password, email ON auth.users
  FOR EACH ROW
  WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.security_events_on_auth_user();

CREATE OR REPLACE FUNCTION public.security_events_on_mfa_factor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status::text <> 'verified' AND NEW.status::text = 'verified' THEN
        PERFORM public.record_security_event(NEW.user_id, 'mfa_enrolled',
          jsonb_build_object('factor_type', NEW.factor_type::text), 'mfa:' || NEW.id || ':enrolled');
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      -- Skip when the whole user is being deleted (cascade): nothing to alert and the FK would fail.
      IF OLD.status::text = 'verified' AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
        PERFORM public.record_security_event(OLD.user_id, 'mfa_disabled',
          jsonb_build_object('factor_type', OLD.factor_type::text), 'mfa:' || OLD.id || ':disabled');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'security_events_on_mfa_factor failed: %', SQLERRM;
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_events_mfa_update ON auth.mfa_factors;
CREATE TRIGGER trg_security_events_mfa_update
  AFTER UPDATE OF status ON auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION public.security_events_on_mfa_factor();

DROP TRIGGER IF EXISTS trg_security_events_mfa_delete ON auth.mfa_factors;
CREATE TRIGGER trg_security_events_mfa_delete
  AFTER DELETE ON auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION public.security_events_on_mfa_factor();

CREATE OR REPLACE FUNCTION public.security_events_on_api_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public.record_security_event(NEW.user_id, 'api_key_created',
        jsonb_build_object('key_name', left(NEW.name, 80), 'key_prefix', NEW.key_prefix), 'ak:' || NEW.id || ':created');
    ELSIF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      PERFORM public.record_security_event(NEW.user_id, 'api_key_revoked',
        jsonb_build_object('key_name', left(NEW.name, 80), 'key_prefix', NEW.key_prefix), 'ak:' || NEW.id || ':revoked');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'security_events_on_api_key failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_events_api_keys_ins ON public.api_keys;
CREATE TRIGGER trg_security_events_api_keys_ins
  AFTER INSERT ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.security_events_on_api_key();

DROP TRIGGER IF EXISTS trg_security_events_api_keys_rev ON public.api_keys;
CREATE TRIGGER trg_security_events_api_keys_rev
  AFTER UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.security_events_on_api_key();

-- ---------------------------------------------------------------------------
-- Acknowledge ("this was me" / dismiss the banner). Self-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acknowledge_security_events()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.security_events
     SET acknowledged_at = now()
   WHERE user_id = auth.uid() AND acknowledged_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_security_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_security_events() TO authenticated;

-- ---------------------------------------------------------------------------
-- Step-up: true when the caller's JWT proves an authentication within the last N seconds.
-- Supabase stamps `amr` entries ({method, timestamp}) at sign-in / MFA / OTP verification;
-- refreshing the access token does not add entries, so this really means "authenticated recently".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_recent_auth(p_max_age_seconds integer DEFAULT 600)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT max(CASE WHEN (e ->> 'timestamp') ~ '^[0-9]+$' THEN (e ->> 'timestamp')::bigint END)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END
           ) AS e
  ), 0) >= (extract(epoch FROM now())::bigint - GREATEST(p_max_age_seconds, 0));
$$;
GRANT EXECUTE ON FUNCTION public.has_recent_auth(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.require_recent_auth_api_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only end-user requests are gated; service role / migrations / maintenance are not.
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NOT public.has_recent_auth(600) THEN
    RAISE EXCEPTION 'REAUTH_REQUIRED' USING ERRCODE = '42501', HINT = 'Confirm your identity again to manage API keys.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_require_recent_auth_api_keys ON public.api_keys;
CREATE TRIGGER trg_require_recent_auth_api_keys
  BEFORE INSERT OR UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.require_recent_auth_api_keys();

-- Retention helper (schedule with pg_cron or data-retention-sweep). 24 months.
CREATE OR REPLACE FUNCTION public.prune_security_events(p_keep interval DEFAULT interval '24 months')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.security_events WHERE occurred_at < now() - p_keep;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_security_events(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_security_events(interval) TO service_role;
