/*
  # Real Telematics OS

  A standalone operational-truth layer, deliberately separate from Fleet Economics:

    Vehicle -> GPS -> Technician -> Job -> Driving -> Fuel -> Safety -> Maintenance

  - telematics_connections / telematics_credentials: provider links (Samsara, Geotab,
    generic signed webhook). Credentials live in a service-role-only table (RLS on,
    zero policies) and are AES-GCM encrypted by the edge functions.
  - vehicles (+ columns): external id mapping so provider devices map to your roster.
  - vehicle_live_state: one hot row per vehicle (live GPS, engine, fuel, odometer).
  - vehicle_position_log: throttled GPS breadcrumbs (source of truth for trips).
  - telematics_events: normalized safety/diagnostic/geofence/dashcam events.
  - vehicle_trips: derived drive cycles (distance, drive/idle time, harsh events).
  - telematics_job_visits: automatic job arrival / departure from geofence dwell.
  - vehicle_faults + vehicle_maintenance_schedules: diagnostics and PM schedule.
  - driver_safety_daily: daily rollups + 0-100 score per vehicle/technician.
  - job_operational_truth: the unified chain per job (vehicle -> tech -> job value -> customer outcome).

  Fleet Economics is NOT modified. compute-telematics-chain writes real miles into the
  existing job_vehicle_trips table, so compute-fleet-economics picks them up unchanged.
*/

-- =============================================================
-- CONNECTIONS (+ service-role-only credentials)
-- =============================================================

