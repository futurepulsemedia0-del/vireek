/*
  # Causal World Simulator (Business Digital Twin)

  ## Why
  Completes the already-wired "Causal World Simulator" feature (route +
  nav item + AI Core task already existed, page + backend did not).
  Answers "if I do X, what happens to Revenue/Margin/SLA/Capacity — and
  what would happen if I didn't?" Baseline + projected metrics are
  computed deterministically server-side from THIS account's own real
  data; the AI layer only narrates on top of numbers already computed.

  ## Table
  - causal_world_simulations — one row per simulation run, append-only.
*/

CREATE TABLE IF NOT EXISTS causal_world_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  decision_type text NOT NULL
    CHECK (decision_type IN (
      'hire_technicians', 'raise_prices', 'add_service_line',
      'extend_hours_24_7', 'increase_marketing_spend', 'reduce_response_time'
    )),
  decision_label text NOT NULL,
  decision_params jsonb NOT NULL DEFAULT '{}',

  /* Deterministic, computed server-side from real account data */
  baseline jsonb NOT NULL DEFAULT '{}',
  projected jsonb NOT NULL DEFAULT '{}',

  /* AI-generated, grounded only in "baseline"/"projected" above */
  predicted_impact_pct numeric NOT NULL DEFAULT 0,
  predicted_confidence integer NOT NULL DEFAULT 0 CHECK (predicted_confidence BETWEEN 0 AND 100),
  timeframe_days integer NOT NULL DEFAULT 30,
  causal_factors jsonb NOT NULL DEFAULT '[]',
  risk_factors jsonb NOT NULL DEFAULT '[]',
  counterfactual_narrative text,

  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cws_baseline_is_object') THEN
    ALTER TABLE causal_world_simulations
      ADD CONSTRAINT cws_baseline_is_object CHECK (jsonb_typeof(baseline) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cws_projected_is_object') THEN
    ALTER TABLE causal_world_simulations
      ADD CONSTRAINT cws_projected_is_object CHECK (jsonb_typeof(projected) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cws_causal_factors_is_array') THEN
    ALTER TABLE causal_world_simulations
      ADD CONSTRAINT cws_causal_factors_is_array CHECK (jsonb_typeof(causal_factors) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cws_risk_factors_is_array') THEN
    ALTER TABLE causal_world_simulations
      ADD CONSTRAINT cws_risk_factors_is_array CHECK (jsonb_typeof(risk_factors) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_causal_world_simulations_user
  ON causal_world_simulations(user_id, created_at DESC);

ALTER TABLE causal_world_simulations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_causal_world_simulations" ON causal_world_simulations;
CREATE POLICY "select_own_causal_world_simulations" ON causal_world_simulations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_causal_world_simulations" ON causal_world_simulations;
CREATE POLICY "insert_own_causal_world_simulations" ON causal_world_simulations
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_causal_world_simulations" ON causal_world_simulations;
CREATE POLICY "delete_own_causal_world_simulations" ON causal_world_simulations
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
