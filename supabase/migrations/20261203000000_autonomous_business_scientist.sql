/*
  # Autonomous Business Scientist

  ## Why
  Every existing AI console in this codebase answers a single question well
  (Decision Engine: "what should I do?", Regret Console: "which choice hurts
  least if I'm wrong?", Next Best Action: "who do I call right now?"). None
  of them close the loop: propose -> test on a slice of the real business ->
  measure -> only then roll out everywhere. This table is that loop.

  Deliberately reuses `business_decisions` as the RESEARCH + PROBLEM
  DISCOVERY stage (it already mines calls/leads/jobs into grounded,
  numeric problems) instead of re-detecting anomalies from scratch — one
  fewer place for a false signal to originate. A study is created FROM a
  decision the owner hasn't acted on yet, and starts life at the
  HYPOTHESIS stage.

  All statistics (impact simulation, experiment significance, the
  rollout/iterate/abandon decision) are plain, inspectable arithmetic in
  src/lib/businessScientist.ts — never an opaque model output. AI is used
  ONLY to turn a grounded problem into a plain-English hypothesis + a
  proposed intervention (see supabase/functions/business-scientist-cycle
  and _shared/ai-core/businessScientist.ts); it never sees or influences
  the simulation, the experiment result, or the rollout decision.
*/

CREATE TABLE IF NOT EXISTS business_scientist_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  source_decision_id uuid REFERENCES business_decisions(id) ON DELETE SET NULL,

  category text NOT NULL DEFAULT 'operations'
    CHECK (category IN ('pricing', 'dispatch', 'staffing', 'marketing', 'collections', 'retention', 'operations')),
  problem_title text NOT NULL,
  problem_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_estimated_impact numeric,

  stage text NOT NULL DEFAULT 'hypothesis'
    CHECK (stage IN ('hypothesis', 'experimenting', 'measuring', 'decided', 'rolled_out', 'abandoned')),

  /* ---- Hypothesis (AI-drafted, owner-editable) ---- */
  hypothesis text,
  proposed_intervention text,
  predicted_metric text,
  predicted_direction text CHECK (predicted_direction IN ('increase', 'decrease')),
  predicted_magnitude_pct numeric,
  confidence_score int CHECK (confidence_score BETWEEN 0 AND 100),

  /* ---- Simulation: computeSimulation() in src/lib/businessScientist.ts ---- */
  simulation jsonb,

  /* ---- Experiment ---- */
  experiment_design jsonb,
  experiment_status text NOT NULL DEFAULT 'not_started'
    CHECK (experiment_status IN ('not_started', 'running', 'completed')),
  experiment_started_at timestamptz,
  experiment_ends_at timestamptz,

  /* ---- Measurement: owner enters the real control/treatment numbers,   */
  /*      evaluateExperiment() in src/lib/businessScientist.ts scores it. */
  measured_result jsonb,

  decision text CHECK (decision IN ('rollout', 'iterate', 'abandon')),
  decision_reasoning text,

  /* ---- Rollout ---- */
  rollout_action text,
  rolled_out_at timestamptz,
  abandoned_at timestamptz,

  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_scientist_evidence_is_object') THEN
    ALTER TABLE business_scientist_studies
      ADD CONSTRAINT business_scientist_evidence_is_object CHECK (jsonb_typeof(problem_evidence) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_scientist_simulation_is_object') THEN
    ALTER TABLE business_scientist_studies
      ADD CONSTRAINT business_scientist_simulation_is_object CHECK (simulation IS NULL OR jsonb_typeof(simulation) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_scientist_design_is_object') THEN
    ALTER TABLE business_scientist_studies
      ADD CONSTRAINT business_scientist_design_is_object CHECK (experiment_design IS NULL OR jsonb_typeof(experiment_design) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_scientist_measured_is_object') THEN
    ALTER TABLE business_scientist_studies
      ADD CONSTRAINT business_scientist_measured_is_object CHECK (measured_result IS NULL OR jsonb_typeof(measured_result) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_scientist_studies_user
  ON business_scientist_studies(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_scientist_studies_stage
  ON business_scientist_studies(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_business_scientist_studies_source_decision
  ON business_scientist_studies(source_decision_id);

CREATE OR REPLACE FUNCTION public.touch_business_scientist_studies_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_scientist_studies_touch ON business_scientist_studies;
CREATE TRIGGER trg_business_scientist_studies_touch
  BEFORE UPDATE ON business_scientist_studies
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_scientist_studies_updated_at();

ALTER TABLE business_scientist_studies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_scientist_studies" ON business_scientist_studies;
CREATE POLICY "select_own_business_scientist_studies" ON business_scientist_studies
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_scientist_studies" ON business_scientist_studies;
CREATE POLICY "insert_own_business_scientist_studies" ON business_scientist_studies
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_scientist_studies" ON business_scientist_studies;
CREATE POLICY "update_own_business_scientist_studies" ON business_scientist_studies
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_scientist_studies" ON business_scientist_studies;
CREATE POLICY "delete_own_business_scientist_studies" ON business_scientist_studies
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- ------------------------------------------------------------------
-- Per-account settings: how eager the research cycle is.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_scientist_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  min_confidence_threshold int NOT NULL DEFAULT 70 CHECK (min_confidence_threshold BETWEEN 0 AND 100),
  min_effect_pct numeric NOT NULL DEFAULT 3 CHECK (min_effect_pct >= 0),
  default_experiment_days int NOT NULL DEFAULT 14 CHECK (default_experiment_days > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_business_scientist_settings_touch ON business_scientist_settings;
CREATE TRIGGER trg_business_scientist_settings_touch
  BEFORE UPDATE ON business_scientist_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_scientist_studies_updated_at();

ALTER TABLE business_scientist_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_scientist_settings" ON business_scientist_settings;
CREATE POLICY "select_own_business_scientist_settings" ON business_scientist_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "upsert_own_business_scientist_settings" ON business_scientist_settings;
CREATE POLICY "upsert_own_business_scientist_settings" ON business_scientist_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_scientist_settings" ON business_scientist_settings;
CREATE POLICY "update_own_business_scientist_settings" ON business_scientist_settings
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
