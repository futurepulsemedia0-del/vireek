/*
  # Agent Disagreement Chamber

  Stores each convened decision: the signals used, every agent position, the
  conflicts between them, the trade-off numbers, the CEO recommendation, and
  what the owner actually decided (with a reason when they overrode the CEO).

  Cases are a record of reasoning. Once written, the analysis is not edited;
  only the owner's decision fields change.

  RLS: account-scoped via get_account_owner_id().
*/

CREATE TABLE IF NOT EXISTS agent_chamber_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  case_kind text NOT NULL DEFAULT 'campaign' CHECK (case_kind IN ('campaign')),
  title text NOT NULL,
  signals jsonb NOT NULL,
  positions jsonb NOT NULL,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  tradeoff jsonb NOT NULL,
  ceo jsonb NOT NULL,
  owner_decision text CHECK (owner_decision IN ('accepted', 'overridden')),
  owner_note text CHECK (owner_note IS NULL OR char_length(owner_note) <= 500),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_chamber_cases_user_created
  ON agent_chamber_cases(user_id, created_at DESC);

ALTER TABLE agent_chamber_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_agent_chamber_cases ON agent_chamber_cases;
CREATE POLICY select_own_agent_chamber_cases ON agent_chamber_cases
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_agent_chamber_cases ON agent_chamber_cases;
CREATE POLICY insert_own_agent_chamber_cases ON agent_chamber_cases
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS update_own_agent_chamber_cases ON agent_chamber_cases;
CREATE POLICY update_own_agent_chamber_cases ON agent_chamber_cases
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
