/*
  # Regret Minimization Console

  ## Why
  A standalone decision-support tool — deliberately NOT merged into
  business_decisions (the existing AI confidence-score recommender at
  /dashboard/decision-engine). That system answers "what's the best
  move?"; this one answers "which move hurts least if I'm wrong?" —
  a different, complementary lens on the same kinds of calls (pricing,
  discounts, overtime, job accept/decline).

  All math (minimax regret, worst-case/Wald floor, optional expected
  value) runs client-side in src/lib/regretConsole.ts — this table only
  persists the decision the owner built and its computed result, so it
  becomes a real decision journal over time (what was decided, what
  actually happened).
*/

CREATE TABLE IF NOT EXISTS regret_console_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  decision_type text NOT NULL DEFAULT 'custom'
    CHECK (decision_type IN ('pricing', 'discount', 'overtime', 'decline_job', 'custom')),
  title text NOT NULL,

  /* [{ id, name, reversibility: 'easy'|'moderate'|'hard' }] */
  options jsonb NOT NULL,
  /* [{ id, name, probability_pct: number|null }] */
  scenarios jsonb NOT NULL,
  /* { [optionId]: { [scenarioId]: number } } — the owner's own dollar-impact estimates */
  payoff_matrix jsonb NOT NULL,

  /* Computed by computeRegret() at save time, so the list view never has to recompute */
  recommended_option_id text,
  max_regret_by_option jsonb,
  worst_case_by_option jsonb,
  expected_value_by_option jsonb,

  notes text,

  /* Filled in once the owner actually acts */
  chosen_option_id text,
  decided_at timestamptz,

  /* Filled in later, once reality plays out — turns this into a journal */
  actual_scenario_id text,
  outcome_notes text,
  resolved_at timestamptz,

  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regret_console_options_is_array') THEN
    ALTER TABLE regret_console_decisions
      ADD CONSTRAINT regret_console_options_is_array CHECK (jsonb_typeof(options) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regret_console_scenarios_is_array') THEN
    ALTER TABLE regret_console_decisions
      ADD CONSTRAINT regret_console_scenarios_is_array CHECK (jsonb_typeof(scenarios) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regret_console_matrix_is_object') THEN
    ALTER TABLE regret_console_decisions
      ADD CONSTRAINT regret_console_matrix_is_object CHECK (jsonb_typeof(payoff_matrix) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_regret_console_decisions_user
  ON regret_console_decisions(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_regret_console_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_regret_console_touch ON regret_console_decisions;
CREATE TRIGGER trg_regret_console_touch
  BEFORE UPDATE ON regret_console_decisions
  FOR EACH ROW EXECUTE FUNCTION public.touch_regret_console_updated_at();

ALTER TABLE regret_console_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_regret_console_decisions" ON regret_console_decisions;
CREATE POLICY "select_own_regret_console_decisions" ON regret_console_decisions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_regret_console_decisions" ON regret_console_decisions;
CREATE POLICY "insert_own_regret_console_decisions" ON regret_console_decisions
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_regret_console_decisions" ON regret_console_decisions;
CREATE POLICY "update_own_regret_console_decisions" ON regret_console_decisions
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_regret_console_decisions" ON regret_console_decisions;
CREATE POLICY "delete_own_regret_console_decisions" ON regret_console_decisions
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
