-- =============================================================
-- SIEM log streaming (Splunk HEC / Datadog Logs)
--
-- Streams each account's audit_log (security + admin events) to the
-- customer's own SIEM. Owner-only, Business/Enterprise plans.
--
-- Design
--   * Cursor-based, no triggers on audit_log: each destination keeps a
--     (created_at, id) cursor; the siem-stream edge function reads the next
--     batch with siem_fetch_batch(), delivers it, then advances the cursor.
--     A failed delivery never advances the cursor, so nothing is lost
--     (at-least-once; every event carries a stable `id` for de-duplication).
--   * Events younger than 15 s are held back so a slow-committing
--     transaction can never be skipped by the cursor.
--   * New destinations start at "now" (no historical flood).
--   * The Splunk HEC token / Datadog API key lives ONLY in
--     siem_destination_secrets (AES-256-GCM encrypted by the edge function,
--     RLS on, zero policies, privileges revoked): service role only.
--   * All writes go through the siem-stream edge function (service role).
--     Clients can only SELECT their own rows.
--
-- Required edge-function secrets (supabase secrets set ...):
--   SIEM_ENCRYPTION_KEY   openssl rand -base64 32
--   SIEM_CRON_SECRET      openssl rand -hex 32
--
-- Scheduler (Supabase SQL editor; pg_cron + pg_net enabled). Replace placeholders:
--
--   select cron.schedule('siem-stream-every-minute', '* * * * *', $cron$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/siem-stream',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<SIEM_CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $cron$);
-- =============================================================

-- 1. DESTINATIONS -------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.siem_destinations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  provider             text NOT NULL CHECK (provider IN ('splunk_hec', 'datadog')),
  endpoint_url         text,
  datadog_site         text,
  splunk_index         text,
  splunk_sourcetype    text,
  min_severity         text NOT NULL DEFAULT 'info' CHECK (min_severity IN ('info', 'low', 'medium', 'high')),
  enabled              boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'failing', 'auth_failed')),
  cursor_created_at    timestamptz NOT NULL DEFAULT now(),
  cursor_id            uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  lease_until          timestamptz,
  next_attempt_at      timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at      timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  events_sent_total    bigint NOT NULL DEFAULT 0,
  events_dropped_total bigint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siem_destinations_provider_fields CHECK (
    (provider = 'splunk_hec' AND endpoint_url IS NOT NULL AND datadog_site IS NULL)
    OR (provider = 'datadog' AND datadog_site IS NOT NULL AND endpoint_url IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_siem_destinations_user
  ON public.siem_destinations (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_siem_destinations_due
  ON public.siem_destinations (next_attempt_at)
  WHERE enabled;

ALTER TABLE public.siem_destinations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_siem_destinations" ON public.siem_destinations;
CREATE POLICY "owner_select_siem_destinations"
  ON public.siem_destinations FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.siem_destinations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.siem_destinations FROM authenticated;

-- 2. SECRETS (service role only) ---------------------------------------

CREATE TABLE IF NOT EXISTS public.siem_destination_secrets (
  destination_id uuid PRIMARY KEY REFERENCES public.siem_destinations (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  secret_enc     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.siem_destination_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.siem_destination_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge function) can touch this table.

COMMENT ON TABLE public.siem_destination_secrets IS
  'AES-256-GCM encrypted SIEM tokens / API keys. Service role only: no policies, no grants for anon/authenticated.';

-- 3. DELIVERY LOG -------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.siem_delivery_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES public.siem_destinations (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  kind           text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'test')),
  status         text NOT NULL CHECK (status IN ('ok', 'failed')),
  event_count    integer NOT NULL DEFAULT 0,
  dropped_count  integer NOT NULL DEFAULT 0,
  http_status    integer,
  error          text,
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_siem_delivery_log_dest_created
  ON public.siem_delivery_log (destination_id, created_at DESC);

ALTER TABLE public.siem_delivery_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_siem_delivery_log" ON public.siem_delivery_log;
CREATE POLICY "owner_select_siem_delivery_log"
  ON public.siem_delivery_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.siem_delivery_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.siem_delivery_log FROM authenticated;

-- 4. BATCH READER (service role only) ----------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created_id
  ON public.audit_log (user_id, created_at, id);

CREATE OR REPLACE FUNCTION public.siem_fetch_batch(p_destination_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE (
  id           uuid,
  created_at   timestamptz,
  actor_id     uuid,
  actor_email  text,
  action       text,
  target_table text,
  target_id    text,
  metadata     jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.created_at, a.actor_id, a.actor_email, a.action, a.target_table, a.target_id, a.metadata
  FROM public.siem_destinations d
  JOIN public.audit_log a ON a.user_id = d.user_id
  WHERE d.id = p_destination_id
    AND a.created_at <= now() - interval '15 seconds'
    AND (a.created_at, a.id) > (d.cursor_created_at, d.cursor_id)
  ORDER BY a.created_at ASC, a.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.siem_fetch_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.siem_fetch_batch(uuid, integer) TO service_role;