CREATE TABLE IF NOT EXISTS telematics_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  provider text NOT NULL CHECK (provider IN ('samsara', 'geotab', 'webhook')),
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  external_org text,
  last_sync_at timestamptz,
  last_error text,
  sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingest_token_hash text,
  settings jsonb NOT NULL DEFAULT jsonb_build_object(
    'geofence_radius_m', 150,
    'dwell_arrival_seconds', 120,
    'departure_buffer_m', 75,
    'idle_threshold_seconds', 300,
    'auto_advance_job_status', false
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_telematics_connections_user ON telematics_connections(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telematics_connections_token ON telematics_connections(ingest_token_hash) WHERE ingest_token_hash IS NOT NULL;

ALTER TABLE telematics_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_telematics_connections" ON telematics_connections;
CREATE POLICY "select_own_telematics_connections" ON telematics_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Writes go through the telematics-connect edge function (service role) only.

CREATE TABLE IF NOT EXISTS telematics_credentials (
  connection_id uuid PRIMARY KEY REFERENCES telematics_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  encrypted text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telematics_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: only the service role can read or write credentials.

-- =============================================================
-- VEHICLES: provider mapping (additive, nullable)
-- =============================================================

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS telematics_connection_id uuid REFERENCES telematics_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS telematics_external_id text,
  ADD COLUMN IF NOT EXISTS vin text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_telematics_external
  ON vehicles(telematics_connection_id, telematics_external_id)
  WHERE telematics_external_id IS NOT NULL;

-- =============================================================
-- LIVE STATE (1 row per vehicle)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_live_state (
  vehicle_id uuid PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  latitude double precision,
  longitude double precision,
  speed_mph numeric,
  heading_deg numeric,
  engine_state text NOT NULL DEFAULT 'unknown' CHECK (engine_state IN ('on', 'off', 'idle', 'unknown')),
  odometer_miles numeric,
  engine_hours numeric,
  fuel_pct numeric,
  check_engine boolean NOT NULL DEFAULT false,
  last_fix_at timestamptz,
  stationary_since timestamptz,
  reverse_geo text,
  geofence_pending jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_live_state_user ON vehicle_live_state(user_id);

ALTER TABLE vehicle_live_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_vehicle_live_state" ON vehicle_live_state;
CREATE POLICY "select_own_vehicle_live_state" ON vehicle_live_state FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- GPS BREADCRUMBS (throttled; idempotent on vehicle + timestamp)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_position_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  speed_mph numeric,
  engine_state text,
  UNIQUE (vehicle_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_position_log_vehicle_time ON vehicle_position_log(vehicle_id, recorded_at DESC);

ALTER TABLE vehicle_position_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_vehicle_position_log" ON vehicle_position_log;
CREATE POLICY "select_own_vehicle_position_log" ON vehicle_position_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- NORMALIZED EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS telematics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'idling', 'collision',
    'dtc_fault', 'geofence_enter', 'geofence_exit', 'ignition_on', 'ignition_off',
    'dashcam_clip', 'distracted_driving', 'seatbelt', 'other'
  )),
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  occurred_at timestamptz NOT NULL,
  latitude double precision,
  longitude double precision,
  speed_mph numeric,
  speed_limit_mph numeric,
  duration_seconds integer,
  media_url text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'provider',
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL external_ids never collide, so this stays idempotent for provider events
  -- while allowing PostgREST upsert(onConflict) (partial indexes can't be targeted).
  UNIQUE (vehicle_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_telematics_events_vehicle_time ON telematics_events(vehicle_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_telematics_events_user_time ON telematics_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_telematics_events_job ON telematics_events(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE telematics_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telematics_events" ON telematics_events;
CREATE POLICY "select_own_telematics_events" ON telematics_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- TRIPS (derived from breadcrumbs by compute-telematics-chain)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  distance_miles numeric NOT NULL DEFAULT 0,
  driving_seconds integer NOT NULL DEFAULT 0,
  idle_seconds integer NOT NULL DEFAULT 0,
  max_speed_mph numeric,
  start_latitude double precision,
  start_longitude double precision,
  end_latitude double precision,
  end_longitude double precision,
  harsh_event_count integer NOT NULL DEFAULT 0,
  linked_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_trips_user_time ON vehicle_trips(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_trips_job ON vehicle_trips(linked_job_id) WHERE linked_job_id IS NOT NULL;

ALTER TABLE vehicle_trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_vehicle_trips" ON vehicle_trips;
CREATE POLICY "select_own_vehicle_trips" ON vehicle_trips FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB VISITS (automatic arrival / departure)
-- =============================================================

CREATE TABLE IF NOT EXISTS telematics_job_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  arrived_at timestamptz NOT NULL,
  departed_at timestamptz,
  onsite_seconds integer,
  arrival_distance_m numeric,
  scheduled_at timestamptz,
  minutes_late integer,
  arrival_method text NOT NULL DEFAULT 'geofence',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, vehicle_id, arrived_at)
);

CREATE INDEX IF NOT EXISTS idx_telematics_job_visits_job ON telematics_job_visits(job_id);
CREATE INDEX IF NOT EXISTS idx_telematics_job_visits_open ON telematics_job_visits(vehicle_id) WHERE departed_at IS NULL;

ALTER TABLE telematics_job_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telematics_job_visits" ON telematics_job_visits;
CREATE POLICY "select_own_telematics_job_visits" ON telematics_job_visits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS telematics_arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS telematics_departed_at timestamptz,
  ADD COLUMN IF NOT EXISTS telematics_onsite_minutes integer;

-- =============================================================
-- DIAGNOSTICS + MAINTENANCE
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_faults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  check_engine boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  source text NOT NULL DEFAULT 'provider'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_faults_active ON vehicle_faults(vehicle_id, code) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_faults_user ON vehicle_faults(user_id, last_seen_at DESC);

ALTER TABLE vehicle_faults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_vehicle_faults" ON vehicle_faults;
CREATE POLICY "select_own_vehicle_faults" ON vehicle_faults FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS vehicle_maintenance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  name text NOT NULL,
  interval_miles numeric CHECK (interval_miles IS NULL OR interval_miles > 0),
  interval_days integer CHECK (interval_days IS NULL OR interval_days > 0),
  last_service_miles numeric,
  last_service_date date,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (interval_miles IS NOT NULL OR interval_days IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_schedules_vehicle ON vehicle_maintenance_schedules(vehicle_id);

ALTER TABLE vehicle_maintenance_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules;
CREATE POLICY "select_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules;
CREATE POLICY "insert_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules;
CREATE POLICY "update_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules;
CREATE POLICY "delete_own_vehicle_maintenance_schedules" ON vehicle_maintenance_schedules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- DRIVER SAFETY (daily rollup, per vehicle)
-- =============================================================

CREATE TABLE IF NOT EXISTS driver_safety_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  day date NOT NULL,
  miles numeric NOT NULL DEFAULT 0,
  driving_minutes numeric NOT NULL DEFAULT 0,
  idle_minutes numeric NOT NULL DEFAULT 0,
  harsh_brake integer NOT NULL DEFAULT 0,
  harsh_accel integer NOT NULL DEFAULT 0,
  harsh_turn integer NOT NULL DEFAULT 0,
  speeding_events integer NOT NULL DEFAULT 0,
  other_events integer NOT NULL DEFAULT 0,
  score numeric NOT NULL DEFAULT 100 CHECK (score BETWEEN 0 AND 100),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, day)
);

CREATE INDEX IF NOT EXISTS idx_driver_safety_daily_user_day ON driver_safety_daily(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_driver_safety_daily_tech ON driver_safety_daily(technician_id, day DESC);

ALTER TABLE driver_safety_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_driver_safety_daily" ON driver_safety_daily;
CREATE POLICY "select_own_driver_safety_daily" ON driver_safety_daily FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB OPERATIONAL TRUTH (the unified chain)
-- =============================================================

CREATE TABLE IF NOT EXISTS job_operational_truth (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  drive_miles numeric NOT NULL DEFAULT 0,
  drive_minutes numeric NOT NULL DEFAULT 0,
  idle_minutes numeric NOT NULL DEFAULT 0,
  onsite_minutes numeric,
  minutes_late integer,
  harsh_events integer NOT NULL DEFAULT 0,
  speeding_events integer NOT NULL DEFAULT 0,
  travel_cost numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  value_per_onsite_hour numeric,
  customer_rating smallint,
  is_rework boolean NOT NULL DEFAULT false,
  customer_disputed boolean NOT NULL DEFAULT false,
  arrival_verified boolean NOT NULL DEFAULT false,
  integrity_score numeric NOT NULL DEFAULT 0 CHECK (integrity_score BETWEEN 0 AND 100),
  flags text[] NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_operational_truth_user ON job_operational_truth(user_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_operational_truth_score ON job_operational_truth(integrity_score);

ALTER TABLE job_operational_truth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_operational_truth" ON job_operational_truth;
CREATE POLICY "select_own_job_operational_truth" ON job_operational_truth FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- REALTIME: live board subscribes to vehicle_live_state
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'vehicle_live_state'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE vehicle_live_state;
  END IF;
END $$;

/*
## Cron (run once in the Supabase SQL editor; pg_cron + pg_net must be enabled).
## Replace <project-ref>, <service-role-key> and <CRON_SECRET>.

    select cron.schedule(
      'telematics-sync-every-minute', '* * * * *',
      $$ select net.http_post(
           url := 'https://<project-ref>.supabase.co/functions/v1/telematics-sync',
           headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
           body := '{}'::jsonb
         ); $$
    );

    select cron.schedule(
      'telematics-chain-every-15-min', '*/15 * * * *',
      $$ select net.http_post(
           url := 'https://<project-ref>.supabase.co/functions/v1/compute-telematics-chain',
           headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
           body := '{}'::jsonb
         ); $$
    );

## Retention: vehicle_position_log grows fast. Add a nightly delete of rows older than
## 90 days (same idea as data-retention-sweep):

    select cron.schedule('telematics-breadcrumb-retention', '40 3 * * *',
      $$ delete from vehicle_position_log where recorded_at < now() - interval '90 days'; $$);
*/
