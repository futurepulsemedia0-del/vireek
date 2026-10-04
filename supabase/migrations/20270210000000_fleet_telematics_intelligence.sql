/*
  # Fleet Intelligence — Telematics → Technician → Job Intelligence

  Turns Fleet Economics (cost accounting) into Fleet Intelligence by adding
  the missing telematics layer and joining it to the technician and the job:

    Vehicle → GPS → Technician → Job → Drive → Arrival → Work → Outcome

  ## New tables
  - telematics_connections   Ingest tokens (hashed) for GPS/OBD providers
                              (Samsara, Geotab, Motive, Vireek mobile, …).
  - vehicle_telemetry_pings  Raw GPS + odometer + fuel + ignition samples.
  - vehicle_safety_events    Harsh braking/accel/cornering, speeding, idle,
                              geofence enter/exit, dashcam clips, collisions.
  - vehicle_diagnostics      Active / cleared diagnostic trouble codes.
  - fleet_geofences          Depots, restricted zones, customer sites.
  - fleet_trip_intelligence  OUTPUT. One row per job: the reconstructed
                              Drive → Arrival → Work → Outcome lifecycle and
                              the fully loaded cost / contribution.
  - fleet_intelligence_profiles OUTPUT. Rollups per technician, vehicle,
                              technician×service, territory×service and
                              technician×vehicle×service. Read by Dispatch
                              (travel cost / speed / on-site time) and by the
                              Workforce Equilibrium engine.

  ## Altered tables (additive only, all IF NOT EXISTS)
  - vehicles           telematics device mapping + last known position.
  - job_vehicle_trips  `source` ('manual' | 'telematics') so automatic trips
                        never overwrite a trip someone logged by hand.

  ## Security
  Every table is tenant-scoped with public.get_account_owner_id(), same as
  vehicles / vehicle_expenses. Output tables are read-only for clients
  (written by service-role edge functions only).
*/

-- =============================================================
-- VEHICLES: telematics fields
-- =============================================================

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS vin text,
  ADD COLUMN IF NOT EXISTS fuel_type text NOT NULL DEFAULT 'gasoline',
  ADD COLUMN IF NOT EXISTS rated_mpg numeric,
  ADD COLUMN IF NOT EXISTS telematics_provider text,
  ADD COLUMN IF NOT EXISTS telematics_device_id text,
  ADD COLUMN IF NOT EXISTS last_latitude double precision,
  ADD COLUMN IF NOT EXISTS last_longitude double precision,
  ADD COLUMN IF NOT EXISTS last_speed_mph numeric,
  ADD COLUMN IF NOT EXISTS last_ignition_on boolean,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_fuel_type_check') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_fuel_type_check
      CHECK (fuel_type IN ('gasoline', 'diesel', 'electric', 'hybrid', 'propane', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_rated_mpg_check') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_rated_mpg_check
      CHECK (rated_mpg IS NULL OR (rated_mpg > 0 AND rated_mpg < 200));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_telematics_device
  ON vehicles (user_id, telematics_provider, telematics_device_id)
  WHERE telematics_device_id IS NOT NULL;

-- =============================================================
-- JOB_VEHICLE_TRIPS: provenance
-- =============================================================

ALTER TABLE job_vehicle_trips
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_vehicle_trips_source_check') THEN
    ALTER TABLE job_vehicle_trips ADD CONSTRAINT job_vehicle_trips_source_check
      CHECK (source IN ('manual', 'telematics'));
  END IF;
END $$;

-- =============================================================
-- TELEMATICS_CONNECTIONS
-- Only a SHA-256 hash of the ingest token is stored. The raw token is
-- generated in the browser, shown once, and never leaves the client again.
-- =============================================================

CREATE TABLE IF NOT EXISTS telematics_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  provider text NOT NULL DEFAULT 'other'
    CHECK (provider IN ('vireek_mobile', 'samsara', 'geotab', 'verizon_connect', 'motive', 'other')),
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telematics_connections_user ON telematics_connections(user_id);

ALTER TABLE telematics_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_telematics_connections" ON telematics_connections;
CREATE POLICY "select_own_telematics_connections" ON telematics_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_telematics_connections" ON telematics_connections;
CREATE POLICY "insert_own_telematics_connections" ON telematics_connections FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_telematics_connections" ON telematics_connections;
CREATE POLICY "update_own_telematics_connections" ON telematics_connections FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_telematics_connections" ON telematics_connections;
CREATE POLICY "delete_own_telematics_connections" ON telematics_connections FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_TELEMETRY_PINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_telemetry_pings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed_mph numeric CHECK (speed_mph IS NULL OR (speed_mph >= 0 AND speed_mph < 250)),
  heading_deg numeric CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),
  odometer_miles numeric CHECK (odometer_miles IS NULL OR odometer_miles >= 0),
  fuel_level_pct numeric CHECK (fuel_level_pct IS NULL OR (fuel_level_pct >= 0 AND fuel_level_pct <= 100)),
  ignition_on boolean,
  source text NOT NULL DEFAULT 'api',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_telemetry_pings_user_time
  ON vehicle_telemetry_pings(user_id, recorded_at DESC);

ALTER TABLE vehicle_telemetry_pings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_telemetry_pings" ON vehicle_telemetry_pings;
CREATE POLICY "select_own_vehicle_telemetry_pings" ON vehicle_telemetry_pings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_SAFETY_EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'harsh_braking', 'harsh_acceleration', 'harsh_cornering', 'speeding',
    'excessive_idle', 'geofence_enter', 'geofence_exit', 'dashcam_clip', 'collision'
  )),
  severity smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  value numeric,
  unit text,
  latitude double precision,
  longitude double precision,
  occurred_at timestamptz NOT NULL,
  media_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'api',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, event_type, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_safety_events_user_time
  ON vehicle_safety_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_safety_events_vehicle_time
  ON vehicle_safety_events(vehicle_id, occurred_at DESC);

