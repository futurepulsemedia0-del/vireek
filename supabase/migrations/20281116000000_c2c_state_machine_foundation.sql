/*
  # Call-to-cash orchestration — slice 1: foundation

  Adds (all additive, nothing renamed/dropped/backfilled):
    1. feature flag `c2c_orchestration`      (default OFF, per-tenant via existing feature_flags system)
    2. job_transition_rules                  (editable legal-transition matrix; jobs.job_status stays plain text)
    3. job_transition_log                    (append-only: actor agent|human|system, reason, trace id)
    4. guard + log triggers on jobs          (ONLY act when the flag is ON for the job's tenant)
    5. job_automation_locks + takeover RPCs  (operator takeover; automation writes are rejected while locked)
    6. jobs.voice_idempotency_key + unique index (one job per call id + tool call id, atomic)
    7. c2c_workflow_health()                 (stuck work with age, owner queue, suggested action)
    8. c2c_set_job_status / c2c_override_job_status RPCs (the tagged write paths)

  Behaviour when the flag is OFF: triggers return immediately; no rows are written, no transition rejected.

  Known limits (by design, see report):
    - Agents that UPDATE jobs.job_status directly (not via c2c_set_job_status) are logged as actor 'system'.
      The operator lock blocks both 'agent' and 'system' actors, so it still holds; authenticated humans are not blocked.
    - Matrix is permissive on purpose (matches statuses actually used in the repo). Tighten by deleting rows.

  Rollback (safe to leave in place):
    UPDATE feature_flags SET enabled = false WHERE key = 'c2c_orchestration';   -- instant, all tenants
    -- or: DROP TRIGGER trg_c2c_guard_job_transition ON jobs;
*/

-- =============================================================
-- 1. Feature flag
-- =============================================================
INSERT INTO feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('c2c_orchestration', 'Call-to-cash orchestration',
        'Enforces the job lifecycle state machine, writes the transition log, honours operator takeover locks.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.c2c_orchestration_enabled(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_tenant, f.key)
    FROM feature_flags f
    LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
    WHERE f.key = 'c2c_orchestration'
  ), false);
$$;

