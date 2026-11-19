-- Heat-index alerts for technicians (opt-in), with water / rest reminders.
--
-- Builds on Site Safety Intelligence (20281201000000). The lone-worker timer, escalation to the dispatcher and the
-- incident log already exist there (safety_sessions / safety_events / safety_incidents) and are NOT duplicated here.
--
-- Rules:
--  * Two opt-ins: the company turns heat reminders on, AND each technician turns them on for themselves.
--  * Reminders are shown to the technician only. They never contact the dispatcher or emergency services.
--  * No medical data is stored: only ZIP, an estimated temperature / humidity / heat index and reminder timestamps.
--  * Technicians see only their own watches and events. Managers see settings, not individual heat data.
--  * Writes happen only through the SECURITY DEFINER RPCs below and the service-role tick (safety-heat-tick).
--  * Heat data is purged after 30 days (safety_heat_purge_expired).

-- =============================================================
-- 1) Interval validator (used by a CHECK constraint)
-- =============================================================
CREATE OR REPLACE FUNCTION public.safety_heat_intervals_ok(j jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN j IS NULL OR jsonb_typeof(j) <> 'object' THEN false
    WHEN NOT (j ?& ARRAY['low', 'caution', 'high', 'very_high', 'extreme']) THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(j)) <> 5 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_each(j) e
      WHERE CASE
        WHEN jsonb_typeof(e.value) <> 'number' THEN true
        ELSE (e.value::text)::numeric <> trunc((e.value::text)::numeric)
          OR ((e.value::text)::numeric <> 0 AND ((e.value::text)::numeric < 5 OR (e.value::text)::numeric > 480))
      END
    )
  END;
$$;

-- =============================================================
-- 2) Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS safety_heat_settings (
  user_id uuid PRIMARY KEY,                                    -- account owner
  enabled boolean NOT NULL DEFAULT false,
  water_every_min jsonb NOT NULL DEFAULT '{"low":0,"caution":60,"high":30,"very_high":20,"extreme":15}'::jsonb,
  rest_every_min jsonb NOT NULL DEFAULT '{"low":0,"caution":0,"high":120,"very_high":60,"extreme":30}'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_heat_water_intervals CHECK (public.safety_heat_intervals_ok(water_every_min)),
  CONSTRAINT chk_heat_rest_intervals CHECK (public.safety_heat_intervals_ok(rest_every_min))
);
ALTER TABLE safety_heat_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_heat_settings_select" ON safety_heat_settings;
CREATE POLICY "safety_heat_settings_select" ON safety_heat_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.safety_can_manage());

CREATE TABLE IF NOT EXISTS safety_heat_prefs (
  team_member_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  opted_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE safety_heat_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_heat_prefs_select" ON safety_heat_prefs;
CREATE POLICY "safety_heat_prefs_select" ON safety_heat_prefs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND team_member_id = public.get_my_team_member_id());

