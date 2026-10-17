-- Per-person attribution for native push tokens, mirroring push_subscriptions.subscriber_user_id,
-- so targeted notifications (e.g. @mentions) reach only the intended person's devices.

ALTER TABLE public.device_push_tokens
  ADD COLUMN IF NOT EXISTS subscriber_user_id uuid;

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

  INSERT INTO public.device_push_tokens (user_id, subscriber_user_id, token, platform, app_version)
  VALUES (v_owner, auth.uid(), p_token, p_platform, p_app_version)
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        subscriber_user_id = EXCLUDED.subscriber_user_id,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        last_seen_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.register_device_push_token(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(text, text, text) TO authenticated;
