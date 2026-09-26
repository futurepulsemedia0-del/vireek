/*
  # Business Digital Twin

  ## Why
  Every other decision tool in this app (Regret Console, Decision Engine,
  Counterfactual Library) reasons about a *single* choice already on the
  table. This one is upstream of all of them: a lightweight model of the
  whole business (revenue, jobs, technician capacity, cash) that lets the
  owner run "what happens if..." forward in time, BEFORE committing to
  anything — hire two techs? raise prices 8%? push $1,000/wk into ads?
  stack all three?

  All simulation math runs client-side in src/lib/digitalTwin.ts (same
  "transparent, no hidden weighting" philosophy as regretConsole.ts). This
  migration only persists:
    1. the scenarios the owner built (baseline + levers),
    2. each run's projected weekly series + summary,
    3. what actually happened once real time passed, and
    4. the per-lever adjustment factors the twin has *learned* by
       comparing past projections to reality — so it gets more accurate
       the longer it's used, including from scenarios that were explored
       and never acted on.
*/

CREATE TABLE IF NOT EXISTS business_twin_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  name text NOT NULL,
  description text,
  horizon_weeks integer NOT NULL DEFAULT 12 CHECK (horizon_weeks BETWEEN 1 AND 104),

  /* { weekly_revenue, weekly_jobs_completed, technician_count,
       technician_weekly_capacity_hours, avg_job_hours, avg_job_value,
       weekly_marketing_spend, cash_on_hand } */
  baseline jsonb NOT NULL,
  /* [{ id, type, label, value, notes }] */
  levers jsonb NOT NULL DEFAULT '[]'::jsonb,

  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'run', 'archived')),

  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_twin_baseline_is_object') THEN
    ALTER TABLE business_twin_scenarios
      ADD CONSTRAINT business_twin_baseline_is_object CHECK (jsonb_typeof(baseline) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_twin_levers_is_array') THEN
    ALTER TABLE business_twin_scenarios
      ADD CONSTRAINT business_twin_levers_is_array CHECK (jsonb_typeof(levers) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_twin_scenarios_user
  ON business_twin_scenarios(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_twin_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL REFERENCES business_twin_scenarios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),

  horizon_weeks integer NOT NULL,
  baseline jsonb NOT NULL,
  levers jsonb NOT NULL DEFAULT '[]'::jsonb,
  /* per-lever adjustment_factor actually used for this run, snapshotted so
     old runs stay reproducible even after the twin keeps learning */
  assumptions_used jsonb NOT NULL DEFAULT '{}'::jsonb,

  /* [{ week_index, revenue_expected, revenue_optimistic, revenue_pessimistic,
        jobs_expected, utilization_pct_expected,
        cash_cumulative_expected, cash_cumulative_optimistic, cash_cumulative_pessimistic }] */
  weekly_projection jsonb NOT NULL,
  /* { revenue_total_expected, jobs_total_expected, utilization_avg_expected,
        cash_delta_expected, cash_delta_optimistic, cash_delta_pessimistic } */
  summary jsonb NOT NULL,
  narrative text,

  /* Filled in later, once the horizon has actually elapsed — this is what
     lets the twin learn. Never required to close the loop. */
  actual_outcome jsonb,
  accuracy_score numeric CHECK (accuracy_score IS NULL OR (accuracy_score >= 0 AND accuracy_score <= 1)),
  compared_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_twin_runs_projection_is_array') THEN
    ALTER TABLE business_twin_runs
      ADD CONSTRAINT business_twin_runs_projection_is_array CHECK (jsonb_typeof(weekly_projection) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_twin_runs_scenario
  ON business_twin_runs(scenario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_twin_runs_user
  ON business_twin_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_twin_learned_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  lever_type text NOT NULL CHECK (lever_type IN
    ('hire_technicians', 'price_change', 'marketing_spend', 'demand_shock', 'churn_change', 'custom')),
  /* multiplier applied to that lever's modeled effect size; starts at 1.0
     (trust the default assumption) and drifts toward reality over time */
  adjustment_factor numeric NOT NULL DEFAULT 1.0,
  sample_size integer NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  last_run_id uuid REFERENCES business_twin_runs(id) ON DELETE SET NULL,

  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lever_type)
);

CREATE OR REPLACE FUNCTION public.touch_business_twin_scenario_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_twin_scenario_touch ON business_twin_scenarios;
CREATE TRIGGER trg_business_twin_scenario_touch
  BEFORE UPDATE ON business_twin_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_twin_scenario_updated_at();

ALTER TABLE business_twin_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_twin_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_twin_learned_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_twin_scenarios" ON business_twin_scenarios;
CREATE POLICY "select_own_business_twin_scenarios" ON business_twin_scenarios
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_twin_scenarios" ON business_twin_scenarios;
CREATE POLICY "insert_own_business_twin_scenarios" ON business_twin_scenarios
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_twin_scenarios" ON business_twin_scenarios;
CREATE POLICY "update_own_business_twin_scenarios" ON business_twin_scenarios
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_twin_scenarios" ON business_twin_scenarios;
CREATE POLICY "delete_own_business_twin_scenarios" ON business_twin_scenarios
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_business_twin_runs" ON business_twin_runs;
CREATE POLICY "select_own_business_twin_runs" ON business_twin_runs
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_twin_runs" ON business_twin_runs;
CREATE POLICY "insert_own_business_twin_runs" ON business_twin_runs
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_twin_runs" ON business_twin_runs;
CREATE POLICY "update_own_business_twin_runs" ON business_twin_runs
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_twin_runs" ON business_twin_runs;
CREATE POLICY "delete_own_business_twin_runs" ON business_twin_runs
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_business_twin_adjustments" ON business_twin_learned_adjustments;
CREATE POLICY "select_own_business_twin_adjustments" ON business_twin_learned_adjustments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_twin_adjustments" ON business_twin_learned_adjustments;
CREATE POLICY "insert_own_business_twin_adjustments" ON business_twin_learned_adjustments
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_twin_adjustments" ON business_twin_learned_adjustments;
CREATE POLICY "update_own_business_twin_adjustments" ON business_twin_learned_adjustments
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_twin_adjustments" ON business_twin_learned_adjustments;
CREATE POLICY "delete_own_business_twin_adjustments" ON business_twin_learned_adjustments
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
