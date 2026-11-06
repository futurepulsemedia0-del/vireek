/*
  # Release safety, part 2 (expand-only, additive)

  1. Two-person guard: INCREASING exposure of a high/critical flag needs a second staff approver
     (trigger on feature_flags + request/decide RPCs). Reductions (off / lower %) are always one click.
  2. Staged rollouts: release_rollouts + release_health_samples. Canary = a feature flag (ON = new code path).
     Auto-rollback sets the flag off; advancing a stage needs a fresh "promote" decision (health gate).
  3. staff_flag_impact(): impact preview before a toggle.
  4. AI prompt/route versions: draft -> shadow (sampled, no customer impact) -> active, promotion gated by
     shadow + eval thresholds, instant rollback. No customer content is stored (metrics only).
  5. Mobile: staged "update available" prompt, OTA compatibility field, two-person min-version raises.

  Depends on 20280501000000_release_safety_core.sql (kill_switches, release_change_requests).
  Old clients keep working: get_app_release_policy() is untouched; a v2 RPC is added beside it.
*/
-- rollback: DROP the tables/functions created here (release_rollouts, release_health_samples, ai_release_versions,
-- ai_shadow_results, ai_release_audit, the staff_*/release_*/ai_* functions, get_app_release_policy_v2, trigger
-- trg_feature_flags_guard_high_risk) and the two app_release_policy columns. Nothing existing is modified.

