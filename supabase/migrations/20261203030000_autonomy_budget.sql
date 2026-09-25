/*
  # Autonomy Budget

  ## Why
  20261121000000_ai_agent_governance.sql governs *what kind of action* is
  allowed (per action_slug, account-wide: on/off, approval policy, spend
  caps). This migration governs *how much independent authority a given
  agent gets in one run*: a spend ceiling, an action-count ceiling, a wall-
  clock session limit, an explicit allowlist of tools (action_slugs) it may
  use, and a declared risk level — a bundle the dashboard calls an
  "Autonomy Budget". It reuses agent_action_catalog.agent_source as the
  agent identity and agent_action_catalog.slug as the tool vocabulary, so
  there is exactly one place new agents/tools get registered.

  ## Loop
  set a budget (agent_autonomy_budgets) -> an agent starts a run
  (start_autonomy_session) -> before each action it calls
  check_autonomy_action(), which enforces the tool allowlist, the
  session's wall-clock limit, and both the per-session and rolling-period
  action-count/spend ceilings, atomically incrementing usage on allow ->
  the agent (or a cron sweep) calls end_autonomy_session() when done.

  A session that would breach its budget is not just refused for that one
  action — it's marked terminated_budget_exceeded, so the agent (and the
  dashboard) can see the run itself was cut off, not just one call.
*/

CREATE TABLE IF NOT EXISTS agent_autonomy_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  agent_source text NOT NULL,
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  spend_limit_cents integer CHECK (spend_limit_cents IS NULL OR spend_limit_cents >= 0),
  spend_period text NOT NULL DEFAULT 'daily' CHECK (spend_period IN ('daily', 'weekly', 'monthly')),
  max_actions integer CHECK (max_actions IS NULL OR max_actions > 0),
  actions_period text NOT NULL DEFAULT 'daily' CHECK (actions_period IN ('daily', 'weekly', 'monthly')),
  max_session_minutes integer CHECK (max_session_minutes IS NULL OR max_session_minutes > 0),
  allowed_tools jsonb NOT NULL DEFAULT '[]',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (user_id, agent_source)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_autonomy_budgets_allowed_tools_is_array') THEN
    ALTER TABLE agent_autonomy_budgets
      ADD CONSTRAINT agent_autonomy_budgets_allowed_tools_is_array CHECK (jsonb_typeof(allowed_tools) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_aab_user ON agent_autonomy_budgets(user_id);
ALTER TABLE agent_autonomy_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_autonomy_budgets" ON agent_autonomy_budgets;
CREATE POLICY "select_own_autonomy_budgets" ON agent_autonomy_budgets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE — only upsert_autonomy_budget() below.

CREATE TABLE IF NOT EXISTS agent_autonomy_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  budget_id uuid NOT NULL REFERENCES agent_autonomy_budgets(id) ON DELETE CASCADE,
  agent_source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  actions_taken integer NOT NULL DEFAULT 0,
  spend_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'terminated_budget_exceeded')),
  termination_reason text
);

