-- 20290306000000_oauth_state_binding.sql
--
-- Server-issued, single-use, SESSION-BOUND OAuth state.
--
-- Why: OAuth callbacks (acct / crm / google-calendar / hubspot) run with verify_jwt = false because the
-- provider redirects the browser there without a Vireek session. The HMAC-signed `state` proves WHO started
-- the flow, but a signed state alone can be replayed inside its 10 minute life and keeps working after the
-- user signed out. This migration adds a server-side record written by the *-oauth-start functions (which DO
-- have the caller's JWT) and consumed exactly once by the callbacks:
--   * oauth_state_issue()  : service_role only, records (nonce, provider, user, owner, auth session id).
--   * oauth_state_redeem() : service_role only, DELETEs the record first (atomic single use, even on failure),
--                            then checks expiry and that the minting auth session is still alive.
--
-- Idempotent: safe to run more than once.
-- Rollback (transient data only): DROP FUNCTION public.oauth_state_redeem(text, text),
--   public.oauth_state_issue(text, text, uuid, uuid, uuid, integer); DROP TABLE public.oauth_state_issued;
-- Requires: nothing else. Does not touch oauth_state_consumed / oauth_state_consume (still used by other flows).

CREATE TABLE IF NOT EXISTS public.oauth_state_issued (
  nonce      text        PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{24}$'),
  provider   text        NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  user_id    uuid        NOT NULL,
  owner_id   uuid        NOT NULL,
  session_id uuid        NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_state_issued_expires_idx ON public.oauth_state_issued (expires_at);

ALTER TABLE public.oauth_state_issued ENABLE ROW LEVEL SECURITY;  -- no policies: service_role only
REVOKE ALL ON public.oauth_state_issued FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.oauth_state_issue(
  p_nonce text,
  p_provider text,
  p_user uuid,
  p_owner uuid,
  p_session uuid,
  p_ttl_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{24}$'
     OR p_provider IS NULL OR char_length(p_provider) NOT BETWEEN 1 AND 40
     OR p_user IS NULL OR p_owner IS NULL OR p_session IS NULL
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 30 AND 900 THEN
    RETURN false;
  END IF;

  INSERT INTO public.oauth_state_issued (nonce, provider, user_id, owner_id, session_id, expires_at)
  VALUES (p_nonce, p_provider, p_user, p_owner, p_session, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (nonce) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Opportunistic pruning (states live <= 15 minutes), no cron job required.
  IF random() < 0.05 THEN
    DELETE FROM public.oauth_state_issued WHERE expires_at < now() - interval '1 hour';
  END IF;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.oauth_state_redeem(p_nonce text, p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  r public.oauth_state_issued%ROWTYPE;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{24}$' OR p_provider IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'malformed');
  END IF;

  -- DELETE first: whatever happens next, this state can never be used again (replay-proof, race-proof).
  DELETE FROM public.oauth_state_issued
   WHERE nonce = p_nonce AND provider = p_provider
  RETURNING * INTO r;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_or_used');
  END IF;
  IF r.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
     WHERE s.id = r.session_id
       AND s.user_id = r.user_id
       AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_ended');
  END IF;

  RETURN jsonb_build_object('ok', true, 'user_id', r.user_id, 'owner_id', r.owner_id);
END;
$$;

REVOKE ALL ON FUNCTION public.oauth_state_issue(text, text, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.oauth_state_redeem(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_state_issue(text, text, uuid, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.oauth_state_redeem(text, text) TO service_role;
