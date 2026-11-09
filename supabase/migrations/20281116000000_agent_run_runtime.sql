/*
  # Agent Run Runtime — durable run/step ledger, entity leases, circuit breakers

  هدف: یک لایهٔ اجرای مشترک برای همهٔ Agentها (additive، بدون تغییر رفتار فعلی).

  ## اضافه می‌کند
  1. agent_runs           — یک ردیف به‌ازای هر اجرا (plan، scopes، limits، usage، deadline)
  2. agent_run_steps      — دفتر کل گام‌ها؛ UNIQUE(user_id, idempotency_key) تضمین می‌کند
                            هر گام فقط یک‌بار اثر جانبی دارد
  3. agent_entity_leases  — قفل با TTL روی (tenant, entity) تا دو Agent هم‌زمان
                            به یک مشتری پیام ندهند
  4. agent_circuit_breakers — circuit breaker به‌ازای provider
  5. RPCها (فقط service_role): agent_run_start / agent_step_begin / agent_step_attach_log /
     agent_step_finish / agent_run_finish / agent_lease_acquire / agent_lease_release /
     agent_circuit_allow / agent_circuit_record / agent_runtime_health
  6. slugهای جدید در agent_action_catalog (همه default_requires_approval=false به‌جز refund،
     تا رفتار فعلی تغییر نکند؛ سیاست را مالک از Agent Governance تعیین می‌کند)

  ## بازگشت (rollback)
  هیچ داده/ستون موجودی تغییر نمی‌کند. برای حذف:
    DROP TABLE agent_run_steps, agent_runs, agent_entity_leases, agent_circuit_breakers CASCADE;
    DROP FUNCTION ... (امضاها پایین فایل در بخش ROLLBACK کامنت شده)
*/

-- =============================================================
-- 1) agent_runs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_source text NOT NULL,
  -- کلید یکتای تریگر (cron tick / webhook id) — اجرای تکراری همان تریگر، همان run را برمی‌گرداند
  trigger_ref text,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'awaiting_approval', 'succeeded', 'failed', 'escalated', 'dead_letter', 'cancelled')),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  scopes text[] NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{"steps":0,"cost_cents":0,"tokens":0,"contacts":0}'::jsonb,
  deadline_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_trigger
  ON public.agent_runs (user_id, agent_source, trigger_ref)
  WHERE trigger_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_open
  ON public.agent_runs (status, heartbeat_at)
  WHERE status IN ('running', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created
  ON public.agent_runs (user_id, created_at DESC);

-- =============================================================
-- 2) agent_run_steps
-- =============================================================
CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  tool text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'succeeded', 'failed_retryable', 'failed_permanent',
                      'awaiting_approval', 'blocked', 'needs_human')),
  attempt_count integer NOT NULL DEFAULT 1,
  -- true when the side effect MAY have happened (crash / timeout) — next attempt must reconcile first
  maybe_executed boolean NOT NULL DEFAULT false,
  result jsonb,
  error_class text
    CHECK (error_class IS NULL OR error_class IN ('transient', 'permanent', 'policy_blocked', 'ambiguous_input', 'dependency_down')),
  error text,
  action_log_id uuid,
  verification text NOT NULL DEFAULT 'not_required'
    CHECK (verification IN ('not_required', 'pending', 'verified', 'failed')),
  next_retry_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_run_steps_idem
  ON public.agent_run_steps (user_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_run_steps_run_index
  ON public.agent_run_steps (run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_open
  ON public.agent_run_steps (status, updated_at)
  WHERE status IN ('in_flight', 'failed_retryable', 'awaiting_approval', 'needs_human');

-- =============================================================
-- 3) agent_entity_leases
-- =============================================================
CREATE TABLE IF NOT EXISTS public.agent_entity_leases (
  user_id uuid NOT NULL,
  entity_table text NOT NULL,
  entity_id text NOT NULL,
  holder text NOT NULL,
  run_id uuid,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, entity_table, entity_id)
);

-- =============================================================
-- 4) agent_circuit_breakers (سراسری به‌ازای provider؛ بدون داده‌ی tenant)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.agent_circuit_breakers (
  provider text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  open_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 5) RLS — مالک فقط می‌خواند؛ همهٔ نوشتن‌ها از RPCهای service_role