CREATE INDEX IF NOT EXISTS idx_aas_user ON agent_autonomy_sessions(user_id, agent_source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_aas_budget ON agent_autonomy_sessions(budget_id);
ALTER TABLE agent_autonomy_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_autonomy_sessions" ON agent_autonomy_sessions;
CREATE POLICY "select_own_autonomy_sessions" ON agent_autonomy_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE — only the RPCs below (agents write via service_role).

-- =============================================================
-- Dashboard: create or update an agent's autonomy budget
-- =============================================================
CREATE OR REPLACE FUNCTION public.upsert_autonomy_budget(
  p_agent_source text, p_risk_level text, p_spend_limit_cents integer, p_spend_period text,
  p_max_actions integer, p_actions_period text, p_max_session_minutes integer,
  p_allowed_tools jsonb, p_enabled boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  INSERT INTO agent_autonomy_budgets (
    user_id, agent_source, risk_level, spend_limit_cents, spend_period,
    max_actions, actions_period, max_session_minutes, allowed_tools, enabled, updated_by
  ) VALUES (
    v_owner, p_agent_source, p_risk_level, p_spend_limit_cents, p_spend_period,
    p_max_actions, p_actions_period, p_max_session_minutes, COALESCE(p_allowed_tools, '[]'::jsonb), p_enabled, auth.uid()
  )
  ON CONFLICT (user_id, agent_source) DO UPDATE SET
    risk_level = EXCLUDED.risk_level,
    spend_limit_cents = EXCLUDED.spend_limit_cents,
    spend_period = EXCLUDED.spend_period,
    max_actions = EXCLUDED.max_actions,
    actions_period = EXCLUDED.actions_period,
    max_session_minutes = EXCLUDED.max_session_minutes,
    allowed_tools = EXCLUDED.allowed_tools,
    enabled = EXCLUDED.enabled,
    updated_at = now(),
    updated_by = auth.uid()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_autonomy_budget(text, text, integer, text, integer, text, integer, jsonb, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_autonomy_budget(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM agent_autonomy_budgets WHERE id = p_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_autonomy_budget(uuid) TO authenticated;

-- =============================================================
-- Agent: start a run under its budget
-- =============================================================
CREATE OR REPLACE FUNCTION public.start_autonomy_session(p_user_id uuid, p_agent_source text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_budget record; v_session_id uuid;
BEGIN
  SELECT * INTO v_budget FROM agent_autonomy_budgets WHERE user_id = p_user_id AND agent_source = p_agent_source;
  IF NOT FOUND OR v_budget.enabled = false THEN
    RAISE EXCEPTION 'No active autonomy budget for agent "%"', p_agent_source;
  END IF;

  INSERT INTO agent_autonomy_sessions (user_id, budget_id, agent_source)
  VALUES (p_user_id, v_budget.id, p_agent_source)
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_autonomy_session(uuid, text) TO authenticated, service_role;

-- =============================================================
-- THE GATE: call before every action inside a session.
-- Checks tool allowlist, session wall-clock limit, and rolling-period
-- action/spend ceilings (this session + prior sessions in the window).
-- On allow, atomically increments the session's own counters.
-- =============================================================
CREATE OR REPLACE FUNCTION public.check_autonomy_action(p_session_id uuid, p_action_slug text, p_amount_cents integer DEFAULT 0)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session record; v_budget record;
  v_period_actions integer; v_period_spend integer;
  v_window interval;
BEGIN
  SELECT * INTO v_session FROM agent_autonomy_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    allowed := false; reason := 'Session not found'; RETURN NEXT; RETURN;
  END IF;

  IF v_session.status <> 'running' THEN
    allowed := false; reason := format('Session is %s, not running', v_session.status); RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO v_budget FROM agent_autonomy_budgets WHERE id = v_session.budget_id;

  -- Wall-clock session limit
  IF v_budget.max_session_minutes IS NOT NULL
     AND now() > v_session.started_at + (v_budget.max_session_minutes || ' minutes')::interval THEN
    UPDATE agent_autonomy_sessions SET status = 'terminated_budget_exceeded', termination_reason = 'Session duration limit reached', ended_at = now() WHERE id = p_session_id;
    allowed := false; reason := format('Session exceeded its %s-minute limit', v_budget.max_session_minutes); RETURN NEXT; RETURN;
  END IF;

  -- Tool allowlist (empty allowlist = no restriction)
  IF jsonb_array_length(v_budget.allowed_tools) > 0 AND NOT (v_budget.allowed_tools ? p_action_slug) THEN
    allowed := false; reason := format('Tool "%s" is not in this agent''s allowed_tools', p_action_slug); RETURN NEXT; RETURN;
  END IF;

  -- Rolling-period action count and spend, across all sessions for this agent
  v_window := CASE v_budget.actions_period WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '30 days' END;
  SELECT COALESCE(sum(actions_taken), 0) INTO v_period_actions FROM agent_autonomy_sessions
    WHERE budget_id = v_budget.id AND started_at > now() - v_window;
  IF v_budget.max_actions IS NOT NULL AND v_period_actions + 1 > v_budget.max_actions THEN
    UPDATE agent_autonomy_sessions SET status = 'terminated_budget_exceeded', termination_reason = 'Action count limit reached', ended_at = now() WHERE id = p_session_id;
    allowed := false; reason := format('Action count limit (%s per %s) reached', v_budget.max_actions, v_budget.actions_period); RETURN NEXT; RETURN;
  END IF;

  v_window := CASE v_budget.spend_period WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '30 days' END;
  SELECT COALESCE(sum(spend_cents), 0) INTO v_period_spend FROM agent_autonomy_sessions
    WHERE budget_id = v_budget.id AND started_at > now() - v_window;
  IF v_budget.spend_limit_cents IS NOT NULL AND v_period_spend + COALESCE(p_amount_cents, 0) > v_budget.spend_limit_cents THEN
    UPDATE agent_autonomy_sessions SET status = 'terminated_budget_exceeded', termination_reason = 'Spend limit reached', ended_at = now() WHERE id = p_session_id;
    allowed := false; reason := format('Spend limit (%s cents per %s) reached', v_budget.spend_limit_cents, v_budget.spend_period); RETURN NEXT; RETURN;
  END IF;

  UPDATE agent_autonomy_sessions
    SET actions_taken = actions_taken + 1, spend_cents = spend_cents + COALESCE(p_amount_cents, 0)
    WHERE id = p_session_id;

  allowed := true; reason := NULL; RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_autonomy_action(uuid, text, integer) TO authenticated, service_role;

-- =============================================================
-- Agent: close out a run
-- =============================================================
CREATE OR REPLACE FUNCTION public.end_autonomy_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE agent_autonomy_sessions SET status = 'completed', ended_at = now()
  WHERE id = p_session_id AND status = 'running';
END;
$$;

GRANT EXECUTE ON FUNCTION public.end_autonomy_session(uuid) TO authenticated, service_role;
