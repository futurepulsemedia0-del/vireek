/*
  # Autonomous Business Decision Engine

  ## Why
  Real AI Insights (generate-insights) surfaces observations. This layer
  goes one step further: it turns grounded account metrics into concrete,
  categorized DECISIONS the owner can approve/reject, each with a
  confidence score and estimated dollar impact — and, for exactly one
  low-risk, already-existing lever (`profiles.surge_mode_active`), can
  act on its own using deterministic rules (never a raw LLM output).

  ## Tables
  - business_decision_settings: one row per account owner, controls
    whether autonomous execution is allowed at all, and for which lever.
  - business_decisions: the decision log/feed — advisory or auto-executed.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project.
*/

CREATE TABLE IF NOT EXISTS business_decision_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),

  autonomy_enabled boolean NOT NULL DEFAULT false,
  surge_mode_auto_control boolean NOT NULL DEFAULT false,
  min_confidence_threshold numeric(5,2) NOT NULL DEFAULT 70,

  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_decision_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_decision_settings" ON business_decision_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_decision_settings" ON business_decision_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_decision_settings" ON business_decision_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS business_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  category text NOT NULL CHECK (category IN (
    'pricing', 'dispatch', 'staffing', 'marketing', 'collections', 'retention', 'operations'
  )),
  title text NOT NULL,
  reasoning text NOT NULL,
  recommended_action text NOT NULL,
  confidence_score numeric(5,2) NOT NULL DEFAULT 50,
  estimated_impact numeric(12,2),

  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'auto_executed', 'expired'
  )),
  is_auto_executable boolean NOT NULL DEFAULT false,
  executed_at timestamptz,

  metric_snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_decisions_user_created
  ON business_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_decisions_user_status
  ON business_decisions(user_id, status);

ALTER TABLE business_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_business_decisions" ON business_decisions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_business_decisions" ON business_decisions
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_business_decisions" ON business_decisions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "delete_own_business_decisions" ON business_decisions
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
