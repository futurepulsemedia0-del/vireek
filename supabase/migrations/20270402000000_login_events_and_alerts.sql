/*
# Login events + new-device / new-location alerts

Backs the `login-alert` edge function. One row per completed sign-in
session (any method: password, magic link, Google, Apple, passkey).

Security model
- Rows are written ONLY by the edge function (service role). There is no
  INSERT/UPDATE/DELETE policy for anon/authenticated, so a client can't
  forge or erase its own history to dodge alerts.
- Users may read their own rows (future "recent sign-ins" UI).
- Only a coarse, masked IP is stored (last IPv4 octet / IPv6 tail zeroed).
- `session_id` is UNIQUE: that is the idempotency key that guarantees one
  alert per session even if the client retries or two tabs race.
*/

CREATE TABLE IF NOT EXISTS public.login_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id         uuid NOT NULL,
  auth_method        text,
  device_cookie_hash text,
  ua_hash            text NOT NULL,
  device_label       text,
  ip_masked          text,
  country            text,
  region             text,
  city               text,
  is_baseline        boolean NOT NULL DEFAULT false,
  is_new_device      boolean NOT NULL DEFAULT false,
  is_new_location    boolean NOT NULL DEFAULT false,
  alert_sent         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_events_session_id_key UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS login_events_user_created_idx
  ON public.login_events (user_id, created_at DESC);

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_login_events" ON public.login_events;
CREATE POLICY "select_own_login_events"
  ON public.login_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Server-recorded network info for a session (IP + user agent as Supabase
-- Auth saw them at sign-in). The edge function trusts THIS, not anything
-- the browser claims. Callable by the service role only.
CREATE OR REPLACE FUNCTION public.get_session_network_info(p_user_id uuid, p_session_id uuid)
RETURNS TABLE (ip text, user_agent text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
  SELECT host(s.ip), s.user_agent
  FROM auth.sessions s
  WHERE s.id = p_session_id AND s.user_id = p_user_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_session_network_info(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_session_network_info(uuid, uuid) TO service_role;

-- Retention helper: keep 12 months. Schedule it (pg_cron or your existing
-- data-retention-sweep) — see docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md.
CREATE OR REPLACE FUNCTION public.prune_login_events(p_keep interval DEFAULT interval '12 months')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.login_events WHERE created_at < now() - p_keep;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_login_events(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_login_events(interval) TO service_role;