-- =============================================================
-- 1. HIGH-RISK FLAG GUARD
-- =============================================================
CREATE OR REPLACE FUNCTION public.release_is_high_risk(p_risk text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(p_risk, 'low') IN ('high', 'critical');
$$;

CREATE OR REPLACE FUNCTION public.release_risk_rank(p_risk text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_risk WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END;
$$;

-- Applies only to signed-in callers (auth.uid() not null). Service role, migrations and the SQL editor pass.
CREATE OR REPLACE FUNCTION public.feature_flags_guard_high_risk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_increase boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.release_change_approved', true) = NEW.key THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF public.release_is_high_risk(NEW.risk) AND (NEW.enabled OR NEW.rollout_pct > 0) THEN
      RAISE EXCEPTION 'A new % flag must be created switched off; enabling it needs a second approver', NEW.risk USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public.release_is_high_risk(OLD.risk) AND NOT public.release_is_high_risk(NEW.risk) THEN
    RETURN NEW;
  END IF;

  v_increase :=
       (NEW.enabled AND NOT OLD.enabled)
    OR (NEW.enabled AND NEW.rollout_pct > OLD.rollout_pct)
    OR (NEW.enabled AND NEW.targeting IS DISTINCT FROM OLD.targeting)
    OR (public.release_risk_rank(NEW.risk) < public.release_risk_rank(OLD.risk));

  IF v_increase THEN
    RAISE EXCEPTION 'Increasing exposure of a % flag needs a second approver (use the change request flow)', OLD.risk USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flags_guard_high_risk ON feature_flags;
CREATE TRIGGER trg_feature_flags_guard_high_risk BEFORE INSERT OR UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.feature_flags_guard_high_risk();

-- =============================================================
-- 2. ROLLOUTS + HEALTH
-- =============================================================
CREATE TABLE IF NOT EXISTS release_rollouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE RESTRICT,
  component text NOT NULL CHECK (component IN ('edge_function', 'web', 'ai_route', 'other')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  stage_pct integer NOT NULL DEFAULT 0 CHECK (stage_pct IN (0, 1, 5, 25, 50, 100)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rolled_back', 'completed')),
  slo jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(slo) = 'object'),
  breach_count integer NOT NULL DEFAULT 0 CHECK (breach_count >= 0),
  last_decision text CHECK (last_decision IN ('promote', 'hold', 'rollback')),
  last_decision_at timestamptz,
  last_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  rollback_reason text CHECK (rollback_reason IS NULL OR char_length(rollback_reason) <= 500),
  stage_started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid DEFAULT auth.uid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_release_rollouts_active ON release_rollouts(flag_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS release_health_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_key text NOT NULL,
  cohort text NOT NULL CHECK (cohort IN ('canary', 'baseline')),
  requests integer NOT NULL CHECK (requests >= 0),
  errors integer NOT NULL CHECK (errors >= 0 AND errors <= requests),
  p95_ms integer CHECK (p95_ms IS NULL OR p95_ms >= 0),
  calls_offered integer NOT NULL DEFAULT 0 CHECK (calls_offered >= 0),
  calls_answered integer NOT NULL DEFAULT 0 CHECK (calls_answered >= 0 AND calls_answered <= calls_offered),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_release_health_flag_time ON release_health_samples(flag_key, created_at DESC);

ALTER TABLE release_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_health_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON release_rollouts, release_health_samples FROM anon;
REVOKE INSERT, UPDATE, DELETE ON release_rollouts, release_health_samples FROM authenticated;

DROP POLICY IF EXISTS "staff_read_release_rollouts" ON release_rollouts;
CREATE POLICY "staff_read_release_rollouts" ON release_rollouts FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_release_health_samples" ON release_health_samples;
CREATE POLICY "staff_read_release_health_samples" ON release_health_samples FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));

-- Internal: apply a stage, or open a change request when the flag is high/critical risk. Not granted to any role.
CREATE OR REPLACE FUNCTION public.release_stage_apply(p_rollout_id uuid, p_pct integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  ro release_rollouts%ROWTYPE;
  v_risk text;
  v_id uuid;
BEGIN
  SELECT * INTO ro FROM release_rollouts q WHERE q.id = p_rollout_id;
  SELECT f.risk INTO v_risk FROM feature_flags f WHERE f.key = ro.flag_key;

  IF public.release_is_high_risk(v_risk) THEN
    BEGIN
      INSERT INTO release_change_requests (kind, target_key, payload, reason, requested_by)
      VALUES ('flag_change', ro.flag_key,
              jsonb_build_object('enabled', true, 'rollout_pct', p_pct, 'rollout_id', ro.id),
              left(p_reason, 500), auth.uid())
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A change request is already pending for this flag' USING ERRCODE = '23505';
    END;
    RETURN jsonb_build_object('status', 'pending_approval', 'request_id', v_id);
  END IF;

  UPDATE feature_flags SET enabled = true, rollout_pct = p_pct WHERE feature_flags.key = ro.flag_key;
  UPDATE release_rollouts
     SET stage_pct = p_pct, breach_count = 0, last_decision = NULL, last_decision_at = NULL,
         last_reasons = '[]'::jsonb, stage_started_at = now(), updated_at = now()
   WHERE id = ro.id;
  RETURN jsonb_build_object('status', 'applied', 'stage_pct', p_pct);
END;
$$;

-- Internal: roll back = flag OFF (everyone returns to the stable path), rollout closed. Idempotent.
CREATE OR REPLACE FUNCTION public.release_do_rollback(p_flag_key text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_flag integer;
  v_ro integer;
BEGIN
  UPDATE feature_flags SET enabled = false WHERE feature_flags.key = p_flag_key AND feature_flags.enabled;
  GET DIAGNOSTICS v_flag = ROW_COUNT;
  UPDATE release_rollouts
     SET status = 'rolled_back', stage_pct = 0, rollback_reason = left(COALESCE(p_reason, 'rolled back'), 500),
         ended_at = now(), updated_at = now()
   WHERE flag_key = p_flag_key AND status = 'active';
  GET DIAGNOSTICS v_ro = ROW_COUNT;
  RETURN (v_flag + v_ro) > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_start_rollout(p_flag_key text, p_component text, p_label text, p_slo jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  f feature_flags%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_component NOT IN ('edge_function', 'web', 'ai_route', 'other') OR p_slo IS NULL OR jsonb_typeof(p_slo) <> 'object' THEN
    RAISE EXCEPTION 'Invalid component or SLO' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO f FROM feature_flags x WHERE x.key = p_flag_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag not found' USING ERRCODE = 'P0002';
  END IF;
  IF f.enabled AND f.rollout_pct > 0 THEN
    RAISE EXCEPTION 'The flag is already live; start a rollout from a flag that is off' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO release_rollouts (flag_key, component, label, slo)
    VALUES (p_flag_key, p_component, left(btrim(p_label), 120), p_slo)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This flag already has an active rollout' USING ERRCODE = '23505';
  END;
  RETURN public.release_stage_apply(v_id, 1, 'start rollout: ' || left(btrim(p_label), 100));
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_advance_rollout(p_flag_key text, p_next_pct integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  ro release_rollouts%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ro FROM release_rollouts q WHERE q.flag_key = p_flag_key AND q.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active rollout for this flag' USING ERRCODE = 'P0002';
  END IF;
  IF p_next_pct NOT IN (5, 25, 50, 100) OR p_next_pct <= ro.stage_pct THEN
    RAISE EXCEPTION 'Next stage must be one of 5, 25, 50, 100 and higher than the current stage' USING ERRCODE = '22023';
  END IF;
  IF ro.last_decision IS DISTINCT FROM 'promote' OR ro.last_decision_at IS NULL OR ro.last_decision_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'Release health gate not passed: a fresh "promote" decision (< 15 min old) is required' USING ERRCODE = 'P0001';
  END IF;
  RETURN public.release_stage_apply(ro.id, p_next_pct, 'advance to ' || p_next_pct || '%');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_complete_rollout(p_flag_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  UPDATE release_rollouts SET status = 'completed', ended_at = now(), updated_at = now()
   WHERE flag_key = p_flag_key AND status = 'active' AND stage_pct = 100;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active rollout at 100% for this flag' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_rollback_rollout(p_flag_key text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '22023';
  END IF;
  RETURN public.release_do_rollback(p_flag_key, 'manual: ' || btrim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_rollouts()
RETURNS TABLE (
  flag_key text, component text, label text, stage_pct integer, status text, breach_count integer,
  last_decision text, last_decision_at timestamptz, last_reasons jsonb, rollback_reason text,
  started_at timestamptz, ended_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.flag_key, r.component, r.label, r.stage_pct, r.status, r.breach_count, r.last_decision,
         r.last_decision_at, r.last_reasons, r.rollback_reason, r.started_at, r.ended_at
    FROM release_rollouts r
   ORDER BY (r.status = 'active') DESC, r.started_at DESC
   LIMIT 50;
END;
$$;

-- Service-role endpoints used by the release-guard edge function.
CREATE OR REPLACE FUNCTION public.release_record_health(
  p_flag_key text, p_cohort text, p_requests integer, p_errors integer, p_p95_ms integer,
  p_calls_offered integer DEFAULT 0, p_calls_answered integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO release_health_samples (flag_key, cohort, requests, errors, p95_ms, calls_offered, calls_answered)
  VALUES (p_flag_key, p_cohort, p_requests, p_errors, p_p95_ms, COALESCE(p_calls_offered, 0), COALESCE(p_calls_answered, 0));
END;
$$;

-- Aggregates the window, never reaching back before the current stage started.
CREATE OR REPLACE FUNCTION public.release_health_summary(p_flag_key text, p_minutes integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (
    SELECT GREATEST(
             now() - make_interval(mins => LEAST(GREATEST(COALESCE(p_minutes, 30), 1), 1440)),
             COALESCE((SELECT r.stage_started_at FROM release_rollouts r WHERE r.flag_key = p_flag_key AND r.status = 'active'), '-infinity'::timestamptz)
           ) AS since
  ),
  s AS (
    SELECT h.cohort,
           sum(h.requests)::bigint AS requests,
           sum(h.errors)::bigint AS errors,
           COALESCE(max(h.p95_ms), 0)::integer AS p95_ms,
           sum(h.calls_offered)::bigint AS offered,
           sum(h.calls_answered)::bigint AS answered
      FROM release_health_samples h, w
     WHERE h.flag_key = p_flag_key AND h.created_at >= w.since
     GROUP BY h.cohort
  )
  SELECT jsonb_build_object(
    'canary', COALESCE((SELECT to_jsonb(s) - 'cohort' FROM s WHERE s.cohort = 'canary'),
                       '{"requests":0,"errors":0,"p95_ms":0,"offered":0,"answered":0}'::jsonb),
    'baseline', COALESCE((SELECT to_jsonb(s) - 'cohort' FROM s WHERE s.cohort = 'baseline'),
                         '{"requests":0,"errors":0,"p95_ms":0,"offered":0,"answered":0}'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.release_active_rollouts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'flag_key', r.flag_key, 'slo', r.slo, 'breach_count', r.breach_count,
    'stage_pct', r.stage_pct, 'stage_started_at', r.stage_started_at)), '[]'::jsonb)
    FROM release_rollouts r
   WHERE r.status = 'active' AND r.stage_pct > 0;
$$;

CREATE OR REPLACE FUNCTION public.release_record_decision(p_flag_key text, p_decision text, p_breach_count integer, p_reasons jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_decision NOT IN ('promote', 'hold', 'rollback') THEN
    RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023';
  END IF;
  UPDATE release_rollouts
     SET last_decision = p_decision, last_decision_at = now(), breach_count = GREATEST(COALESCE(p_breach_count, 0), 0),
         last_reasons = COALESCE(p_reasons, '[]'::jsonb), updated_at = now()
   WHERE flag_key = p_flag_key AND status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.release_auto_rollback(p_flag_key text, p_reason text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.release_do_rollback(p_flag_key, 'auto: ' || COALESCE(p_reason, 'SLO breach'));
$$;

CREATE OR REPLACE FUNCTION public.release_prune_health_samples()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM release_health_samples WHERE created_at < now() - interval '14 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- =============================================================
-- 3. APPROVALS (flag_change, app_policy) + IMPACT PREVIEW
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_request_flag_change(p_flag_key text, p_enabled boolean, p_rollout_pct integer, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Reason must be 3-500 characters' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL OR p_rollout_pct IS NULL OR p_rollout_pct < 0 OR p_rollout_pct > 100 THEN
    RAISE EXCEPTION 'Invalid change' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.key = p_flag_key) THEN
    RAISE EXCEPTION 'Flag not found' USING ERRCODE = 'P0002';
  END IF;
  BEGIN
    INSERT INTO release_change_requests (kind, target_key, payload, reason, requested_by)
    VALUES ('flag_change', p_flag_key, jsonb_build_object('enabled', p_enabled, 'rollout_pct', p_rollout_pct), v_reason, auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A change request is already pending for this flag' USING ERRCODE = '23505';
  END;
  RETURN v_id;
END;
$$;

-- Returns 'approved' | 'rejected' | 'expired'. Approver must differ from requester; 24h expiry.
CREATE OR REPLACE FUNCTION public.staff_decide_flag_change(p_request_id uuid, p_approve boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r release_change_requests%ROWTYPE;
  v_rows integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM release_change_requests q WHERE q.id = p_request_id AND q.kind = 'flag_change' FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'Request not found or already decided' USING ERRCODE = 'P0002';
  END IF;
  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'A second person must decide this request' USING ERRCODE = '42501';
  END IF;
  IF r.requested_at < now() - interval '24 hours' THEN
    UPDATE release_change_requests SET status = 'expired', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'expired';
  END IF;
  IF NOT p_approve THEN
    UPDATE release_change_requests SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'rejected';
  END IF;

  PERFORM set_config('app.release_change_approved', r.target_key, true);
  UPDATE feature_flags
     SET enabled = (r.payload ->> 'enabled')::boolean, rollout_pct = (r.payload ->> 'rollout_pct')::integer
   WHERE feature_flags.key = r.target_key;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.release_change_approved', '', true);
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Flag no longer exists' USING ERRCODE = 'P0002';
  END IF;

  IF r.payload ? 'rollout_id' THEN
    UPDATE release_rollouts
       SET stage_pct = (r.payload ->> 'rollout_pct')::integer, breach_count = 0, last_decision = NULL,
           last_decision_at = NULL, last_reasons = '[]'::jsonb, stage_started_at = now(), updated_at = now()
     WHERE id = (r.payload ->> 'rollout_id')::uuid AND status = 'active';
  END IF;

  UPDATE release_change_requests SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
  RETURN 'approved';
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_change_requests()
RETURNS TABLE (
  id uuid, kind text, target_key text, payload jsonb, reason text, status text,
  requested_by uuid, requested_by_email text, requested_at timestamptz, decided_by_email text, decided_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.kind, r.target_key, r.payload, r.reason, r.status,
         r.requested_by, rp.email, r.requested_at, dp.email, r.decided_at
    FROM release_change_requests r
    LEFT JOIN profiles rp ON rp.id = r.requested_by
    LEFT JOIN profiles dp ON dp.id = r.decided_by
   ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
   LIMIT 50;
END;
$$;

-- Impact preview: how many tenants would see the flag after the change (respects overrides and plan targeting).
CREATE OR REPLACE FUNCTION public.staff_flag_impact(p_flag_key text, p_enabled boolean, p_rollout_pct integer)
RETURNS TABLE (current_tenants integer, next_tenants integer, newly_exposed integer, total_tenants integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_rollout_pct IS NULL OR p_rollout_pct < 0 OR p_rollout_pct > 100 OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid change' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE x.cur))::integer,
         (count(*) FILTER (WHERE x.nxt))::integer,
         (count(*) FILTER (WHERE x.nxt AND NOT x.cur))::integer,
         count(*)::integer
    FROM (
      SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p.id, f.key)
               AND (o.state = 'on' OR public.feature_flag_plan_match(f.targeting, p.plan)) AS cur,
             public.feature_flag_is_on(p_enabled, p_rollout_pct, o.state, p.id, f.key)
               AND (o.state = 'on' OR public.feature_flag_plan_match(f.targeting, p.plan)) AS nxt
        FROM profiles p
       CROSS JOIN feature_flags f
        LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p.id
       WHERE p.role = 'owner' AND f.key = p_flag_key
    ) x;
END;
$$;

-- =============================================================
-- 4. AI PROMPT / ROUTE VERSIONS + SHADOW MODE
-- =============================================================
CREATE OR REPLACE FUNCTION public.ai_release_payload_ok(p_kind text, p_payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN false
    WHEN p_kind = 'prompt' THEN
      CASE WHEN jsonb_typeof(p_payload -> 'system_suffix') = 'string'
           THEN char_length(p_payload ->> 'system_suffix') BETWEEN 1 AND 4000
           ELSE false END
    WHEN p_kind = 'route' THEN
      CASE WHEN jsonb_typeof(p_payload -> 'route') = 'array'
           THEN jsonb_array_length(p_payload -> 'route') BETWEEN 1 AND 6
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p_payload -> 'route') e
                   WHERE jsonb_typeof(e -> 'provider') IS DISTINCT FROM 'string'
                      OR jsonb_typeof(e -> 'model') IS DISTINCT FROM 'string')
           ELSE false END
    ELSE false
  END;
$$;

CREATE TABLE IF NOT EXISTS ai_release_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('prompt', 'route')),
  task_key text NOT NULL CHECK (task_key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shadow', 'active', 'retired')),
  shadow_sample_pct integer NOT NULL DEFAULT 5 CHECK (shadow_sample_pct BETWEEN 0 AND 25),
  eval_score numeric(5, 4) CHECK (eval_score IS NULL OR (eval_score >= 0 AND eval_score <= 1)),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  retired_at timestamptz,
  UNIQUE (kind, task_key, version),
  CONSTRAINT ai_release_payload_valid CHECK (public.ai_release_payload_ok(kind, payload))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_release_active ON ai_release_versions(kind, task_key) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_release_shadow ON ai_release_versions(kind, task_key) WHERE status = 'shadow';

CREATE TABLE IF NOT EXISTS ai_shadow_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('prompt', 'route')),
  task_key text NOT NULL,
  candidate_version integer NOT NULL,
  baseline_ok boolean NOT NULL,
  candidate_ok boolean NOT NULL,
  baseline_latency_ms integer CHECK (baseline_latency_ms IS NULL OR baseline_latency_ms >= 0),
  candidate_latency_ms integer CHECK (candidate_latency_ms IS NULL OR candidate_latency_ms >= 0),
  similarity numeric(5, 4) CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_shadow_lookup ON ai_shadow_results(kind, task_key, candidate_version, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_release_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  task_key text NOT NULL,
  version integer,
  action text NOT NULL CHECK (action IN ('create', 'shadow', 'promote', 'rollback', 'eval')),
  reason text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_release_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_shadow_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_release_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_release_versions, ai_shadow_results, ai_release_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON ai_release_versions, ai_shadow_results, ai_release_audit FROM authenticated;

DROP POLICY IF EXISTS "staff_read_ai_release_versions" ON ai_release_versions;
CREATE POLICY "staff_read_ai_release_versions" ON ai_release_versions FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_ai_shadow_results" ON ai_shadow_results;
CREATE POLICY "staff_read_ai_shadow_results" ON ai_shadow_results FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_ai_release_audit" ON ai_release_audit;
CREATE POLICY "staff_read_ai_release_audit" ON ai_release_audit FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));

-- Edge read: active + shadow candidate. When the 'ai_model_prompt_versions' kill switch is stopped
-- nothing is returned, so callers fall back to the code defaults (the pinned baseline).
CREATE OR REPLACE FUNCTION public.ai_resolve_versions(p_kind text, p_task_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM kill_switches k WHERE k.key = 'ai_model_prompt_versions' AND k.stopped)
      THEN jsonb_build_object('active', NULL, 'shadow', NULL, 'stopped', true)
    ELSE jsonb_build_object(
      'stopped', false,
      'active', (SELECT jsonb_build_object('version', v.version, 'payload', v.payload)
                   FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.status = 'active'),
      'shadow', (SELECT jsonb_build_object('version', v.version, 'payload', v.payload, 'sample_pct', v.shadow_sample_pct)
                   FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.status = 'shadow'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.ai_record_shadow_result(
  p_kind text, p_task_key text, p_candidate_version integer, p_baseline_ok boolean, p_candidate_ok boolean,
  p_baseline_latency_ms integer, p_candidate_latency_ms integer, p_similarity numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_release_versions v
                  WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.version = p_candidate_version AND v.status = 'shadow') THEN
    RETURN; -- candidate is no longer in shadow; drop the sample silently
  END IF;
  INSERT INTO ai_shadow_results (kind, task_key, candidate_version, baseline_ok, candidate_ok, baseline_latency_ms, candidate_latency_ms, similarity)
  VALUES (p_kind, p_task_key, p_candidate_version, p_baseline_ok, p_candidate_ok, p_baseline_latency_ms, p_candidate_latency_ms, p_similarity);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_record_eval(p_kind text, p_task_key text, p_version integer, p_score numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_release_versions SET eval_score = p_score
   WHERE kind = p_kind AND task_key = p_task_key AND version = p_version;
  IF FOUND THEN
    INSERT INTO ai_release_audit (kind, task_key, version, action, reason) VALUES (p_kind, p_task_key, p_version, 'eval', 'score ' || p_score::text);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_promotion_summary(p_kind text, p_task_key text, p_version integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'samples', count(*),
    'baseline_ok_rate', COALESCE(avg(CASE WHEN r.baseline_ok THEN 1.0 ELSE 0.0 END), 0),
    'candidate_ok_rate', COALESCE(avg(CASE WHEN r.candidate_ok THEN 1.0 ELSE 0.0 END), 0),
    'baseline_p95_ms', COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.baseline_latency_ms), 0),
    'candidate_p95_ms', COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.candidate_latency_ms), 0),
    'mean_similarity', avg(r.similarity),
    'eval_score', (SELECT v.eval_score FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.version = p_version)
  )
  FROM ai_shadow_results r
  WHERE r.kind = p_kind AND r.task_key = p_task_key AND r.candidate_version = p_version;
$$;

CREATE OR REPLACE FUNCTION public.staff_ai_create_version(p_kind text, p_task_key text, p_payload jsonb, p_notes text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_version integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF NOT public.ai_release_payload_ok(p_kind, p_payload) THEN
    RAISE EXCEPTION 'Invalid payload for kind %', p_kind USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_release:' || p_kind || ':' || p_task_key, 0));
  SELECT COALESCE(max(v.version), 0) + 1 INTO v_version FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key;
  INSERT INTO ai_release_versions (kind, task_key, version, payload, notes)
  VALUES (p_kind, p_task_key, v_version, p_payload, NULLIF(left(btrim(COALESCE(p_notes, '')), 500), ''));
  INSERT INTO ai_release_audit (kind, task_key, version, action, actor) VALUES (p_kind, p_task_key, v_version, 'create', auth.uid());
  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_ai_start_shadow(p_kind text, p_task_key text, p_version integer, p_sample_pct integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_sample_pct IS NULL OR p_sample_pct < 1 OR p_sample_pct > 25 THEN
    RAISE EXCEPTION 'Sample must be 1-25 percent' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_release:' || p_kind || ':' || p_task_key, 0));
  UPDATE ai_release_versions SET status = 'draft'
   WHERE kind = p_kind AND task_key = p_task_key AND status = 'shadow' AND version <> p_version;
  UPDATE ai_release_versions SET status = 'shadow', shadow_sample_pct = p_sample_pct
   WHERE kind = p_kind AND task_key = p_task_key AND version = p_version AND status IN ('draft', 'shadow');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found or not a draft' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO ai_release_audit (kind, task_key, version, action, actor) VALUES (p_kind, p_task_key, p_version, 'shadow', auth.uid());
END;
$$;

-- Promotion gate (authoritative thresholds): >=200 shadow samples, candidate success within 0.5 pt of baseline,
-- candidate p95 <= 1.25x baseline, mean similarity >= 0.80, eval score >= 0.90.
CREATE OR REPLACE FUNCTION public.staff_ai_promote(p_kind text, p_task_key text, p_version integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s jsonb;
  v_fail text[] := ARRAY[]::text[];
  v_base_p95 numeric;
  v_cand_p95 numeric;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_release:' || p_kind || ':' || p_task_key, 0));
  IF NOT EXISTS (SELECT 1 FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.version = p_version AND v.status = 'shadow') THEN
    RAISE EXCEPTION 'Only a version that has been in shadow can be promoted' USING ERRCODE = '22023';
  END IF;

  s := public.ai_promotion_summary(p_kind, p_task_key, p_version);
  v_base_p95 := (s ->> 'baseline_p95_ms')::numeric;
  v_cand_p95 := (s ->> 'candidate_p95_ms')::numeric;

  IF (s ->> 'samples')::integer < 200 THEN v_fail := array_append(v_fail, 'needs at least 200 shadow samples'::text); END IF;
  IF (s ->> 'candidate_ok_rate')::numeric < (s ->> 'baseline_ok_rate')::numeric - 0.005 THEN v_fail := array_append(v_fail, 'candidate success rate is below baseline'::text); END IF;
  IF v_base_p95 > 0 AND v_cand_p95 > v_base_p95 * 1.25 THEN v_fail := array_append(v_fail, 'candidate p95 latency is more than 1.25x baseline'::text); END IF;
  IF (s ->> 'mean_similarity') IS NULL OR (s ->> 'mean_similarity')::numeric < 0.80 THEN v_fail := array_append(v_fail, 'mean similarity below 0.80'::text); END IF;
  IF (s ->> 'eval_score') IS NULL OR (s ->> 'eval_score')::numeric < 0.90 THEN v_fail := array_append(v_fail, 'eval score below 0.90 (or not recorded)'::text); END IF;

  IF array_length(v_fail, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Promotion gate failed: %', array_to_string(v_fail, '; ') USING ERRCODE = 'P0001';
  END IF;

  UPDATE ai_release_versions SET status = 'retired', retired_at = now()
   WHERE kind = p_kind AND task_key = p_task_key AND status = 'active';
  UPDATE ai_release_versions SET status = 'active', promoted_at = now()
   WHERE kind = p_kind AND task_key = p_task_key AND version = p_version;
  INSERT INTO ai_release_audit (kind, task_key, version, action, reason, actor)
  VALUES (p_kind, p_task_key, p_version, 'promote', s::text, auth.uid());
END;
$$;

-- Instant rollback: re-activates the most recently promoted retired version, or (if none) retires the active
-- one so callers fall back to the code defaults.
CREATE OR REPLACE FUNCTION public.staff_ai_rollback(p_kind text, p_task_key text, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_cur integer;
  v_prev integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_release:' || p_kind || ':' || p_task_key, 0));
  SELECT v.version INTO v_cur FROM ai_release_versions v WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.status = 'active';
  IF v_cur IS NULL THEN
    RAISE EXCEPTION 'No active version to roll back' USING ERRCODE = 'P0002';
  END IF;
  SELECT v.version INTO v_prev FROM ai_release_versions v
   WHERE v.kind = p_kind AND v.task_key = p_task_key AND v.status = 'retired' AND v.promoted_at IS NOT NULL AND v.version < v_cur
   ORDER BY v.promoted_at DESC LIMIT 1;

  UPDATE ai_release_versions SET status = 'retired', retired_at = now()
   WHERE kind = p_kind AND task_key = p_task_key AND version = v_cur;
  IF v_prev IS NOT NULL THEN
    UPDATE ai_release_versions SET status = 'active', retired_at = NULL
     WHERE kind = p_kind AND task_key = p_task_key AND version = v_prev;
  END IF;
  INSERT INTO ai_release_audit (kind, task_key, version, action, reason, actor)
  VALUES (p_kind, p_task_key, v_cur, 'rollback', btrim(p_reason), auth.uid());
  RETURN v_prev; -- NULL = back to code defaults
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_ai_list_versions()
RETURNS TABLE (kind text, task_key text, version integer, status text, shadow_sample_pct integer, eval_score numeric, notes text, created_at timestamptz, promoted_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.kind, v.task_key, v.version, v.status, v.shadow_sample_pct, v.eval_score, v.notes, v.created_at, v.promoted_at
    FROM ai_release_versions v
   ORDER BY v.task_key, v.kind, v.version DESC
   LIMIT 200;
END;
$$;

-- =============================================================
-- 5. MOBILE: staged prompt, OTA compatibility, two-person min-version raise
-- =============================================================
ALTER TABLE app_release_policy
  ADD COLUMN IF NOT EXISTS rollout_pct integer NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ota_min_native_version text CHECK (ota_min_native_version IS NULL OR ota_min_native_version ~ '^[0-9]+(\.[0-9]+){0,3}$');

-- v2 sits beside get_app_release_policy() (unchanged), so installed apps keep working.
CREATE OR REPLACE FUNCTION public.get_app_release_policy_v2(p_platform text)
RETURNS TABLE (min_version text, latest_version text, store_url text, message text, rollout_pct integer, ota_min_native_version text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.min_version, p.latest_version, p.store_url, p.message, p.rollout_pct, p.ota_min_native_version
    FROM public.app_release_policy p
   WHERE p.platform = p_platform;
$$;

REVOKE ALL ON FUNCTION public.get_app_release_policy_v2(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_app_release_policy_v2(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.release_version_gt(a text, b text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT string_to_array(a, '.')::integer[] > string_to_array(b, '.')::integer[];
$$;

-- Lowering/keeping min_version (and any soft-prompt change) applies at once; RAISING min_version (which locks out
-- installed builds) opens a request that a second staff member must approve.
CREATE OR REPLACE FUNCTION public.staff_set_app_release_policy(
  p_platform text, p_min_version text, p_latest_version text, p_rollout_pct integer, p_message text, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  cur app_release_policy%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_id uuid;
  v_payload jsonb;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_min_version !~ '^[0-9]+(\.[0-9]+){0,3}$', true) OR COALESCE(p_latest_version !~ '^[0-9]+(\.[0-9]+){0,3}$', true)
     OR p_rollout_pct IS NULL OR p_rollout_pct < 0 OR p_rollout_pct > 100
     OR (p_message IS NOT NULL AND char_length(p_message) > 300)
     OR v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Invalid policy' USING ERRCODE = '22023';
  END IF;
  IF public.release_version_gt(p_min_version, p_latest_version) THEN
    RAISE EXCEPTION 'min_version cannot be higher than latest_version' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO cur FROM app_release_policy q WHERE q.platform = p_platform FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Platform not found' USING ERRCODE = 'P0002';
  END IF;

  v_payload := jsonb_build_object('min_version', p_min_version, 'latest_version', p_latest_version,
                                  'rollout_pct', p_rollout_pct, 'message', NULLIF(btrim(COALESCE(p_message, '')), ''));

  IF public.release_version_gt(p_min_version, cur.min_version) THEN
    BEGIN
      INSERT INTO release_change_requests (kind, target_key, payload, reason, requested_by)
      VALUES ('app_policy', p_platform, v_payload, v_reason, auth.uid())
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A policy change is already pending for this platform' USING ERRCODE = '23505';
    END;
    RETURN jsonb_build_object('status', 'pending_approval', 'request_id', v_id);
  END IF;

  UPDATE app_release_policy
     SET min_version = p_min_version, latest_version = p_latest_version, rollout_pct = p_rollout_pct,
         message = NULLIF(btrim(COALESCE(p_message, '')), ''), updated_at = now()
   WHERE platform = p_platform;
  RETURN jsonb_build_object('status', 'applied');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_decide_app_policy(p_request_id uuid, p_approve boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r release_change_requests%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM release_change_requests q WHERE q.id = p_request_id AND q.kind = 'app_policy' FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'Request not found or already decided' USING ERRCODE = 'P0002';
  END IF;
  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'A second person must decide this request' USING ERRCODE = '42501';
  END IF;
  IF r.requested_at < now() - interval '24 hours' THEN
    UPDATE release_change_requests SET status = 'expired', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'expired';
  END IF;
  IF NOT p_approve THEN
    UPDATE release_change_requests SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'rejected';
  END IF;

  UPDATE app_release_policy
     SET min_version = r.payload ->> 'min_version', latest_version = r.payload ->> 'latest_version',
         rollout_pct = (r.payload ->> 'rollout_pct')::integer, message = r.payload ->> 'message', updated_at = now()
   WHERE platform = r.target_key;
  UPDATE release_change_requests SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
  RETURN 'approved';
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================
-- Pure helpers: the guard trigger and the CHECK constraint run them as the calling user, so authenticated needs EXECUTE.
REVOKE ALL ON FUNCTION public.release_is_high_risk(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_risk_rank(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_version_gt(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_release_payload_ok(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_is_high_risk(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_risk_rank(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_version_gt(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_release_payload_ok(text, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_stage_apply(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_do_rollback(text, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.release_record_health(text, text, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_health_summary(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_active_rollouts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_record_decision(text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_auto_rollback(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_prune_health_samples() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_resolve_versions(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_record_shadow_result(text, text, integer, boolean, boolean, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_record_eval(text, text, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_promotion_summary(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_record_health(text, text, integer, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_health_summary(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_active_rollouts() TO service_role;
GRANT EXECUTE ON FUNCTION public.release_record_decision(text, text, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_auto_rollback(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_prune_health_samples() TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_resolve_versions(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_record_shadow_result(text, text, integer, boolean, boolean, integer, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_record_eval(text, text, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_promotion_summary(text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.staff_start_rollout(text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_advance_rollout(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_complete_rollout(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_rollback_rollout(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_rollouts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_request_flag_change(text, boolean, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_decide_flag_change(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_change_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_flag_impact(text, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_ai_create_version(text, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_ai_start_shadow(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_ai_promote(text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_ai_rollback(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_ai_list_versions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_app_release_policy(text, text, text, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_decide_app_policy(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_start_rollout(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_advance_rollout(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_complete_rollout(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_rollback_rollout(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_rollouts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_request_flag_change(text, boolean, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_decide_flag_change(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_change_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_flag_impact(text, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ai_create_version(text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ai_start_shadow(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ai_promote(text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ai_rollback(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ai_list_versions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_app_release_policy(text, text, text, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_decide_app_policy(uuid, boolean) TO authenticated;
