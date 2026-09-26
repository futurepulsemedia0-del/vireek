/*
  # Continual Identity Learner

  ## Why
  Every other AI-ish module here (Decision Engine, Business Constitution,
  Regret Console, Playbooks) assumes the owner's priorities are fixed or
  can be asked for once. This module assumes the opposite: priorities
  drift as the business grows, and the system should notice — from real
  decisions, not a preferences form.

  ## Model
  A small, fixed catalog of bipolar value dimensions (identity_value_dimensions),
  e.g. growth_vs_stability, risk_vs_safety. Every time the owner (or any
  other module in this codebase) logs a real decision via
  log_identity_decision(), it's stored as a raw event AND folded into a
  running per-dimension score (business_identity_state) using a decaying-
  learning-rate weighted average — recent behavior matters more, but the
  system never fully "freezes," which is the whole point of "continual."

  Periodically (recompute_business_identity_snapshot(), called from the
  dashboard, cheap and idempotent within a day) the current vector is
  frozen into business_identity_snapshots and compared against the oldest
  snapshot in the trailing 30-90 day window. A large enough move on any
  axis is logged as a business_identity_drift_events row — the "this
  business may not be optimizing for what it used to" signal.

  Purely additive. No existing table is touched.
*/

-- =====================================================================
-- 1) Catalog of value dimensions (static reference data, not user-scoped)
-- =====================================================================
CREATE TABLE IF NOT EXISTS identity_value_dimensions (
  key text PRIMARY KEY,
  label text NOT NULL,
  pole_negative_label text NOT NULL,
  pole_positive_label text NOT NULL,
  description text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO identity_value_dimensions (key, label, pole_negative_label, pole_positive_label, description, sort_order) VALUES
  ('growth_vs_stability', 'Growth vs. Stability', 'Stability & Predictability', 'Aggressive Growth', 'How much the business leans into expansion and new bets versus protecting what already works.', 1),
  ('risk_vs_safety', 'Risk vs. Safety', 'Safety-First', 'Risk-Tolerant', 'Willingness to accept uncertain or risky jobs, hires, and bets.', 2),
  ('speed_vs_quality', 'Speed vs. Quality', 'Quality-Priority', 'Speed-Priority', 'Whether the business optimizes for turnaround time or for doing the job right.', 3),
  ('price_vs_relationship', 'Price vs. Relationship', 'Relationship-Driven', 'Price-Driven', 'Whether pricing decisions favor the number or the long-term customer relationship.', 4),
  ('autonomy_vs_control', 'Automation vs. Control', 'Wants Manual Control', 'Delegates & Automates', 'Comfort letting automation/AI/staff decide versus wanting to approve everything.', 5),
  ('discount_generosity', 'Discount Generosity', 'Protects Margin', 'Generous with Discounts', 'How readily the business trades margin for goodwill or volume.', 6)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  pole_negative_label = EXCLUDED.pole_negative_label,
  pole_positive_label = EXCLUDED.pole_positive_label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

ALTER TABLE identity_value_dimensions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_identity_value_dimensions" ON identity_value_dimensions;
CREATE POLICY "read_identity_value_dimensions" ON identity_value_dimensions
  FOR SELECT TO authenticated USING (true);

-- =====================================================================
-- 2) Raw decision events (append-only ledger — the "real decisions" feed)
-- =====================================================================
CREATE TABLE IF NOT EXISTS identity_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  source text NOT NULL DEFAULT 'manual',
  entity_type text,
  entity_id uuid,
  entity_label text,

  /* { [dimension_key]: observed_position } — observed_position in [-1, 1],
     this single decision's evidence of where the business sits on that axis */
  dimension_signals jsonb NOT NULL,
  confidence numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  context jsonb NOT NULL DEFAULT '{}',
  note text,

  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ide_signals_is_object') THEN
    ALTER TABLE identity_decision_events
      ADD CONSTRAINT ide_signals_is_object CHECK (jsonb_typeof(dimension_signals) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ide_user ON identity_decision_events(user_id, occurred_at DESC);

ALTER TABLE identity_decision_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_identity_decision_events" ON identity_decision_events;
CREATE POLICY "select_own_identity_decision_events" ON identity_decision_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — writes only via log_identity_decision() below,
-- so the running score always stays in sync with the event log.

-- =====================================================================
-- 3) Current value function (one row per dimension per business)
-- =====================================================================
CREATE TABLE IF NOT EXISTS business_identity_state (
  user_id uuid NOT NULL,
  dimension_key text NOT NULL REFERENCES identity_value_dimensions(key),
  score numeric(4,3) NOT NULL DEFAULT 0 CHECK (score BETWEEN -1 AND 1),
  sample_count integer NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dimension_key)
);

ALTER TABLE business_identity_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_business_identity_state" ON business_identity_state;
CREATE POLICY "select_own_business_identity_state" ON business_identity_state
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Written only by log_identity_decision() (SECURITY DEFINER).

