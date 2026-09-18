/*
  # Weather-Triggered Surge Intelligence

  This project already has Surge Mode, but split across two disconnected
  halves, both added before this migration:
    - 20260912050000_add_surge_mode.sql: surge_mode_active / surge_mode_note /
      surge_mode_activated_at — read by the dashboard banner
      (src/components/SurgeModeBanner.tsx).
    - 20260913010000_oncall_and_surge_mode.sql: surge_mode_enabled /
      surge_mode_message / surge_mode_priority / surge_max_bookings_per_day —
      read by the AI receptionist (supabase/functions/vapi-webhook).
  Neither half has ever had a UI to turn it ON — only the banner that shows
  it's active exists today. This migration is the first real activator for
  both halves at once, driven by real severe-weather alerts instead of a
  human remembering to flip a switch mid-storm.

  ## What this does

  - Two new columns on `business_profile`:
      weather_surge_enabled  — opt-in switch (default false; nothing
                                changes for an account until the owner
                                turns this on and sets a zip code).
      weather_zip_code       — the 5-digit US zip to watch.
      weather_surge_last_checked_at, surge_mode_source ('manual'|'weather')
                              — bookkeeping so an automatic weather
                                deactivation can never clobber a surge the
                                owner turned on by hand, and vice versa.
  - `weather_surge_events`: one row per NWS alert ever seen for an
    account (deduplicated on the alert's own id), independent of
    whether it ended up triggering surge mode — a real audit trail of
    "what weather did we actually watch happen here."
  - `activate_weather_surge()`: SECURITY DEFINER, called by the
    weather-surge-check Edge Function once per newly-detected relevant
    alert. Sets BOTH surge halves together (so the dashboard banner and
    the AI's call handling always agree), but only when surge isn't
    already active from a manual toggle — a human's explicit call
    always wins over an automated one.
  - `resolve_expired_weather_surges()`: turns surge back off once every
    weather alert that triggered it has expired — but only for accounts
    where the ledger shows weather (not a human) turned it on.
  - Every activation/resolution is also appended to the
    business_activity_events ledger (20260928000000) as
    aggregate_type='business_profile', so "why did surge mode turn on
    last Tuesday" has a permanent, replayable answer.

  ## Deploying

  Matches this repo's existing convention (see send-payment-reminders,
  expire_stale_quotes): the check itself is a callable Edge Function,
  not a migration-managed pg_cron job. After this migration:

    supabase functions deploy weather-surge-check --no-verify-jwt
    supabase secrets set WEATHER_SURGE_CRON_SECRET=<random-string>

  Then schedule a call to it every 15–30 minutes (Supabase Dashboard →
  Edge Functions → Cron, or any external scheduler) as:

    POST https://<project>.functions.supabase.co/weather-surge-check
    X-Cron-Secret: <the same random string>

  No key is required for the weather data itself — it calls the US
  National Weather Service's free public alerts API (api.weather.gov),
  which needs no API key, only a descriptive User-Agent header.
*/

-- =============================================================
-- BUSINESS_PROFILE: opt-in + config
-- =============================================================

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS weather_surge_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS weather_zip_code text,
ADD COLUMN IF NOT EXISTS weather_surge_last_checked_at timestamptz,
ADD COLUMN IF NOT EXISTS surge_mode_source text CHECK (surge_mode_source IS NULL OR surge_mode_source IN ('manual', 'weather'));

-- =============================================================
-- WEATHER_SURGE_EVENTS: every alert ever seen for an account
-- =============================================================

CREATE TABLE IF NOT EXISTS weather_surge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  nws_alert_id text NOT NULL,
  event_type text NOT NULL,
  severity text,
  headline text,
  area_desc text,
  triggered_surge boolean NOT NULL DEFAULT false,
  effective_at timestamptz,
  expires_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_surge_events_unique_alert UNIQUE (user_id, nws_alert_id)
);

CREATE INDEX IF NOT EXISTS idx_weather_surge_events_user ON weather_surge_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_surge_events_open
  ON weather_surge_events(user_id) WHERE triggered_surge AND resolved_at IS NULL;

