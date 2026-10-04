/*
  # Property Intelligence OS — the physical-world loop

  Equipment -> Sensor/IoT -> Live Telemetry -> AI Prediction -> Failure Probability
            -> Part -> Technician -> Schedule -> Customer -> Payment -> Learning

  ## Objects
  pio_devices            sensors/gateways bound to an equipment unit (hashed API key)
  pio_telemetry          raw readings (idempotent per device+metric+timestamp)
  pio_predictions        calibrated failure probability per unit + failure mode
  pio_missions           the autonomous pipeline state machine (one open per unit)
  pio_part_map           optional owner-defined failure-mode -> part mapping
  pio_calibration        per-account learning: how often predictions were right

  ## RPCs
  pio_register_device    owner/team creates a device, key shown ONCE
  pio_set_device_status  pause / resume / revoke
  pio_equipment_features service-role only: SQL-side feature extraction for the model
  pio_dismiss_mission    owner dismisses a mission that hasn't reached the field
  pio_record_outcome     owner/tech confirms what really happened (teaches the model)
  pio_prune_telemetry    retention (service role; schedule daily)

  ## Security model
  * Every table is RLS-scoped to public.get_account_owner_id().
  * Clients can READ everything of theirs; WRITES go only through the RPCs above
    or the service-role edge functions (iot-ingest, property-intelligence-agent).
  * Device keys are stored only as SHA-256 hashes; the plaintext is returned once.

  ## Depends on (pre-existing)
  customers, equipment, jobs, quotes, inventory_parts, inventory_locations,
  inventory_stock_levels, inventory_reservations, job_parts_required,
  inventory_part_vendors, agent_action_catalog, notifications, get_account_owner_id()
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ============================================================
-- DEVICES
-- ============================================================
CREATE TABLE IF NOT EXISTS pio_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  name text NOT NULL,
  sensor_kind text NOT NULL DEFAULT 'generic',
  protocol text NOT NULL DEFAULT 'http'
    CHECK (protocol IN ('http', 'mqtt', 'matter', 'modbus', 'bacnet', 'manual')),
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  last_seen_at timestamptz,
  battery_pct integer CHECK (battery_pct BETWEEN 0 AND 100),
  offline_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pio_devices_user ON pio_devices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pio_devices_equipment ON pio_devices(equipment_id);

ALTER TABLE pio_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_pio_devices" ON pio_devices;
CREATE POLICY "select_own_pio_devices" ON pio_devices
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- TELEMETRY
-- ============================================================
CREATE TABLE IF NOT EXISTS pio_telemetry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES pio_devices(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
  value double precision NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_pio_telemetry_eq_metric_time
  ON pio_telemetry(equipment_id, metric, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_pio_telemetry_user_time
  ON pio_telemetry(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_pio_telemetry_received ON pio_telemetry(received_at);

ALTER TABLE pio_telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_pio_telemetry" ON pio_telemetry;
CREATE POLICY "select_own_pio_telemetry" ON pio_telemetry
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- PREDICTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS pio_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  failure_mode text NOT NULL,
  label text NOT NULL,
  probability numeric(4, 3) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  raw_probability numeric(4, 3),
  confidence numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  horizon_days_min integer NOT NULL,
  horizon_days_max integer NOT NULL,
  predicted_failure_at timestamptz NOT NULL,
  severity text NOT NULL CHECK (severity IN ('watch', 'high', 'critical')),
  probable_cause text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  lifecycle_prior numeric(4, 3) NOT NULL DEFAULT 0,
  model_version text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'confirmed', 'false_positive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One live prediction per unit + failure mode; re-scans update it in place.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pio_active_prediction
  ON pio_predictions(equipment_id, failure_mode) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pio_predictions_user_active
  ON pio_predictions(user_id, probability DESC) WHERE status = 'active';

ALTER TABLE pio_predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_pio_predictions" ON pio_predictions;
CREATE POLICY "select_own_pio_predictions" ON pio_predictions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- MISSIONS (the autonomous pipeline)
-- ============================================================
CREATE TABLE IF NOT EXISTS pio_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  prediction_id uuid REFERENCES pio_predictions(id) ON DELETE SET NULL,
  failure_mode text NOT NULL,
  stage text NOT NULL DEFAULT 'detected' CHECK (stage IN (
    'detected', 'awaiting_customer', 'scheduled', 'dispatched',
    'repaired', 'verified', 'declined', 'dismissed', 'expired'
  )),
  urgency text NOT NULL CHECK (urgency IN ('high', 'critical')),
  headline text NOT NULL,
  explanation text,
  probability numeric(4, 3) NOT NULL,
  deadline_at timestamptz NOT NULL,
  -- parts
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  part_quantity integer NOT NULL DEFAULT 1,
  part_status text NOT NULL DEFAULT 'unchecked'
    CHECK (part_status IN ('unchecked', 'reserved', 'low_stock', 'backorder', 'not_found', 'not_required')),
  part_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  part_eta date,
  reservation_id uuid REFERENCES inventory_reservations(id) ON DELETE SET NULL,
  -- commercial + field
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  -- learning
  outcome text CHECK (outcome IN ('confirmed', 'not_needed', 'different_issue')),
  outcome_at timestamptz,
  blocked_reason text,
  stage_history jsonb NOT NULL DEFAULT '[]',
  customer_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- One open mission per unit: a sick unit never spawns duplicate outreach.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pio_open_mission
  ON pio_missions(equipment_id)
  WHERE stage NOT IN ('verified', 'declined', 'dismissed', 'expired');
CREATE INDEX IF NOT EXISTS idx_pio_missions_user_stage ON pio_missions(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_pio_missions_customer ON pio_missions(customer_id);

ALTER TABLE pio_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pio_missions REPLICA IDENTITY FULL;
DROP POLICY IF EXISTS "select_own_pio_missions" ON pio_missions;
CREATE POLICY "select_own_pio_missions" ON pio_missions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pio_mission_id uuid REFERENCES pio_missions(id) ON DELETE SET NULL;

-- ============================================================
-- PART MAP + CALIBRATION
-- ============================================================
CREATE TABLE IF NOT EXISTS pio_part_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  failure_mode text NOT NULL,
  equipment_type_pattern text,           -- optional ILIKE pattern, e.g. '%condenser%'
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, failure_mode, equipment_type_pattern, part_id)
);

ALTER TABLE pio_part_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "manage_own_pio_part_map" ON pio_part_map;
CREATE POLICY "manage_own_pio_part_map" ON pio_part_map
  FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS pio_calibration (
  user_id uuid NOT NULL,
  failure_mode text NOT NULL,
  total integer NOT NULL DEFAULT 0,
  confirmed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, failure_mode)
);

ALTER TABLE pio_calibration ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_pio_calibration" ON pio_calibration;
CREATE POLICY "select_own_pio_calibration" ON pio_calibration
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- RPC: register a device (key returned ONCE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.pio_register_device(
  p_equipment_id uuid,
  p_name text,
  p_sensor_kind text DEFAULT 'generic',
  p_protocol text DEFAULT 'http'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_customer uuid;
  v_prefix text;
  v_key text;
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF coalesce(btrim(p_name), '') = '' THEN RAISE EXCEPTION 'Device name is required'; END IF;
  IF p_protocol NOT IN ('http', 'mqtt', 'matter', 'modbus', 'bacnet', 'manual') THEN
    RAISE EXCEPTION 'Unsupported protocol';
  END IF;

  SELECT customer_id INTO v_customer FROM equipment
  WHERE id = p_equipment_id AND user_id = v_owner AND status = 'active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Equipment not found'; END IF;

  v_prefix := 'vpk_' || encode(gen_random_bytes(4), 'hex');
  v_key := v_prefix || '_' || encode(gen_random_bytes(24), 'hex');

  INSERT INTO pio_devices (user_id, customer_id, equipment_id, name, sensor_kind, protocol, key_prefix, key_hash)
  VALUES (v_owner, v_customer, p_equipment_id, left(btrim(p_name), 80), left(coalesce(p_sensor_kind, 'generic'), 40),
          p_protocol, v_prefix, encode(digest(v_key, 'sha256'), 'hex'))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('device_id', v_id, 'api_key', v_key, 'key_prefix', v_prefix);
END;
$$;

CREATE OR REPLACE FUNCTION public.pio_set_device_status(p_device_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('active', 'paused', 'revoked') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE pio_devices SET status = p_status, offline_alerted_at = NULL
  WHERE id = p_device_id AND user_id = public.get_account_owner_id() AND status <> 'revoked';
  RETURN FOUND;
END;
$$;

-- ============================================================
-- RPC: feature extraction for the model (service role only)
-- 30-day baseline (excluding last 24h) vs last-24h window + 7-day slope.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pio_equipment_features(p_user_id uuid)
RETURNS TABLE (
  equipment_id uuid, metric text,
  n_baseline integer, base_mean double precision, base_std double precision,
  n_recent integer, recent_mean double precision, recent_p95 double precision,
  slope_per_day double precision, last_value double precision, last_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (
    SELECT t.equipment_id AS eq, t.metric AS m, t.value AS v, t.recorded_at AS ts,
           (t.recorded_at >= now() - interval '24 hours') AS is_recent,
           (t.recorded_at < now() - interval '24 hours') AS is_base,
           (t.recorded_at >= now() - interval '7 days') AS in_slope
    FROM pio_telemetry t
    WHERE t.user_id = p_user_id AND t.recorded_at >= now() - interval '30 days'
  )
  SELECT w.eq, w.m,
         (count(*) FILTER (WHERE w.is_base))::integer,
         avg(w.v) FILTER (WHERE w.is_base),
         stddev_samp(w.v) FILTER (WHERE w.is_base),
         (count(*) FILTER (WHERE w.is_recent))::integer,
         avg(w.v) FILTER (WHERE w.is_recent),
         percentile_cont(0.95) WITHIN GROUP (ORDER BY w.v) FILTER (WHERE w.is_recent),
         regr_slope(w.v, extract(epoch FROM w.ts) / 86400.0) FILTER (WHERE w.in_slope),
         (array_agg(w.v ORDER BY w.ts DESC))[1],
         max(w.ts)
  FROM w
  GROUP BY w.eq, w.m;
$$;

REVOKE ALL ON FUNCTION public.pio_equipment_features(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pio_equipment_features(uuid) TO service_role;

-- ============================================================
-- RPC: dismiss / learn
-- ============================================================
CREATE OR REPLACE FUNCTION public.pio_dismiss_mission(p_mission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE pio_missions
  SET stage = 'dismissed', blocked_reason = NULL, completed_at = now(), updated_at = now(),
      stage_history = stage_history || jsonb_build_array(jsonb_build_object('stage', 'dismissed', 'at', now(), 'by', 'owner'))
  WHERE id = p_mission_id AND user_id = public.get_account_owner_id()
    AND stage IN ('detected', 'awaiting_customer');
  IF FOUND THEN
    -- Release any reserved part so it returns to available stock.
    UPDATE inventory_reservations SET status = 'released', released_at = now()
    WHERE id = (SELECT reservation_id FROM pio_missions WHERE id = p_mission_id) AND status = 'active';
  END IF;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.pio_record_outcome(p_mission_id uuid, p_outcome text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  m pio_missions%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('confirmed', 'not_needed', 'different_issue') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
  SELECT * INTO m FROM pio_missions WHERE id = p_mission_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR m.outcome IS NOT NULL OR m.stage NOT IN ('repaired', 'verified') THEN RETURN false; END IF;

  UPDATE pio_missions SET outcome = p_outcome, outcome_at = now(), updated_at = now() WHERE id = m.id;
  UPDATE pio_predictions
  SET status = CASE WHEN p_outcome = 'confirmed' THEN 'confirmed' ELSE 'false_positive' END,
      resolved_at = now(), updated_at = now()
  WHERE id = m.prediction_id;

  INSERT INTO pio_calibration (user_id, failure_mode, total, confirmed)
  VALUES (v_owner, m.failure_mode, 1, CASE WHEN p_outcome = 'confirmed' THEN 1 ELSE 0 END)
  ON CONFLICT (user_id, failure_mode) DO UPDATE
  SET total = pio_calibration.total + 1,
      confirmed = pio_calibration.confirmed + EXCLUDED.confirmed,
      updated_at = now();
  RETURN true;
END;
$$;

-- ============================================================
-- Retention (raw readings older than 45 days; model only uses 30)
-- ============================================================
CREATE OR REPLACE FUNCTION public.pio_prune_telemetry()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM pio_telemetry WHERE recorded_at < now() - interval '45 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.pio_prune_telemetry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pio_prune_telemetry() TO service_role;

GRANT EXECUTE ON FUNCTION public.pio_register_device(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pio_set_device_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pio_dismiss_mission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pio_record_outcome(uuid, text) TO authenticated;

-- ============================================================
-- Agent Governance: customer outreach needs owner approval by default;
-- parts reservation + dispatch are internal and reversible.
-- ============================================================
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('pio_customer_outreach', 'property-intelligence-agent', 'Predictive failure alert & quote to customer', 'messaging', false, false, true),
  ('pio_parts_reserve', 'property-intelligence-agent', 'Reserve predicted-failure part from stock', 'other', true, false, false),
  ('pio_dispatch', 'property-intelligence-agent', 'Auto-schedule & dispatch predictive repair', 'other', false, false, false)
ON CONFLICT (slug) DO NOTHING;

-- Live dashboard updates (RLS still applies to realtime events).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE pio_missions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

/*
## Cron (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  select cron.schedule('pio-agent-hourly', '7 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/property-intelligence-agent',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>')
    ); $$);

  select cron.schedule('pio-prune-daily', '40 3 * * *', 'select public.pio_prune_telemetry()');
*/
