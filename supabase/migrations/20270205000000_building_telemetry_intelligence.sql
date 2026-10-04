/*
  # Building Telemetry Intelligence

  Machine-side signal layer: BACnet / Modbus / MQTT / BMS-BAS / thermostat /
  smart-meter / sensor / IoT-gateway data arrives through the
  `telemetry-ingest` edge function (gateway-token auth), is analysed by
  `telemetry-analyze`, and flows
      Telemetry -> Anomaly -> Failure probability -> Parts prediction
      -> Technician preparation -> Proactive service -> Outcome (learning).

  ## Tables
  - telemetry_gateways            token-authenticated ingest endpoints (hash only stored)
  - telemetry_points              one row per sensor / register / topic, mapped to equipment
  - telemetry_readings            raw time series (30-day retention)
  - telemetry_rollups_daily       permanent daily aggregates (the long-term data moat)
  - telemetry_anomalies           detected deviations from each machine's own baseline
  - equipment_failure_predictions explainable probabilities + predicted parts
  - telemetry_outcomes            technician feedback (confirmed / false alarm) -> calibration

  Writes to readings / anomalies / predictions / rollups happen only through
  edge functions (service role) — there are intentionally no client INSERT
  policies on those tables. Every table is scoped by public.get_account_owner_id().
*/

