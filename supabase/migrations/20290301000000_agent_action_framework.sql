/*
  # Agent Action Framework (flag OFF by default, per-account entitlement OFF by default)

  Tables
    agent_action_account_settings  per-account entitlement (staff-set) + account kill switch (owner-set pause)
    agent_scope_grants             scope -> autonomy ceiling, per agent, per account (deny by default)
    agent_action_tool_policy       per-account enable/autonomy ceiling per registered tool
    agent_action_limits            spend / message volume / rate / discount cap / time window
    agent_action_requests          one row per proposed action: approval inbox + execution state machine
    agent_action_usage             counters for windowed limits (atomic reservation)
    agent_action_audit             append-only, hash-chained, per tenant (written by triggers only)

  Zero behaviour change while OFF: the feature flag `agent_action_framework` is seeded disabled, entitlement
  defaults to false, and every write RPC refuses until both are on. Nothing in this migration touches existing tables.

  Depends on (all exist in earlier migrations): get_account_owner_id(), is_vireek_staff(uuid), can_manage_ai_security(),
  flag_evaluate(text, uuid), feature_flags, kill_switches.

  Deploy order: this migration -> edge function agent-actions -> shared engine callers -> UI.

  ROLLBACK (data in these objects is lost; nothing else is touched):
    DROP TABLE IF EXISTS public.agent_action_audit, public.agent_action_usage, public.agent_action_requests,
      public.agent_action_limits, public.agent_action_tool_policy, public.agent_scope_grants,
      public.agent_action_account_settings CASCADE;
    DROP FUNCTION IF EXISTS public.agent_action_audit_trigger(), public.agent_action_audit_immutable(),
      public.agent_action_requests_guard(), public.agent_action_enabled_for(uuid), public.agent_action_assert_manager(),
      public.agent_action_load_policy(uuid, text, text), public.agent_action_usage_reserve(uuid, uuid, text, text, text, numeric, jsonb, boolean),
      public.agent_action_usage_release(uuid, uuid), public.agent_action_set_paused(boolean, text),
      public.agent_action_set_grant(text, text, text), public.agent_action_delete_grant(text, text),
      public.agent_action_set_tool_policy(text, boolean, text),
      public.agent_action_upsert_limit(uuid, text, text, text, integer, numeric, text, integer[], integer, integer, text),
      public.agent_action_delete_limit(uuid), public.get_my_agent_action_state(),
      public.staff_set_agent_action_entitlement(uuid, boolean), public.agent_action_expire_stale(),
      public.agent_action_prune(), public.verify_agent_action_audit(uuid);
    DELETE FROM public.kill_switches WHERE key = 'agent_action_framework';
    DELETE FROM public.feature_flags WHERE key = 'agent_action_framework';
*/

-- =============================================================
-- 1. FLAG + KILL SWITCH SEEDS (additive, idempotent)
-- =============================================================
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct, kind, risk)
VALUES ('agent_action_framework', 'Agent action framework',
        'Typed tool registry, approvals, limits, undo and audit for AI agent actions. Also needs the per-account entitlement.',
        false, 0, 'release', 'high')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.kill_switches (key, label, description, risk)
