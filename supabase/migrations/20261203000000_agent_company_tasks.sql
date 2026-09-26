/*
  # Multi-Agent Company — shared task handoff

  ## Why
  Vireek already runs a roster of specialized autonomous agents
  (workflow-engine-executor, outbound-dialer, followup-agent-dispatcher,
  financing-create-offer, marketing-campaign-dispatcher,
  membership-lifecycle-agent, business-decision-engine, ...) — see
  agent_action_catalog / agent_action_log from
  20261121000000_ai_agent_governance.sql. That system governs whether a
  single agent is ALLOWED to act. It has no way for one agent to hand a
  task to another, or share the context behind why — every agent still
  runs blind to what its siblings just decided.

  ## What this adds
  `agent_tasks` — a shared handoff board. Any agent (or the dashboard
  owner, manually) posts a task naming which agent it's for and why;
  the target agent's own cron loop claims it, does the work, and
  reports the outcome back — all visible in one place instead of
  buried across separate function logs.

  This is additive and inert until something posts to it: no existing
  agent's behavior changes just because this table exists. Wiring a
  specific handoff (e.g. business-decision-engine -> financing-create-
  offer) into an existing edge function is a separate, deliberate
  change per pair, not done here.

  RLS mirrors 20261121000000_ai_agent_governance.sql exactly: whole-
  account SELECT via get_account_owner_id(), no direct client INSERT/
  UPDATE/DELETE — every write goes through a SECURITY DEFINER RPC
  below, and edge functions write via the service role (which bypasses
  RLS regardless, but goes through the same RPCs for one shared code
  path instead of duplicating the state-machine logic).
*/

CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_by_agent text NOT NULL,
  target_agent_source text NOT NULL,
  task_type text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_table text,
  target_id text,
  reasoning text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'completed', 'failed', 'cancelled')),
  claimed_by_agent text,
  claimed_at timestamptz,
  result jsonb,
  error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status
  ON agent_tasks(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_target_status
  ON agent_tasks(user_id, target_agent_source, status);

-- Idempotency: while an open/claimed task for this exact target already
-- exists for this agent+task_type, a re-scan finds it instead of piling
-- up duplicate handoffs (same idiom as uq_agent_action_log_open_target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tasks_open_target
  ON agent_tasks(user_id, target_agent_source, task_type, target_table, target_id)
  WHERE target_table IS NOT NULL AND target_id IS NOT NULL
    AND status IN ('open', 'claimed');

ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_tasks" ON agent_tasks;
CREATE POLICY "select_own_agent_tasks" ON agent_tasks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client INSERT/UPDATE/DELETE policy — every write goes through the
-- RPCs below.

-- =============================================================
-- RPC: create_agent_task — either an agent (service role, explicit
-- p_user_id) or the dashboard owner (p_user_id defaults to auth.uid())
-- posts a task for another agent to pick up.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_agent_task(
  p_created_by_agent text,
  p_target_agent_source text,
  p_task_type text,
  p_priority text DEFAULT 'normal',
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_reasoning text DEFAULT NULL,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS agent_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing agent_tasks;
  v_row agent_tasks;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required (no authenticated session and none was supplied).';
  END IF;
  IF p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Invalid priority: %', p_priority;
  END IF;

  IF p_target_table IS NOT NULL AND p_target_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM agent_tasks
      WHERE user_id = p_user_id AND target_agent_source = p_target_agent_source
        AND task_type = p_task_type AND target_table = p_target_table AND target_id = p_target_id
        AND status IN ('open', 'claimed')
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  INSERT INTO agent_tasks (
    user_id, created_by_agent, target_agent_source, task_type, priority,
    payload, target_table, target_id, reasoning
  ) VALUES (
    p_user_id, p_created_by_agent, p_target_agent_source, p_task_type, p_priority,
    p_payload, p_target_table, p_target_id, p_reasoning
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: claim_agent_task — the target agent picks up an open task.
-- =============================================================

CREATE OR REPLACE FUNCTION public.claim_agent_task(
  p_task_id uuid,
  p_claimed_by_agent text
)
RETURNS agent_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_tasks;
BEGIN
  UPDATE agent_tasks
  SET status = 'claimed', claimed_by_agent = p_claimed_by_agent, claimed_at = now(), updated_at = now()
  WHERE id = p_task_id AND status = 'open'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % not found or not open (already claimed/finished elsewhere).', p_task_id;
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: complete_agent_task / fail_agent_task — the target agent
-- reports the outcome. Allowed from 'open' too (an agent that acts
-- immediately without a separate claim step) as well as 'claimed'.
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_agent_task(
  p_task_id uuid,
  p_result jsonb DEFAULT NULL
)
RETURNS agent_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_tasks;
BEGIN
  UPDATE agent_tasks
  SET status = 'completed', result = p_result, completed_at = now(), updated_at = now()
  WHERE id = p_task_id AND status IN ('open', 'claimed')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % not found or already finished.', p_task_id;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_agent_task(
  p_task_id uuid,
  p_error text
)
RETURNS agent_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_tasks;
BEGIN
  UPDATE agent_tasks
  SET status = 'failed', error = p_error, completed_at = now(), updated_at = now()
  WHERE id = p_task_id AND status IN ('open', 'claimed')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % not found or already finished.', p_task_id;
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: cancel_agent_task — dashboard-only, owner cancels a stuck or
-- no-longer-needed task. Unlike the RPCs above, this checks auth.uid()
-- ownership directly (same idiom as decide_agent_action()).
-- =============================================================

CREATE OR REPLACE FUNCTION public.cancel_agent_task(p_task_id uuid)
RETURNS agent_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_tasks;
BEGIN
  UPDATE agent_tasks
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_task_id AND user_id = auth.uid() AND status IN ('open', 'claimed')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found, not owned by this account, or already finished.';
  END IF;

  RETURN v_row;
END;
$$;
