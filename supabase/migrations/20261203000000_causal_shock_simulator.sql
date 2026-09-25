/*
  # Causal Shock Simulator

  ## Why
  Turns a free-text "what if X happens" question into a grounded domino
  chain across customer, SLA, cash, jobs, crew and reputation — computed
  from this business's OWN real data, never invented. Two-step AI Core
  pipeline: (1) extract structured shock parameters from the question,
  (2) after deterministic impact numbers are computed server-side, turn
  those numbers into an ordered causal narrative + response plan. The AI
  never sees raw rows and never invents a number.

  ## Table
  - causal_shock_simulations — one row per simulation run, append-only
    (a real decision-support log the owner can look back on).
*/

CREATE TABLE IF NOT EXISTS causal_shock_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  question text NOT NULL,
  shock_type text NOT NULL DEFAULT 'other'
    CHECK (shock_type IN ('technician_unavailable', 'payment_outage', 'demand_surge', 'supply_shortage', 'other')),
  shock_params jsonb NOT NULL DEFAULT '{}',

  /* Deterministic, computed server-side from real account data */
  impact jsonb NOT NULL DEFAULT '{}',
  severity text NOT NULL DEFAULT 'moderate'
    CHECK (severity IN ('low', 'moderate', 'high', 'severe')),

  /* AI-generated, grounded only in "impact" above */
  cascade jsonb NOT NULL DEFAULT '[]',
  response_plan jsonb NOT NULL DEFAULT '[]',
  summary text,

  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'css_impact_is_object') THEN
    ALTER TABLE causal_shock_simulations
      ADD CONSTRAINT css_impact_is_object CHECK (jsonb_typeof(impact) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'css_cascade_is_array') THEN
    ALTER TABLE causal_shock_simulations
      ADD CONSTRAINT css_cascade_is_array CHECK (jsonb_typeof(cascade) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'css_response_plan_is_array') THEN
    ALTER TABLE causal_shock_simulations
      ADD CONSTRAINT css_response_plan_is_array CHECK (jsonb_typeof(response_plan) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_causal_shock_simulations_user
  ON causal_shock_simulations(user_id, created_at DESC);

ALTER TABLE causal_shock_simulations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_causal_shock_simulations" ON causal_shock_simulations;
CREATE POLICY "select_own_causal_shock_simulations" ON causal_shock_simulations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_causal_shock_simulations" ON causal_shock_simulations;
CREATE POLICY "insert_own_causal_shock_simulations" ON causal_shock_simulations
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_causal_shock_simulations" ON causal_shock_simulations;
CREATE POLICY "delete_own_causal_shock_simulations" ON causal_shock_simulations
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
