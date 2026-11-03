/*
  # Edge-function security primitives: shared rate limiting + webhook replay protection

  Used by supabase/functions/_shared/http (rate limit + replay store). Service-role only:
  RLS is enabled with NO policies and every privilege is revoked from anon/authenticated,
  so clients can never read or write these tables or call the functions.

  ## Tables
  - edge_rate_limits(bucket, window_start, hits)         fixed-window counters (atomic upsert)
  - webhook_event_claims(provider, event_id, claimed_at) one row per processed webhook event (PK = replay guard)

  ## Functions (SECURITY DEFINER, search_path pinned, service_role only)
  - edge_rate_limit_hit(p_bucket, p_limit, p_window_seconds) -> jsonb {allowed, remaining, retry_after}
  - claim_webhook_event(p_provider, p_event_id)               -> boolean (true = first time, false = replay)
  - purge_edge_security_rows()                                -> int   (call from a daily cron)

  Rollback: DROP FUNCTION purge_edge_security_rows(), claim_webhook_event(text,text),
  edge_rate_limit_hit(text,int,int); DROP TABLE webhook_event_claims, edge_rate_limits;
  (safe: only transient counters/nonces live here).
*/

CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start),
  CONSTRAINT edge_rate_limits_bucket_len CHECK (char_length(bucket) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS public.webhook_event_claims (
  provider   text        NOT NULL,
  event_id   text        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id),
  CONSTRAINT webhook_event_claims_len CHECK (char_length(provider) BETWEEN 1 AND 64 AND char_length(event_id) BETWEEN 1 AND 256)
);
CREATE INDEX IF NOT EXISTS webhook_event_claims_claimed_at_idx ON public.webhook_event_claims (claimed_at);
CREATE INDEX IF NOT EXISTS edge_rate_limits_window_idx ON public.edge_rate_limits (window_start);

ALTER TABLE public.edge_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.edge_rate_limits, public.webhook_event_claims FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.edge_rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window timestamptz;
  v_hits   integer;
BEGIN
  IF p_bucket IS NULL OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate limit arguments' USING ERRCODE = '22023';
  END IF;
  v_window := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.edge_rate_limits AS t (bucket, window_start, hits)
  VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = t.hits + 1
  RETURNING t.hits INTO v_hits;
  RETURN jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'remaining', greatest(p_limit - v_hits, 0),
    'retry_after', greatest(ceil(extract(epoch FROM (v_window + make_interval(secs => p_window_seconds) - now())))::int, 1)
  );
END $$;

CREATE OR REPLACE FUNCTION public.claim_webhook_event(p_provider text, p_event_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO public.webhook_event_claims (provider, event_id) VALUES (p_provider, p_event_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

CREATE OR REPLACE FUNCTION public.purge_edge_security_rows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a integer; b integer;
BEGIN
  DELETE FROM public.edge_rate_limits WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM public.webhook_event_claims WHERE claimed_at < now() - interval '30 days';
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN a + b;
END $$;

REVOKE ALL ON FUNCTION public.edge_rate_limit_hit(text, integer, integer), public.claim_webhook_event(text, text), public.purge_edge_security_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edge_rate_limit_hit(text, integer, integer), public.claim_webhook_event(text, text), public.purge_edge_security_rows() TO service_role;
