/*
  # Call-to-Cash Workflow Engine

  This is a real event -> condition -> action automation engine, the thing
  the Automation Marketplace (automation_installs) has so far only
  *displayed* as installed without actually running. It is built
  deliberately ON TOP of two systems this project already has, instead of
  duplicating them:

    - business_activity_events (20260928000000) is the existing internal,
      append-only, in-transaction event ledger. Rather than add a parallel
      set of triggers on calls/leads/jobs/quotes, this migration adds
      THREE small supplemental triggers to fill gaps the ledger doesn't
      cover yet (call.missed, call.emergency, quote.declined) and then
      hangs ONE new trigger off business_activity_events itself. Every
      event this engine can react to — old or new — flows through the
      same ledger.
    - The SMS/call sending, DNC suppression, and A2P gating are done in
      the executor Edge Function by re-using the exact same shared
      modules followup-agent-dispatcher already uses
      (_shared/messaging/sendSms.ts, _shared/compliance/dncCheck.ts).
      Nothing about compliance is reimplemented.

  Model:
    workflow_definitions  — one automation ("Quote Follow-Up & Close").
    workflow_versions     — immutable, versioned step lists. Editing a
                             definition creates a new version; runs that
                             already started keep executing the version
                             they were enrolled under.
    workflow_runs         — one execution of a definition against one
                             real event (one call, one quote, one job...).
    workflow_run_steps    — one step of one run: pending -> running ->
                             succeeded/failed/skipped/awaiting_approval.
    workflow_approvals    — human-in-the-loop gate for a step.

  Enrollment is idempotent by construction: workflow_runs has a UNIQUE
  (workflow_id, trigger_activity_event_id), and business_activity_events
  is itself append-only and fires its trigger exactly once per row, so a
  given business event can never double-enroll a workflow.

  Deploy order:
    1. Run this migration.
    2. supabase functions deploy workflow-engine-executor --no-verify-jwt
    3. Point an external cron (same one hitting followup-agent-dispatcher
       today) at workflow-engine-executor every 1-2 minutes, using the
       same X-Cron-Secret header / CRON_SECRET value.
*/

-- =============================================================
-- SUPPLEMENTAL LEDGER EVENTS
-- (business_activity_events already has call.created, lead.created,
-- job.created, job.completed, quote.sent, quote.accepted,
-- payment.received, review.completed — see 20260928000000. These three
-- are additive: same append_activity_event() RPC, same log_activity_event()
-- trigger function, just new (table, condition) pairs it didn't cover.)
-- =============================================================

DROP TRIGGER IF EXISTS trigger_log_call_missed ON calls;
CREATE TRIGGER trigger_log_call_missed
  AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.status = 'missed')
  EXECUTE FUNCTION public.log_activity_event('call', 'call.missed');

DROP TRIGGER IF EXISTS trigger_log_call_emergency ON calls;
CREATE TRIGGER trigger_log_call_emergency
  AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.is_emergency = true)
  EXECUTE FUNCTION public.log_activity_event('call', 'call.emergency');

DROP TRIGGER IF EXISTS trigger_log_quote_declined ON quotes;
CREATE TRIGGER trigger_log_quote_declined
  AFTER UPDATE ON quotes
  FOR EACH ROW WHEN (NEW.status = 'declined' AND OLD.status IS DISTINCT FROM 'declined')
  EXECUTE FUNCTION public.log_activity_event('quote', 'quote.declined');