-- =============================================================
-- GATEWAYS
-- =============================================================
CREATE TABLE IF NOT EXISTS telemetry_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  protocol text NOT NULL DEFAULT 'iot_gateway'
    CHECK (protocol IN ('bacnet','modbus','mqtt','bms_bas','thermostat','smart_meter','sensor','iot_gateway','rest')),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  auto_register boolean NOT NULL DEFAULT true,
  max_points integer NOT NULL DEFAULT 500 CHECK (max_points BETWEEN 1 AND 5000),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_gateways_user ON telemetry_gateways(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_gateways_hash_active ON telemetry_gateways(token_hash) WHERE revoked_at IS NULL;

ALTER TABLE telemetry_gateways ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_telemetry_gateways" ON telemetry_gateways;
CREATE POLICY "select_own_telemetry_gateways" ON telemetry_gateways FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_telemetry_gateways" ON telemetry_gateways;
CREATE POLICY "insert_own_telemetry_gateways" ON telemetry_gateways FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_telemetry_gateways" ON telemetry_gateways;
CREATE POLICY "update_own_telemetry_gateways" ON telemetry_gateways FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

-- Token material is immutable; a gateway can only be revoked, never revived.
CREATE OR REPLACE FUNCTION public.prevent_telemetry_gateway_tampering()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Gateway token and owner are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A revoked gateway cannot be re-activated';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_telemetry_gateway_tampering ON telemetry_gateways;
CREATE TRIGGER trg_prevent_telemetry_gateway_tampering
  BEFORE UPDATE ON telemetry_gateways
  FOR EACH ROW EXECUTE FUNCTION public.prevent_telemetry_gateway_tampering();

-- =============================================================
-- POINTS
-- =============================================================
CREATE TABLE IF NOT EXISTS telemetry_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gateway_id uuid NOT NULL REFERENCES telemetry_gateways(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  label text,
  metric text NOT NULL DEFAULT 'other',
  unit text,
  min_valid double precision,
  max_valid double precision,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','muted')),
  baseline_median double precision,
  baseline_mad double precision,
  baseline_mean double precision,
  baseline_std double precision,
  baseline_n integer NOT NULL DEFAULT 0,
  baseline_updated_at timestamptz,
  last_value double precision,
  last_ts timestamptz,
  last_analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_points_user ON telemetry_points(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_points_equipment ON telemetry_points(equipment_id) WHERE equipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telemetry_points_analyze ON telemetry_points(user_id, last_analyzed_at NULLS FIRST) WHERE status = 'active';

ALTER TABLE telemetry_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_telemetry_points" ON telemetry_points;
CREATE POLICY "select_own_telemetry_points" ON telemetry_points FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_telemetry_points" ON telemetry_points;
CREATE POLICY "update_own_telemetry_points" ON telemetry_points FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_telemetry_points" ON telemetry_points;
CREATE POLICY "delete_own_telemetry_points" ON telemetry_points FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- READINGS (raw, 30-day retention) + DAILY ROLLUPS (permanent)
-- =============================================================
CREATE TABLE IF NOT EXISTS telemetry_readings (
  point_id uuid NOT NULL REFERENCES telemetry_points(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ts timestamptz NOT NULL,
  value double precision NOT NULL,
  PRIMARY KEY (point_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_readings_ts ON telemetry_readings(ts);

ALTER TABLE telemetry_readings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telemetry_readings" ON telemetry_readings;
CREATE POLICY "select_own_telemetry_readings" ON telemetry_readings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS telemetry_rollups_daily (
  point_id uuid NOT NULL REFERENCES telemetry_points(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  day date NOT NULL,
  n integer NOT NULL,
  min_value double precision NOT NULL,
  max_value double precision NOT NULL,
  avg_value double precision NOT NULL,
  PRIMARY KEY (point_id, day)
);

ALTER TABLE telemetry_rollups_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telemetry_rollups" ON telemetry_rollups_daily;
CREATE POLICY "select_own_telemetry_rollups" ON telemetry_rollups_daily FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Housekeeping, called by telemetry-analyze (service role only).
CREATE OR REPLACE FUNCTION public.telemetry_housekeeping(p_retention_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted bigint;
BEGIN
  INSERT INTO telemetry_rollups_daily (point_id, user_id, day, n, min_value, max_value, avg_value)
  SELECT point_id, user_id, (ts AT TIME ZONE 'UTC')::date, count(*), min(value), max(value), avg(value)
  FROM telemetry_readings
  WHERE ts >= (now() - interval '3 days')
  GROUP BY point_id, user_id, (ts AT TIME ZONE 'UTC')::date
  ON CONFLICT (point_id, day) DO UPDATE
    SET n = EXCLUDED.n, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, avg_value = EXCLUDED.avg_value;

  DELETE FROM telemetry_readings WHERE ts < now() - make_interval(days => GREATEST(p_retention_days, 7));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.telemetry_housekeeping(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telemetry_housekeeping(integer) TO service_role;

-- =============================================================
-- ANOMALIES
-- =============================================================
CREATE TABLE IF NOT EXISTS telemetry_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  point_id uuid NOT NULL REFERENCES telemetry_points(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  metric text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('spike','drift','flatline','out_of_range','rate_of_change')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  direction text NOT NULL CHECK (direction IN ('high','low')),
  z_score double precision NOT NULL DEFAULT 0,
  observed double precision,
  expected double precision,
  persistence_hours double precision NOT NULL DEFAULT 0,
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_anomalies_open ON telemetry_anomalies(point_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_telemetry_anomalies_user_open ON telemetry_anomalies(user_id, detected_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_telemetry_anomalies_equipment ON telemetry_anomalies(equipment_id) WHERE equipment_id IS NOT NULL;

ALTER TABLE telemetry_anomalies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telemetry_anomalies" ON telemetry_anomalies;
CREATE POLICY "select_own_telemetry_anomalies" ON telemetry_anomalies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FAILURE PREDICTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS equipment_failure_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  failure_mode text NOT NULL,
  failure_label text NOT NULL,
  probability numeric(4,3) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  horizon_days integer NOT NULL,
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  predicted_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_action text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','prepared','serviced','dismissed','expired')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  notified_at timestamptz,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_predictions_active
  ON equipment_failure_predictions(equipment_id, failure_mode) WHERE status IN ('open','prepared');
CREATE INDEX IF NOT EXISTS idx_failure_predictions_user_status ON equipment_failure_predictions(user_id, status, probability DESC);
CREATE INDEX IF NOT EXISTS idx_failure_predictions_job ON equipment_failure_predictions(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE equipment_failure_predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_failure_predictions" ON equipment_failure_predictions;
CREATE POLICY "select_own_failure_predictions" ON equipment_failure_predictions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_failure_predictions" ON equipment_failure_predictions;
CREATE POLICY "update_own_failure_predictions" ON equipment_failure_predictions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.telemetry_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_failure_predictions_touch ON equipment_failure_predictions;
CREATE TRIGGER trg_failure_predictions_touch
  BEFORE UPDATE ON equipment_failure_predictions
  FOR EACH ROW EXECUTE FUNCTION public.telemetry_touch_updated_at();

-- =============================================================
-- OUTCOMES (learning loop)
-- =============================================================
CREATE TABLE IF NOT EXISTS telemetry_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  prediction_id uuid REFERENCES equipment_failure_predictions(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  failure_mode text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('confirmed','false_alarm')),
  predicted_probability numeric(4,3),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_outcomes_prediction ON telemetry_outcomes(prediction_id) WHERE prediction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telemetry_outcomes_user_mode ON telemetry_outcomes(user_id, failure_mode);

ALTER TABLE telemetry_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_telemetry_outcomes" ON telemetry_outcomes;
CREATE POLICY "select_own_telemetry_outcomes" ON telemetry_outcomes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_telemetry_outcomes" ON telemetry_outcomes;
CREATE POLICY "insert_own_telemetry_outcomes" ON telemetry_outcomes FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
