/*
  # First Call — "Call Sarah now" sessions + time-to-first-call KPI

  ## What this adds
  1. `first_call_sessions`  one row per owner attempt to hear Sarah (phone ring-back or in-browser).
                            Written ONLY by the first-call-start edge function and the triggers below (service role /
                            SECURITY DEFINER). `authenticated` can only SELECT its own account's rows.
  2. Triggers (no vapi-webhook change needed): live_calls / live_call_lines / calls / jobs rows that carry the
     session's vapi_call_id advance the session (ringing -> in_call -> completed|voicemail|no_answer|failed),
     stamp first_transcript_at and booking_at, and link call_id / job_id. Terminal states never move again.
  3. `first_call_kpi_daily`  p50/p90 time-to-first-call. Service role only (aggregates across tenants).

  ## Privacy
  - The owner's phone number is NOT stored on the session. Only country calling code + last 4 digits.
  - `notify_phone_e164` is stored ONLY when the owner ticks "text me when ready" (explicit opt-in) and is
    nulled as soon as the message is sent.

  ## Rollback
    DROP VIEW IF EXISTS public.first_call_kpi_daily;
    DROP TRIGGER IF EXISTS trg_fcs_live_calls ON public.live_calls;
    DROP TRIGGER IF EXISTS trg_fcs_live_lines ON public.live_call_lines;
    DROP TRIGGER IF EXISTS trg_fcs_calls ON public.calls;
    DROP TRIGGER IF EXISTS trg_fcs_jobs ON public.jobs;
    DROP FUNCTION IF EXISTS public.fcs_on_live_call(), public.fcs_on_live_line(), public.fcs_on_call(), public.fcs_on_job();
    DROP TABLE IF EXISTS public.first_call_sessions;
*/

CREATE TABLE IF NOT EXISTS public.first_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('phone', 'browser')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN
    ('created', 'waiting_for_number', 'ringing', 'in_call', 'completed', 'no_answer', 'voicemail', 'failed', 'canceled')),
  failure_code text CHECK (failure_code IS NULL OR failure_code IN
    ('not_configured', 'number_pending', 'invalid_number', 'unsupported_destination', 'rate_limited',
     'carrier_error', 'no_answer', 'voicemail', 'busy', 'canceled', 'provider_error')),
  vapi_call_id text UNIQUE,
  phone_calling_code text,
  phone_last4 text CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{1,4}$'),
  notify_when_ready boolean NOT NULL DEFAULT false,
  notify_phone_e164 text CHECK (notify_phone_e164 IS NULL OR notify_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  notified_at timestamptz,
  signup_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  ringing_at timestamptz,
  answered_at timestamptz,
  first_transcript_at timestamptz,
  booking_at timestamptz,
  completed_at timestamptz,
  call_id uuid,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (notify_phone_e164 IS NULL OR notify_when_ready)
);

