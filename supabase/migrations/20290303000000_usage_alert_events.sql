/*
  # Usage alert events (once-per-period ledger for owner alerts)

  ## What this does
  - usage_alert_events: one row per (account owner, billing period, alert kind). UNIQUE(user_id, period_key, kind)
    is what guarantees "each alert at most once per period", even when two cron runs overlap.
  - period_key = calendar month in UTC ('YYYY-MM'). The repo has no usage_periods table, and
    profiles.minutes_used_this_month is a calendar-month counter (see 20260927000000_call_usage_metering.sql).
  - channels (jsonb) records the outcome per channel, e.g. {"in_app":"sent","email":"sent","sms":"deferred"}.
    Values: sent | deferred | skipped:<reason> | failed:<reason>. Only failed:* is retried.
  - claim_usage_alert() / complete_usage_alert(): service_role-only RPCs. A claim takes a 5-minute lease so
    overlapping runs never send the same alert twice; a crashed run's lease simply expires and is retried
    (max 5 attempts per event).

  ## Access
  Owners (and team members, via get_account_owner_id()) may SELECT their own rows. No INSERT/UPDATE/DELETE
  policy exists, so only the service role can write.

  ## Rollback (before any data matters)
    DROP FUNCTION IF EXISTS public.claim_usage_alert(uuid, text, text, int, int);
    DROP FUNCTION IF EXISTS public.complete_usage_alert(uuid, jsonb, boolean, boolean);
    DROP TABLE IF EXISTS public.usage_alert_events;

  ## Scheduling: see docs/USAGE_ALERTS.md
*/

CREATE TABLE IF NOT EXISTS public.usage_alert_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_key   text NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind         text NOT NULL CHECK (kind IN (
                 'minutes_80', 'minutes_100', 'overage_started', 'sms_80', 'sms_100',
                 'seat_limit', 'location_limit', 'number_limit')),
  channels     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(channels) = 'object'),
  attempts     smallint NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_alert_events_once_per_period UNIQUE (user_id, period_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_usage_alert_events_period_kind ON public.usage_alert_events (period_key, kind);

ALTER TABLE public.usage_alert_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_usage_alert_events" ON public.usage_alert_events;
CREATE POLICY "select_own_usage_alert_events"
  ON public.usage_alert_events FOR SELECT
  TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.usage_alert_events FROM anon, authenticated;
GRANT SELECT ON public.usage_alert_events TO authenticated;

-- Atomically create the event or take over an unfinished one whose lease expired.
-- Returns zero rows when the alert is already completed, leased by another run, or out of attempts.
CREATE OR REPLACE FUNCTION public.claim_usage_alert(
  p_user_id uuid,
  p_period_key text,
  p_kind text,
  p_lease_seconds int DEFAULT 300,
  p_max_attempts int DEFAULT 5
)
RETURNS TABLE (event_id uuid, channels jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_channels jsonb;
BEGIN
  INSERT INTO public.usage_alert_events AS e (user_id, period_key, kind, attempts, lease_until)
  VALUES (p_user_id, p_period_key, p_kind, 1, now() + make_interval(secs => p_lease_seconds))
  ON CONFLICT ON CONSTRAINT usage_alert_events_once_per_period DO UPDATE
    SET attempts = e.attempts + 1,
        lease_until = now() + make_interval(secs => p_lease_seconds)
    WHERE e.completed_at IS NULL
      AND (e.lease_until IS NULL OR e.lease_until < now())
      AND e.attempts < p_max_attempts
  RETURNING e.id, e.channels INTO v_id, v_channels;

  IF v_id IS NULL THEN
    RETURN;
  END IF;
  event_id := v_id;
  channels := v_channels;
  RETURN NEXT;
END;
$$;

-- Merge a per-channel outcome patch; optionally mark the event done and/or release the lease.
CREATE OR REPLACE FUNCTION public.complete_usage_alert(
  p_event_id uuid,
  p_patch jsonb,
  p_done boolean,
  p_release boolean
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.usage_alert_events
     SET channels = channels || COALESCE(p_patch, '{}'::jsonb),
         completed_at = CASE WHEN p_done THEN COALESCE(completed_at, now()) ELSE completed_at END,
         lease_until = CASE WHEN p_release OR p_done THEN NULL ELSE lease_until END
   WHERE id = p_event_id;
$$;

REVOKE ALL ON FUNCTION public.claim_usage_alert(uuid, text, text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_usage_alert(uuid, jsonb, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_usage_alert(uuid, text, text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_usage_alert(uuid, jsonb, boolean, boolean) TO service_role;