-- =====================================================================
-- 4) Snapshots (history, and the baseline drift is measured against)
-- =====================================================================
CREATE TABLE IF NOT EXISTS business_identity_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  vector jsonb NOT NULL,
  event_count_since_last integer NOT NULL DEFAULT 0,
  trigger text NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('scheduled', 'manual', 'drift_detected'))
);

CREATE INDEX IF NOT EXISTS idx_bis_user ON business_identity_snapshots(user_id, snapshot_at DESC);

ALTER TABLE business_identity_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_business_identity_snapshots" ON business_identity_snapshots;
CREATE POLICY "select_own_business_identity_snapshots" ON business_identity_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =====================================================================
-- 5) Drift alerts ("this business may not be the same one anymore")
-- =====================================================================
CREATE TABLE IF NOT EXISTS business_identity_drift_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  dimension_key text NOT NULL REFERENCES identity_value_dimensions(key),
  baseline_score numeric(4,3) NOT NULL,
  current_score numeric(4,3) NOT NULL,
  magnitude numeric(4,3) NOT NULL,
  baseline_snapshot_at timestamptz NOT NULL,
  severity text NOT NULL CHECK (severity IN ('notable', 'significant', 'major')),
  narrative text NOT NULL,
  acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bide_user ON business_identity_drift_events(user_id, detected_at DESC);

ALTER TABLE business_identity_drift_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_business_identity_drift_events" ON business_identity_drift_events;
CREATE POLICY "select_own_business_identity_drift_events" ON business_identity_drift_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Acknowledging is a deliberate, logged act — via acknowledge_identity_drift() only.

-- =====================================================================
-- 6) log_identity_decision() — the single write path for real signal.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.log_identity_decision(
  p_source text,
  p_dimension_signals jsonb,
  p_confidence numeric DEFAULT 1.0,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_entity_label text DEFAULT NULL,
  p_context jsonb DEFAULT '{}',
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_event_id uuid;
  v_key text;
  v_observed numeric;
  v_confidence numeric := LEAST(GREATEST(COALESCE(p_confidence, 1.0), 0), 1);
  v_old_score numeric;
  v_old_count integer;
  v_alpha numeric;
  v_new_score numeric;
BEGIN
  IF jsonb_typeof(p_dimension_signals) IS DISTINCT FROM 'object' OR p_dimension_signals = '{}'::jsonb THEN
    RAISE EXCEPTION 'p_dimension_signals must be a non-empty JSON object of dimension_key -> value in [-1, 1]';
  END IF;

  INSERT INTO identity_decision_events
    (user_id, source, entity_type, entity_id, entity_label, dimension_signals, confidence, context, note)
  VALUES
    (v_owner, COALESCE(p_source, 'manual'), p_entity_type, p_entity_id, p_entity_label, p_dimension_signals, v_confidence, COALESCE(p_context, '{}'), p_note)
  RETURNING id INTO v_event_id;

  FOR v_key, v_observed IN SELECT key, LEAST(GREATEST(value::numeric, -1), 1) FROM jsonb_each_text(p_dimension_signals) AS t(key, value)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM identity_value_dimensions WHERE key = v_key) THEN
      CONTINUE;
    END IF;

    SELECT score, sample_count INTO v_old_score, v_old_count
    FROM business_identity_state WHERE user_id = v_owner AND dimension_key = v_key;

    v_old_score := COALESCE(v_old_score, 0);
    v_old_count := COALESCE(v_old_count, 0);

    v_alpha := GREATEST(0.08, 1.0 / (v_old_count + 5)) * v_confidence;
    v_new_score := ROUND(LEAST(GREATEST((1 - v_alpha) * v_old_score + v_alpha * v_observed, -1), 1), 3);

    INSERT INTO business_identity_state (user_id, dimension_key, score, sample_count, last_event_at, updated_at)
    VALUES (v_owner, v_key, v_new_score, 1, now(), now())
    ON CONFLICT (user_id, dimension_key) DO UPDATE SET
      score = v_new_score,
      sample_count = business_identity_state.sample_count + 1,
      last_event_at = now(),
      updated_at = now();
  END LOOP;

  RETURN v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_identity_decision(text, jsonb, numeric, text, uuid, text, jsonb, text) TO authenticated;

