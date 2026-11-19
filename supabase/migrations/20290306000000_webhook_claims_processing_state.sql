-- webhook_event_claims: add a processing state so a generic inbound webhook can be retried safely.
-- claim_webhook_event(text,text) is unchanged: its rows default to status 'processed' (permanent claim).
-- Additive and idempotent. Service-role only.
-- rollback: DROP FUNCTION IF EXISTS public.begin_webhook_event(text,text,integer);
--           DROP FUNCTION IF EXISTS public.finish_webhook_event(text,text,text);
--           ALTER TABLE public.webhook_event_claims DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS attempts,
--             DROP COLUMN IF EXISTS processed_at, DROP COLUMN IF EXISTS last_error;

ALTER TABLE public.webhook_event_claims
  ADD COLUMN IF NOT EXISTS status       text        NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS attempts     integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error   text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_event_claims_status_check') THEN
    ALTER TABLE public.webhook_event_claims
      ADD CONSTRAINT webhook_event_claims_status_check CHECK (status IN ('processing', 'processed', 'failed')) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.begin_webhook_event(p_provider text, p_event_id text, p_lease_seconds integer DEFAULT 300)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_provider IS NULL OR p_event_id IS NULL
     OR char_length(p_provider) NOT BETWEEN 1 AND 64
     OR char_length(p_event_id) NOT BETWEEN 1 AND 256
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'invalid webhook claim arguments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.webhook_event_claims (provider, event_id, status, attempts)
  VALUES (p_provider, p_event_id, 'processing', 1)
  ON CONFLICT (provider, event_id) DO NOTHING;
  IF FOUND THEN
    RETURN 'new';
  END IF;

  UPDATE public.webhook_event_claims
     SET status = 'processing', claimed_at = now(), attempts = attempts + 1
   WHERE provider = p_provider AND event_id = p_event_id
     AND (status = 'failed'
          OR (status = 'processing' AND claimed_at < now() - make_interval(secs => p_lease_seconds)));
  IF FOUND THEN
    RETURN 'retry';
  END IF;

  SELECT status INTO v_status FROM public.webhook_event_claims WHERE provider = p_provider AND event_id = p_event_id;
  RETURN CASE WHEN v_status = 'processed' THEN 'duplicate' ELSE 'in_progress' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_webhook_event(p_provider text, p_event_id text, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.webhook_event_claims
     SET status       = CASE WHEN p_error IS NULL THEN 'processed' ELSE 'failed' END,
         processed_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
         last_error   = left(p_error, 2000)
   WHERE provider = p_provider AND event_id = p_event_id AND status = 'processing';
$$;

REVOKE ALL ON FUNCTION public.begin_webhook_event(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_webhook_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_webhook_event(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_webhook_event(text, text, text) TO service_role;
