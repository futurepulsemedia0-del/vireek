/*
  # Browser extension (Chrome): click-to-call + quick lead capture

  Additive only. One new table, written exclusively by the `browser-extension` edge
  function (service role). It provides:
    - idempotency (UNIQUE user_id + kind + request_id) so a retried click never double-dials
      or double-creates a lead,
    - per-user rate limiting (index on user_id, kind, created_at),
    - an audit trail of every click-to-call / capture (only the page HOST is stored, never the
      full URL; phone numbers are E.164 business data owned by the tenant).

  Reads: the user sees their own rows; the account owner sees the whole team's rows.
  Writes: service role only (no INSERT/UPDATE/DELETE grants for clients).

  Retention (optional, run once):
    select cron.schedule('browser-extension-events-prune', '23 3 * * *',
      $$ select public.browser_extension_events_prune(180); $$);
*/

CREATE TABLE IF NOT EXISTS public.browser_extension_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('lead_capture', 'click_to_call')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'captured', 'duplicate', 'queued', 'ringing', 'answered',
    'completed', 'busy', 'no_answer', 'failed', 'canceled', 'blocked')),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  to_number text CHECK (to_number IS NULL OR to_number ~ '^\+[1-9][0-9]{7,14}$'),
  from_number text CHECK (from_number IS NULL OR from_number ~ '^\+[1-9][0-9]{7,14}$'),
  agent_hint text CHECK (agent_hint IS NULL OR char_length(agent_hint) <= 40),
  provider_sid text CHECK (provider_sid IS NULL OR char_length(provider_sid) <= 64),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  page_host text CHECK (page_host IS NULL OR char_length(page_host) <= 253),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_browser_extension_events_request UNIQUE (user_id, kind, request_id)
);

CREATE INDEX IF NOT EXISTS idx_bee_user_kind_recent
  ON public.browser_extension_events (user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bee_owner_recent
  ON public.browser_extension_events (account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bee_provider_sid
  ON public.browser_extension_events (provider_sid) WHERE provider_sid IS NOT NULL;

CREATE OR REPLACE FUNCTION public.browser_extension_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bee_touch_updated_at ON public.browser_extension_events;
CREATE TRIGGER trg_bee_touch_updated_at
  BEFORE UPDATE ON public.browser_extension_events
  FOR EACH ROW EXECUTE FUNCTION public.browser_extension_touch_updated_at();

ALTER TABLE public.browser_extension_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_or_owner_browser_extension_events" ON public.browser_extension_events;
CREATE POLICY "select_own_or_owner_browser_extension_events"
  ON public.browser_extension_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR account_owner_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.browser_extension_events FROM authenticated, anon;
GRANT SELECT ON public.browser_extension_events TO authenticated;

CREATE OR REPLACE FUNCTION public.browser_extension_events_prune(p_days integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.browser_extension_events
   WHERE created_at < now() - make_interval(days => GREATEST(COALESCE(p_days, 180), 30));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.browser_extension_events_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.browser_extension_events_prune(integer) TO service_role;