-- =============================================================
-- WORKFLOW_DEFINITIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  industry text,
  trigger_event text NOT NULL CHECK (trigger_event IN (
    'call.created', 'call.missed', 'call.emergency',
    'lead.created', 'job.created', 'job.completed',
    'quote.sent', 'quote.accepted', 'quote.declined',
    'payment.received', 'review.completed'
  )),
  -- jsonb containment match against the ledger row's event_data, e.g.
  -- {"is_emergency": true} or {} to match every event of that type.
  trigger_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  active_version integer,
  source_template_slug text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_definitions_unique_slug UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workflow_definitions_user ON workflow_definitions(user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_trigger
  ON workflow_definitions(trigger_event) WHERE status = 'active';

ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_definitions" ON workflow_definitions;
CREATE POLICY "select_own_workflow_definitions" ON workflow_definitions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_workflow_definitions" ON workflow_definitions;
CREATE POLICY "insert_own_workflow_definitions" ON workflow_definitions FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_workflow_definitions" ON workflow_definitions;
CREATE POLICY "update_own_workflow_definitions" ON workflow_definitions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_workflow_definitions" ON workflow_definitions;
CREATE POLICY "delete_own_workflow_definitions" ON workflow_definitions FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.set_workflow_definitions_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_definitions_updated_at ON workflow_definitions;
CREATE TRIGGER trg_workflow_definitions_updated_at
  BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_definitions_updated_at();

-- =============================================================
-- WORKFLOW_VERSIONS — immutable step snapshots
-- =============================================================

CREATE TABLE IF NOT EXISTS workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  -- Array of: { step_number, type: 'sms'|'call'|'wait'|'webhook'|
  -- 'human_approval'|'condition_gate', delay_minutes, config, on_failure }
  steps jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_versions_unique UNIQUE (workflow_id, version)
);

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_versions" ON workflow_versions;
CREATE POLICY "select_own_workflow_versions" ON workflow_versions FOR SELECT TO authenticated
  USING (workflow_id IN (SELECT id FROM workflow_definitions WHERE user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "insert_own_workflow_versions" ON workflow_versions;
CREATE POLICY "insert_own_workflow_versions" ON workflow_versions FOR INSERT TO authenticated
  WITH CHECK (workflow_id IN (SELECT id FROM workflow_definitions WHERE user_id = public.get_account_owner_id()));

-- =============================================================
-- WORKFLOW_RUNS
-- =============================================================

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trigger_activity_event_id bigint REFERENCES business_activity_events(id) ON DELETE SET NULL,
  entity_type text,
  entity_id uuid,
  customer_name text,
  customer_phone text,
  customer_email text,
  -- Best-effort copy of the triggering event's fields (minus id/user_id),
  -- used as template variables by later steps (e.g. {{service_type}}).
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  current_step_number integer NOT NULL DEFAULT 0,
  stop_reason text,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT workflow_runs_idempotent_enrollment UNIQUE (workflow_id, trigger_activity_event_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_user ON workflow_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_runs" ON workflow_runs;
CREATE POLICY "select_own_workflow_runs" ON workflow_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- WORKFLOW_RUN_STEPS
-- =============================================================

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  step_type text NOT NULL CHECK (step_type IN ('sms', 'call', 'wait', 'webhook', 'human_approval', 'condition_gate')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  on_failure text NOT NULL DEFAULT 'continue' CHECK (on_failure IN ('continue', 'stop')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  result jsonb,
  error text,
  CONSTRAINT workflow_run_steps_unique UNIQUE (run_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_due
  ON workflow_run_steps(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, step_number);

ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_run_steps" ON workflow_run_steps;
CREATE POLICY "select_own_workflow_run_steps" ON workflow_run_steps FOR SELECT TO authenticated
  USING (run_id IN (SELECT id FROM workflow_runs WHERE user_id = public.get_account_owner_id()));

-- =============================================================
-- WORKFLOW_APPROVALS
-- =============================================================

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  run_step_id uuid NOT NULL REFERENCES workflow_run_steps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  decision_note text,
  CONSTRAINT workflow_approvals_unique_step UNIQUE (run_step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_pending
  ON workflow_approvals(user_id) WHERE status = 'pending';

ALTER TABLE workflow_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_approvals" ON workflow_approvals;
CREATE POLICY "select_own_workflow_approvals" ON workflow_approvals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- ADVANCE: schedule the next step of a run from its version's step
-- list, or complete the run if there is no next step. Used by the
-- enrollment trigger (completed_step_number = 0), the executor (after
-- each step), and approve_workflow_step (after a human approves).
-- =============================================================

CREATE OR REPLACE FUNCTION public.workflow_advance_run(
  p_run_id uuid,
  p_completed_step_number integer,
  p_status text DEFAULT 'active'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run workflow_runs;
  v_steps jsonb;
  v_next jsonb;
BEGIN
  SELECT * INTO v_run FROM workflow_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN;
  END IF;

  SELECT steps INTO v_steps FROM workflow_versions
  WHERE workflow_id = v_run.workflow_id AND version = v_run.workflow_version;

  SELECT elem INTO v_next
  FROM jsonb_array_elements(COALESCE(v_steps, '[]'::jsonb)) elem
  WHERE (elem->>'step_number')::int = p_completed_step_number + 1;

  IF v_next IS NULL THEN
    UPDATE workflow_runs
    SET status = 'completed', current_step_number = p_completed_step_number, completed_at = now()
    WHERE id = p_run_id;
    RETURN;
  END IF;

  INSERT INTO workflow_run_steps (run_id, step_number, step_type, config, on_failure, scheduled_at)
  VALUES (
    p_run_id,
    (v_next->>'step_number')::int,
    v_next->>'type',
    COALESCE(v_next->'config', '{}'::jsonb),
    COALESCE(v_next->>'on_failure', 'continue'),
    now() + make_interval(mins => COALESCE((v_next->>'delay_minutes')::int, 0))
  )
  ON CONFLICT (run_id, step_number) DO NOTHING;

  UPDATE workflow_runs
  SET current_step_number = p_completed_step_number, status = p_status
  WHERE id = p_run_id;
END;
$$;

-- =============================================================
-- MATCH: fires once per new ledger row. Enrolls every active workflow
-- whose trigger_event matches and whose trigger_conditions are a jsonb
-- subset of the event's data.
-- =============================================================

CREATE OR REPLACE FUNCTION public.match_workflow_definitions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_def record;
  v_run_id uuid;
  v_context jsonb;
  v_name text;
  v_phone text;
  v_email text;
BEGIN
  v_context := (NEW.event_data - 'id') - 'user_id';
  v_name := COALESCE(NEW.event_data->>'customer_name', NEW.event_data->>'caller_name', NEW.event_data->>'name');
  v_phone := COALESCE(NEW.event_data->>'customer_phone', NEW.event_data->>'caller_phone', NEW.event_data->>'phone');
  v_email := COALESCE(NEW.event_data->>'customer_email', NEW.event_data->>'email');

  FOR v_def IN
    SELECT * FROM workflow_definitions
    WHERE user_id = NEW.user_id
      AND status = 'active'
      AND trigger_event = NEW.event_type
      AND active_version IS NOT NULL
      AND NEW.event_data @> trigger_conditions
  LOOP
    INSERT INTO workflow_runs (
      workflow_id, workflow_version, user_id, trigger_activity_event_id,
      entity_type, entity_id, customer_name, customer_phone, customer_email,
      context, mode
    ) VALUES (
      v_def.id, v_def.active_version, NEW.user_id, NEW.id,
      NEW.aggregate_type, NEW.aggregate_id, v_name, v_phone, v_email,
      v_context, v_def.mode
    )
    ON CONFLICT (workflow_id, trigger_activity_event_id) DO NOTHING
    RETURNING id INTO v_run_id;

    IF v_run_id IS NOT NULL THEN
      PERFORM public.workflow_advance_run(v_run_id, 0, 'active');
    END IF;
    v_run_id := NULL;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_match_workflow_definitions ON business_activity_events;
CREATE TRIGGER trigger_match_workflow_definitions
  AFTER INSERT ON business_activity_events
  FOR EACH ROW EXECUTE FUNCTION public.match_workflow_definitions();

-- =============================================================
-- INSTALL / MANAGE — called from the dashboard. The step catalog itself
-- ships as code (src/lib/workflowPlaybooks.ts), same philosophy as
-- AUTOMATION_TEMPLATES in src/lib/automationMarketplace.ts: no migration
-- needed to add a new playbook, only what a business turned on lives here.
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_workflow_playbook(
  p_slug text,
  p_name text,
  p_description text,
  p_industry text,
  p_trigger_event text,
  p_trigger_conditions jsonb,
  p_steps jsonb
)
RETURNS workflow_definitions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
  v_def workflow_definitions;
BEGIN
  SELECT * INTO v_def FROM workflow_definitions WHERE user_id = v_user_id AND slug = p_slug;

  IF NOT FOUND THEN
    INSERT INTO workflow_definitions (
      user_id, slug, name, description, industry, trigger_event,
      trigger_conditions, status, active_version, source_template_slug
    ) VALUES (
      v_user_id, p_slug, p_name, p_description, p_industry, p_trigger_event,
      COALESCE(p_trigger_conditions, '{}'::jsonb), 'active', 1, p_slug
    ) RETURNING * INTO v_def;

    INSERT INTO workflow_versions (workflow_id, version, steps) VALUES (v_def.id, 1, p_steps);
  ELSE
    -- Already installed: reactivate if it was paused/archived, don't
    -- silently overwrite any edits the business made to the steps.
    UPDATE workflow_definitions SET status = 'active' WHERE id = v_def.id RETURNING * INTO v_def;
  END IF;

  RETURN v_def;
END;
$$;

GRANT EXECUTE ON FUNCTION public.install_workflow_playbook(text, text, text, text, text, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_workflow_status(p_workflow_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;
  UPDATE workflow_definitions
  SET status = p_status
  WHERE id = p_workflow_id AND user_id = public.get_account_owner_id();
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_workflow_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_workflow_run(p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE workflow_runs
  SET status = 'cancelled', stop_reason = 'cancelled_by_user', completed_at = now()
  WHERE id = p_run_id AND user_id = public.get_account_owner_id() AND status NOT IN ('completed', 'cancelled', 'failed');
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_workflow_run(uuid) TO authenticated;

-- =============================================================
-- APPROVE / REJECT — human-in-the-loop gate
-- =============================================================

CREATE OR REPLACE FUNCTION public.approve_workflow_step(p_approval_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approval workflow_approvals;
  v_step workflow_run_steps;
BEGIN
  UPDATE workflow_approvals
  SET status = 'approved', decided_at = now(), decided_by = auth.uid(), decision_note = p_note
  WHERE id = p_approval_id AND user_id = public.get_account_owner_id() AND status = 'pending'
  RETURNING * INTO v_approval;

  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE workflow_run_steps
  SET status = 'succeeded', completed_at = now(),
      result = jsonb_build_object('approved_by', auth.uid(), 'note', p_note)
  WHERE id = v_approval.run_step_id
  RETURNING * INTO v_step;

  PERFORM public.workflow_advance_run(v_approval.run_id, v_step.step_number, 'active');
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_workflow_step(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_workflow_step(p_approval_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approval workflow_approvals;
BEGIN
  UPDATE workflow_approvals
  SET status = 'rejected', decided_at = now(), decided_by = auth.uid(), decision_note = p_note
  WHERE id = p_approval_id AND user_id = public.get_account_owner_id() AND status = 'pending'
  RETURNING * INTO v_approval;

  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE workflow_run_steps SET status = 'skipped', completed_at = now() WHERE id = v_approval.run_step_id;
  UPDATE workflow_runs
  SET status = 'cancelled', stop_reason = 'rejected_by_human', completed_at = now()
  WHERE id = v_approval.run_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_workflow_step(uuid, text) TO authenticated;
