/*
  # Operator Agent (Cmd+K) — multi-step requests in plain language

  ## What this adds
  1. Three governable action types in agent_action_catalog (approval required by default,
     so the owner opts IN to autonomy per action in Dashboard -> Agent Governance):
       operator_reschedule_jobs, operator_reassign_jobs (reversible), operator_message_customers.
  2. operator_runs / operator_run_steps / operator_run_effects — the run ledger:
     the validated plan, every step, and one row per affected record with its
     BEFORE and AFTER state. This is what the dry-run preview shows, what execution
     updates, and what undo reads.
  3. Three service-role-only helpers that let the edge function use the EXISTING
     approval queue (agent_action_log) without touching its rules:
       operator_force_pending, operator_decide_run, operator_mark_rolled_back.

  ## Security
  - RLS: whole-account SELECT via get_account_owner_id(); NO client write policies.
    Every write comes from the operator-agent edge function (service role).
  - The helpers are SECURITY DEFINER, scoped to agent_source = 'operator-agent',
    and EXECUTE is revoked from everyone except service_role.
  - Jobs are changed only through the existing move_job RPC, called with the
    CALLER'S JWT, so tenancy, capacity, compliance and double-booking rules apply.
*/

-- =============================================================
-- Catalog
-- =============================================================
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('operator_reschedule_jobs',   'operator-agent', 'Operator: reschedule jobs',       'other',     true,  false, true),
  ('operator_reassign_jobs',     'operator-agent', 'Operator: reassign jobs',         'other',     true,  false, true),
  ('operator_message_customers', 'operator-agent', 'Operator: text affected customers', 'messaging', false, false, true)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- operator_runs
-- =============================================================
CREATE TABLE IF NOT EXISTS operator_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,               -- account owner (tenant)
  requested_by uuid NOT NULL,          -- the person who typed the request
  instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 2 AND 500),
  summary text,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text,
  status text NOT NULL CHECK (status IN (
    'awaiting_approval', 'ready', 'running', 'completed', 'partial', 'failed',
    'refused', 'blocked', 'cancelled', 'expired', 'undoing', 'undone', 'undo_partial'
  )),
  message text,                        -- user-facing explanation (refusal / block / failure)
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  approved_by uuid,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  undone_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_operator_runs_user_created ON operator_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_runs_requester_created ON operator_runs(requested_by, created_at DESC);

-- =============================================================
-- operator_run_steps
-- =============================================================
CREATE TABLE IF NOT EXISTS operator_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES operator_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_key text NOT NULL,
  position integer NOT NULL,
  tool text NOT NULL CHECK (tool IN ('reschedule_jobs', 'reassign_jobs', 'message_customers')),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'running', 'succeeded', 'partial', 'failed', 'skipped', 'blocked', 'undone', 'undo_partial'
  )),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_log_id uuid,                  -- agent_action_log row (the approval-queue record)
  needs_approval boolean NOT NULL DEFAULT true,
  approval_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_count integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_operator_run_steps_run ON operator_run_steps(run_id, position);

-- =============================================================
-- operator_run_effects — one row per affected record (the undo ledger)
-- =============================================================
CREATE TABLE IF NOT EXISTS operator_run_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES operator_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES operator_run_steps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('job_reschedule', 'job_reassign', 'sms')),
  record_id uuid NOT NULL,             -- the job
  label text NOT NULL DEFAULT '',
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  after jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'running', 'applied', 'failed', 'skipped', 'undone', 'undo_failed', 'irreversible'
  )),
  reason text,
  external_ref text,
  applied_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_run_effects_run ON operator_run_effects(run_id, step_id);
CREATE INDEX IF NOT EXISTS idx_operator_run_effects_record ON operator_run_effects(user_id, record_id);

-- =============================================================
-- RLS — read-only for the account; writes only via the edge function
-- =============================================================
ALTER TABLE operator_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_run_effects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_operator_runs" ON operator_runs;
CREATE POLICY "select_own_operator_runs" ON operator_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_operator_run_steps" ON operator_run_steps;
CREATE POLICY "select_own_operator_run_steps" ON operator_run_steps FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_operator_run_effects" ON operator_run_effects;
CREATE POLICY "select_own_operator_run_effects" ON operator_run_effects FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Approval-queue helpers (service role only)
-- =============================================================

-- A guardrail (bulk size, far date, dry-run warning) overrides a permissive autonomy
-- setting: flip an auto_approved proposal back to pending_approval before anything runs.
CREATE OR REPLACE FUNCTION public.operator_force_pending(p_log_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE agent_action_log
  SET status = 'pending_approval', decision_reason = left(coalesce(p_reason, 'Guardrail: human approval required.'), 500)
  WHERE id = p_log_id AND agent_source = 'operator-agent' AND status = 'auto_approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- The person reviewing the preview in Cmd+K approves / rejects every still-pending
-- proposal of that run, recorded under THEIR id (a team member is not auth.uid() = owner,
-- which is why decide_agent_action cannot be used here).
CREATE OR REPLACE FUNCTION public.operator_decide_run(p_user_id uuid, p_run_id uuid, p_approve boolean, p_decided_by uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE agent_action_log
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      decided_by = p_decided_by,
      decided_at = now(),
      decision_reason = CASE WHEN p_approve THEN 'Approved in Operator.' ELSE 'Rejected in Operator.' END
  WHERE user_id = p_user_id
    AND agent_source = 'operator-agent'
    AND correlation_id = p_run_id::text
    AND status = 'pending_approval';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Undo is done by compare-and-swap move_job calls (never the generic, non-guarded
-- rollback_agent_action), then the audit rows are marked rolled back here.
CREATE OR REPLACE FUNCTION public.operator_mark_rolled_back(p_user_id uuid, p_log_ids uuid[], p_by uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE agent_action_log
  SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = p_by
  WHERE id = ANY(p_log_ids)
    AND user_id = p_user_id
    AND agent_source = 'operator-agent'
    AND status = 'executed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_force_pending(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operator_decide_run(uuid, uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operator_mark_rolled_back(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operator_force_pending(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.operator_decide_run(uuid, uuid, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.operator_mark_rolled_back(uuid, uuid[], uuid) TO service_role;
