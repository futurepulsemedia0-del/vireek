/*
  # AI Agent Governance

  ## Why
  Vireek already runs several autonomous, cron-driven agents (workflow
  SMS/call steps, the outbound dialer, the follow-up dispatcher, the
  estimate-recovery agent, the business decision engine, ...). None of
  them currently go through a shared checkpoint before they act. This
  migration adds that checkpoint: permission on/off per action type,
  spend limits, human-in-the-loop approval, an append-only audit trail,
  and a safe, allowlisted rollback path — one system every current and
  future autonomous agent can share.

  ## What this adds
  1. `agent_action_catalog` — reference table (not per-tenant) listing
     every governable autonomous action type in the codebase, seeded
     below. New agents register a new row here when they're wired in.
  2. `agent_permissions` — per-account on/off + approval-policy
     override + auto-approve ceiling, one row per (account, action).
  3. `agent_spending_limits` — per-account daily/weekly/monthly caps,
     either global (action_slug NULL) or scoped to one action type.
  4. `agent_action_log` — append-only audit trail AND the proposal
     queue: every time an agent wants to act, it inserts/finds a row
     here via evaluate_agent_action() below. Pending rows are what the
     dashboard's approval queue reads; decided/executed/rolled-back
     rows are the permanent record.
  5. `agent_rollback_allowed_tables` — explicit allowlist of tables a
     rollback is permitted to touch, so rollback_agent_action() can
     never be pointed at an arbitrary table even though it uses
     dynamic SQL internally.
  6. RPCs, all SECURITY DEFINER, mirroring the existing
     get_or_create_capacity_policy() / update_capacity_demand_policy()
     pattern:
     - evaluate_agent_action()      — the gate every agent calls first
     - record_agent_action_outcome() — the agent reports what happened
     - upsert_agent_permission()     — dashboard: change a policy
     - upsert_agent_spending_limit() / delete_agent_spending_limit()
     - decide_agent_action()         — dashboard: human approves/rejects
     - rollback_agent_action()       — dashboard: reverse an executed,
       reversible action

  RLS mirrors 20261103000000_enterprise_identity_security.sql and
  20261111000000_capacity_demand_control.sql exactly: whole-account
  SELECT via get_account_owner_id(), no direct client INSERT/UPDATE/
  DELETE policies anywhere — every write goes through a SECURITY
  DEFINER RPC above, and edge functions write via the service role,
  which bypasses RLS entirely.
*/