REVOKE ALL ON FUNCTION public.c2c_orchestration_enabled(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.c2c_orchestration_enabled(uuid) TO authenticated, service_role;

-- =============================================================
-- 2. Legal transition matrix (reference data, read-only to clients)
-- =============================================================
CREATE TABLE IF NOT EXISTS job_transition_rules (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

ALTER TABLE job_transition_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_job_transition_rules" ON job_transition_rules;
CREATE POLICY "select_job_transition_rules" ON job_transition_rules FOR SELECT TO authenticated USING (true);

INSERT INTO job_transition_rules (from_status, to_status)
SELECT f, t FROM (
  SELECT f, unnest(ts) AS t FROM (VALUES
    ('scheduled',   ARRAY['en_route','in_progress','completed','cancelled','canceled','no_show',
                          'on_hold','waiting_on_parts','waiting_on_customer','needs_follow_up','return_visit_needed']),
    ('en_route',    ARRAY['scheduled','in_progress','completed','cancelled','canceled','no_show',
                          'on_hold','waiting_on_parts','waiting_on_customer','needs_follow_up','return_visit_needed']),
    ('in_progress', ARRAY['completed','cancelled','canceled',
                          'on_hold','waiting_on_parts','waiting_on_customer','needs_follow_up','return_visit_needed']),
    ('completed',   ARRAY['return_visit_needed','needs_follow_up']),
    ('cancelled',   ARRAY['scheduled']),
    ('canceled',    ARRAY['scheduled']),
    ('no_show',     ARRAY['scheduled','cancelled','canceled']),
    ('on_hold',             ARRAY['scheduled','en_route','in_progress','completed','cancelled','canceled','waiting_on_parts','waiting_on_customer','needs_follow_up','return_visit_needed']),
    ('waiting_on_parts',    ARRAY['scheduled','en_route','in_progress','completed','cancelled','canceled','on_hold','waiting_on_customer','needs_follow_up','return_visit_needed']),
    ('waiting_on_customer', ARRAY['scheduled','en_route','in_progress','completed','cancelled','canceled','on_hold','waiting_on_parts','needs_follow_up','return_visit_needed']),
    ('needs_follow_up',     ARRAY['scheduled','en_route','in_progress','completed','cancelled','canceled','on_hold','waiting_on_parts','waiting_on_customer','return_visit_needed']),
    ('return_visit_needed', ARRAY['scheduled','en_route','in_progress','completed','cancelled','canceled','on_hold','waiting_on_parts','waiting_on_customer','needs_follow_up'])
  ) AS v(f, ts)
) x
ON CONFLICT DO NOTHING;

-- A status is "governed" if the matrix knows it. Unknown/custom statuses pass through untouched.
CREATE OR REPLACE FUNCTION public.job_status_is_governed(p_status text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p_status IS NOT NULL AND EXISTS (
    SELECT 1 FROM job_transition_rules WHERE from_status = p_status OR to_status = p_status
  );
$$;

-- =============================================================
-- 3. Immutable transition log
-- =============================================================
CREATE TABLE IF NOT EXISTS job_transition_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL,                 -- tenant (jobs.user_id); no FK so the log outlives deletes
  job_id      uuid NOT NULL,
  from_status text,                          -- NULL on creation
  to_status   text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
  actor_id    uuid,
  reason      text,
  source      text NOT NULL DEFAULT 'status_change' CHECK (source IN ('create', 'status_change', 'override', 'takeover', 'release')),
  override    boolean NOT NULL DEFAULT false,
  trace_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_transition_log_job ON job_transition_log (job_id, id);
CREATE INDEX IF NOT EXISTS idx_job_transition_log_tenant ON job_transition_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_transition_log_trace ON job_transition_log (trace_id);

CREATE OR REPLACE FUNCTION public.reject_job_transition_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'job_transition_log is append-only — % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_transition_log_no_update ON job_transition_log;
CREATE TRIGGER trg_job_transition_log_no_update BEFORE UPDATE ON job_transition_log
  FOR EACH ROW EXECUTE FUNCTION public.reject_job_transition_log_mutation();
DROP TRIGGER IF EXISTS trg_job_transition_log_no_delete ON job_transition_log;
CREATE TRIGGER trg_job_transition_log_no_delete BEFORE DELETE ON job_transition_log
  FOR EACH ROW EXECUTE FUNCTION public.reject_job_transition_log_mutation();

ALTER TABLE job_transition_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_transition_log" ON job_transition_log;
CREATE POLICY "select_own_job_transition_log" ON job_transition_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: writes happen only in SECURITY DEFINER triggers/RPCs below.

-- =============================================================
-- 4. Operator takeover locks
-- =============================================================
CREATE TABLE IF NOT EXISTS job_automation_locks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  job_id      uuid NOT NULL,
  locked_by   uuid,
  reason      text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  locked_at   timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_automation_locks_open ON job_automation_locks (job_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_automation_locks_tenant ON job_automation_locks (user_id, locked_at DESC);

ALTER TABLE job_automation_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_automation_locks" ON job_automation_locks;
CREATE POLICY "select_own_job_automation_locks" ON job_automation_locks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.job_is_automation_locked(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM job_automation_locks WHERE job_id = p_job_id AND released_at IS NULL);
$$;

REVOKE ALL ON FUNCTION public.job_is_automation_locked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_is_automation_locked(uuid) TO authenticated, service_role;

-- =============================================================
-- 5. Context helpers (GUCs set by the tagged RPCs; transaction-local)
-- =============================================================
CREATE OR REPLACE FUNCTION public.c2c_current_actor_type()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v text := current_setting('vireek.actor_type', true);
BEGIN
  IF v IN ('agent', 'human', 'system') THEN RETURN v; END IF;
  IF auth.uid() IS NOT NULL THEN RETURN 'human'; END IF;
  RETURN 'system';
END;
$$;

CREATE OR REPLACE FUNCTION public.c2c_current_trace_id(p_fallback uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v text := current_setting('vireek.trace_id', true);
BEGIN
  IF v IS NOT NULL AND v <> '' THEN
    BEGIN
      RETURN v::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      NULL;
    END;
  END IF;
  RETURN p_fallback;
END;
$$;

-- =============================================================
-- 6. Guard (BEFORE) + log (AFTER) triggers on jobs
-- =============================================================
CREATE OR REPLACE FUNCTION public.c2c_guard_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    text;
  v_override boolean := COALESCE(current_setting('vireek.c2c_override', true), '') = 'on';
BEGIN
  IF NEW.job_status IS NOT DISTINCT FROM OLD.job_status THEN RETURN NEW; END IF;
  IF NOT public.c2c_orchestration_enabled(NEW.user_id) THEN RETURN NEW; END IF;

  v_actor := public.c2c_current_actor_type();

  IF v_actor IN ('agent', 'system') AND NOT v_override
     AND EXISTS (SELECT 1 FROM job_automation_locks WHERE job_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'job % is under operator control; automation may not change its status', NEW.id
      USING ERRCODE = '55006';
  END IF;

  IF public.job_status_is_governed(OLD.job_status)
     AND public.job_status_is_governed(NEW.job_status)
     AND NOT EXISTS (SELECT 1 FROM job_transition_rules WHERE from_status = OLD.job_status AND to_status = NEW.job_status)
     AND NOT v_override THEN
    RAISE EXCEPTION 'illegal job transition % -> % for job %', OLD.job_status, NEW.job_status, NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c2c_guard_job_transition ON jobs;
CREATE TRIGGER trg_c2c_guard_job_transition
  BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.c2c_guard_job_transition();

CREATE OR REPLACE FUNCTION public.c2c_log_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    text;
  v_trace    uuid;
  v_override boolean := COALESCE(current_setting('vireek.c2c_override', true), '') = 'on';
  v_reason   text := NULLIF(current_setting('vireek.reason', true), '');
  v_from     text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.job_status IS NOT DISTINCT FROM OLD.job_status THEN RETURN NEW; END IF;
  END IF;
  IF NOT public.c2c_orchestration_enabled(NEW.user_id) THEN RETURN NEW; END IF;

  v_actor := public.c2c_current_actor_type();
  v_trace := public.c2c_current_trace_id(COALESCE(NEW.call_id, NEW.id));
  v_from  := CASE WHEN TG_OP = 'UPDATE' THEN OLD.job_status ELSE NULL END;

  INSERT INTO job_transition_log (user_id, job_id, from_status, to_status, actor_type, actor_id, reason, source, override, trace_id)
  VALUES (NEW.user_id, NEW.id, v_from, COALESCE(NEW.job_status, 'unknown'), v_actor, auth.uid(), v_reason,
          CASE WHEN TG_OP = 'INSERT' THEN 'create' WHEN v_override THEN 'override' ELSE 'status_change' END,
          v_override, v_trace);

  -- Durable event for the next stage / Outcome Learning. The ledger's actor_id FK targets profiles(id) and
  -- team members have no profile, so only pass through when auth.uid() is NULL or has a profile.
  IF auth.uid() IS NULL OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()) THEN
    PERFORM public.append_activity_event(
      p_aggregate_type := 'job',
      p_aggregate_id   := NEW.id,
      p_event_type     := 'job.status_changed',
      p_event_data     := jsonb_build_object(
                            'job_id', NEW.id, 'from', v_from, 'to', NEW.job_status,
                            'actor_type', v_actor, 'reason', v_reason, 'override', v_override,
                            'customer_name', NEW.customer_name, 'customer_phone', NEW.customer_phone),
      p_actor_type     := CASE v_actor WHEN 'agent' THEN 'ai' WHEN 'human' THEN 'user' ELSE 'system' END,
      p_correlation_id := v_trace,
      p_user_id        := NEW.user_id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c2c_log_job_transition ON jobs;
CREATE TRIGGER trg_c2c_log_job_transition
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.c2c_log_job_transition();

DROP TRIGGER IF EXISTS trg_c2c_log_job_created ON jobs;
CREATE TRIGGER trg_c2c_log_job_created
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.c2c_log_job_transition();

-- =============================================================
-- 7. Tagged write paths
-- =============================================================

-- Edge-function agents/system jobs (service role only).
CREATE OR REPLACE FUNCTION public.c2c_set_job_status(
  p_job_id uuid, p_to_status text, p_actor_type text, p_reason text, p_trace_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row jobs;
BEGIN
  IF p_actor_type NOT IN ('agent', 'system') THEN
    RAISE EXCEPTION 'p_actor_type must be agent or system' USING ERRCODE = '22023';
  END IF;
  IF p_to_status IS NULL OR btrim(p_to_status) = '' THEN
    RAISE EXCEPTION 'p_to_status required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.actor_type', p_actor_type, true);
  PERFORM set_config('vireek.reason', COALESCE(p_reason, ''), true);
  PERFORM set_config('vireek.trace_id', COALESCE(p_trace_id::text, ''), true);
  UPDATE jobs SET job_status = p_to_status WHERE id = p_job_id RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('job_id', v_row.id, 'job_status', v_row.job_status);
END;
$$;

REVOKE ALL ON FUNCTION public.c2c_set_job_status(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c2c_set_job_status(uuid, text, text, text, uuid) TO service_role;

-- Human exception path: bypasses the matrix, requires a written reason, is logged with override = true.
CREATE OR REPLACE FUNCTION public.c2c_override_job_status(p_job_id uuid, p_to_status text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row jobs;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('vireek.actor_type', 'human', true);
  PERFORM set_config('vireek.c2c_override', 'on', true);
  PERFORM set_config('vireek.reason', p_reason, true);
  UPDATE jobs SET job_status = p_to_status WHERE id = p_job_id RETURNING * INTO v_row;
  PERFORM set_config('vireek.c2c_override', 'off', true);
  RETURN jsonb_build_object('job_id', v_row.id, 'job_status', v_row.job_status);
END;
$$;

REVOKE ALL ON FUNCTION public.c2c_override_job_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.c2c_override_job_status(uuid, text, text) TO authenticated;

-- Takeover / release
CREATE OR REPLACE FUNCTION public.takeover_job_workflow(p_job_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_job jobs; v_lock uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO job_automation_locks (user_id, job_id, locked_by, reason)
  VALUES (v_job.user_id, v_job.id, auth.uid(), p_reason)
  ON CONFLICT (job_id) WHERE released_at IS NULL DO NOTHING
  RETURNING id INTO v_lock;

  IF v_lock IS NULL THEN
    SELECT id INTO v_lock FROM job_automation_locks WHERE job_id = v_job.id AND released_at IS NULL;
    RETURN v_lock;  -- already locked: idempotent
  END IF;

  IF public.c2c_orchestration_enabled(v_job.user_id) THEN
    INSERT INTO job_transition_log (user_id, job_id, from_status, to_status, actor_type, actor_id, reason, source, trace_id)
    VALUES (v_job.user_id, v_job.id, v_job.job_status, v_job.job_status, 'human', auth.uid(), 'takeover: ' || p_reason, 'takeover',
            public.c2c_current_trace_id(COALESCE(v_job.call_id, v_job.id)));
  END IF;
  RETURN v_lock;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_workflow(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_job jobs; v_n int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;

  UPDATE job_automation_locks SET released_at = now(), released_by = auth.uid()
   WHERE job_id = v_job.id AND released_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 AND public.c2c_orchestration_enabled(v_job.user_id) THEN
    INSERT INTO job_transition_log (user_id, job_id, from_status, to_status, actor_type, actor_id, reason, source, trace_id)
    VALUES (v_job.user_id, v_job.id, v_job.job_status, v_job.job_status, 'human', auth.uid(), 'automation resumed', 'release',
            public.c2c_current_trace_id(COALESCE(v_job.call_id, v_job.id)));
  END IF;
  RETURN v_n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.takeover_job_workflow(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_job_workflow(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.takeover_job_workflow(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_workflow(uuid) TO authenticated;

-- =============================================================
-- 8. Voice-to-job idempotency (call id + tool call id)
-- =============================================================
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS voice_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_voice_idempotency
  ON jobs (user_id, voice_idempotency_key)
  WHERE voice_idempotency_key IS NOT NULL;

-- =============================================================
-- 9. Workflow health: stuck work with age, owner queue, suggested action
--    SECURITY INVOKER: RLS on jobs/invoices applies; tenant filter is explicit as well.
--    SLA thresholds are defaults in this slice (per-tenant overrides not built yet).
-- =============================================================
CREATE OR REPLACE FUNCTION public.c2c_workflow_health()
RETURNS TABLE (
  stage text, job_id uuid, invoice_id uuid, customer_name text,
  age_minutes integer, sla_minutes integer, breached boolean,
  owner_queue text, suggested_action text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH t AS (SELECT public.get_account_owner_id() AS id)
  SELECT * FROM (
    -- booking without technician
    SELECT 'booking_without_technician'::text, j.id, NULL::uuid, j.customer_name,
           (EXTRACT(EPOCH FROM now() - j.created_at) / 60)::int, 30,
           (now() - j.created_at) > interval '30 minutes',
           'dispatch'::text, 'Assign a technician or use dispatch auto-assign'::text
    FROM jobs j, t
    WHERE j.user_id = t.id AND j.job_status = 'scheduled' AND j.assigned_technician_id IS NULL
      AND (j.scheduled_datetime IS NULL OR j.scheduled_datetime > now())
    UNION ALL
    -- completed job without invoice
    SELECT 'completed_without_invoice', j.id, NULL, j.customer_name,
           (EXTRACT(EPOCH FROM now() - j.completed_at) / 60)::int, 240,
           (now() - j.completed_at) > interval '4 hours',
           'billing', 'Draft and send the invoice'
    FROM jobs j, t
    WHERE j.user_id = t.id AND j.job_status = 'completed' AND j.completed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status <> 'void')
    UNION ALL
    -- invoice sent/viewed and past due
    SELECT 'invoice_overdue', j.id, i.id, i.customer_name,
           (EXTRACT(EPOCH FROM now() - i.due_date::timestamptz) / 60)::int, 0,
           true,
           'collections', 'Run the follow-up ladder or offer a payment plan'
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id, t
    WHERE i.user_id = t.id AND i.status IN ('sent', 'viewed') AND i.due_date < current_date
    UNION ALL
    -- no-show without a later booking for the same customer
    SELECT 'no_show_without_reschedule', j.id, NULL, j.customer_name,
           (EXTRACT(EPOCH FROM now() - j.scheduled_datetime) / 60)::int, 1440,
           (now() - j.scheduled_datetime) > interval '24 hours',
           'dispatch', 'Contact the customer and rebook'
    FROM jobs j, t
    WHERE j.user_id = t.id AND j.job_status = 'no_show' AND j.customer_id IS NOT NULL
      AND j.scheduled_datetime IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM jobs n
        WHERE n.user_id = j.user_id AND n.customer_id = j.customer_id
          AND n.id <> j.id AND n.job_status NOT IN ('cancelled', 'canceled')
          AND n.scheduled_datetime > j.scheduled_datetime)
  ) s(stage, job_id, invoice_id, customer_name, age_minutes, sla_minutes, breached, owner_queue, suggested_action)
  WHERE age_minutes >= 0
  ORDER BY breached DESC, age_minutes DESC;
$$;

REVOKE ALL ON FUNCTION public.c2c_workflow_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.c2c_workflow_health() TO authenticated;
