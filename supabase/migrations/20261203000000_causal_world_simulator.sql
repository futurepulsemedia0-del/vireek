/*
  # Causal World Simulator

  ## Why
  Every other analytics feature in this project (Decision Engine,
  Benchmarks, Regret Console) works with correlation or the account's
  own state. This feature answers a genuinely different question:
  "if I make this specific change, what happens — and what would have
  happened if I hadn't?" It does that by combining:
    1. The account's own ground-truth metrics (never invented).
    2. An anonymized, k-anonymous cohort of OTHER accounts on the
       platform who logged the same category of decision and whose
       real outcome was later measured (see causal-outcome-tracker).
    3. An LLM that is only ever allowed to reason over (1) and (2),
       never to invent a number that isn't already there.

  ## Tables
  - causal_scenarios: a "what if I do X" question the owner asked.
  - causal_simulations: the computed answer for a scenario.
  - causal_outcome_tracking: closes the loop — if the owner actually
    implements the decision, the real before/after revenue delta is
    measured automatically and feeds the cohort for future users.

  ## Security
  Same tenant-isolation pattern as every other feature here:
  `public.get_account_owner_id()` on every RLS policy. The cross-tenant
  cohort read is a SECURITY DEFINER function granted to service_role
  ONLY (never to `authenticated`), and it refuses to return a row for
  any category with fewer than `p_min_sample` distinct contributing
  accounts — identical anonymity guarantee to compute_platform_benchmarks
  in 20260923000000_cross_tenant_benchmarking.sql.
*/

-- =============================================================
-- 1. SCENARIOS — the question
-- =============================================================

CREATE TABLE IF NOT EXISTS causal_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  title text NOT NULL,
  decision_category text NOT NULL CHECK (decision_category IN (
    'pricing', 'dispatch', 'staffing', 'marketing', 'collections', 'retention', 'operations', 'other'
  )),
  decision_description text NOT NULL,

  status text NOT NULL DEFAULT 'simulating' CHECK (status IN (
    'simulating', 'completed', 'failed'
  )),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_causal_scenarios_user_created
  ON causal_scenarios(user_id, created_at DESC);

ALTER TABLE causal_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_causal_scenarios" ON causal_scenarios
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_causal_scenarios" ON causal_scenarios
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_causal_scenarios" ON causal_scenarios
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. SIMULATIONS — the computed counterfactual answer
-- =============================================================

CREATE TABLE IF NOT EXISTS causal_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL REFERENCES causal_scenarios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),

  cohort_available boolean NOT NULL DEFAULT false,
  cohort_sample_size integer NOT NULL DEFAULT 0,
  cohort_success_rate numeric(5,2),
  cohort_avg_impact_pct numeric(6,2),
  cohort_median_impact_pct numeric(6,2),
  cohort_p25_impact_pct numeric(6,2),
  cohort_p75_impact_pct numeric(6,2),

  predicted_impact_pct numeric(6,2) NOT NULL DEFAULT 0,
  predicted_confidence integer NOT NULL DEFAULT 40,
  timeframe_days integer NOT NULL DEFAULT 30,

  causal_factors jsonb NOT NULL DEFAULT '[]',
  risk_factors jsonb NOT NULL DEFAULT '[]',
  counterfactual_narrative text NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_causal_simulations_scenario
  ON causal_simulations(scenario_id);
CREATE INDEX IF NOT EXISTS idx_causal_simulations_user_created
  ON causal_simulations(user_id, created_at DESC);

ALTER TABLE causal_simulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_causal_simulations" ON causal_simulations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No insert/update/delete policy for authenticated: only the
-- causal-world-simulator edge function (service role) writes here.

-- =============================================================
-- 3. OUTCOME TRACKING — closes the loop, feeds future cohorts
-- =============================================================

CREATE TABLE IF NOT EXISTS causal_outcome_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL REFERENCES causal_scenarios(id) ON DELETE CASCADE,
  simulation_id uuid NOT NULL REFERENCES causal_simulations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),

  decision_made boolean NOT NULL DEFAULT false,
  decision_made_at timestamptz,
  baseline_revenue_30d numeric(12,2),
  timeframe_days integer NOT NULL DEFAULT 30,

  outcome_recorded_at timestamptz,
  actual_revenue_30d numeric(12,2),
  actual_impact_pct numeric(6,2),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_causal_outcome_pending
  ON causal_outcome_tracking(decision_made, outcome_recorded_at)
  WHERE decision_made = true AND outcome_recorded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_causal_outcome_user
  ON causal_outcome_tracking(user_id, created_at DESC);

ALTER TABLE causal_outcome_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_causal_outcome" ON causal_outcome_tracking
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No insert/update policy for authenticated: the edge functions
-- (causal-world-simulator on "mark_implemented", causal-outcome-tracker
-- on the nightly sweep) write here using the service role, so a client
-- can never fabricate its own outcome numbers to game the cohort.

-- =============================================================
-- 4. COHORT INSIGHTS — the one cross-tenant read, k-anonymous
-- =============================================================

/*
  Returns aggregate outcome stats for every OTHER account that logged
  a real, measured decision in this category — never a single row
  unless at least p_min_sample distinct accounts contributed, and
  never anything but aggregates (no account is ever identifiable).
  SECURITY DEFINER so it can see across tenants for this one read;
  REVOKEd from authenticated/anon below so no client session can call
  it directly with a lower p_min_sample to try to de-anonymize a
  competitor — only the causal-world-simulator edge function
  (service_role) may call it.
*/
CREATE OR REPLACE FUNCTION public.compute_causal_cohort_insights(
  p_category text,
  p_min_sample integer DEFAULT 5
)
RETURNS TABLE (
  sample_size integer,
  success_rate numeric,
  avg_impact_pct numeric,
  median_impact_pct numeric,
  p25_impact_pct numeric,
  p75_impact_pct numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH measured AS (
    SELECT t.user_id, t.actual_impact_pct
    FROM causal_outcome_tracking t
    JOIN causal_scenarios s ON s.id = t.scenario_id
    WHERE s.decision_category = p_category
      AND t.decision_made = true
      AND t.outcome_recorded_at IS NOT NULL
      AND t.actual_impact_pct IS NOT NULL
  )
  SELECT
    COUNT(DISTINCT user_id)::integer,
    ROUND((COUNT(*) FILTER (WHERE actual_impact_pct > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 2),
    ROUND(AVG(actual_impact_pct), 2),
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_impact_pct), 2),
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY actual_impact_pct), 2),
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY actual_impact_pct), 2)
  FROM measured
  HAVING COUNT(DISTINCT user_id) >= p_min_sample;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_causal_cohort_insights(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_causal_cohort_insights(text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.compute_causal_cohort_insights(text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_causal_cohort_insights(text, integer) TO service_role;
