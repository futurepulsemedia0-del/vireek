/*
  # Company Reflexes Builder

  Lets an owner describe a conditional response to a real event once
  ("if ETA delay > 20 min, notify; if VIP, call; if delay > 45 min, offer
  credit; if the technician is stuck on a prior job, redispatch") and turns
  it into a standing, always-on reflex:

    event -> context -> policy (ordered condition/action steps) ->
    action (queued for execution) -> measurement (every firing logged) ->
    learning (owner marks each firing good/bad over time)

  ## Design notes (read before wiring more triggers)
  - The rules engine itself (company_reflexes / reflex_steps /
    reflex_executions / reflex_action_queue / evaluate_reflexes) is fully
    self-contained: it only reads a JSONB "context" object handed to it by
    whatever trigger fires it. It has ZERO hard dependency on any other
    table, so it cannot break even if the rest of your schema has drifted
    from this migration.
  - Only ONE concrete trigger is wired in this file, on jobs.eta_minutes /
    jobs.job_status, using columns confirmed to already exist in this
    project (see 20261107000000_live_eta_tracking.sql for eta_minutes/
    eta_set_at, and customers.lifecycle_stage — including the 'vip' value
    — from 20260918000000_create_customers.sql). If your live project
    renamed any of those, adjust ONLY the trg_reflex_from_job_eta()
    function body below — the engine itself needs no changes.
  - Actions are queued, not silently auto-executed against money or
    dispatch, on purpose: `notify_customer_sms` / `alert_human_call` /
    `offer_credit` / `request_redispatch` / `custom_note` all land in
    reflex_action_queue as 'pending' for a human (or your own automation)
    to actually carry out and mark resolved. That queue — not a guess —
    is also exactly what the UI's "open actions" list reads from.
*/

-- =============================================================
-- REFLEXES (the policy)
-- =============================================================
CREATE TABLE IF NOT EXISTS company_reflexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  name text NOT NULL,
  description text,
  -- Extend this list as you wire up more triggers (job_completed,
  -- invoice_overdue, review_negative, etc). 'manual' is always available
  -- for reflexes you plan to trigger yourself from an edge function.
  trigger_event text NOT NULL DEFAULT 'eta_delay' CHECK (trigger_event IN ('eta_delay', 'manual')),
  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_reflexes_user_event
  ON company_reflexes(user_id, trigger_event) WHERE is_active;

ALTER TABLE company_reflexes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_reflexes" ON company_reflexes;
CREATE POLICY "manage_own_reflexes" ON company_reflexes FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- REFLEX STEPS (ordered condition -> action pairs within one reflex)
-- =============================================================
CREATE TABLE IF NOT EXISTS reflex_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reflex_id uuid NOT NULL REFERENCES company_reflexes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_order integer NOT NULL DEFAULT 0,

  -- Condition: read context->>condition_field, compare with condition_operator
  -- against condition_value. NULL condition_field means "always run" (useful
  -- for a default/fallback action with no gate).
  condition_field text,
  condition_operator text NOT NULL DEFAULT 'gt' CHECK (condition_operator IN (
    'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'is_true', 'is_false'
  )),
  condition_value text,

  action_type text NOT NULL CHECK (action_type IN (
    'notify_customer_sms', 'alert_human_call', 'offer_credit', 'request_redispatch', 'custom_note'
  )),
  action_params jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reflex_steps_reflex ON reflex_steps(reflex_id, step_order);