ALTER TABLE weather_surge_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_weather_surge_events" ON weather_surge_events;
CREATE POLICY "select_own_weather_surge_events" ON weather_surge_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- RECORD: insert a newly-seen alert (idempotent on nws_alert_id).
-- Returns the inserted row, or NULL if this alert was already recorded
-- (so the caller knows not to re-activate surge for it).
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_weather_alert(
  p_user_id uuid,
  p_nws_alert_id text,
  p_event_type text,
  p_severity text,
  p_headline text,
  p_area_desc text,
  p_triggered_surge boolean,
  p_effective_at timestamptz,
  p_expires_at timestamptz
)
RETURNS weather_surge_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row weather_surge_events;
BEGIN
  INSERT INTO weather_surge_events (
    user_id, nws_alert_id, event_type, severity, headline, area_desc,
    triggered_surge, effective_at, expires_at
  ) VALUES (
    p_user_id, p_nws_alert_id, p_event_type, p_severity, p_headline, p_area_desc,
    p_triggered_surge, p_effective_at, p_expires_at
  )
  ON CONFLICT (user_id, nws_alert_id) DO NOTHING
  RETURNING * INTO v_row;

  RETURN v_row; -- NULL when this alert id was already recorded
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_weather_alert(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) TO service_role;

-- =============================================================
-- ACTIVATE: flips both surge halves together for one account.
-- Never overrides a manually-activated surge.
-- =============================================================

CREATE OR REPLACE FUNCTION public.activate_weather_surge(
  p_user_id uuid,
  p_event_type text,
  p_headline text,
  p_priority_note text,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_already_active_from_weather boolean;
BEGIN
  SELECT id, surge_mode_active, surge_mode_source INTO v_profile
  FROM business_profile WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A human turned surge on by hand: leave it alone entirely, just
  -- record that we checked.
  IF v_profile.surge_mode_active AND v_profile.surge_mode_source IS DISTINCT FROM 'weather' THEN
    UPDATE business_profile SET weather_surge_last_checked_at = now() WHERE user_id = p_user_id;
    RETURN;
  END IF;

  v_already_active_from_weather := v_profile.surge_mode_active AND v_profile.surge_mode_source = 'weather';

  UPDATE business_profile SET
    surge_mode_active = true,
    surge_mode_enabled = true,
    surge_mode_note = p_headline,
    surge_mode_message = p_headline,
    surge_mode_priority = p_priority_note,
    -- Keep the original activation timestamp if a weather surge was
    -- already running and this is just another alert extending it.
    surge_mode_activated_at = CASE WHEN v_already_active_from_weather THEN surge_mode_activated_at ELSE now() END,
    surge_mode_source = 'weather',
    weather_surge_last_checked_at = now()
  WHERE user_id = p_user_id;

  IF NOT v_already_active_from_weather THEN
    PERFORM public.append_activity_event(
      p_aggregate_type := 'business_profile',
      p_aggregate_id := v_profile.id,
      p_event_type := 'surge.weather_activated',
      p_event_data := jsonb_build_object('weather_event_type', p_event_type, 'headline', p_headline, 'expires_at', p_expires_at),
      p_actor_type := 'system',
      p_user_id := p_user_id
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_weather_surge(uuid, text, text, text, timestamptz) TO service_role;

-- =============================================================
-- RESOLVE: turns surge back off once every triggering alert for an
-- account has expired — only for accounts weather itself turned on.
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_expired_weather_surges()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_business record;
BEGIN
  FOR v_business IN
    SELECT bp.id, bp.user_id
    FROM business_profile bp
    WHERE bp.surge_mode_active
      AND bp.surge_mode_source = 'weather'
      AND NOT EXISTS (
        SELECT 1 FROM weather_surge_events wse
        WHERE wse.user_id = bp.user_id
          AND wse.triggered_surge
          AND wse.resolved_at IS NULL
          AND (wse.expires_at IS NULL OR wse.expires_at > now())
      )
  LOOP
    UPDATE business_profile SET
      surge_mode_active = false,
      surge_mode_enabled = false,
      surge_mode_source = NULL
    WHERE user_id = v_business.user_id;

    UPDATE weather_surge_events
    SET resolved_at = now()
    WHERE user_id = v_business.user_id AND triggered_surge AND resolved_at IS NULL;

    PERFORM public.append_activity_event(
      p_aggregate_type := 'business_profile',
      p_aggregate_id := v_business.id,
      p_event_type := 'surge.weather_resolved',
      p_event_data := '{}'::jsonb,
      p_actor_type := 'system',
      p_user_id := v_business.user_id
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_expired_weather_surges() TO service_role;