-- =====================================================================
-- 7) get_business_identity_profile() — full vector incl. zero-data dims
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_business_identity_profile()
RETURNS TABLE (
  dimension_key text,
  label text,
  pole_negative_label text,
  pole_positive_label text,
  description text,
  score numeric,
  sample_count integer,
  last_event_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    d.key, d.label, d.pole_negative_label, d.pole_positive_label, d.description,
    COALESCE(s.score, 0), COALESCE(s.sample_count, 0), s.last_event_at
  FROM identity_value_dimensions d
  LEFT JOIN business_identity_state s
    ON s.dimension_key = d.key AND s.user_id = public.get_account_owner_id()
  ORDER BY d.sort_order;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_identity_profile() TO authenticated;

-- =====================================================================
-- 8) recompute_business_identity_snapshot() — freeze + drift detection.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.recompute_business_identity_snapshot(p_force boolean DEFAULT false)
RETURNS TABLE (snapshot_id uuid, drift_detected_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_last_snapshot_at timestamptz;
  v_vector jsonb;
  v_new_snapshot_id uuid;
  v_events_since integer;
  v_baseline record;
  v_current numeric;
  v_magnitude numeric;
  v_severity text;
  v_narrative text;
  v_drift_count integer := 0;
BEGIN
  SELECT max(snapshot_at) INTO v_last_snapshot_at
  FROM business_identity_snapshots WHERE user_id = v_owner;

  IF NOT p_force AND v_last_snapshot_at IS NOT NULL AND v_last_snapshot_at > now() - interval '24 hours' THEN
    SELECT id INTO v_new_snapshot_id FROM business_identity_snapshots
    WHERE user_id = v_owner ORDER BY snapshot_at DESC LIMIT 1;
    RETURN QUERY SELECT v_new_snapshot_id, 0;
    RETURN;
  END IF;

  SELECT jsonb_object_agg(dimension_key, score) INTO v_vector
  FROM get_business_identity_profile() AS p(dimension_key, label, pole_negative_label, pole_positive_label, description, score, sample_count, last_event_at);

  SELECT count(*) INTO v_events_since FROM identity_decision_events
  WHERE user_id = v_owner AND occurred_at > COALESCE(v_last_snapshot_at, 'epoch'::timestamptz);

  INSERT INTO business_identity_snapshots (user_id, snapshot_at, vector, event_count_since_last, trigger)
  VALUES (v_owner, now(), COALESCE(v_vector, '{}'::jsonb), v_events_since, CASE WHEN p_force THEN 'manual' ELSE 'scheduled' END)
  RETURNING id INTO v_new_snapshot_id;

  FOR v_baseline IN
    SELECT DISTINCT ON (1) dimension_key, (vector->>dimension_key)::numeric AS baseline_score, snapshot_at
    FROM business_identity_snapshots, jsonb_object_keys(vector) AS dimension_key
    WHERE user_id = v_owner
      AND snapshot_at BETWEEN now() - interval '90 days' AND now() - interval '30 days'
    ORDER BY 1, snapshot_at ASC
  LOOP
    v_current := (v_vector->>v_baseline.dimension_key)::numeric;
    IF v_current IS NULL OR v_baseline.baseline_score IS NULL THEN CONTINUE; END IF;

    v_magnitude := ROUND(ABS(v_current - v_baseline.baseline_score), 3);
    v_severity := CASE
      WHEN v_magnitude >= 0.75 THEN 'major'
      WHEN v_magnitude >= 0.55 THEN 'significant'
      WHEN v_magnitude >= 0.35 THEN 'notable'
      ELSE NULL
    END;

    IF v_severity IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM business_identity_drift_events
      WHERE user_id = v_owner AND dimension_key = v_baseline.dimension_key
        AND acknowledged = false AND baseline_snapshot_at = v_baseline.snapshot_at
    ) THEN
      SELECT format(
        '%s has moved from %s toward %s by %s over the last %s days — this business may not be optimizing for the same priorities it was then.',
        d.label,
        CASE WHEN v_current > v_baseline.baseline_score THEN d.pole_negative_label ELSE d.pole_positive_label END,
        CASE WHEN v_current > v_baseline.baseline_score THEN d.pole_positive_label ELSE d.pole_negative_label END,
        v_magnitude,
        EXTRACT(DAY FROM now() - v_baseline.snapshot_at)::int
      ) INTO v_narrative
      FROM identity_value_dimensions d WHERE d.key = v_baseline.dimension_key;

      INSERT INTO business_identity_drift_events
        (user_id, dimension_key, baseline_score, current_score, magnitude, baseline_snapshot_at, severity, narrative)
      VALUES
        (v_owner, v_baseline.dimension_key, v_baseline.baseline_score, v_current, v_magnitude, v_baseline.snapshot_at, v_severity, v_narrative);

      v_drift_count := v_drift_count + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_new_snapshot_id, v_drift_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_business_identity_snapshot(boolean) TO authenticated;

-- =====================================================================
-- 9) acknowledge_identity_drift() — deliberate, logged dismissal
-- =====================================================================
CREATE OR REPLACE FUNCTION public.acknowledge_identity_drift(p_drift_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE business_identity_drift_events
  SET acknowledged = true, acknowledged_at = now()
  WHERE id = p_drift_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Drift event not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_identity_drift(uuid) TO authenticated;
