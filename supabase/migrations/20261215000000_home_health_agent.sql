/*
  # Home Health Score + Autonomous Home Maintenance Agent

  Builds on `equipment`, `equipment_maintenance_alerts`, `quotes`, `jobs`,
  `assign_technician_to_job()` and the Agent Governance gate.

  Pipeline (one row per equipment prediction in home_health_actions):
    detected -> explained -> [quote sent] awaiting_customer -> scheduled
    -> dispatched -> repaired -> verified
  Terminal: declined | dismissed | expired

  Tables
    home_health_scores         latest score per customer (home)
    home_health_score_history  append-only trend
    home_health_actions        the pipeline state machine
  Writes happen only from the home-health-agent edge function (service role)
  or the dismiss RPC below. Clients get read-only RLS.
*/

CREATE TABLE IF NOT EXISTS home_health_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  grade text NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  confidence numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  equipment_count integer NOT NULL DEFAULT 0,
  at_risk_count integer NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '[]',
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id)
);

CREATE INDEX IF NOT EXISTS idx_home_health_scores_user ON home_health_scores(user_id, score);

CREATE TABLE IF NOT EXISTS home_health_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_health_history_customer ON home_health_score_history(customer_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS home_health_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('maintenance', 'replacement_planning')),
  stage text NOT NULL DEFAULT 'detected' CHECK (stage IN (
    'detected', 'explained', 'awaiting_customer', 'scheduled', 'dispatched',
    'repaired', 'verified', 'declined', 'dismissed', 'expired'
  )),
  urgency text NOT NULL CHECK (urgency IN ('medium', 'high')),
  health_score integer NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  window_min_months integer,
  window_max_months integer,
  confidence numeric(3, 2) NOT NULL DEFAULT 0.5,
  drivers jsonb NOT NULL DEFAULT '[]',
  explanation text,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  blocked_reason text,
  stage_history jsonb NOT NULL DEFAULT '[]',
  detected_at timestamptz NOT NULL DEFAULT now(),
  quoted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- One open action per unit + type; finished ones don't block new predictions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_home_health_open_action
  ON home_health_actions(equipment_id, action_type)
  WHERE stage NOT IN ('verified', 'declined', 'dismissed', 'expired');

CREATE INDEX IF NOT EXISTS idx_home_health_actions_user_stage ON home_health_actions(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_home_health_actions_customer ON home_health_actions(customer_id);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS home_health_action_id uuid REFERENCES home_health_actions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_home_health_action ON jobs(home_health_action_id) WHERE home_health_action_id IS NOT NULL;

ALTER TABLE home_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_health_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_health_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_health_scores" ON home_health_scores;
CREATE POLICY "select_own_home_health_scores" ON home_health_scores FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_home_health_history" ON home_health_score_history;
CREATE POLICY "select_own_home_health_history" ON home_health_score_history FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_home_health_actions" ON home_health_actions;
CREATE POLICY "select_own_home_health_actions" ON home_health_actions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- The only client write path: dismiss a prediction that hasn't reached the field yet.
CREATE OR REPLACE FUNCTION public.dismiss_home_health_action(p_action_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE home_health_actions
  SET stage = 'dismissed',
      blocked_reason = NULL,
      completed_at = now(),
      updated_at = now(),
      stage_history = stage_history || jsonb_build_array(jsonb_build_object('stage', 'dismissed', 'at', now(), 'by', 'owner'))
  WHERE id = p_action_id
    AND user_id = public.get_account_owner_id()
    AND stage IN ('detected', 'explained', 'awaiting_customer');
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dismiss_home_health_action(uuid) TO authenticated;

-- Register the agent's two governable actions. Customer-facing outreach
-- defaults to owner approval; flip it in Agent Governance once you trust it.
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('home_health_outreach', 'home-health-agent', 'Home Health proactive quote & customer outreach', 'messaging', false, false, true),
  ('home_health_dispatch', 'home-health-agent', 'Home Health auto-scheduling & technician dispatch', 'other', false, false, false)
ON CONFLICT (slug) DO NOTHING;
