-- billing_events: add processing state so a failed Stripe webhook handler can be retried safely.
-- Before: the event id was inserted BEFORE the handler ran and handler errors were swallowed (HTTP 200),
-- so a failed side effect (dunning / suspension) was lost forever.
-- After: claim_billing_event() -> 'new' | 'retry' | 'duplicate' | 'in_progress'; complete_billing_event() marks the outcome.
-- Additive only. Safe on a fresh DB and on the current schema (idempotent).
-- rollback: DROP FUNCTION IF EXISTS public.claim_billing_event(text,text,jsonb); DROP FUNCTION IF EXISTS public.complete_billing_event(text,text); ALTER TABLE public.billing_events DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS claimed_at, DROP COLUMN IF EXISTS processed_at, DROP COLUMN IF EXISTS last_error;

ALTER TABLE public.billing_events
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS attempts     integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error   text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_events_status_check') THEN
    ALTER TABLE public.billing_events
      ADD CONSTRAINT billing_events_status_check CHECK (status IN ('processing', 'processed', 'failed')) NOT VALID;
  END IF;
END $$;

-- Pre-existing rows were already de-duplicated and handled by the old code path: treat them as processed.
UPDATE public.billing_events SET processed_at = created_at WHERE processed_at IS NULL AND status = 'processed';

CREATE OR REPLACE FUNCTION public.claim_billing_event(p_event_id text, p_event_type text, p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) = 0 THEN
    RAISE EXCEPTION 'event id required';
  END IF;

  INSERT INTO public.billing_events (stripe_event_id, event_type, payload, status, attempts, claimed_at)
  VALUES (p_event_id, COALESCE(p_event_type, 'unknown'), p_payload, 'processing', 1, now())
  ON CONFLICT (stripe_event_id) DO NOTHING;
  IF FOUND THEN
    RETURN 'new';
  END IF;

  -- Existing row: take it over only if the last attempt failed or its claim went stale (crashed worker).
  UPDATE public.billing_events
     SET status = 'processing', claimed_at = now(), attempts = attempts + 1
   WHERE stripe_event_id = p_event_id
     AND (status = 'failed' OR (status = 'processing' AND claimed_at < now() - interval '5 minutes'));
  IF FOUND THEN
    RETURN 'retry';
  END IF;

  SELECT status INTO v_status FROM public.billing_events WHERE stripe_event_id = p_event_id;
  RETURN CASE WHEN v_status = 'processed' THEN 'duplicate' ELSE 'in_progress' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_billing_event(p_event_id text, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_events
     SET status       = CASE WHEN p_error IS NULL THEN 'processed' ELSE 'failed' END,
         processed_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
         last_error   = left(p_error, 2000)
   WHERE stripe_event_id = p_event_id;
$$;

REVOKE ALL ON FUNCTION public.claim_billing_event(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_billing_event(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_billing_event(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_billing_event(text, text) TO service_role;