-- =============================================================
-- AGENT_ACTION_CATALOG — reference data, not per-tenant
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_action_catalog (
  slug text PRIMARY KEY,
  agent_source text NOT NULL,
  label text NOT NULL,
  category text NOT NULL CHECK (category IN ('messaging', 'calling', 'financial', 'marketing', 'other')),
  is_reversible boolean NOT NULL DEFAULT false,
  has_cost boolean NOT NULL DEFAULT false,
  default_requires_approval boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_action_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select_agent_action_catalog" ON agent_action_catalog;
CREATE POLICY "authenticated_select_agent_action_catalog" ON agent_action_catalog FOR SELECT TO authenticated
  USING (true);

INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('workflow_sms', 'workflow-engine-executor', 'Workflow SMS step', 'messaging', false, false, false),
  ('workflow_call', 'workflow-engine-executor', 'Workflow outbound call step', 'calling', false, false, false),
  ('outbound_dial', 'outbound-dialer', 'Outbound dialer call', 'calling', false, false, false),
  ('followup_dispatch', 'followup-agent-dispatcher', 'Follow-up agent SMS/call', 'messaging', false, false, false),
  ('financing_offer', 'financing-create-offer', 'Automated financing offer', 'financial', false, true, true),
  ('marketing_campaign_send', 'marketing-campaign-dispatcher', 'Marketing campaign dispatch', 'marketing', false, true, false),
  ('membership_lifecycle_action', 'membership-lifecycle-agent', 'Membership lifecycle automated action', 'other', false, false, false),
  ('business_decision_auto_action', 'business-decision-engine', 'Business Decision Engine automated action', 'other', false, true, true)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- AGENT_PERMISSIONS — per-account policy per action type
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_permissions (
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  -- NULL = fall back to agent_action_catalog.default_requires_approval
  requires_approval boolean,
  -- When set and the action carries a cost, amounts at/under this are
  -- auto-approved even if requires_approval is true — UNLESS a spending
  -- limit would be breached, which always wins.
  auto_approve_max_cents integer CHECK (auto_approve_max_cents IS NULL OR auto_approve_max_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (user_id, action_slug)
);

ALTER TABLE agent_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_permissions" ON agent_permissions;
CREATE POLICY "select_own_agent_permissions" ON agent_permissions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client INSERT/UPDATE policy — writes only via upsert_agent_permission().

-- =============================================================
-- AGENT_SPENDING_LIMITS
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_spending_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- NULL = applies across every cost-bearing action for this account
  action_slug text REFERENCES agent_action_catalog(slug) ON DELETE CASCADE,
  period text NOT NULL DEFAULT 'monthly' CHECK (period IN ('daily', 'weekly', 'monthly')),
  limit_cents integer NOT NULL CHECK (limit_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_spending_limits_global
  ON agent_spending_limits(user_id, period) WHERE action_slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_spending_limits_scoped
  ON agent_spending_limits(user_id, action_slug, period) WHERE action_slug IS NOT NULL;

ALTER TABLE agent_spending_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_spending_limits" ON agent_spending_limits;
CREATE POLICY "select_own_agent_spending_limits" ON agent_spending_limits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client INSERT/UPDATE/DELETE policy — writes only via
-- upsert_agent_spending_limit() / delete_agent_spending_limit().

-- =============================================================
-- AGENT_ACTION_LOG — append-only audit trail + approval queue
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug),
  agent_source text NOT NULL,
  target_table text,
  target_id text,
  amount_cents integer,
  reasoning text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_state jsonb,
  rollback_patch jsonb,
  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('auto_approved', 'pending_approval', 'approved', 'rejected', 'executed', 'failed', 'rolled_back')),
  correlation_id text,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  executed_at timestamptz,
  error text,
  rolled_back_at timestamptz,
  rolled_back_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_action_log_user_status
  ON agent_action_log(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_action_log_user_created
  ON agent_action_log(user_id, created_at DESC);

-- Idempotency: while a proposal for one exact target is pending,
-- approved-but-not-yet-executed, or already rejected, a re-scan by the
-- same agent must find it instead of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_action_log_open_target
  ON agent_action_log(user_id, action_slug, target_table, target_id)
  WHERE target_table IS NOT NULL AND target_id IS NOT NULL
    AND status IN ('pending_approval', 'approved', 'rejected');

ALTER TABLE agent_action_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_action_log" ON agent_action_log;
CREATE POLICY "select_own_agent_action_log" ON agent_action_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — inserts come from evaluate_agent_action()
-- (SECURITY DEFINER, called by edge functions with the service role,
-- which bypasses RLS anyway) and from decide_agent_action() /
-- record_agent_action_outcome() / rollback_agent_action() below.

-- =============================================================
-- AGENT_ROLLBACK_ALLOWED_TABLES — defense in depth for rollback_agent_action()
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_rollback_allowed_tables (
  table_name text PRIMARY KEY
);

ALTER TABLE agent_rollback_allowed_tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select_rollback_allowlist" ON agent_rollback_allowed_tables;
CREATE POLICY "authenticated_select_rollback_allowlist" ON agent_rollback_allowed_tables FOR SELECT TO authenticated
  USING (true);

-- Seed with the tenant tables already known to be safe (has a plain
-- `user_id` column, mutable, no cascading side effects on UPDATE). Add
-- a row here yourself when you wire a new reversible agent action.
INSERT INTO agent_rollback_allowed_tables (table_name) VALUES
  ('quotes'), ('jobs')
ON CONFLICT DO NOTHING;

-- =============================================================
-- RPC: evaluate_agent_action — the gate every agent calls first
-- =============================================================

CREATE OR REPLACE FUNCTION public.evaluate_agent_action(
  p_user_id uuid,
  p_action_slug text,
  p_agent_source text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL,
  p_reasoning text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_before_state jsonb DEFAULT NULL,
  p_rollback_patch jsonb DEFAULT NULL,
  p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_catalog agent_action_catalog;
  v_perm agent_permissions;
  v_existing agent_action_log;
  v_log agent_action_log;
  v_requires_approval boolean;
  v_status text;
  v_over_limit boolean := false;
  v_limit record;
  v_period_start timestamptz;
  v_spent_cents numeric;
BEGIN
  SELECT * INTO v_catalog FROM agent_action_catalog WHERE slug = p_action_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown agent action slug: %', p_action_slug;
  END IF;

  -- Idempotency: an open (pending/approved/rejected) proposal for this
  -- exact target already answers the question — don't re-decide it.
  IF p_target_table IS NOT NULL AND p_target_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM agent_action_log
      WHERE user_id = p_user_id AND action_slug = p_action_slug
        AND target_table = p_target_table AND target_id = p_target_id
        AND status IN ('pending_approval', 'approved', 'rejected')
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('decision', v_existing.status, 'log_id', v_existing.id, 'existing', true);
    END IF;
  END IF;

  SELECT * INTO v_perm FROM agent_permissions WHERE user_id = p_user_id AND action_slug = p_action_slug;

  IF FOUND AND v_perm.enabled = false THEN
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
      p_reasoning, p_payload, p_before_state, p_rollback_patch, 'rejected', p_correlation_id,
      'Blocked: this action type is disabled in Agent Governance.'
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', 'disabled');
  END IF;

  v_requires_approval := COALESCE(v_perm.requires_approval, v_catalog.default_requires_approval);

  IF p_amount_cents IS NOT NULL AND p_amount_cents > 0 THEN
    FOR v_limit IN
      SELECT * FROM agent_spending_limits
      WHERE user_id = p_user_id AND (action_slug = p_action_slug OR action_slug IS NULL)
    LOOP
      v_period_start := CASE v_limit.period
        WHEN 'daily' THEN date_trunc('day', now())
        WHEN 'weekly' THEN date_trunc('week', now())
        ELSE date_trunc('month', now())
      END;
      SELECT COALESCE(SUM(amount_cents), 0) INTO v_spent_cents
        FROM agent_action_log
        WHERE user_id = p_user_id
          AND status IN ('auto_approved', 'approved', 'executed')
          AND created_at >= v_period_start
          AND (v_limit.action_slug IS NULL OR action_slug = v_limit.action_slug);
      IF v_spent_cents + p_amount_cents > v_limit.limit_cents THEN
        v_over_limit := true;
      END IF;
    END LOOP;
  END IF;

  IF v_over_limit THEN
    v_requires_approval := true;
  ELSIF v_perm.auto_approve_max_cents IS NOT NULL AND p_amount_cents IS NOT NULL
        AND p_amount_cents <= v_perm.auto_approve_max_cents THEN
    v_requires_approval := false;
  END IF;

  v_status := CASE WHEN v_requires_approval THEN 'pending_approval' ELSE 'auto_approved' END;

  INSERT INTO agent_action_log (
    user_id, action_slug, agent_source, target_table, target_id, amount_cents,
    reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
  ) VALUES (
    p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
    p_reasoning, p_payload, p_before_state, p_rollback_patch, v_status, p_correlation_id,
    CASE WHEN v_over_limit THEN 'Escalated to human approval: spending limit reached.' ELSE NULL END
  ) RETURNING * INTO v_log;

  RETURN jsonb_build_object('decision', v_status, 'log_id', v_log.id, 'over_limit', v_over_limit);
END;
$$;

-- =============================================================
-- RPC: record_agent_action_outcome — agent reports what happened
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_agent_action_outcome(
  p_log_id uuid,
  p_status text,
  p_error text DEFAULT NULL,
  p_after_state jsonb DEFAULT NULL
)
RETURNS agent_action_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_action_log;
BEGIN
  IF p_status NOT IN ('executed', 'failed') THEN
    RAISE EXCEPTION 'Invalid outcome status: %', p_status;
  END IF;

  UPDATE agent_action_log
  SET status = p_status,
      executed_at = now(),
      error = p_error,
      payload = payload || jsonb_build_object('after_state', p_after_state)
  WHERE id = p_log_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent action log % not found.', p_log_id;
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: upsert_agent_permission — dashboard writes its own account only
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_agent_permission(
  p_action_slug text,
  p_enabled boolean DEFAULT NULL,
  p_requires_approval boolean DEFAULT NULL,
  p_clear_requires_approval boolean DEFAULT false,
  p_auto_approve_max_cents integer DEFAULT NULL,
  p_clear_auto_approve_max boolean DEFAULT false
)
RETURNS agent_permissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_permissions;
BEGIN
  INSERT INTO agent_permissions (user_id, action_slug, enabled, requires_approval, auto_approve_max_cents, updated_by)
  VALUES (
    auth.uid(), p_action_slug, COALESCE(p_enabled, true),
    CASE WHEN p_clear_requires_approval THEN NULL ELSE p_requires_approval END,
    CASE WHEN p_clear_auto_approve_max THEN NULL ELSE p_auto_approve_max_cents END,
    auth.uid()
  )
  ON CONFLICT (user_id, action_slug) DO UPDATE SET
    enabled = COALESCE(p_enabled, agent_permissions.enabled),
    requires_approval = CASE
      WHEN p_clear_requires_approval THEN NULL
      WHEN p_requires_approval IS NOT NULL THEN p_requires_approval
      ELSE agent_permissions.requires_approval
    END,
    auto_approve_max_cents = CASE
      WHEN p_clear_auto_approve_max THEN NULL
      WHEN p_auto_approve_max_cents IS NOT NULL THEN p_auto_approve_max_cents
      ELSE agent_permissions.auto_approve_max_cents
    END,
    updated_at = now(),
    updated_by = auth.uid()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: upsert_agent_spending_limit / delete_agent_spending_limit
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_agent_spending_limit(
  p_action_slug text DEFAULT NULL,
  p_period text DEFAULT 'monthly',
  p_limit_cents integer DEFAULT NULL
)
RETURNS agent_spending_limits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_spending_limits;
BEGIN
  IF p_limit_cents IS NULL OR p_limit_cents <= 0 THEN
    RAISE EXCEPTION 'limit_cents must be a positive amount.';
  END IF;
  IF p_period NOT IN ('daily', 'weekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid period: %', p_period;
  END IF;

  IF p_action_slug IS NULL THEN
    INSERT INTO agent_spending_limits (user_id, action_slug, period, limit_cents)
    VALUES (auth.uid(), NULL, p_period, p_limit_cents)
    ON CONFLICT (user_id, period) WHERE action_slug IS NULL
    DO UPDATE SET limit_cents = p_limit_cents, updated_at = now()
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO agent_spending_limits (user_id, action_slug, period, limit_cents)
    VALUES (auth.uid(), p_action_slug, p_period, p_limit_cents)
    ON CONFLICT (user_id, action_slug, period) WHERE action_slug IS NOT NULL
    DO UPDATE SET limit_cents = p_limit_cents, updated_at = now()
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_agent_spending_limit(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM agent_spending_limits WHERE id = p_id AND user_id = auth.uid();
$$;

-- =============================================================
-- RPC: decide_agent_action — human approves/rejects a pending proposal
-- =============================================================

CREATE OR REPLACE FUNCTION public.decide_agent_action(
  p_log_id uuid,
  p_approve boolean,
  p_reason text DEFAULT NULL
)
RETURNS agent_action_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_action_log;
BEGIN
  SELECT * INTO v_row FROM agent_action_log WHERE id = p_log_id AND user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found or not owned by this account.';
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only pending actions can be decided (current status: %).', v_row.status;
  END IF;

  UPDATE agent_action_log
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      decided_by = auth.uid(),
      decided_at = now(),
      decision_reason = p_reason
  WHERE id = p_log_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: rollback_agent_action — reverse an executed, reversible action
-- =============================================================

CREATE OR REPLACE FUNCTION public.rollback_agent_action(p_log_id uuid)
RETURNS agent_action_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_action_log;
  v_owner uuid := auth.uid();
  v_key text;
  v_val jsonb;
  v_set_parts text[] := '{}';
  v_sql text;
BEGIN
  SELECT * INTO v_row FROM agent_action_log WHERE id = p_log_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found or not owned by this account.';
  END IF;
  IF v_row.status <> 'executed' THEN
    RAISE EXCEPTION 'Only executed actions can be rolled back (current status: %).', v_row.status;
  END IF;
  IF v_row.rollback_patch IS NULL OR v_row.target_table IS NULL OR v_row.target_id IS NULL THEN
    RAISE EXCEPTION 'This action recorded no rollback data — it cannot be reversed automatically.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_rollback_allowed_tables WHERE table_name = v_row.target_table) THEN
    RAISE EXCEPTION 'Table % is not on the rollback allowlist.', v_row.target_table;
  END IF;

  FOR v_key, v_val IN SELECT * FROM jsonb_each(v_row.rollback_patch) LOOP
    v_set_parts := array_append(v_set_parts, format('%I = %L', v_key, v_val #>> '{}'));
  END LOOP;

  IF array_length(v_set_parts, 1) IS NULL THEN
    RAISE EXCEPTION 'Empty rollback patch.';
  END IF;

  -- Scoped to user_id = owner even though target_table is allowlisted —
  -- defense in depth against ever touching another tenant's row.
  v_sql := format(
    'UPDATE %I SET %s WHERE id = %L AND user_id = %L',
    v_row.target_table, array_to_string(v_set_parts, ', '), v_row.target_id, v_owner
  );
  EXECUTE v_sql;

  UPDATE agent_action_log
  SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = v_owner
  WHERE id = p_log_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
