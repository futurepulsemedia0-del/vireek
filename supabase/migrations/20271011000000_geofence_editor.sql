/*
  # Geofence editor — circles + polygons with automations on fleet_geofences

  Powers the zone editor on /dashboard/live-map. A zone is a circle or a drawn
  polygon (job site, shop, service area, customer site, depot, restricted area)
  that can trigger automations when a vehicle enters or leaves it:

    - arrived     enter  -> mark the technician's job arrived / in progress
    - clock_in    enter  -> start the assigned technician's shift (time clock)
    - eta_text    enter  -> text the customer "<tech> is about N min away" (+ tracking link)
    - exit_alert  exit   -> notify the account when a vehicle leaves the zone

  Design notes
  - Extends the existing fleet_geofences table (additive); legacy depot /
    restricted / customer_site rows keep working unchanged.
  - Polygons store an OPEN ring of [lng, lat]; latitude/longitude hold the
    centroid and radius_meters the enclosing radius so legacy readers still
    get a sane (coarse) circle.
  - Per-vehicle inside/outside state lives in vehicle_live_state.zone_state so
    the ingest pipeline needs no extra round trips.
  - fleet_geofence_events is the audit trail: one row per confirmed
    enter/exit, with what every automation did (sent / skipped / failed and
    why). Unique per (vehicle, zone, kind, time) so replays never double-fire.
  - Writes to zones require the owner or can_manage_team (enforced by RLS,
    not just the UI).
  - Auto clock-in goes through the existing time-clock event applier, so every
    time-clock validation still applies; the shift is tagged with its source.
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.fleet_can_manage_zones()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1 FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.invite_status = 'accepted'
        AND (
          COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_team', 'false') = 'true'
        )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.fleet_can_manage_zones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fleet_can_manage_zones() TO authenticated;

-- =============================================================
-- VALIDATORS (immutable, used by CHECK constraints)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fleet_polygon_valid(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  pt jsonb;
  n integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN false; END IF;
  n := jsonb_array_length(p);
  IF n < 3 OR n > 200 THEN RETURN false; END IF;
  FOR pt IN SELECT value FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(pt) <> 'array' OR jsonb_array_length(pt) <> 2
       OR jsonb_typeof(pt -> 0) <> 'number' OR jsonb_typeof(pt -> 1) <> 'number' THEN
      RETURN false;
    END IF;
    IF abs((pt ->> 0)::double precision) > 180 OR abs((pt ->> 1)::double precision) > 90 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.fleet_automations_valid(a jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF a IS NULL OR jsonb_typeof(a) <> 'object' THEN RETURN false; END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(a) LOOP
    IF k NOT IN ('arrived', 'clock_in', 'eta_text', 'exit_alert') THEN RETURN false; END IF;
    IF jsonb_typeof(v) <> 'object' OR jsonb_typeof(v -> 'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF v ? 'template' AND (jsonb_typeof(v -> 'template') <> 'string' OR length(v ->> 'template') > 320) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- =============================================================
-- FLEET_GEOFENCES — additive columns + widened constraints
-- =============================================================

ALTER TABLE fleet_geofences
  ADD COLUMN IF NOT EXISTS shape text NOT NULL DEFAULT 'circle',
  ADD COLUMN IF NOT EXISTS polygon jsonb,
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#2563eb',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS automations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dwell_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS exit_buffer_m integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Drop the original type / radius checks whatever they were auto-named.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.fleet_geofences'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%geofence_type%' OR pg_get_constraintdef(oid) ILIKE '%radius_meters%')
  LOOP
    EXECUTE format('ALTER TABLE public.fleet_geofences DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_type_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_type_chk
  CHECK (geofence_type IN ('depot', 'restricted', 'customer_site', 'job_site', 'shop', 'service_area'));

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_radius_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_radius_chk
  CHECK (radius_meters BETWEEN 25 AND 100000);

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_shape_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_shape_chk
  CHECK (shape IN ('circle', 'polygon') AND (shape = 'circle' OR public.fleet_polygon_valid(polygon)));

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_color_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_color_chk CHECK (color ~ '^#[0-9a-fA-F]{6}$');

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_name_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 80);

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_automations_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_automations_chk CHECK (public.fleet_automations_valid(automations));

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_dwell_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_dwell_chk CHECK (dwell_seconds BETWEEN 0 AND 900);

ALTER TABLE fleet_geofences DROP CONSTRAINT IF EXISTS fleet_geofences_exit_buffer_chk;
ALTER TABLE fleet_geofences ADD CONSTRAINT fleet_geofences_exit_buffer_chk CHECK (exit_buffer_m BETWEEN 0 AND 500);

CREATE INDEX IF NOT EXISTS idx_fleet_geofences_job ON fleet_geofences(job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fleet_geofences_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.name := btrim(NEW.name);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fleet_geofences_touch ON fleet_geofences;
CREATE TRIGGER trg_fleet_geofences_touch BEFORE INSERT OR UPDATE ON fleet_geofences
  FOR EACH ROW EXECUTE FUNCTION public.fleet_geofences_touch();

-- Any team member may READ zones (the live map shows them); only managers WRITE.
DROP POLICY IF EXISTS "insert_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "insert_own_fleet_geofences" ON fleet_geofences FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.fleet_can_manage_zones());
DROP POLICY IF EXISTS "update_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "update_own_fleet_geofences" ON fleet_geofences FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fleet_can_manage_zones())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.fleet_can_manage_zones());
DROP POLICY IF EXISTS "delete_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "delete_own_fleet_geofences" ON fleet_geofences FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fleet_can_manage_zones());

-- =============================================================
-- PER-VEHICLE ZONE STATE + JOB / SHIFT AUDIT COLUMNS
-- =============================================================

ALTER TABLE vehicle_live_state ADD COLUMN IF NOT EXISTS zone_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Atomic once-per-window claim for the customer ETA text.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS eta_text_sent_at timestamptz;

ALTER TABLE time_shifts
  ADD COLUMN IF NOT EXISTS clock_in_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS clock_in_zone_id uuid REFERENCES fleet_geofences(id) ON DELETE SET NULL;

-- =============================================================
-- FLEET_GEOFENCE_EVENTS — audit trail + idempotency
-- =============================================================

CREATE TABLE IF NOT EXISTS fleet_geofence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  geofence_id uuid REFERENCES fleet_geofences(id) ON DELETE SET NULL,
  zone_name text NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('enter', 'exit')),
  occurred_at timestamptz NOT NULL,
  latitude double precision,
  longitude double precision,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, geofence_id, kind, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_fleet_geofence_events_user_time ON fleet_geofence_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_geofence_events_zone_time ON fleet_geofence_events(geofence_id, occurred_at DESC);

ALTER TABLE fleet_geofence_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_fleet_geofence_events" ON fleet_geofence_events;
CREATE POLICY "select_own_fleet_geofence_events" ON fleet_geofence_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client write policies: only the ingest pipeline (service role) records events.

-- =============================================================
-- AUTO CLOCK-IN (service role only)
-- Reuses the time-clock event applier so every validation (one open shift,
-- no overlap, ordering, employee link) still applies. Idempotent per event id.
-- Returns: 'applied' | 'duplicate' | 'skipped:<reason>' | 'rejected:<tc_code>'
-- =============================================================

CREATE OR REPLACE FUNCTION public.zone_auto_clock_in(
  p_owner uuid,
  p_team_member uuid,
  p_at timestamptz,
  p_lat double precision,
  p_lng double precision,
  p_zone uuid,
  p_event_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp uuid;
  v_shift uuid := gen_random_uuid();
  v_code text;
BEGIN
  SELECT e.id INTO v_emp
    FROM team_members tm
    JOIN employees e ON e.team_member_id = tm.id AND e.active
   WHERE tm.id = p_team_member AND tm.account_owner_id = p_owner
   LIMIT 1;
  IF v_emp IS NULL THEN RETURN 'skipped:no_employee'; END IF;

  IF EXISTS (SELECT 1 FROM time_event_log WHERE team_member_id = p_team_member AND event_id = p_event_id) THEN
    RETURN 'duplicate';
  END IF;
  IF EXISTS (SELECT 1 FROM time_shifts WHERE team_member_id = p_team_member AND status = 'open') THEN
    RETURN 'skipped:already_clocked_in';
  END IF;

  BEGIN
    PERFORM public._tc_apply_event(p_team_member, v_emp, p_owner, jsonb_build_object(
      'type', 'clock_in', 'id', p_event_id, 'shift_id', v_shift, 'at', p_at,
      'work_date', (p_at AT TIME ZONE 'UTC')::date, 'lat', p_lat, 'lng', p_lng
    ));
  EXCEPTION WHEN OTHERS THEN
    v_code := CASE WHEN SQLERRM LIKE 'tc\_%' THEN SQLERRM ELSE 'tc_invalid_event' END;
    INSERT INTO time_event_log (team_member_id, event_id, outcome, code) VALUES (p_team_member, p_event_id, 'rejected', v_code)
      ON CONFLICT DO NOTHING;
    RETURN 'rejected:' || v_code;
  END;

  INSERT INTO time_event_log (team_member_id, event_id, outcome, code) VALUES (p_team_member, p_event_id, 'applied', NULL)
    ON CONFLICT DO NOTHING;
  UPDATE time_shifts SET clock_in_source = 'zone', clock_in_zone_id = p_zone WHERE id = v_shift;
  RETURN 'applied';
END $$;

REVOKE ALL ON FUNCTION public.zone_auto_clock_in(uuid, uuid, timestamptz, double precision, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zone_auto_clock_in(uuid, uuid, timestamptz, double precision, double precision, uuid, uuid) TO service_role;

-- =============================================================
-- REALTIME — the zone activity feed updates live
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE fleet_geofence_events;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- already published
  WHEN undefined_object THEN NULL;   -- publication does not exist on this project
END $$;