VALUES ('agent_action_framework', 'Agent action framework', 'Stops every agent action proposal, approval and execution (undo stays available).', 'critical')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 2. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.agent_action_account_settings (
  user_id         uuid PRIMARY KEY,
  module_entitled boolean NOT NULL DEFAULT false,
  paused          boolean NOT NULL DEFAULT false,
  pause_reason    text CHECK (pause_reason IS NULL OR char_length(pause_reason) <= 300),
  paused_by       uuid,
  paused_at       timestamptz,
  entitled_by     uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_scope_grants (
  user_id    uuid NOT NULL,
  agent_id   text NOT NULL CHECK (agent_id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  scope      text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
  autonomy   text NOT NULL CHECK (autonomy IN ('suggest', 'require_approval', 'auto_notify')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id, scope)
);

CREATE TABLE IF NOT EXISTS public.agent_action_tool_policy (
  user_id    uuid NOT NULL,
  tool_slug  text NOT NULL CHECK (tool_slug ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  enabled    boolean NOT NULL DEFAULT true,
  autonomy   text CHECK (autonomy IS NULL OR autonomy IN ('suggest', 'require_approval', 'auto_notify')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tool_slug)
);

CREATE TABLE IF NOT EXISTS public.agent_action_limits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('spend_cents', 'messages', 'rate_calls', 'discount_pct', 'time_window')),
  agent_id     text CHECK (agent_id IS NULL OR agent_id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  tool_slug    text CHECK (tool_slug IS NULL OR tool_slug ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  window_sec   integer,
  max_value    numeric,
  on_exceed    text NOT NULL DEFAULT 'approval' CHECK (on_exceed IN ('block', 'approval')),
  tw_days      integer[],
  tw_start_min integer,
  tw_end_min   integer,
  tw_tz        text,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_action_limits_shape CHECK (
    COALESCE(CASE kind
      WHEN 'discount_pct' THEN max_value BETWEEN 0 AND 100 AND window_sec IS NULL AND tw_days IS NULL
      WHEN 'time_window'  THEN tw_days IS NOT NULL AND cardinality(tw_days) BETWEEN 1 AND 7
                               AND tw_days <@ ARRAY[0,1,2,3,4,5,6] AND tw_start_min BETWEEN 0 AND 1439
                               AND tw_end_min BETWEEN 1 AND 1440 AND tw_start_min <> tw_end_min
                               AND tw_tz IS NOT NULL AND max_value IS NULL AND window_sec IS NULL
      ELSE max_value > 0 AND window_sec BETWEEN 1 AND 2592000 AND tw_days IS NULL
    END, false)
  )
);
CREATE INDEX IF NOT EXISTS idx_agent_action_limits_user ON public.agent_action_limits (user_id);

CREATE TABLE IF NOT EXISTS public.agent_action_requests (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  agent_id         text NOT NULL CHECK (agent_id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  tool_slug        text NOT NULL CHECK (char_length(tool_slug) BETWEEN 1 AND 80),
  tool_version     integer NOT NULL CHECK (tool_version >= 0),
  idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,120}$'),
  status           text NOT NULL CHECK (status IN ('suggested','pending_approval','approved','executing','executed','failed','rejected','blocked','expired','undone')),
  autonomy         text CHECK (autonomy IS NULL OR autonomy IN ('suggest', 'require_approval', 'auto_notify')),
  reason           text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  input_hash       text NOT NULL DEFAULT '' CHECK (char_length(input_hash) <= 64),
  inputs_redacted  jsonb CHECK (inputs_redacted IS NULL OR octet_length(inputs_redacted::text) <= 8000),
  exec_payload     jsonb CHECK (exec_payload IS NULL OR octet_length(exec_payload::text) <= 20000),
  preview          jsonb CHECK (preview IS NULL OR octet_length(preview::text) <= 20000),
  outputs_redacted jsonb CHECK (outputs_redacted IS NULL OR octet_length(outputs_redacted::text) <= 8000),
  undo             jsonb CHECK (undo IS NULL OR octet_length(undo::text) <= 20000),
  undo_until       timestamptz,
  model            text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
  prompt_version   text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 80),
  sources          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array' AND octet_length(sources::text) <= 8000),
  decision_code    text CHECK (decision_code IS NULL OR char_length(decision_code) <= 80),
  decision_detail  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(decision_detail) = 'array' AND octet_length(decision_detail::text) <= 4000),
  decided_by       uuid,
  expires_at       timestamptz,
  executed_at      timestamptz,
  error            text CHECK (error IS NULL OR char_length(error) <= 300),
  last_actor       text NOT NULL DEFAULT 'system' CHECK (char_length(last_actor) <= 80),
  correlation_id   text CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_action_requests_idem UNIQUE (user_id, agent_id, tool_slug, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_action_requests_user_status ON public.agent_action_requests (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_action_requests_open ON public.agent_action_requests (user_id, expires_at) WHERE status IN ('pending_approval', 'suggested');

CREATE TABLE IF NOT EXISTS public.agent_action_usage (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL,
  request_id  uuid NOT NULL,
  agent_id    text NOT NULL,
  tool_slug   text NOT NULL,
  kind        text NOT NULL,
  amount      numeric NOT NULL CHECK (amount >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_action_usage_lookup ON public.agent_action_usage (user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_action_usage_request ON public.agent_action_usage (user_id, request_id);

CREATE TABLE IF NOT EXISTS public.agent_action_audit (
  user_id    uuid NOT NULL,
  seq        bigint NOT NULL,
  request_id uuid,
  event      text NOT NULL,
  actor      text NOT NULL,
  snapshot   jsonb NOT NULL,
  prev_hash  text NOT NULL,
  row_hash   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_action_audit_request ON public.agent_action_audit (request_id, seq);

-- =============================================================
-- 3. REQUEST STATE-MACHINE GUARD (defence in depth; mirrors TRANSITIONS in types.ts)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_action_requests_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('blocked', 'pending_approval', 'suggested', 'approved') THEN
      RAISE EXCEPTION 'invalid initial status %', NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'blocked' THEN NEW.exec_payload := NULL; END IF;
    RETURN NEW;
  END IF;

  IF current_setting('app.agent_action_maintenance', true) = 'on' THEN
    RETURN NEW; -- agent_action_prune() only: nulls payload-ish columns, status unchanged
  END IF;

  IF OLD.status = NEW.status THEN
    RAISE EXCEPTION 'agent_action_requests: status must change on update' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.agent_id <> OLD.agent_id OR NEW.tool_slug <> OLD.tool_slug
     OR NEW.tool_version <> OLD.tool_version OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.input_hash <> OLD.input_hash OR NEW.model <> OLD.model OR NEW.prompt_version <> OLD.prompt_version
     OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at
     OR NEW.inputs_redacted IS DISTINCT FROM OLD.inputs_redacted OR NEW.preview IS DISTINCT FROM OLD.preview
     OR NEW.sources IS DISTINCT FROM OLD.sources THEN
    RAISE EXCEPTION 'agent_action_requests: immutable column changed' USING ERRCODE = '42501';
  END IF;

  v_ok := CASE OLD.status
    WHEN 'suggested'        THEN NEW.status IN ('approved', 'rejected', 'expired', 'blocked')
    WHEN 'pending_approval' THEN NEW.status IN ('approved', 'rejected', 'expired', 'blocked')
    WHEN 'approved'         THEN NEW.status IN ('executing', 'blocked')
    WHEN 'executing'        THEN NEW.status IN ('executed', 'failed')
    WHEN 'executed'         THEN NEW.status = 'undone'
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'agent_action_requests: illegal transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- data minimisation, enforced by the database itself
  IF NEW.status IN ('executed', 'failed', 'rejected', 'blocked', 'expired', 'undone') THEN NEW.exec_payload := NULL; END IF;
  IF NEW.status = 'undone' THEN NEW.undo := NULL; NEW.undo_until := NULL; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_action_requests_guard ON public.agent_action_requests;
CREATE TRIGGER trg_agent_action_requests_guard BEFORE INSERT OR UPDATE ON public.agent_action_requests
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_requests_guard();

CREATE OR REPLACE FUNCTION public.agent_action_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS trg_agent_action_requests_no_delete ON public.agent_action_requests;
CREATE TRIGGER trg_agent_action_requests_no_delete BEFORE DELETE ON public.agent_action_requests
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_no_delete();

-- =============================================================
-- 4. APPEND-ONLY AUDIT CHAIN (trigger-written; PII-free by construction)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_action_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'agent_action_audit is append-only' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS trg_agent_action_audit_immutable ON public.agent_action_audit;
CREATE TRIGGER trg_agent_action_audit_immutable BEFORE UPDATE OR DELETE ON public.agent_action_audit
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_immutable();
DROP TRIGGER IF EXISTS trg_agent_action_audit_no_truncate ON public.agent_action_audit;
CREATE TRIGGER trg_agent_action_audit_no_truncate BEFORE TRUNCATE ON public.agent_action_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_action_audit_immutable();

CREATE OR REPLACE FUNCTION public.agent_action_audit_hash(p_prev text, p_seq bigint, p_req uuid, p_event text, p_snap jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_prev || '|' || p_seq::text || '|' || COALESCE(p_req::text, '-') || '|' || p_event || '|' || p_snap::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION public.agent_action_audit_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jsonb; v_owner uuid; v_req uuid; v_event text; v_actor text; v_snap jsonb; v_prev text; v_seq bigint;
BEGIN
  IF current_setting('app.agent_action_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN j := to_jsonb(OLD); ELSE j := to_jsonb(NEW); END IF;
  v_owner := (j ->> 'user_id')::uuid;

  IF TG_TABLE_NAME = 'agent_action_requests' THEN
    v_req := (j ->> 'id')::uuid;
    v_event := j ->> 'status';
    v_actor := COALESCE(j ->> 'last_actor', 'system');
    -- exec_payload / preview / undo hold raw data and are deliberately NOT audited; inputs_redacted is.
    v_snap := jsonb_build_object(
      'agent_id', j -> 'agent_id', 'tool_slug', j -> 'tool_slug', 'tool_version', j -> 'tool_version',
      'status', j -> 'status', 'autonomy', j -> 'autonomy', 'reason', j -> 'reason', 'input_hash', j -> 'input_hash',
      'inputs_redacted', j -> 'inputs_redacted', 'outputs_redacted', j -> 'outputs_redacted',
      'model', j -> 'model', 'prompt_version', j -> 'prompt_version', 'sources', j -> 'sources',
      'decision_code', j -> 'decision_code', 'decision_detail', j -> 'decision_detail',
      'decided_by', j -> 'decided_by', 'error', j -> 'error');
  ELSE
    v_event := TG_TABLE_NAME || ':' || lower(TG_OP);
    v_actor := COALESCE(auth.uid()::text, 'service');
    v_snap := j;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('agent_action_audit:' || v_owner::text, 0));
  SELECT a.row_hash, a.seq INTO v_prev, v_seq FROM public.agent_action_audit a WHERE a.user_id = v_owner ORDER BY a.seq DESC LIMIT 1;
  v_prev := COALESCE(v_prev, repeat('0', 64));
  v_seq := COALESCE(v_seq, 0) + 1;
  INSERT INTO public.agent_action_audit (user_id, seq, request_id, event, actor, snapshot, prev_hash, row_hash)
  VALUES (v_owner, v_seq, v_req, v_event, v_actor, v_snap, v_prev, public.agent_action_audit_hash(v_prev, v_seq, v_req, v_event, v_snap));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_action_requests_audit ON public.agent_action_requests;
CREATE TRIGGER trg_agent_action_requests_audit AFTER INSERT OR UPDATE ON public.agent_action_requests
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_trigger();
DROP TRIGGER IF EXISTS trg_agent_scope_grants_audit ON public.agent_scope_grants;
CREATE TRIGGER trg_agent_scope_grants_audit AFTER INSERT OR UPDATE OR DELETE ON public.agent_scope_grants
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_trigger();
DROP TRIGGER IF EXISTS trg_agent_action_tool_policy_audit ON public.agent_action_tool_policy;
CREATE TRIGGER trg_agent_action_tool_policy_audit AFTER INSERT OR UPDATE OR DELETE ON public.agent_action_tool_policy
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_trigger();
DROP TRIGGER IF EXISTS trg_agent_action_limits_audit ON public.agent_action_limits;
CREATE TRIGGER trg_agent_action_limits_audit AFTER INSERT OR UPDATE OR DELETE ON public.agent_action_limits
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_trigger();
DROP TRIGGER IF EXISTS trg_agent_action_settings_audit ON public.agent_action_account_settings;
CREATE TRIGGER trg_agent_action_settings_audit AFTER INSERT OR UPDATE OR DELETE ON public.agent_action_account_settings
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_audit_trigger();

CREATE OR REPLACE FUNCTION public.verify_agent_action_audit(p_user_id uuid)
RETURNS TABLE (ok boolean, checked bigint, broken_seq bigint, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_prev text := repeat('0', 64); v_expect bigint := 1; v_n bigint := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not allowed to verify another account.' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT * FROM public.agent_action_audit WHERE user_id = p_user_id ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_expect THEN RETURN QUERY SELECT false, v_n, r.seq, 'sequence gap (row removed)'; RETURN; END IF;
    IF r.prev_hash <> v_prev THEN RETURN QUERY SELECT false, v_n, r.seq, 'prev_hash mismatch'; RETURN; END IF;
    IF r.row_hash <> public.agent_action_audit_hash(r.prev_hash, r.seq, r.request_id, r.event, r.snapshot) THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'row_hash mismatch (row altered)'; RETURN;
    END IF;
    v_prev := r.row_hash; v_expect := r.seq + 1;
  END LOOP;
  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::text;
END $$;

-- =============================================================
-- 5. ENABLEMENT + ENGINE-FACING RPCs (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_action_enabled_for(p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.flag_evaluate('agent_action_framework', p_owner), false)
     AND COALESCE((SELECT s.module_entitled FROM public.agent_action_account_settings s WHERE s.user_id = p_owner), false);
$$;

CREATE OR REPLACE FUNCTION public.agent_action_load_policy(p_user uuid, p_agent text, p_tool text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_enabled boolean := public.agent_action_enabled_for(p_user);
BEGIN
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('moduleEnabled', false, 'paused', false, 'agentGrants', '{}'::jsonb, 'toolPolicy', NULL, 'limits', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'moduleEnabled', true,
    'paused', COALESCE((SELECT s.paused FROM agent_action_account_settings s WHERE s.user_id = p_user), false),
    'agentGrants', COALESCE((SELECT jsonb_object_agg(g.scope, g.autonomy) FROM agent_scope_grants g WHERE g.user_id = p_user AND g.agent_id = p_agent), '{}'::jsonb),
    'toolPolicy', (SELECT jsonb_build_object('enabled', t.enabled, 'autonomy', t.autonomy) FROM agent_action_tool_policy t WHERE t.user_id = p_user AND t.tool_slug = p_tool),
    'limits', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'kind', l.kind, 'agentId', l.agent_id, 'toolSlug', l.tool_slug, 'windowSec', l.window_sec, 'max', l.max_value,
        'onExceed', l.on_exceed, 'days', to_jsonb(l.tw_days), 'startMin', l.tw_start_min, 'endMin', l.tw_end_min, 'tz', l.tw_tz))
      FROM agent_action_limits l WHERE l.user_id = p_user), '[]'::jsonb));
END $$;

-- Atomic per (tenant, kind): sum usage in each window, record only if every ENFORCED check passes.
-- p_honor_soft=false ignores 'approval' checks (a human already approved) but still records the usage.
CREATE OR REPLACE FUNCTION public.agent_action_usage_reserve(
  p_user uuid, p_request uuid, p_agent text, p_tool text, p_kind text, p_amount numeric, p_checks jsonb, p_honor_soft boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c jsonb; v_used numeric; v_soft boolean := false; v_on text;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 OR jsonb_typeof(p_checks) <> 'array' THEN
    RAISE EXCEPTION 'invalid reservation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_action_usage:' || p_user::text || ':' || p_kind, 0));
  FOR c IN SELECT * FROM jsonb_array_elements(p_checks) LOOP
    SELECT COALESCE(SUM(u.amount), 0) INTO v_used FROM agent_action_usage u
     WHERE u.user_id = p_user AND u.kind = p_kind AND u.released_at IS NULL
       AND u.created_at > now() - make_interval(secs => (c ->> 'windowSec')::int)
       AND ((c ->> 'agentId') IS NULL OR u.agent_id = c ->> 'agentId')
       AND ((c ->> 'toolSlug') IS NULL OR u.tool_slug = c ->> 'toolSlug');
    IF v_used + p_amount > (c ->> 'cap')::numeric THEN
      v_on := COALESCE(c ->> 'onExceed', 'block');
      IF v_on = 'block' THEN RETURN jsonb_build_object('ok', false, 'onExceed', 'block'); END IF;
      IF p_honor_soft THEN v_soft := true; END IF;
    END IF;
  END LOOP;
  IF v_soft THEN RETURN jsonb_build_object('ok', false, 'onExceed', 'approval'); END IF;
  INSERT INTO agent_action_usage (user_id, request_id, agent_id, tool_slug, kind, amount) VALUES (p_user, p_request, p_agent, p_tool, p_kind, p_amount);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_usage_release(p_user uuid, p_request uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE agent_action_usage SET released_at = now() WHERE user_id = p_user AND request_id = p_request AND kind <> 'rate_calls' AND released_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.agent_action_expire_stale()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE agent_action_requests SET status = 'expired', last_actor = 'system'
   WHERE status IN ('pending_approval', 'suggested') AND expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Retention: usage rows > 35 days, and raw preview/undo of terminal requests > 30 days. Schedule it (pg_cron or an
-- existing cron edge function) - scheduling is NOT done here.
CREATE OR REPLACE FUNCTION public.agent_action_prune()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM agent_action_usage WHERE created_at < now() - interval '35 days';
  PERFORM set_config('app.agent_action_maintenance', 'on', true);
  UPDATE agent_action_requests SET preview = NULL, undo = NULL, undo_until = NULL
   WHERE status IN ('executed', 'failed', 'rejected', 'blocked', 'expired', 'undone')
     AND updated_at < now() - interval '30 days' AND (preview IS NOT NULL OR undo IS NOT NULL);
  PERFORM set_config('app.agent_action_maintenance', 'off', true);
END $$;

-- =============================================================
-- 6. OWNER / MANAGER RPCs (authenticated; permission + tenant derived server-side)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_action_assert_manager()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not allowed to manage agent actions.' USING ERRCODE = '42501';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL OR NOT public.agent_action_enabled_for(v_owner) THEN
    RAISE EXCEPTION 'Agent actions are not enabled for this account.' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END $$;

CREATE OR REPLACE FUNCTION public.get_my_agent_action_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RETURN jsonb_build_object('enabled', false, 'paused', false, 'canManage', false); END IF;
  RETURN jsonb_build_object(
    'enabled', public.agent_action_enabled_for(v_owner),
    'paused', COALESCE((SELECT s.paused FROM agent_action_account_settings s WHERE s.user_id = v_owner), false),
    'canManage', public.can_manage_ai_security());
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_set_paused(p_paused boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager();
BEGIN
  INSERT INTO agent_action_account_settings (user_id, paused, pause_reason, paused_by, paused_at)
  VALUES (v_owner, p_paused, CASE WHEN p_paused THEN left(NULLIF(btrim(COALESCE(p_reason, '')), ''), 300) END, auth.uid(), CASE WHEN p_paused THEN now() END)
  ON CONFLICT (user_id) DO UPDATE SET paused = EXCLUDED.paused, pause_reason = EXCLUDED.pause_reason,
    paused_by = EXCLUDED.paused_by, paused_at = EXCLUDED.paused_at, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_set_grant(p_agent text, p_scope text, p_autonomy text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager(); v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM agent_scope_grants WHERE user_id = v_owner;
  IF v_n >= 500 AND NOT EXISTS (SELECT 1 FROM agent_scope_grants WHERE user_id = v_owner AND agent_id = p_agent AND scope = p_scope) THEN
    RAISE EXCEPTION 'Too many grants.' USING ERRCODE = '54000';
  END IF;
  INSERT INTO agent_scope_grants (user_id, agent_id, scope, autonomy, updated_by) VALUES (v_owner, p_agent, p_scope, p_autonomy, auth.uid())
  ON CONFLICT (user_id, agent_id, scope) DO UPDATE SET autonomy = EXCLUDED.autonomy, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_delete_grant(p_agent text, p_scope text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager();
BEGIN
  DELETE FROM agent_scope_grants WHERE user_id = v_owner AND agent_id = p_agent AND scope = p_scope;
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_set_tool_policy(p_tool text, p_enabled boolean, p_autonomy text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager();
BEGIN
  INSERT INTO agent_action_tool_policy (user_id, tool_slug, enabled, autonomy, updated_by) VALUES (v_owner, p_tool, p_enabled, p_autonomy, auth.uid())
  ON CONFLICT (user_id, tool_slug) DO UPDATE SET enabled = EXCLUDED.enabled, autonomy = EXCLUDED.autonomy, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_upsert_limit(
  p_id uuid, p_kind text, p_agent_id text, p_tool_slug text, p_window_sec integer, p_max numeric, p_on_exceed text,
  p_days integer[], p_start_min integer, p_end_min integer, p_tz text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager(); v_id uuid;
BEGIN
  IF p_kind = 'time_window' AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    RAISE EXCEPTION 'Unknown time zone.' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM agent_action_limits WHERE user_id = v_owner) >= 100 THEN RAISE EXCEPTION 'Too many limits.' USING ERRCODE = '54000'; END IF;
    INSERT INTO agent_action_limits (user_id, kind, agent_id, tool_slug, window_sec, max_value, on_exceed, tw_days, tw_start_min, tw_end_min, tw_tz, updated_by)
    VALUES (v_owner, p_kind, NULLIF(p_agent_id, ''), NULLIF(p_tool_slug, ''), p_window_sec, p_max, p_on_exceed, p_days, p_start_min, p_end_min, p_tz, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE agent_action_limits SET kind = p_kind, agent_id = NULLIF(p_agent_id, ''), tool_slug = NULLIF(p_tool_slug, ''), window_sec = p_window_sec,
      max_value = p_max, on_exceed = p_on_exceed, tw_days = p_days, tw_start_min = p_start_min, tw_end_min = p_end_min, tw_tz = p_tz, updated_by = auth.uid()
     WHERE id = p_id AND user_id = v_owner RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Limit not found.' USING ERRCODE = 'P0002'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.agent_action_delete_limit(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.agent_action_assert_manager();
BEGIN
  DELETE FROM agent_action_limits WHERE id = p_id AND user_id = v_owner;
END $$;

CREATE OR REPLACE FUNCTION public.staff_set_agent_action_entitlement(p_tenant uuid, p_entitled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  INSERT INTO agent_action_account_settings (user_id, module_entitled, entitled_by) VALUES (p_tenant, p_entitled, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET module_entitled = EXCLUDED.module_entitled, entitled_by = EXCLUDED.entitled_by, updated_at = now();
END $$;

-- =============================================================
-- 7. RLS + GRANTS (reads via RLS; every write goes through the RPCs above or the service role)
-- =============================================================
ALTER TABLE public.agent_action_account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_scope_grants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_tool_policy     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_limits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_usage           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_audit           ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.agent_action_account_settings, public.agent_scope_grants, public.agent_action_tool_policy,
  public.agent_action_limits, public.agent_action_requests, public.agent_action_usage, public.agent_action_audit FROM anon, authenticated;
GRANT ALL ON public.agent_action_account_settings, public.agent_scope_grants, public.agent_action_tool_policy,
  public.agent_action_limits, public.agent_action_requests, public.agent_action_usage, public.agent_action_audit TO service_role;
GRANT SELECT ON public.agent_action_account_settings, public.agent_scope_grants, public.agent_action_tool_policy,
  public.agent_action_limits, public.agent_action_audit TO authenticated;
-- raw payload columns (exec_payload, undo) are never readable by clients
GRANT SELECT (id, user_id, agent_id, tool_slug, tool_version, idempotency_key, status, autonomy, reason, input_hash, inputs_redacted,
  preview, outputs_redacted, undo_until, model, prompt_version, sources, decision_code, decision_detail, decided_by, expires_at,
  executed_at, error, last_actor, correlation_id, created_at, updated_at)
  ON public.agent_action_requests TO authenticated;

DROP POLICY IF EXISTS "select_own_agent_action_settings" ON public.agent_action_account_settings;
CREATE POLICY "select_own_agent_action_settings" ON public.agent_action_account_settings FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_agent_scope_grants" ON public.agent_scope_grants;
CREATE POLICY "select_own_agent_scope_grants" ON public.agent_scope_grants FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_agent_action_tool_policy" ON public.agent_action_tool_policy;
CREATE POLICY "select_own_agent_action_tool_policy" ON public.agent_action_tool_policy FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_agent_action_limits" ON public.agent_action_limits;
CREATE POLICY "select_own_agent_action_limits" ON public.agent_action_limits FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_agent_action_requests" ON public.agent_action_requests;
CREATE POLICY "select_own_agent_action_requests" ON public.agent_action_requests FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_agent_action_audit" ON public.agent_action_audit;
CREATE POLICY "select_own_agent_action_audit" ON public.agent_action_audit FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- function privileges
REVOKE ALL ON FUNCTION public.agent_action_enabled_for(uuid), public.agent_action_load_policy(uuid, text, text),
  public.agent_action_usage_reserve(uuid, uuid, text, text, text, numeric, jsonb, boolean), public.agent_action_usage_release(uuid, uuid),
  public.agent_action_expire_stale(), public.agent_action_prune(), public.agent_action_assert_manager() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_action_enabled_for(uuid), public.agent_action_load_policy(uuid, text, text),
  public.agent_action_usage_reserve(uuid, uuid, text, text, text, numeric, jsonb, boolean), public.agent_action_usage_release(uuid, uuid),
  public.agent_action_expire_stale(), public.agent_action_prune() TO service_role;

REVOKE ALL ON FUNCTION public.get_my_agent_action_state(), public.agent_action_set_paused(boolean, text), public.agent_action_set_grant(text, text, text),
  public.agent_action_delete_grant(text, text), public.agent_action_set_tool_policy(text, boolean, text),
  public.agent_action_upsert_limit(uuid, text, text, text, integer, numeric, text, integer[], integer, integer, text),
  public.agent_action_delete_limit(uuid), public.staff_set_agent_action_entitlement(uuid, boolean), public.verify_agent_action_audit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_agent_action_state(), public.agent_action_set_paused(boolean, text), public.agent_action_set_grant(text, text, text),
  public.agent_action_delete_grant(text, text), public.agent_action_set_tool_policy(text, boolean, text),
  public.agent_action_upsert_limit(uuid, text, text, text, integer, numeric, text, integer[], integer, integer, text),
  public.agent_action_delete_limit(uuid), public.staff_set_agent_action_entitlement(uuid, boolean), public.verify_agent_action_audit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_agent_action_audit(uuid) TO service_role;
