/*
# Call usage metering

## What this migration does
Makes `profiles.minutes_used_this_month` a real meter driven by call duration.

Whenever a row in `calls` gets a (higher) `duration_seconds`, the delta is
converted to whole minutes (ceil) and added to the account owner's
`minutes_used_this_month`. This is the single source of truth used by:
- UsageLimitBanner
- BillingPage / UsageDashboardPage
- check-usage-alert edge function

## Design choices
1. `usage_billed_seconds` on `calls` — tracks how many seconds of this call
   have already been charged. Re-processing the same end-of-call-report
   (Vapi can retry) never double-counts.
2. BEFORE INSERT OR UPDATE trigger — can write back `usage_billed_seconds`
   on NEW without a second UPDATE.
3. SECURITY DEFINER + fixed search_path — same pattern as the rest of the
   schema; the trigger must be able to UPDATE profiles regardless of the
   role that wrote the call row (service-role from vapi-webhook, or a
   future authenticated insert).
4. Only positive deltas. Decreasing duration (rare correction) does not
   refund minutes automatically — that would be a support action.
5. Billing unit = ceil(seconds / 60). Matches industry voice metering and
   the integer-minute UI already shown in the dashboard.

## Monthly reset
This migration does NOT reset the counter. The product currently treats
`minutes_used_this_month` as a calendar-month field with no automated
rollover in the repo. Add a scheduled job (pg_cron or external) that runs
on the 1st of each month:

  UPDATE profiles SET minutes_used_this_month = 0;

Or reset on Stripe invoice.paid / subscription cycle if you prefer
billing-period alignment. Without a reset, usage only ever grows.

## Backfill (optional, run once after deploy)
To seed the current month from existing call rows (idempotent because of
usage_billed_seconds):

  UPDATE calls
  SET duration_seconds = duration_seconds
  WHERE duration_seconds IS NOT NULL
    AND duration_seconds > 0
    AND COALESCE(usage_billed_seconds, 0) = 0
    AND call_datetime >= date_trunc('month', now());

The trigger will fire and charge each call exactly once.
*/

-- =============================================================
-- COLUMN: how many seconds of this call have already been metered
-- =============================================================

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS usage_billed_seconds integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.calls.usage_billed_seconds IS
  'Seconds of duration_seconds already applied to profiles.minutes_used_this_month. Prevents double-counting on webhook retries.';

-- =============================================================
-- TRIGGER FUNCTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_call_duration_to_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_billed integer;
  v_new_duration integer;
  v_delta_seconds integer;
  v_delta_minutes integer;
BEGIN
  v_new_duration := COALESCE(NEW.duration_seconds, 0);

  -- Nothing to meter yet (in-progress call, or duration not reported).
  IF v_new_duration <= 0 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_old_billed := 0;
  ELSE
    v_old_billed := COALESCE(OLD.usage_billed_seconds, 0);
  END IF;

  v_delta_seconds := v_new_duration - v_old_billed;

  -- Already fully billed, or a downward correction we do not auto-refund.
  IF v_delta_seconds <= 0 THEN
    RETURN NEW;
  END IF;

  -- Whole minutes, rounding partial minutes up (standard voice metering).
  v_delta_minutes := CEIL(v_delta_seconds / 60.0)::integer;

  IF v_delta_minutes > 0 AND NEW.user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET minutes_used_this_month = minutes_used_this_month + v_delta_minutes
    WHERE id = NEW.user_id;
  END IF;

  NEW.usage_billed_seconds := v_new_duration;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.apply_call_duration_to_usage() IS
  'Meters call duration into profiles.minutes_used_this_month. Idempotent via calls.usage_billed_seconds.';

-- =============================================================
-- TRIGGER
-- =============================================================

DROP TRIGGER IF EXISTS trg_apply_call_duration_to_usage ON public.calls;

CREATE TRIGGER trg_apply_call_duration_to_usage
  BEFORE INSERT OR UPDATE OF duration_seconds
  ON public.calls
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_call_duration_to_usage();
