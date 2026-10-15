/*
  # Login alerts — sign-in history + new-device detection

  ## Why
  /dashboard/settings/sessions lists the user's real auth sessions
  (list_own_sessions / revoke_own_session, 20260913010000) and trusted
  devices (trusted-device edge function). What was missing is the
  "was that you?" half: a record of sign-ins and an alert when an account
  is signed into from a browser/OS combination it has not been used from
  before.

  ## How it works
  The signed-in client calls record_login_event() when Supabase reports a
  sign-in. The function identifies the session from the caller's own JWT
  (`session_id` claim), reads that row from auth.sessions, and stores one
  login_events row per (user, session) — repeat calls are no-ops, so the
  tab-focus SIGNED_IN re-emits supabase-js produces are harmless.

  A sign-in is flagged:
    is_new_device  the device label (e.g. "Chrome on Mac") was never seen
                   in this user's earlier events. The first event ever
                   recorded is the baseline and is never flagged, and
                   sessions older than 15 minutes (e.g. already open when
                   this shipped) are recorded but never alert.
    is_new_ip      the IP address was never seen before (informational only
                   — mobile users change networks constantly, so it does
                   not raise an alert on its own).
  An alert is `alerted = true` when it is a recent new-device sign-in and
  the user's profiles.notify_login_alert toggle is on. Alerts surface as a
  banner on the sessions page until acknowledged; account owners also get
  a row in the notification bell (notifications are keyed to the account
  owner, so a team member's sign-in is not pushed into the owner's bell).

  ## Honest limits
  Detection is client-triggered and based on browser/OS + IP from
  auth.sessions. It cannot see a stolen session cookie used from the same
  browser type, and there is no email delivery in this migration.

  ## Security
  login_events is readable only by its own user and has no write policies;
  rows are written only by the SECURITY DEFINER functions below, which use
  auth.uid() and never trust a client-supplied user id. 180-day retention is
  enforced on every write.
*/

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notify_login_alert boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  ip text,
  user_agent text,
  device_label text NOT NULL,
  is_new_device boolean NOT NULL DEFAULT false,
  is_new_ip boolean NOT NULL DEFAULT false,
  alerted boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_login_events_user_created ON login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_unacknowledged ON login_events(user_id) WHERE alerted AND acknowledged_at IS NULL;

ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_login_events" ON login_events;
CREATE POLICY "select_own_login_events" ON login_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Mirrors describeUserAgent() in src/lib/sessions.ts and the trusted-device
-- edge function so labels agree everywhere.
CREATE OR REPLACE FUNCTION public._device_label(p_ua text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_ua IS NULL OR p_ua = '' THEN 'Unknown device' ELSE
    (CASE WHEN p_ua ~ 'Edg/' THEN 'Edge'
          WHEN p_ua ~ 'Chrome/' THEN 'Chrome'
          WHEN p_ua ~ 'Safari/' THEN 'Safari'
          WHEN p_ua ~ 'Firefox/' THEN 'Firefox'
          ELSE 'Browser' END)
    || ' on ' ||
    (CASE WHEN p_ua ~ '(iPhone|iPad|iPod)' THEN 'iOS'
          WHEN p_ua ~ 'Android' THEN 'Android'
          WHEN p_ua ~ 'Macintosh' THEN 'Mac'
          WHEN p_ua ~ 'Windows' THEN 'Windows'
          ELSE 'device' END)
  END;
$$;

CREATE OR REPLACE FUNCTION public.record_login_event()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sid uuid;
  s RECORD;
  v_label text;
  v_has_prior boolean;
  v_new_device boolean;
  v_new_ip boolean;
  v_pref boolean;
  v_alert boolean;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('recorded', false); END IF;

  BEGIN
    v_sid := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_sid := NULL;
  END;
  IF v_sid IS NULL THEN RETURN jsonb_build_object('recorded', false); END IF;

  IF EXISTS (SELECT 1 FROM public.login_events WHERE user_id = v_uid AND session_id = v_sid) THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;

  SELECT created_at, user_agent, ip::text AS ip INTO s
  FROM auth.sessions WHERE id = v_sid AND user_id = v_uid;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded', false); END IF;

  v_label := public._device_label(s.user_agent);
  SELECT EXISTS (SELECT 1 FROM public.login_events WHERE user_id = v_uid) INTO v_has_prior;
  v_new_device := v_has_prior AND NOT EXISTS (
    SELECT 1 FROM public.login_events WHERE user_id = v_uid AND device_label = v_label);
  v_new_ip := v_has_prior AND s.ip IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.login_events WHERE user_id = v_uid AND ip = s.ip);

  SELECT notify_login_alert INTO v_pref FROM public.profiles WHERE id = v_uid;
  v_alert := v_new_device AND COALESCE(v_pref, true) AND s.created_at > now() - interval '15 minutes';

  INSERT INTO public.login_events (user_id, session_id, ip, user_agent, device_label, is_new_device, is_new_ip, alerted)
  VALUES (v_uid, v_sid, s.ip, left(s.user_agent, 400), v_label, v_new_device, v_new_ip, v_alert)
  ON CONFLICT (user_id, session_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN jsonb_build_object('recorded', false); END IF;

  IF v_alert AND public.get_account_owner_id() = v_uid THEN
    INSERT INTO public.notifications (user_id, type, title, message, action_url)
    VALUES (
      v_uid, 'system', 'New sign-in to your account',
      format('%s signed in from %s. If this wasn''t you, sign out everywhere and change your password.',
             v_label, COALESCE(s.ip, 'an unknown network')),
      '/dashboard/settings/sessions'
    );
  END IF;

  DELETE FROM public.login_events WHERE user_id = v_uid AND created_at < now() - interval '180 days';

  RETURN jsonb_build_object('recorded', true, 'alerted', v_alert);
END;
$$;

REVOKE ALL ON FUNCTION public.record_login_event() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_login_event() TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_login_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  UPDATE public.login_events SET acknowledged_at = now()
  WHERE user_id = auth.uid() AND alerted AND acknowledged_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_login_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_login_events() TO authenticated;