CREATE TABLE IF NOT EXISTS safety_heat_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  zip text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('manual', 'max_duration', 'opted_out')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  tier text NOT NULL DEFAULT 'low' CHECK (tier IN ('low', 'caution', 'high', 'very_high', 'extreme')),
  last_checked_at timestamptz,
  last_observed_at timestamptz,
  last_temp_f numeric(5, 1),
  last_rh numeric(4, 1),
  last_heat_index_f numeric(5, 1),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 60),
  last_water_at timestamptz NOT NULL DEFAULT now(),
  last_rest_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_heat_watch_end CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_heat_watch_live ON safety_heat_watches(team_member_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_safety_heat_watch_live ON safety_heat_watches(status, last_checked_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_safety_heat_watch_purge ON safety_heat_watches(ended_at) WHERE status = 'ended';
ALTER TABLE safety_heat_watches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_heat_watches_select" ON safety_heat_watches;
CREATE POLICY "safety_heat_watches_select" ON safety_heat_watches FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND team_member_id = public.get_my_team_member_id());

CREATE TABLE IF NOT EXISTS safety_heat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  watch_id uuid NOT NULL REFERENCES safety_heat_watches(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('watch_started', 'tier_change', 'water_prompt', 'rest_prompt', 'watch_ended')),
  tier text CHECK (tier IS NULL OR tier IN ('low', 'caution', 'high', 'very_high', 'extreme')),
  heat_index_f numeric(5, 1),
  dedupe_key text NOT NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: the same timer action can never be recorded twice for a watch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_heat_event_dedupe ON safety_heat_events(watch_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_safety_heat_events_watch ON safety_heat_events(watch_id, created_at DESC);
ALTER TABLE safety_heat_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_heat_events_select" ON safety_heat_events;
CREATE POLICY "safety_heat_events_select" ON safety_heat_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND EXISTS (SELECT 1 FROM safety_heat_watches w WHERE w.id = watch_id AND w.team_member_id = public.get_my_team_member_id()));

-- No client writes at all: everything goes through the RPCs below or the service-role tick.
REVOKE INSERT, UPDATE, DELETE ON safety_heat_settings, safety_heat_prefs, safety_heat_watches, safety_heat_events FROM anon, authenticated;

-- =============================================================
-- 3) RPCs
-- =============================================================

-- Settings + the caller's own opt-in. Any signed-in team member may read the on/off state; intervals are returned
-- to everyone because the technician UI shows "every N minutes" wording.
CREATE OR REPLACE FUNCTION public.heat_get_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_s safety_heat_settings%ROWTYPE;
  v_in boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_s FROM safety_heat_settings WHERE user_id = v_owner;
  IF v_me IS NOT NULL THEN
    SELECT coalesce(opted_in, false) INTO v_in FROM safety_heat_prefs WHERE team_member_id = v_me;
  END IF;
  RETURN jsonb_build_object(
    'enabled', coalesce(v_s.enabled, false),
    'water_every_min', coalesce(v_s.water_every_min, '{"low":0,"caution":60,"high":30,"very_high":20,"extreme":15}'::jsonb),
    'rest_every_min', coalesce(v_s.rest_every_min, '{"low":0,"caution":0,"high":120,"very_high":60,"extreme":30}'::jsonb),
    'my_opted_in', coalesce(v_in, false),
    'is_team_member', v_me IS NOT NULL,
    'can_manage', public.safety_can_manage());