-- =============================================================
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_entity_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_circuit_breakers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_runs" ON public.agent_runs;
CREATE POLICY "select_own_agent_runs" ON public.agent_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_agent_run_steps" ON public.agent_run_steps;
CREATE POLICY "select_own_agent_run_steps" ON public.agent_run_steps FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_agent_entity_leases" ON public.agent_entity_leases;
CREATE POLICY "select_own_agent_entity_leases" ON public.agent_entity_leases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- agent_circuit_breakers: عمداً بدون policy (فقط service_role)

-- =============================================================
-- 6) agent_run_start — idempotent روی (user, agent, trigger_ref)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_run_start(
  p_user_id uuid,
  p_agent_source text,
  p_trigger_ref text,
  p_correlation_id text,
  p_plan jsonb,
  p_scopes text[],
  p_limits jsonb,
  p_deadline_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run agent_runs;
  v_created boolean := true;
BEGIN
  IF p_user_id IS NULL OR p_agent_source IS NULL OR length(p_agent_source) = 0 THEN
    RAISE EXCEPTION 'agent_run_start: user_id and agent_source are required';
  END IF;

  IF p_trigger_ref IS NOT NULL THEN
    INSERT INTO agent_runs (user_id, agent_source, trigger_ref, correlation_id, plan, scopes, limits, deadline_at)
    VALUES (p_user_id, p_agent_source, p_trigger_ref, p_correlation_id, COALESCE(p_plan, '{}'::jsonb),
            COALESCE(p_scopes, '{}'), COALESCE(p_limits, '{}'::jsonb),
            now() + make_interval(secs => GREATEST(10, LEAST(p_deadline_seconds, 86400))))
    ON CONFLICT (user_id, agent_source, trigger_ref) WHERE trigger_ref IS NOT NULL DO NOTHING
    RETURNING * INTO v_run;

    IF v_run.id IS NULL THEN
      v_created := false;
      SELECT * INTO v_run FROM agent_runs
        WHERE user_id = p_user_id AND agent_source = p_agent_source AND trigger_ref = p_trigger_ref;
    END IF;
  ELSE
    INSERT INTO agent_runs (user_id, agent_source, trigger_ref, correlation_id, plan, scopes, limits, deadline_at)
    VALUES (p_user_id, p_agent_source, NULL, p_correlation_id, COALESCE(p_plan, '{}'::jsonb),
            COALESCE(p_scopes, '{}'), COALESCE(p_limits, '{}'::jsonb),
            now() + make_interval(secs => GREATEST(10, LEAST(p_deadline_seconds, 86400))))
    RETURNING * INTO v_run;
  END IF;

  RETURN jsonb_build_object(
    'run_id', v_run.id, 'created', v_created, 'status', v_run.status,
    'scopes', to_jsonb(v_run.scopes), 'limits', v_run.limits, 'usage', v_run.usage,
    'deadline_at', v_run.deadline_at, 'plan', v_run.plan, 'correlation_id', v_run.correlation_id,
    'created_at', v_run.created_at
  );
END;
$$;

-- =============================================================
-- 7) agent_step_begin — قلب idempotency + budget + resume
--    خروجی action یکی از:
--    execute | replay | reconcile | in_flight | backoff | exhausted | terminal |
--    approval_expired | budget_exceeded | run_closed | conflict
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_step_begin(
  p_run_id uuid,
  p_user_id uuid,
  p_step_index integer,
  p_tool text,
  p_idempotency_key text,
  p_input_hash text,
  p_input jsonb,
  p_max_attempts integer,
  p_projected_cost_cents integer DEFAULT 0,
  p_is_contact boolean DEFAULT false,
  p_stale_after_seconds integer DEFAULT 120,
  p_approval_ttl_seconds integer DEFAULT 86400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run agent_runs;
  v_step agent_run_steps;
  v_lim_steps integer;
  v_lim_cost numeric;
  v_lim_contacts integer;
  v_use_steps integer;
  v_use_cost numeric;
  v_use_contacts integer;
BEGIN
  -- قفل ردیف run: همهٔ beginهای هم‌زمان یک run سریالی می‌شوند
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_step_begin: run not found for tenant';
  END IF;

  IF v_run.status NOT IN ('running', 'awaiting_approval') THEN
    RETURN jsonb_build_object('action', 'run_closed', 'run_status', v_run.status);
  END IF;

  SELECT * INTO v_step FROM agent_run_steps
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key FOR UPDATE;

  IF FOUND THEN
    IF v_step.input_hash IS DISTINCT FROM p_input_hash THEN
      RETURN jsonb_build_object('action', 'conflict', 'step_id', v_step.id);
    END IF;

    -- replay بدون هیچ هزینه‌ای مجاز است (حتی بعد از اتمام budget/deadline)
    IF v_step.status = 'succeeded' THEN
      RETURN jsonb_build_object('action', 'replay', 'step_id', v_step.id, 'result', v_step.result,
                                'attempt', v_step.attempt_count);
    END IF;

    IF v_step.status IN ('failed_permanent', 'blocked', 'needs_human') THEN
      RETURN jsonb_build_object('action', 'terminal', 'step_id', v_step.id, 'status', v_step.status,
                                'error_class', v_step.error_class, 'error', v_step.error);
    END IF;

    IF v_step.status = 'in_flight' THEN
      IF v_step.updated_at > now() - make_interval(secs => p_stale_after_seconds) THEN
        RETURN jsonb_build_object('action', 'in_flight', 'step_id', v_step.id);
      END IF;
      -- worker مرده: اثر جانبی ممکن است انجام شده باشد → reconcile
      UPDATE agent_run_steps SET updated_at = now(), maybe_executed = true WHERE id = v_step.id;
      RETURN jsonb_build_object('action', 'reconcile', 'step_id', v_step.id, 'attempt', v_step.attempt_count,
                                'action_log_id', v_step.action_log_id);
    END IF;

    IF v_step.status = 'awaiting_approval' THEN
      IF v_step.updated_at < now() - make_interval(secs => p_approval_ttl_seconds) THEN
        -- تأیید کهنه روی داده‌های قدیمی اجرا نمی‌شود
        UPDATE agent_run_steps SET status = 'blocked', error_class = 'policy_blocked',
               error = 'approval_expired', finished_at = now(), updated_at = now()
          WHERE id = v_step.id;
        UPDATE agent_action_log SET status = 'failed', error = 'approval_expired',
               decision_reason = 'Approval expired — facts may be stale; re-plan required.'
          WHERE id = v_step.action_log_id AND status IN ('pending_approval', 'approved');
        RETURN jsonb_build_object('action', 'approval_expired', 'step_id', v_step.id);
      END IF;
      UPDATE agent_run_steps SET status = 'in_flight', updated_at = now() WHERE id = v_step.id;
      UPDATE agent_runs SET status = 'running', updated_at = now() WHERE id = v_run.id AND status = 'awaiting_approval';
      RETURN jsonb_build_object('action', 'execute', 'step_id', v_step.id, 'attempt', v_step.attempt_count,
                                'action_log_id', v_step.action_log_id, 'was_awaiting_approval', true);
    END IF;

    IF v_step.status = 'failed_retryable' THEN
      IF v_step.attempt_count >= GREATEST(p_max_attempts, 1) THEN
        RETURN jsonb_build_object('action', 'exhausted', 'step_id', v_step.id, 'attempt', v_step.attempt_count);
      END IF;
      IF v_step.next_retry_at IS NOT NULL AND v_step.next_retry_at > now() THEN
        RETURN jsonb_build_object('action', 'backoff', 'step_id', v_step.id, 'retry_at', v_step.next_retry_at);
      END IF;
      UPDATE agent_run_steps SET status = 'in_flight', attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = v_step.id;
      RETURN jsonb_build_object(
        'action', CASE WHEN v_step.maybe_executed THEN 'reconcile' ELSE 'execute' END,
        'step_id', v_step.id, 'attempt', v_step.attempt_count + 1, 'action_log_id', v_step.action_log_id);
    END IF;
  END IF;

  -- گام جدید: deadline + budget (اتمی چون run قفل است)
  IF now() > v_run.deadline_at THEN
    RETURN jsonb_build_object('action', 'budget_exceeded', 'reason', 'wall_clock');
  END IF;

  v_lim_steps := NULLIF(v_run.limits->>'max_steps', '')::integer;
  v_lim_cost := NULLIF(v_run.limits->>'max_cost_cents', '')::numeric;
  v_lim_contacts := NULLIF(v_run.limits->>'max_contacts', '')::integer;
  v_use_steps := COALESCE((v_run.usage->>'steps')::integer, 0);
  v_use_cost := COALESCE((v_run.usage->>'cost_cents')::numeric, 0);
  v_use_contacts := COALESCE((v_run.usage->>'contacts')::integer, 0);

  IF v_lim_steps IS NOT NULL AND v_use_steps + 1 > v_lim_steps THEN
    RETURN jsonb_build_object('action', 'budget_exceeded', 'reason', 'max_steps');
  END IF;
  IF v_lim_cost IS NOT NULL AND v_use_cost + GREATEST(p_projected_cost_cents, 0) > v_lim_cost THEN
    RETURN jsonb_build_object('action', 'budget_exceeded', 'reason', 'max_cost');
  END IF;
  IF p_is_contact AND v_lim_contacts IS NOT NULL AND v_use_contacts + 1 > v_lim_contacts THEN
    RETURN jsonb_build_object('action', 'budget_exceeded', 'reason', 'max_contacts');
  END IF;

  INSERT INTO agent_run_steps (run_id, user_id, step_index, tool, idempotency_key, input_hash, input, status, attempt_count)
  VALUES (p_run_id, p_user_id, p_step_index, p_tool, p_idempotency_key, p_input_hash, COALESCE(p_input, '{}'::jsonb), 'in_flight', 1)
  RETURNING * INTO v_step;

  UPDATE agent_runs SET heartbeat_at = now(), updated_at = now() WHERE id = v_run.id;

  RETURN jsonb_build_object('action', 'execute', 'step_id', v_step.id, 'attempt', 1);
END;
$$;

-- =============================================================
-- 8) agent_step_attach_log — ثبت action_log_id تا replay دوباره authorize نکند
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_step_attach_log(
  p_step_id uuid, p_user_id uuid, p_action_log_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE agent_run_steps SET action_log_id = p_action_log_id, updated_at = now()
  WHERE id = p_step_id AND user_id = p_user_id;
$$;

-- =============================================================
-- 9) agent_step_finish — usage فقط یک‌بار شمرده می‌شود (انتقال به succeeded)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_step_finish(
  p_step_id uuid,
  p_user_id uuid,
  p_status text,
  p_result jsonb DEFAULT NULL,
  p_error_class text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_next_retry_at timestamptz DEFAULT NULL,
  p_maybe_executed boolean DEFAULT false,
  p_verification text DEFAULT 'not_required',
  p_cost_cents integer DEFAULT 0,
  p_tokens integer DEFAULT 0,
  p_is_contact boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step agent_run_steps;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed_retryable', 'failed_permanent', 'awaiting_approval', 'blocked', 'needs_human') THEN
    RAISE EXCEPTION 'agent_step_finish: invalid status %', p_status;
  END IF;

  SELECT * INTO v_step FROM agent_run_steps WHERE id = p_step_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_step_finish: step not found for tenant';
  END IF;

  -- یک گام موفق دیگر تغییر نمی‌کند (جلوگیری از شمارش/بازنویسی مضاعف)
  IF v_step.status = 'succeeded' THEN
    RETURN;
  END IF;

  UPDATE agent_run_steps SET
    status = p_status,
    result = CASE WHEN p_status = 'succeeded' THEN p_result ELSE result END,
    error_class = p_error_class,
    error = left(p_error, 2000),
    next_retry_at = p_next_retry_at,
    maybe_executed = CASE WHEN p_status = 'succeeded' THEN false ELSE p_maybe_executed END,
    verification = p_verification,
    finished_at = CASE WHEN p_status IN ('succeeded', 'failed_permanent', 'blocked', 'needs_human') THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = p_step_id;

  IF p_status = 'succeeded' THEN
    UPDATE agent_runs SET
      usage = jsonb_build_object(
        'steps', COALESCE((usage->>'steps')::integer, 0) + 1,
        'cost_cents', COALESCE((usage->>'cost_cents')::numeric, 0) + GREATEST(COALESCE(p_cost_cents, 0), 0),
        'tokens', COALESCE((usage->>'tokens')::bigint, 0) + GREATEST(COALESCE(p_tokens, 0), 0),
        'contacts', COALESCE((usage->>'contacts')::integer, 0) + CASE WHEN p_is_contact THEN 1 ELSE 0 END
      ),
      heartbeat_at = now(), updated_at = now()
    WHERE id = v_step.run_id;
  ELSIF p_status = 'awaiting_approval' THEN
    UPDATE agent_runs SET status = 'awaiting_approval', heartbeat_at = now(), updated_at = now()
    WHERE id = v_step.run_id AND status = 'running';
  END IF;
END;
$$;

-- =============================================================
-- 10) agent_run_finish
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_run_finish(
  p_run_id uuid, p_user_id uuid, p_status text, p_stop_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('succeeded', 'failed', 'escalated', 'dead_letter', 'cancelled', 'awaiting_approval', 'running') THEN
    RAISE EXCEPTION 'agent_run_finish: invalid status %', p_status;
  END IF;
  UPDATE agent_runs SET
    status = p_status,
    stop_reason = left(p_stop_reason, 500),
    finished_at = CASE WHEN p_status IN ('succeeded', 'failed', 'escalated', 'dead_letter', 'cancelled') THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = p_run_id AND user_id = p_user_id
    AND status IN ('running', 'awaiting_approval');
END;
$$;

-- =============================================================
-- 11) Leases (mutual exclusion با TTL)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_lease_acquire(
  p_user_id uuid, p_entity_table text, p_entity_id text, p_holder text, p_run_id uuid, p_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease agent_entity_leases;
  v_ttl integer := GREATEST(5, LEAST(COALESCE(p_ttl_seconds, 60), 3600));
BEGIN
  INSERT INTO agent_entity_leases (user_id, entity_table, entity_id, holder, run_id, expires_at)
  VALUES (p_user_id, p_entity_table, p_entity_id, p_holder, p_run_id, now() + make_interval(secs => v_ttl))
  ON CONFLICT (user_id, entity_table, entity_id) DO UPDATE
    SET holder = EXCLUDED.holder, run_id = EXCLUDED.run_id,
        acquired_at = now(), expires_at = EXCLUDED.expires_at
    WHERE agent_entity_leases.expires_at <= now() OR agent_entity_leases.holder = EXCLUDED.holder
  RETURNING * INTO v_lease;

  IF v_lease.holder IS NOT NULL THEN
    RETURN jsonb_build_object('acquired', true, 'holder', v_lease.holder, 'expires_at', v_lease.expires_at);
  END IF;

  SELECT * INTO v_lease FROM agent_entity_leases
    WHERE user_id = p_user_id AND entity_table = p_entity_table AND entity_id = p_entity_id;
  RETURN jsonb_build_object('acquired', false, 'holder', v_lease.holder, 'expires_at', v_lease.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_lease_release(
  p_user_id uuid, p_entity_table text, p_entity_id text, p_holder text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM agent_entity_leases
  WHERE user_id = p_user_id AND entity_table = p_entity_table
    AND entity_id = p_entity_id AND holder = p_holder;
$$;

-- =============================================================
-- 12) Circuit breaker
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_circuit_allow(p_provider text, p_cooldown_seconds integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cb agent_circuit_breakers;
BEGIN
  INSERT INTO agent_circuit_breakers (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_cb FROM agent_circuit_breakers WHERE provider = p_provider FOR UPDATE;

  IF v_cb.state = 'closed' THEN
    RETURN jsonb_build_object('allowed', true, 'state', 'closed');
  END IF;

  IF v_cb.open_until IS NULL OR v_cb.open_until <= now() THEN
    -- فقط یک probe: بقیه تا پایان cooldown مسدودند
    UPDATE agent_circuit_breakers
      SET state = 'half_open', open_until = now() + make_interval(secs => GREATEST(p_cooldown_seconds, 5)), updated_at = now()
      WHERE provider = p_provider;
    RETURN jsonb_build_object('allowed', true, 'state', 'half_open');
  END IF;

  RETURN jsonb_build_object('allowed', false, 'state', v_cb.state, 'retry_at', v_cb.open_until);
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_circuit_record(
  p_provider text, p_ok boolean, p_threshold integer DEFAULT 5, p_cooldown_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cb agent_circuit_breakers;
  v_failures integer;
  v_open boolean;
BEGIN
  INSERT INTO agent_circuit_breakers (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_cb FROM agent_circuit_breakers WHERE provider = p_provider FOR UPDATE;

  IF p_ok THEN
    UPDATE agent_circuit_breakers
      SET state = 'closed', consecutive_failures = 0, opened_at = NULL, open_until = NULL, updated_at = now()
      WHERE provider = p_provider;
    RETURN jsonb_build_object('state', 'closed');
  END IF;

  v_failures := v_cb.consecutive_failures + 1;
  v_open := v_cb.state = 'half_open' OR v_failures >= GREATEST(p_threshold, 1);

  IF v_open THEN
    UPDATE agent_circuit_breakers
      SET state = 'open', consecutive_failures = v_failures,
          opened_at = COALESCE(CASE WHEN v_cb.state = 'open' THEN v_cb.opened_at END, now()),
          open_until = now() + make_interval(secs => GREATEST(p_cooldown_seconds, 5)), updated_at = now()
      WHERE provider = p_provider;
    RETURN jsonb_build_object('state', 'open', 'consecutive_failures', v_failures);
  END IF;

  UPDATE agent_circuit_breakers SET consecutive_failures = v_failures, updated_at = now() WHERE provider = p_provider;
  RETURN jsonb_build_object('state', 'closed', 'consecutive_failures', v_failures);
END;
$$;

-- =============================================================
-- 13) Health برای alerting (run گیرکرده، dead-letter، breaker باز)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_runtime_health(p_stuck_after_minutes integer DEFAULT 15)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'stuck_runs', (SELECT count(*) FROM agent_runs
                    WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => p_stuck_after_minutes)),
    'dead_letter_24h', (SELECT count(*) FROM agent_runs
                    WHERE status = 'dead_letter' AND updated_at > now() - interval '24 hours'),
    'escalated_24h', (SELECT count(*) FROM agent_runs
                    WHERE status = 'escalated' AND updated_at > now() - interval '24 hours'),
    'open_breakers', COALESCE((SELECT jsonb_agg(provider) FROM agent_circuit_breakers WHERE state <> 'closed'), '[]'::jsonb)
  );
$$;

-- =============================================================
-- 14) دسترسی: فقط service_role
-- =============================================================
REVOKE ALL ON FUNCTION public.agent_run_start(uuid, text, text, text, jsonb, text[], jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_step_begin(uuid, uuid, integer, text, text, text, jsonb, integer, integer, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_step_attach_log(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_step_finish(uuid, uuid, text, jsonb, text, text, timestamptz, boolean, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_run_finish(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_lease_acquire(uuid, text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_lease_release(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_circuit_allow(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_circuit_record(text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_runtime_health(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.agent_run_start(uuid, text, text, text, jsonb, text[], jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_step_begin(uuid, uuid, integer, text, text, text, jsonb, integer, integer, boolean, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_step_attach_log(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_step_finish(uuid, uuid, text, jsonb, text, text, timestamptz, boolean, text, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_run_finish(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_lease_acquire(uuid, text, text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_lease_release(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_circuit_allow(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_circuit_record(text, boolean, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_runtime_health(integer) TO service_role;

-- =============================================================
-- 15) slugهای جدید governance (رفتار فعلی تغییر نمی‌کند: به‌جز refund همه بدون تأیید پیش‌فرض)
-- =============================================================
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('agent_send_sms',            'agent-run',          'Agent run: customer SMS',               'messaging', false, false, false),
  ('service_recovery_contact',  'service-recovery-agent', 'Service recovery customer contact', 'messaging', false, false, false),
  ('voice_book_appointment',    'vapi-webhook',       'Voice agent: book appointment',         'other',     true,  false, false),
  ('voice_reschedule',          'vapi-webhook',       'Voice agent: reschedule appointment',   'other',     true,  false, false),
  ('voice_collect_payment',     'vapi-webhook',       'Voice agent: collect card payment',     'financial', false, true,  false),
  ('voice_transfer_call',       'vapi-webhook',       'Voice agent: transfer call to human',   'calling',   false, false, false),
  ('agent_refund',              'agent-run',          'Agent run: issue refund',               'financial', false, true,  true),
  ('agent_dispatch_assign',     'agent-run',          'Agent run: assign technician to job',   'other',     true,  false, false)
ON CONFLICT (slug) DO NOTHING;

/* ROLLBACK (دستی، فقط اگر لازم شد):
DROP FUNCTION IF EXISTS public.agent_runtime_health(integer);
DROP FUNCTION IF EXISTS public.agent_circuit_record(text, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.agent_circuit_allow(text, integer);
DROP FUNCTION IF EXISTS public.agent_lease_release(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.agent_lease_acquire(uuid, text, text, text, uuid, integer);
DROP FUNCTION IF EXISTS public.agent_run_finish(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.agent_step_finish(uuid, uuid, text, jsonb, text, text, timestamptz, boolean, text, integer, integer, boolean);
DROP FUNCTION IF EXISTS public.agent_step_attach_log(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.agent_step_begin(uuid, uuid, integer, text, text, text, jsonb, integer, integer, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.agent_run_start(uuid, text, text, text, jsonb, text[], jsonb, integer);
DROP TABLE IF EXISTS public.agent_run_steps, public.agent_runs, public.agent_entity_leases, public.agent_circuit_breakers;
*/
