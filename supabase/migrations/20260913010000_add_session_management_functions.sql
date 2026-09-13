-- Session management for account-owner self-service (Step 35).
--
-- supabase-js has no client API to list or revoke a single auth.sessions
-- row individually — only `signOut({ scope: 'others' })`, which nukes
-- every other session at once with no visibility into what's being
-- signed out. Supabase's own docs confirm two facts this migration relies
-- on: every access token carries a `session_id` claim matching
-- auth.sessions.id, and a session is treated as ended once its
-- `not_after` timestamp is in the past. Both functions below are
-- SECURITY DEFINER so they can read/write the `auth` schema (normally
-- off-limits to the `authenticated` role), but `search_path` is locked
-- down and every row is filtered by `auth.uid()` — a user can only ever
-- see or end their OWN sessions, never anyone else's.

CREATE OR REPLACE FUNCTION public.list_own_sessions()
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  not_after timestamptz,
  user_agent text,
  ip text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
  SELECT s.id, s.created_at, s.updated_at, s.refreshed_at, s.not_after,
         s.user_agent, s.ip::text
  FROM auth.sessions s
  WHERE s.user_id = auth.uid()
    AND (s.not_after IS NULL OR s.not_after > now())
  ORDER BY COALESCE(s.refreshed_at, s.updated_at) DESC;
$$;

REVOKE ALL ON FUNCTION public.list_own_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_own_sessions() TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_own_session(target_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
BEGIN
  UPDATE auth.sessions
  SET not_after = now()
  WHERE id = target_session_id
    AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found or not owned by the current user';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_own_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_own_session(uuid) TO authenticated;