ALTER TABLE reflex_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_reflex_steps" ON reflex_steps;
CREATE POLICY "manage_own_reflex_steps" ON reflex_steps FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- REFLEX EXECUTIONS (measurement — one row per real-world firing)
-- System-written only (via evaluate_reflexes, SECURITY DEFINER). Feedback
-- columns are updated only through give_reflex_feedback() below, so a
-- client can never fabricate a firing or forge its own "it went well".
-- =============================================================
CREATE TABLE IF NOT EXISTS reflex_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reflex_id uuid NOT NULL REFERENCES company_reflexes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,

  trigger_event text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_type text,
  entity_id uuid,
  entity_label text,

  steps_fired jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_at timestamptz NOT NULL DEFAULT now(),

  -- Learning loop: the owner reviews a firing later and marks it.
  feedback text CHECK (feedback IS NULL OR feedback IN ('good', 'bad')),
  feedback_note text,
  feedback_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_reflex_executions_user ON reflex_executions(user_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_reflex_executions_reflex ON reflex_executions(reflex_id, triggered_at DESC);

ALTER TABLE reflex_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_reflex_executions" ON reflex_executions;
CREATE POLICY "select_own_reflex_executions" ON reflex_executions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — rows/feedback only via SECURITY DEFINER RPCs below.

-- =============================================================
-- REFLEX ACTION QUEUE (action — what a human or your own automation
-- still needs to actually do)
-- =============================================================
CREATE TABLE IF NOT EXISTS reflex_action_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES reflex_executions(id) ON DELETE CASCADE,
  reflex_id uuid NOT NULL REFERENCES company_reflexes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,

  action_type text NOT NULL,
  action_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_type text,
  entity_id uuid,
  entity_label text,

  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'acknowledged', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_reflex_queue_user_status ON reflex_action_queue(user_id, status, created_at DESC);

ALTER TABLE reflex_action_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_reflex_queue" ON reflex_action_queue;
CREATE POLICY "select_own_reflex_queue" ON reflex_action_queue FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — only evaluate_reflexes() writes rows.
-- UPDATE (resolving) goes through resolve_reflex_action() below.

-- =============================================================
-- create_reflex: save a whole reflex (name + ordered steps) in one call
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_reflex(
  p_name text,
  p_trigger_event text,
  p_description text,
  p_steps jsonb -- [{ "condition_field": "delay_minutes", "condition_operator": "gt", "condition_value": "20", "action_type": "notify_customer_sms", "action_params": {...} }, ...]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
  v_reflex_id uuid;
  v_step jsonb;
  v_order integer := 0;
BEGIN
  IF trim(coalesce(p_name, '')) = '' THEN
    RAISE EXCEPTION 'Reflex name is required';
  END IF;
  IF jsonb_array_length(coalesce(p_steps, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'At least one step is required';
  END IF;

  INSERT INTO company_reflexes (user_id, name, description, trigger_event)
  VALUES (v_user_id, p_name, p_description, coalesce(p_trigger_event, 'eta_delay'))
  RETURNING id INTO v_reflex_id;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps)
  LOOP
    INSERT INTO reflex_steps (
      reflex_id, user_id, step_order, condition_field, condition_operator, condition_value, action_type, action_params
    )
    VALUES (
      v_reflex_id, v_user_id, v_order,
      NULLIF(v_step->>'condition_field', ''),
      coalesce(v_step->>'condition_operator', 'gt'),
      v_step->>'condition_value',
      v_step->>'action_type',
      coalesce(v_step->'action_params', '{}'::jsonb)
    );
    v_order := v_order + 10;
  END LOOP;

  RETURN v_reflex_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_reflex(text, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_reflex_active(p_id uuid, p_is_active boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE company_reflexes SET is_active = p_is_active, updated_at = now()
  WHERE id = p_id AND user_id = public.get_account_owner_id();
$$;

GRANT EXECUTE ON FUNCTION public.set_reflex_active(uuid, boolean) TO authenticated;

-- =============================================================
-- Generic condition evaluator: numeric compare first, then boolean,
-- then falls back to text equality. A field missing from context (or a
-- value that won't cast) just evaluates to false rather than erroring,
-- so one odd payload can never take down the whole reflex run.
-- =============================================================
CREATE OR REPLACE FUNCTION public.evaluate_reflex_condition(p_context jsonb, p_field text, p_operator text, p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw text;
  v_num numeric;
  v_target numeric;
BEGIN
  IF p_field IS NULL THEN
    RETURN true; -- ungated step: always runs
  END IF;

  v_raw := p_context ->> p_field;
  IF v_raw IS NULL THEN
    RETURN false;
  END IF;

  IF p_operator = 'is_true' THEN
    RETURN lower(v_raw) IN ('true', 't', '1');
  ELSIF p_operator = 'is_false' THEN
    RETURN lower(v_raw) IN ('false', 'f', '0');
  END IF;

  BEGIN
    v_num := v_raw::numeric;
    v_target := p_value::numeric;
    RETURN CASE p_operator
      WHEN 'gt' THEN v_num > v_target
      WHEN 'gte' THEN v_num >= v_target
      WHEN 'lt' THEN v_num < v_target
      WHEN 'lte' THEN v_num <= v_target
      WHEN 'eq' THEN v_num = v_target
      WHEN 'neq' THEN v_num <> v_target
      ELSE false
    END;
  EXCEPTION WHEN OTHERS THEN
    RETURN CASE p_operator
      WHEN 'eq' THEN v_raw = p_value
      WHEN 'neq' THEN v_raw <> p_value
      ELSE false
    END;
  END;
END;
$$;

-- =============================================================
-- evaluate_reflexes: the heart of the engine. Called by a trigger (or an
-- edge function) with a context payload; walks every active reflex for
-- this trigger_event, runs its steps in order, queues matching actions,
-- and writes ONE execution row summarizing what fired.
-- =============================================================
CREATE OR REPLACE FUNCTION public.evaluate_reflexes(
  p_user_id uuid,
  p_trigger_event text,
  p_context jsonb,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_entity_label text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reflex record;
  v_step record;
  v_matched boolean;
  v_steps_fired jsonb;
  v_execution_id uuid;
  v_fired_count integer := 0;
BEGIN
  FOR v_reflex IN
    SELECT * FROM company_reflexes
    WHERE user_id = p_user_id AND trigger_event = p_trigger_event AND is_active
  LOOP
    v_steps_fired := '[]'::jsonb;

    FOR v_step IN
      SELECT * FROM reflex_steps WHERE reflex_id = v_reflex.id ORDER BY step_order ASC
    LOOP
      v_matched := public.evaluate_reflex_condition(p_context, v_step.condition_field, v_step.condition_operator, v_step.condition_value);
      IF v_matched THEN
        v_steps_fired := v_steps_fired || jsonb_build_object(
          'step_id', v_step.id,
          'action_type', v_step.action_type,
          'condition_field', v_step.condition_field,
          'condition_operator', v_step.condition_operator,
          'condition_value', v_step.condition_value
        );
      END IF;
    END LOOP;

    IF jsonb_array_length(v_steps_fired) = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO reflex_executions (reflex_id, user_id, trigger_event, context, entity_type, entity_id, entity_label, steps_fired)
    VALUES (v_reflex.id, p_user_id, p_trigger_event, p_context, p_entity_type, p_entity_id, p_entity_label, v_steps_fired)
    RETURNING id INTO v_execution_id;

    INSERT INTO reflex_action_queue (execution_id, reflex_id, user_id, action_type, action_params, entity_type, entity_id, entity_label)
    SELECT
      v_execution_id, v_reflex.id, p_user_id,
      f->>'action_type',
      coalesce((SELECT rs.action_params FROM reflex_steps rs WHERE rs.id = (f->>'step_id')::uuid), '{}'::jsonb),
      p_entity_type, p_entity_id, p_entity_label
    FROM jsonb_array_elements(v_steps_fired) f;

    v_fired_count := v_fired_count + 1;
  END LOOP;

  RETURN v_fired_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_reflexes(uuid, text, jsonb, text, uuid, text) TO authenticated, service_role;

-- =============================================================
-- Resolve a queued action (staff marks it sent/acknowledged/dismissed)
-- =============================================================
CREATE OR REPLACE FUNCTION public.resolve_reflex_action(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'acknowledged', 'dismissed') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  UPDATE reflex_action_queue
    SET status = p_status, resolved_at = now()
    WHERE id = p_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found or not authorized';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_reflex_action(uuid, text) TO authenticated;

-- =============================================================
-- Learning loop: owner reviews a past firing and rates it
-- =============================================================
CREATE OR REPLACE FUNCTION public.give_reflex_feedback(p_execution_id uuid, p_feedback text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_feedback NOT IN ('good', 'bad') THEN
    RAISE EXCEPTION 'Invalid feedback value';
  END IF;
  UPDATE reflex_executions
    SET feedback = p_feedback, feedback_note = p_note, feedback_at = now()
    WHERE id = p_execution_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution not found or not authorized';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.give_reflex_feedback(uuid, text, text) TO authenticated;

-- =============================================================
-- Per-reflex effectiveness summary (the "learning" dashboard reads this)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_reflex_stats(p_user_id uuid)
RETURNS TABLE (
  reflex_id uuid,
  name text,
  is_active boolean,
  fire_count bigint,
  good_count bigint,
  bad_count bigint,
  pending_actions bigint,
  last_fired_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.name, r.is_active,
    count(e.id),
    count(e.id) FILTER (WHERE e.feedback = 'good'),
    count(e.id) FILTER (WHERE e.feedback = 'bad'),
    (SELECT count(*) FROM reflex_action_queue q WHERE q.reflex_id = r.id AND q.status = 'pending'),
    max(e.triggered_at)
  FROM company_reflexes r
  LEFT JOIN reflex_executions e ON e.reflex_id = r.id
  WHERE r.user_id = p_user_id
  GROUP BY r.id, r.name, r.is_active
  ORDER BY max(e.triggered_at) DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_reflex_stats(uuid) TO authenticated;

-- =============================================================
-- WIRING: the one concrete trigger shipped in this migration.
-- Fires the 'eta_delay' event whenever a job that is running late gets
-- an eta/status update, with a context object every 'eta_delay' reflex
-- can key off: delay_minutes, is_vip, technician_stuck.
--
-- If jobs.eta_minutes / eta_set_at / job_status / customer_id or
-- customers.lifecycle_stage don't match your live schema, this is the
-- ONLY function you need to edit — the engine above needs no changes.
-- =============================================================
CREATE OR REPLACE FUNCTION public.trg_reflex_from_job_eta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay_minutes integer;
  v_is_vip boolean := false;
  v_technician_stuck boolean := false;
BEGIN
  IF NEW.job_status NOT IN ('en_route', 'in_progress') OR NEW.eta_minutes IS NULL THEN
    RETURN NEW;
  END IF;

  v_delay_minutes := GREATEST(
    0,
    (EXTRACT(EPOCH FROM (now() - (COALESCE(NEW.eta_set_at, NEW.scheduled_datetime) + (NEW.eta_minutes || ' minutes')::interval))) / 60)::integer
  );

  IF v_delay_minutes < 5 THEN
    RETURN NEW;
  END IF;

  IF NEW.customer_id IS NOT NULL THEN
    SELECT (lifecycle_stage = 'vip') INTO v_is_vip FROM customers WHERE id = NEW.customer_id;
  END IF;

  IF NEW.assigned_technician_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM jobs j2
      WHERE j2.assigned_technician_id = NEW.assigned_technician_id
        AND j2.id <> NEW.id AND j2.job_status = 'in_progress'
    ) INTO v_technician_stuck;
  END IF;

  PERFORM public.evaluate_reflexes(
    NEW.user_id,
    'eta_delay',
    jsonb_build_object(
      'delay_minutes', v_delay_minutes,
      'is_vip', COALESCE(v_is_vip, false),
      'technician_stuck', v_technician_stuck
    ),
    'job', NEW.id, NEW.customer_name
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_reflex_eta ON jobs;
CREATE TRIGGER trg_jobs_reflex_eta AFTER UPDATE OF eta_minutes, job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.trg_reflex_from_job_eta();