CREATE INDEX IF NOT EXISTS idx_fcs_user_requested ON public.first_call_sessions (user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_fcs_waiting ON public.first_call_sessions (status) WHERE status = 'waiting_for_number' AND notify_when_ready;
-- At most one in-flight attempt per account: a double-click or a second tab gets the same session back (idempotent start).
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcs_one_active
  ON public.first_call_sessions (user_id) WHERE status IN ('created', 'ringing', 'in_call');

ALTER TABLE public.first_call_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "first_call_sessions_select" ON public.first_call_sessions;
CREATE POLICY "first_call_sessions_select" ON public.first_call_sessions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.first_call_sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.first_call_sessions FROM authenticated;
GRANT SELECT ON public.first_call_sessions TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.first_call_sessions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- =============================================================
-- Triggers: advance the session from rows the webhook already writes
-- =============================================================

-- live_calls: ringing / in_progress / ended
CREATE OR REPLACE FUNCTION public.fcs_on_live_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r text := lower(coalesce(NEW.ended_reason, ''));
BEGIN
  IF NEW.status = 'ringing' THEN
    UPDATE first_call_sessions SET status = 'ringing', ringing_at = coalesce(ringing_at, now()), updated_at = now()
     WHERE vapi_call_id = NEW.vapi_call_id AND user_id = NEW.user_id AND status IN ('created', 'ringing');
  ELSIF NEW.status = 'in_progress' THEN
    UPDATE first_call_sessions SET status = 'in_call', ringing_at = coalesce(ringing_at, now()),
           answered_at = coalesce(answered_at, now()), updated_at = now()
     WHERE vapi_call_id = NEW.vapi_call_id AND user_id = NEW.user_id AND status IN ('created', 'ringing', 'in_call');
  ELSIF NEW.status = 'ended' THEN
    UPDATE first_call_sessions SET
      status = CASE
        WHEN r LIKE '%voicemail%' THEN 'voicemail'
        WHEN r LIKE '%did-not-answer%' OR r LIKE '%no-answer%' THEN 'no_answer'
        WHEN r LIKE '%busy%' THEN 'failed'
        WHEN answered_at IS NOT NULL THEN 'completed'
        ELSE 'failed' END,
      failure_code = CASE
        WHEN r LIKE '%voicemail%' THEN 'voicemail'
        WHEN r LIKE '%did-not-answer%' OR r LIKE '%no-answer%' THEN 'no_answer'
        WHEN r LIKE '%busy%' THEN 'busy'
        WHEN answered_at IS NOT NULL THEN NULL
        WHEN r LIKE '%twilio%' OR r LIKE '%carrier%' OR r LIKE '%sip%' OR r LIKE '%failed-to-connect%' THEN 'carrier_error'
        ELSE 'provider_error' END,
      completed_at = coalesce(completed_at, now()), updated_at = now()
     WHERE vapi_call_id = NEW.vapi_call_id AND user_id = NEW.user_id AND status IN ('created', 'ringing', 'in_call');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fcs_live_calls ON public.live_calls;
CREATE TRIGGER trg_fcs_live_calls AFTER INSERT OR UPDATE OF status ON public.live_calls
  FOR EACH ROW EXECUTE FUNCTION public.fcs_on_live_call();

-- live_call_lines: first transcript line = the "wow" moment
CREATE OR REPLACE FUNCTION public.fcs_on_live_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE first_call_sessions s SET first_transcript_at = coalesce(s.first_transcript_at, now()), updated_at = now()
    FROM live_calls lc
   WHERE lc.id = NEW.live_call_id AND s.vapi_call_id = lc.vapi_call_id AND s.user_id = NEW.user_id
     AND s.first_transcript_at IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fcs_live_lines ON public.live_call_lines;
CREATE TRIGGER trg_fcs_live_lines AFTER INSERT ON public.live_call_lines
  FOR EACH ROW EXECUTE FUNCTION public.fcs_on_live_line();

-- calls: link the call row
CREATE OR REPLACE FUNCTION public.fcs_on_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.vapi_call_id IS NOT NULL THEN
    UPDATE first_call_sessions SET call_id = NEW.id, updated_at = now()
     WHERE vapi_call_id = NEW.vapi_call_id AND user_id = NEW.user_id AND call_id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fcs_calls ON public.calls;
CREATE TRIGGER trg_fcs_calls AFTER INSERT OR UPDATE OF vapi_call_id ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.fcs_on_call();

-- jobs: the booking that "appears on screen"
CREATE OR REPLACE FUNCTION public.fcs_on_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.call_id IS NOT NULL THEN
    UPDATE first_call_sessions s SET job_id = coalesce(s.job_id, NEW.id), booking_at = coalesce(s.booking_at, now()), updated_at = now()
      FROM calls c
     WHERE c.id = NEW.call_id AND s.vapi_call_id = c.vapi_call_id AND s.user_id = NEW.user_id AND s.job_id IS NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fcs_jobs ON public.jobs;
CREATE TRIGGER trg_fcs_jobs AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.fcs_on_job();

-- =============================================================
-- KPI: time-to-first-call (signup -> owner answered and Sarah is speaking), and time-to-wow (first transcript line)
-- Operational product metric computed from the account's own timestamps (no tracking identifiers). Service role only.
-- =============================================================
CREATE OR REPLACE VIEW public.first_call_kpi_daily AS
WITH first_ok AS (
  SELECT DISTINCT ON (user_id) user_id, signup_at, answered_at, first_transcript_at, channel
    FROM public.first_call_sessions
   WHERE answered_at IS NOT NULL AND signup_at IS NOT NULL
   ORDER BY user_id, answered_at
)
SELECT date_trunc('day', answered_at)::date AS day,
       count(*) AS accounts,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - signup_at)) AS p50_seconds_to_first_call,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - signup_at)) AS p90_seconds_to_first_call,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_transcript_at - signup_at))
         FILTER (WHERE first_transcript_at IS NOT NULL) AS p50_seconds_to_wow
  FROM first_ok GROUP BY 1;
REVOKE ALL ON public.first_call_kpi_daily FROM PUBLIC, anon, authenticated;