ALTER TABLE vehicle_safety_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_safety_events" ON vehicle_safety_events;
CREATE POLICY "select_own_vehicle_safety_events" ON vehicle_safety_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_DIAGNOSTICS
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
  odometer_miles numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_diagnostics_active_code
  ON vehicle_diagnostics(vehicle_id, code) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vehicle_diagnostics_user_status
  ON vehicle_diagnostics(user_id, status);

ALTER TABLE vehicle_diagnostics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_diagnostics" ON vehicle_diagnostics;
CREATE POLICY "select_own_vehicle_diagnostics" ON vehicle_diagnostics FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FLEET_GEOFENCES
-- =============================================================

CREATE TABLE IF NOT EXISTS fleet_geofences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  geofence_type text NOT NULL DEFAULT 'depot' CHECK (geofence_type IN ('depot', 'restricted', 'customer_site')),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_meters integer NOT NULL DEFAULT 200 CHECK (radius_meters BETWEEN 25 AND 20000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_geofences_user ON fleet_geofences(user_id) WHERE active;

ALTER TABLE fleet_geofences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "select_own_fleet_geofences" ON fleet_geofences FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "insert_own_fleet_geofences" ON fleet_geofences FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "update_own_fleet_geofences" ON fleet_geofences FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_fleet_geofences" ON fleet_geofences;
CREATE POLICY "delete_own_fleet_geofences" ON fleet_geofences FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FLEET_TRIP_INTELLIGENCE (OUTPUT — one row per job)
-- Money is stored in integer cents.
-- =============================================================

CREATE TABLE IF NOT EXISTS fleet_trip_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  territory_id uuid,
  service_type text,
  outcome text NOT NULL DEFAULT 'completed',

  scheduled_at timestamptz,
  departed_at timestamptz,
  arrived_at timestamptz,
  work_started_at timestamptz,
  work_completed_at timestamptz,
  arrival_verified boolean NOT NULL DEFAULT false,

  drive_minutes numeric,
  idle_minutes numeric,
  on_site_minutes numeric,
  arrival_delay_minutes numeric,
  distance_miles numeric,
  distance_source text NOT NULL DEFAULT 'none'
    CHECK (distance_source IN ('odometer', 'gps_path', 'estimated', 'manual', 'none')),
  avg_speed_mph numeric,
  harsh_event_count integer NOT NULL DEFAULT 0,
  speeding_event_count integer NOT NULL DEFAULT 0,

  fuel_cost_cents integer NOT NULL DEFAULT 0,
  wear_cost_cents integer NOT NULL DEFAULT 0,
  idle_cost_cents integer NOT NULL DEFAULT 0,
  fixed_cost_cents integer NOT NULL DEFAULT 0,
  vehicle_cost_cents integer NOT NULL DEFAULT 0,
  drive_labor_cost_cents integer NOT NULL DEFAULT 0,
  on_site_labor_cost_cents integer NOT NULL DEFAULT 0,
  fully_loaded_cost_cents integer NOT NULL DEFAULT 0,
  revenue_cents integer NOT NULL DEFAULT 0,
  contribution_cents integer NOT NULL DEFAULT 0,
  margin_pct numeric,

  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
  data_quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_trip_intel_user_time ON fleet_trip_intelligence(user_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_trip_intel_user_arrived ON fleet_trip_intelligence(user_id, work_completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_trip_intel_tech ON fleet_trip_intelligence(technician_id);
CREATE INDEX IF NOT EXISTS idx_fleet_trip_intel_vehicle ON fleet_trip_intelligence(vehicle_id);

ALTER TABLE fleet_trip_intelligence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_fleet_trip_intelligence" ON fleet_trip_intelligence;
CREATE POLICY "select_own_fleet_trip_intelligence" ON fleet_trip_intelligence FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FLEET_INTELLIGENCE_PROFILES (OUTPUT — rollups)
-- =============================================================

CREATE TABLE IF NOT EXISTS fleet_intelligence_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_key text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('technician', 'technician_service', 'vehicle', 'territory_service', 'combo')),
  technician_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  territory_id uuid,
  service_type text,
  window_days integer NOT NULL DEFAULT 90,

  sample_size integer NOT NULL DEFAULT 0,
  avg_drive_minutes numeric,
  avg_on_site_minutes numeric,
  avg_distance_miles numeric,
  avg_speed_mph numeric,
  windshield_share_pct numeric,
  idle_share_pct numeric,
  cost_per_mile_cents numeric,
  variable_cost_per_mile_cents numeric,
  avg_idle_cost_cents numeric,
  avg_vehicle_cost_cents numeric,
  avg_fully_loaded_cost_cents numeric,
  avg_revenue_cents numeric,
  avg_contribution_cents numeric,
  avg_margin_pct numeric,
  on_time_pct numeric,
  harsh_per_100mi numeric,
  total_vehicle_cost_cents bigint NOT NULL DEFAULT 0,
  total_contribution_cents bigint NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),

  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_fleet_profiles_user_scope ON fleet_intelligence_profiles(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_fleet_profiles_tech ON fleet_intelligence_profiles(technician_id);

ALTER TABLE fleet_intelligence_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_fleet_intelligence_profiles" ON fleet_intelligence_profiles;
CREATE POLICY "select_own_fleet_intelligence_profiles" ON fleet_intelligence_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- RETENTION: raw pings are only needed until a trip is reconstructed.
-- Schedule daily (pg_cron or a scheduled edge function):
--   SELECT public.prune_vehicle_telemetry(45);
-- Safety events and trip intelligence are kept.
-- =============================================================

CREATE OR REPLACE FUNCTION public.prune_vehicle_telemetry(p_retention_days integer DEFAULT 45)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days < 7 THEN
    RAISE EXCEPTION 'retention must be at least 7 days';
  END IF;
  DELETE FROM vehicle_telemetry_pings
  WHERE recorded_at < now() - make_interval(days => p_retention_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_vehicle_telemetry(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_vehicle_telemetry(integer) TO service_role;
