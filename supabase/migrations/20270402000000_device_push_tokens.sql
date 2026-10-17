-- Native (iOS / Android) push tokens. Web Push keeps using push_subscriptions.
-- One FCM token per device; user_id is the ACCOUNT OWNER (same scoping as push_subscriptions),
-- so every technician device of an account receives that account's notifications.
-- Clients never write the table directly: a device token can move between accounts on a shared
-- phone, which needs to re-assign an existing row — done only by the SECURITY DEFINER RPCs below.

CREATE TABLE IF NOT EXISTS public.device_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 20 AND 4096),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user ON public.device_push_tokens(user_id);

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_device_push_tokens" ON public.device_push_tokens;
CREATE POLICY "select_own_device_push_tokens"
ON public.device_push_tokens FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.register_device_push_token(
  p_token text,
  p_platform text,
  p_app_version text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'invalid platform' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.device_push_tokens (user_id, token, platform, app_version)
  VALUES (v_owner, p_token, p_platform, p_app_version)
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        last_seen_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.unregister_device_push_token(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  DELETE FROM public.device_push_tokens WHERE token = p_token AND user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public.register_device_push_token(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unregister_device_push_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_device_push_token(text) TO authenticated;

COMMENT ON TABLE public.device_push_tokens IS
  'FCM tokens of the native iOS/Android app, scoped to the account owner. Written only via register_device_push_token / unregister_device_push_token.';