END;
$$;
REVOKE ALL ON FUNCTION public.heat_get_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_get_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.heat_save_settings(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cur safety_heat_settings%ROWTYPE;
  v_enabled boolean;
  v_water jsonb;
  v_rest jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.safety_can_manage() THEN
    RAISE EXCEPTION 'Only managers can change heat reminder settings' USING ERRCODE = '42501';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_cur FROM safety_heat_settings WHERE user_id = v_owner;
  v_enabled := coalesce((p ->> 'enabled')::boolean, v_cur.enabled, false);
  v_water := coalesce(p -> 'water_every_min', v_cur.water_every_min, '{"low":0,"caution":60,"high":30,"very_high":20,"extreme":15}'::jsonb);
  v_rest := coalesce(p -> 'rest_every_min', v_cur.rest_every_min, '{"low":0,"caution":0,"high":120,"very_high":60,"extreme":30}'::jsonb);
  IF NOT public.safety_heat_intervals_ok(v_water) OR NOT public.safety_heat_intervals_ok(v_rest) THEN
    RAISE EXCEPTION 'Each level needs 0 (off) or a whole number of minutes from 5 to 480' USING ERRCODE = '22023';
  END IF;
  INSERT INTO safety_heat_settings (user_id, enabled, water_every_min, rest_every_min, updated_by)
  VALUES (v_owner, v_enabled, v_water, v_rest, auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, water_every_min = EXCLUDED.water_every_min,
        rest_every_min = EXCLUDED.rest_every_min, updated_by = EXCLUDED.updated_by, updated_at = now();
  -- Turning the company switch off ends every live watch so nobody keeps getting prompts.
  IF NOT v_enabled THEN
    UPDATE safety_heat_watches SET status = 'ended', ended_at = now(), end_reason = 'manual'
    WHERE user_id = v_owner AND status = 'active';
  END IF;
  RETURN public.heat_get_settings();
END;
$$;
REVOKE ALL ON FUNCTION public.heat_save_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_save_settings(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.heat_set_optin(p_opted_in boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Only team members can change heat reminder preferences' USING ERRCODE = '42501';
  END IF;
  IF p_opted_in IS NULL THEN RAISE EXCEPTION 'Invalid choice' USING ERRCODE = '22023'; END IF;
  INSERT INTO safety_heat_prefs (team_member_id, user_id, opted_in) VALUES (v_me, v_owner, p_opted_in)
  ON CONFLICT (team_member_id) DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = now();
  IF NOT p_opted_in THEN
    UPDATE safety_heat_watches SET status = 'ended', ended_at = now(), end_reason = 'opted_out'
    WHERE team_member_id = v_me AND status = 'active';
  END IF;
  RETURN public.heat_get_settings();
END;
$$;
REVOKE ALL ON FUNCTION public.heat_set_optin(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_set_optin(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.heat_start_watch(p_zip text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_zip text := btrim(coalesce(p_zip, ''));
  v_enabled boolean;
  v_in boolean;
  v_w safety_heat_watches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Only team members can start heat reminders' USING ERRCODE = '42501';
  END IF;
  IF v_zip !~ '^[0-9]{5}$' THEN RETURN jsonb_build_object('success', false, 'error', 'bad_zip'); END IF;
  SELECT coalesce(enabled, false) INTO v_enabled FROM safety_heat_settings WHERE user_id = v_owner;
  IF NOT coalesce(v_enabled, false) THEN RETURN jsonb_build_object('success', false, 'error', 'heat_disabled'); END IF;
  SELECT coalesce(opted_in, false) INTO v_in FROM safety_heat_prefs WHERE team_member_id = v_me;
  IF NOT coalesce(v_in, false) THEN RETURN jsonb_build_object('success', false, 'error', 'not_opted_in'); END IF;

  SELECT * INTO v_w FROM safety_heat_watches WHERE team_member_id = v_me AND status = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'existing', true, 'watch_id', v_w.id);
  END IF;
  BEGIN
    INSERT INTO safety_heat_watches (user_id, team_member_id, zip) VALUES (v_owner, v_me, v_zip) RETURNING * INTO v_w;
  EXCEPTION WHEN unique_violation THEN
    -- Two taps at once: the other insert won. Return it instead of failing.
    SELECT * INTO v_w FROM safety_heat_watches WHERE team_member_id = v_me AND status = 'active';
    RETURN jsonb_build_object('success', true, 'existing', true, 'watch_id', v_w.id);
  END;
  INSERT INTO safety_heat_events (user_id, watch_id, kind, tier, dedupe_key)
  VALUES (v_owner, v_w.id, 'watch_started', 'low', 'start') ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('success', true, 'existing', false, 'watch_id', v_w.id);
END;
$$;
REVOKE ALL ON FUNCTION public.heat_start_watch(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_start_watch(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.heat_end_watch(p_watch uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE safety_heat_watches SET status = 'ended', ended_at = now(), end_reason = 'manual'
  WHERE id = p_watch AND team_member_id = v_me AND status = 'active';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'ended', v_n > 0);   -- ending twice is fine
END;
$$;
REVOKE ALL ON FUNCTION public.heat_end_watch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_end_watch(uuid) TO authenticated;

-- The technician's live view: their watch, open prompts, and any official heat alert already stored by
-- weather-surge-check for the account.
CREATE OR REPLACE FUNCTION public.heat_my_watch()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_w safety_heat_watches%ROWTYPE;
  v_events jsonb;
  v_alert text;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL OR v_owner IS NULL THEN RETURN jsonb_build_object('watch', NULL, 'events', '[]'::jsonb, 'alert', NULL); END IF;
  SELECT * INTO v_w FROM safety_heat_watches WHERE team_member_id = v_me AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('watch', NULL, 'events', '[]'::jsonb, 'alert', NULL); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'tier', e.tier, 'heat_index_f', e.heat_index_f, 'created_at', e.created_at)
                            ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_events
    FROM (SELECT * FROM safety_heat_events
          WHERE watch_id = v_w.id AND acknowledged_at IS NULL AND kind IN ('water_prompt', 'rest_prompt', 'tier_change')
          ORDER BY created_at DESC LIMIT 10) e;
  SELECT event_type INTO v_alert FROM weather_surge_events
   WHERE user_id = v_owner AND resolved_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     AND event_type IN ('Extreme Heat Warning', 'Extreme Heat Watch', 'Excessive Heat Warning', 'Excessive Heat Watch', 'Heat Advisory')
   ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'watch', jsonb_build_object('id', v_w.id, 'zip', v_w.zip, 'tier', v_w.tier, 'started_at', v_w.started_at,
      'last_checked_at', v_w.last_checked_at, 'last_observed_at', v_w.last_observed_at, 'temp_f', v_w.last_temp_f,
      'rh', v_w.last_rh, 'heat_index_f', v_w.last_heat_index_f, 'error', v_w.last_error,
      'last_water_at', v_w.last_water_at, 'last_rest_at', v_w.last_rest_at),
    'events', v_events,
    'alert', v_alert);
END;
$$;
REVOKE ALL ON FUNCTION public.heat_my_watch() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_my_watch() TO authenticated;

-- Acknowledge a prompt. Acknowledging a water / rest prompt restarts that reminder cycle. Idempotent: a second tap
-- on the same event changes nothing, so a double tap can never push the next reminder further out.
CREATE OR REPLACE FUNCTION public.heat_ack(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_e safety_heat_events%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE safety_heat_events e SET acknowledged_at = now()
   WHERE e.id = p_event AND e.acknowledged_at IS NULL
     AND EXISTS (SELECT 1 FROM safety_heat_watches w WHERE w.id = e.watch_id AND w.team_member_id = v_me AND w.status = 'active')
   RETURNING * INTO v_e;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'changed', false); END IF;
  IF v_e.kind = 'water_prompt' THEN UPDATE safety_heat_watches SET last_water_at = now() WHERE id = v_e.watch_id;
  ELSIF v_e.kind = 'rest_prompt' THEN UPDATE safety_heat_watches SET last_rest_at = now() WHERE id = v_e.watch_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.heat_ack(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heat_ack(uuid) TO authenticated;

-- Service role only: 30-day retention.
CREATE OR REPLACE FUNCTION public.safety_heat_purge_expired()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM safety_heat_watches WHERE status = 'ended' AND ended_at < now() - interval '30 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('watches_deleted', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_heat_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safety_heat_purge_expired() TO service_role;

/*
## Cron (run once in the Supabase SQL editor; needs pg_cron + pg_net). Every 10 minutes is enough: the source is an hourly forecast.

    select cron.schedule('safety-heat-tick', '*/10 * * * *', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/safety-heat-tick',
        headers := jsonb_build_object('Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
        body := '{"mode":"tick"}'::jsonb);
    $$);

## ROLLBACK (manual, destructive; heat data is not evidence and is purged after 30 days anyway)
    -- drop table safety_heat_events, safety_heat_watches, safety_heat_prefs, safety_heat_settings cascade;
    -- drop function public.heat_get_settings(), public.heat_save_settings(jsonb), public.heat_set_optin(boolean),
    --   public.heat_start_watch(text), public.heat_end_watch(uuid), public.heat_my_watch(), public.heat_ack(uuid),
    --   public.safety_heat_purge_expired(), public.safety_heat_intervals_ok(jsonb);
*/
