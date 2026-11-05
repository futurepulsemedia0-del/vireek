-- =============================================================================
-- Voice observability: per-call trace + compact timeline, live tool/provider events,
-- real-traffic SLI metrics for alerting/dashboards, alert state, an IMMUTABLE inspector
-- audit log, and a bridge that turns detected bad calls into the existing AI Quality queue.
--
-- Depends on: public.synthetic_is_operator(), public.is_vireek_staff(uuid) (20271102000000 / 20260913020000),
--             public.synthetic_open_incident / synthetic_resolve_incident (status page),
--             public.ai_quality_reviews / ai_quality_findings (20271102000000_ai_quality_center.sql),
--             public.webhook_logs, public.calls.
--
-- Privacy: NOTHING here stores transcript text, audio, names, phone numbers or e-mails. The timeline
-- holds numbers, ids, provider names and templated flag titles only.
-- Access: every table is RLS-enabled with NO policy => browsers get nothing. Staff read through
-- SECURITY DEFINER RPCs that re-check profiles.is_staff; the service role writes.
--
-- Rollback (manual, in this order):
--   select cron.unschedule('vireek-obs-purge');  -- if scheduled
--   drop function public.enqueue_call_quality_flags(uuid, uuid, jsonb); drop function public.obs_purge(integer, integer, integer);
--   drop function public.obs_voice_metrics(integer); drop function public.obs_sli_counts(integer[]); drop function public.obs_voice_dashboard(integer, text);
--   drop function public.inspector_search_calls(text, text, integer, text); drop function public.inspector_get_call(text, text);
--   drop function public.inspector_log_access(text, text, text, uuid); drop function public.inspector_recent_audit(integer);
--   drop function public.obs_assert_inspector(); drop table public.call_inspector_audit, public.observability_maintenance,
--     public.observability_alert_log, public.observability_alert_state, public.call_trace_events, public.call_traces;
--   -- and restore ai_quality_findings_kind_check to the original 6 kinds (see section 7).
-- =============================================================================

-- 1) Per-call trace (one row per Vapi call) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.call_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL CHECK (char_length(vapi_call_id) BETWEEN 1 AND 128),
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  region text CHECK (region IS NULL OR char_length(region) <= 40),
  dial_code text CHECK (dial_code IS NULL OR dial_code ~ '^(\+[0-9]{1,3}|unknown)$'),
  asr_provider text CHECK (asr_provider IS NULL OR char_length(asr_provider) <= 40),
  llm_provider text CHECK (llm_provider IS NULL OR char_length(llm_provider) <= 40),
  tts_provider text CHECK (tts_provider IS NULL OR char_length(tts_provider) <= 40),
  telephony_provider text CHECK (telephony_provider IS NULL OR char_length(telephony_provider) <= 40),
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ended_reason text CHECK (ended_reason IS NULL OR char_length(ended_reason) <= 80),
  answered boolean NOT NULL DEFAULT false,
  completed boolean,
  booking_attempted boolean NOT NULL DEFAULT false,
  booked boolean NOT NULL DEFAULT false,
  turn_ms integer[] NOT NULL DEFAULT '{}',
  turn_count integer NOT NULL DEFAULT 0,
  turn_p50_ms integer, turn_p95_ms integer, turn_p99_ms integer, turn_max_ms integer,
  ttfw_ms integer,
  llm_ttfb_p95_ms integer, tts_ttfb_p95_ms integer, asr_p95_ms integer,
  asr_conf_avg numeric(4, 3) CHECK (asr_conf_avg IS NULL OR (asr_conf_avg >= 0 AND asr_conf_avg <= 1)),
  interruptions integer NOT NULL DEFAULT 0,
  tool_total integer NOT NULL DEFAULT 0,
  tool_failed integer NOT NULL DEFAULT 0,
  tool_retried integer NOT NULL DEFAULT 0,
  jitter_ms numeric(8, 2), packet_loss_pct numeric(5, 2), mos numeric(3, 2),
  flags text[] NOT NULL DEFAULT '{}',
  is_synthetic boolean NOT NULL DEFAULT false,
  timeline jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(timeline) <= 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, vapi_call_id)
);
CREATE INDEX IF NOT EXISTS idx_call_traces_created ON public.call_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_traces_vapi ON public.call_traces (vapi_call_id);
CREATE INDEX IF NOT EXISTS idx_call_traces_trace ON public.call_traces (trace_id);
CREATE INDEX IF NOT EXISTS idx_call_traces_region_created ON public.call_traces (region, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_traces_flagged ON public.call_traces (created_at DESC) WHERE cardinality(flags) > 0;
ALTER TABLE public.call_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_traces FROM PUBLIC, anon, authenticated;

-- 2) Live events written during the call (tool calls, notifications, CRM) ---------------------
CREATE TABLE IF NOT EXISTS public.call_trace_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  vapi_call_id text NOT NULL CHECK (char_length(vapi_call_id) BETWEEN 1 AND 128),
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  kind text NOT NULL CHECK (kind IN ('lifecycle', 'tool', 'provider', 'notify', 'crm')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  tool_call_id text CHECK (tool_call_id IS NULL OR char_length(tool_call_id) <= 128),
  ok boolean,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(attrs) <= 2048),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cte_call ON public.call_trace_events (vapi_call_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cte_occurred ON public.call_trace_events (occurred_at);
ALTER TABLE public.call_trace_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_trace_events FROM PUBLIC, anon, authenticated;

-- 3) Alert state, alert log (also the page budget counter), maintenance windows ---------------
CREATE TABLE IF NOT EXISTS public.observability_alert_state (
  fingerprint text PRIMARY KEY CHECK (char_length(fingerprint) <= 200),
  rule_key text NOT NULL,
  scope_key text NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.observability_alert_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trigger', 'resolve', 'digest')),
  severity text NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  channel text NOT NULL CHECK (channel IN ('pagerduty', 'slack', 'ticket', 'status')),
  delivered boolean NOT NULL,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oal_created ON public.observability_alert_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oal_channel_created ON public.observability_alert_log (channel, created_at DESC);
CREATE TABLE IF NOT EXISTS public.observability_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL DEFAULT '*',
  rule_key text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '24 hours'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.observability_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observability_alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observability_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.observability_alert_state, public.observability_alert_log, public.observability_maintenance FROM PUBLIC, anon, authenticated;

-- 4) Inspector audit log: append-only (UPDATE/DELETE blocked even for the service role) --------
CREATE TABLE IF NOT EXISTS public.call_inspector_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('search', 'view', 'transcript', 'replay')),
  vapi_call_id text,
  target_user_id uuid,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cia_created ON public.call_inspector_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cia_actor ON public.call_inspector_audit (actor_id, created_at DESC);
ALTER TABLE public.call_inspector_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_inspector_audit FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.call_inspector_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'call_inspector_audit is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_call_inspector_audit_immutable ON public.call_inspector_audit;
CREATE TRIGGER trg_call_inspector_audit_immutable
  BEFORE UPDATE OR DELETE ON public.call_inspector_audit
  FOR EACH ROW EXECUTE FUNCTION public.call_inspector_audit_immutable();

-- 5) Inspector RPCs (staff only; every read is audited BEFORE data is returned) ----------------
CREATE OR REPLACE FUNCTION public.obs_assert_inspector()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT coalesce(public.is_vireek_staff(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;
REVOKE ALL ON FUNCTION public.obs_assert_inspector() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obs_assert_inspector() TO authenticated;

CREATE OR REPLACE FUNCTION public.inspector_log_access(p_action text, p_vapi_call_id text, p_reason text, p_target_user_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := public.obs_assert_inspector();
BEGIN
  IF p_action NOT IN ('search', 'view', 'transcript', 'replay') THEN
    RAISE EXCEPTION 'invalid action' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.call_inspector_audit (actor_id, action, vapi_call_id, target_user_id, reason)
  VALUES (v_uid, p_action, left(p_vapi_call_id, 128), p_target_user_id, left(btrim(p_reason), 500));
END;
$$;
REVOKE ALL ON FUNCTION public.inspector_log_access(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspector_log_access(text, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.inspector_search_calls(p_query text DEFAULT NULL, p_reason text DEFAULT NULL, p_limit integer DEFAULT 25, p_filter text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_out jsonb;
BEGIN
  PERFORM public.inspector_log_access('search', v_q, p_reason, NULL);
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_out FROM (
    SELECT t.vapi_call_id, t.trace_id, t.region, t.created_at, t.duration_ms, t.ended_reason, t.answered, t.completed,
           t.turn_p95_ms, t.ttfw_ms, t.tool_failed, t.flags, t.is_synthetic
      FROM public.call_traces t
     WHERE (v_q IS NULL OR t.vapi_call_id = v_q OR t.trace_id = lower(v_q))
       AND (p_filter = 'all'
            OR (p_filter = 'flagged' AND cardinality(t.flags) > 0)
            OR (p_filter = 'failed' AND (t.completed IS FALSE OR t.tool_failed > 0))
            OR (p_filter = 'slow' AND coalesce(t.turn_p95_ms, 0) > 3000))
     ORDER BY t.created_at DESC
     LIMIT v_limit
  ) x;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.inspector_search_calls(text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspector_search_calls(text, text, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.inspector_get_call(p_vapi_call_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_trace public.call_traces%ROWTYPE;
  v_events jsonb;
  v_findings jsonb;
BEGIN
  SELECT * INTO v_trace FROM public.call_traces t WHERE t.vapi_call_id = p_vapi_call_id ORDER BY t.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM public.inspector_log_access('view', p_vapi_call_id, p_reason, NULL);
    RETURN NULL;
  END IF;
  PERFORM public.inspector_log_access('view', p_vapi_call_id, p_reason, v_trace.user_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.occurred_at, 'kind', e.kind, 'name', e.name, 'ok', e.ok, 'ms', e.duration_ms,
           'tool_call_id', e.tool_call_id, 'attrs', e.attrs) ORDER BY e.occurred_at), '[]'::jsonb)
    INTO v_events FROM public.call_trace_events e WHERE e.vapi_call_id = p_vapi_call_id AND e.user_id = v_trace.user_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', f.kind, 'severity', f.severity, 'title', f.title, 'detail', f.detail,
           'turn_index', f.turn_index, 'status', f.status) ORDER BY f.created_at), '[]'::jsonb)
    INTO v_findings FROM public.ai_quality_findings f
   WHERE f.user_id = v_trace.user_id AND f.call_id IN (SELECT c.id FROM public.calls c WHERE c.user_id = v_trace.user_id AND c.vapi_call_id = p_vapi_call_id);
  RETURN jsonb_build_object(
    'tenant_id', v_trace.user_id, 'trace_id', v_trace.trace_id, 'vapi_call_id', v_trace.vapi_call_id, 'region', v_trace.region,
    'providers', jsonb_build_object('asr', v_trace.asr_provider, 'llm', v_trace.llm_provider, 'tts', v_trace.tts_provider, 'telephony', v_trace.telephony_provider),
    'started_at', v_trace.started_at, 'ended_at', v_trace.ended_at, 'duration_ms', v_trace.duration_ms, 'ended_reason', v_trace.ended_reason,
    'flags', to_jsonb(v_trace.flags), 'timeline', v_trace.timeline, 'events', v_events, 'quality_findings', v_findings);
END;
$$;
REVOKE ALL ON FUNCTION public.inspector_get_call(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspector_get_call(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.inspector_recent_audit(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.obs_assert_inspector();
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC) FROM (
    SELECT id, actor_id, action, vapi_call_id, reason, created_at FROM public.call_inspector_audit
     ORDER BY created_at DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200))) a), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.inspector_recent_audit(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspector_recent_audit(integer) TO authenticated;

-- 6) Metrics for alert rules (long format: metric, scope_key, value, samples) and the dashboard ----
-- Scope keys: 'global', each region, and '<kind>:<provider>' for provider_error_rate.
CREATE OR REPLACE FUNCTION public.obs_voice_metrics(p_window_minutes integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
  v_out jsonb;
BEGIN
  IF NOT public.synthetic_is_operator() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  v_since := now() - make_interval(mins => greatest(1, least(coalesce(p_window_minutes, 15), 1440)));
  WITH c AS (
    SELECT t.*, s.scope
      FROM public.call_traces t
      CROSS JOIN LATERAL (VALUES ('global'::text), (coalesce(t.region, 'unknown'))) AS s(scope)
     WHERE coalesce(t.started_at, t.created_at) >= v_since AND NOT t.is_synthetic
  ),
  m AS (
    SELECT 'answer_rate'::text AS metric, scope AS scope_key, avg(answered::int)::float8 AS value, count(*) AS samples FROM c GROUP BY scope
    UNION ALL
    SELECT 'call_completion_rate', scope, avg(completed::int)::float8, count(*) FROM c WHERE answered AND completed IS NOT NULL GROUP BY scope
    UNION ALL
    SELECT 'booking_success_rate', scope, avg(booked::int)::float8, count(*) FROM c WHERE booking_attempted GROUP BY scope
    UNION ALL
    SELECT 'tool_failure_rate', scope, (sum(tool_failed)::float8 / nullif(sum(tool_total), 0)), coalesce(sum(tool_total), 0)::bigint FROM c GROUP BY scope HAVING sum(tool_total) > 0
    UNION ALL
    SELECT 'asr_confidence_avg', scope, avg(asr_conf_avg)::float8, count(*) FROM c WHERE asr_conf_avg IS NOT NULL GROUP BY scope
    UNION ALL
    SELECT 'time_to_first_word_p95_ms', scope, percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfw_ms), count(*) FROM c WHERE ttfw_ms IS NOT NULL GROUP BY scope
    UNION ALL
    SELECT 'turn_latency_p95_ms', c.scope, percentile_cont(0.95) WITHIN GROUP (ORDER BY x.ms), count(*)
      FROM c CROSS JOIN LATERAL unnest(c.turn_ms) AS x(ms) GROUP BY c.scope
    UNION ALL
    SELECT 'provider_error_rate', p.kind || ':' || p.name,
           avg((c.completed IS FALSE AND c.ended_reason ILIKE '%' || p.name || '%')::int)::float8, count(*)
      FROM c CROSS JOIN LATERAL (VALUES ('asr', c.asr_provider), ('llm', c.llm_provider), ('tts', c.tts_provider), ('telephony', c.telephony_provider)) AS p(kind, name)
     WHERE c.scope = 'global' AND p.name IS NOT NULL GROUP BY p.kind, p.name
    UNION ALL
    SELECT 'webhook_error_rate', 'global', avg((w.status = 'error')::int)::float8, count(*)
      FROM public.webhook_logs w WHERE w.direction = 'incoming' AND w.created_at >= v_since HAVING count(*) > 0
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('metric', m.metric, 'scope_key', m.scope_key, 'value', m.value, 'samples', m.samples)), '[]'::jsonb)
    INTO v_out FROM m;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.obs_voice_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obs_voice_metrics(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obs_voice_dashboard(p_hours integer DEFAULT 24, p_group text DEFAULT 'region')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
  v_out jsonb;
BEGIN
  IF NOT public.synthetic_is_operator() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_group NOT IN ('all', 'region', 'dial', 'asr', 'llm', 'tts', 'telephony') THEN RAISE EXCEPTION 'invalid group' USING ERRCODE = '22023'; END IF;
  v_since := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
  WITH c AS (
    SELECT t.*, CASE p_group
             WHEN 'region' THEN coalesce(t.region, 'unknown') WHEN 'dial' THEN coalesce(t.dial_code, 'unknown') WHEN 'asr' THEN coalesce(t.asr_provider, 'unknown')
             WHEN 'llm' THEN coalesce(t.llm_provider, 'unknown') WHEN 'tts' THEN coalesce(t.tts_provider, 'unknown')
             WHEN 'telephony' THEN coalesce(t.telephony_provider, 'unknown') ELSE 'all' END AS g
      FROM public.call_traces t
     WHERE coalesce(t.started_at, t.created_at) >= v_since AND NOT t.is_synthetic
  ),
  a AS (
    SELECT g, count(*) AS calls,
           avg(answered::int) AS answer_rate,
           avg(completed::int) FILTER (WHERE answered AND completed IS NOT NULL) AS completion_rate,
           avg(booked::int) FILTER (WHERE booking_attempted) AS booking_success_rate,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfw_ms) FILTER (WHERE ttfw_ms IS NOT NULL) AS ttfw_p50_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfw_ms) FILTER (WHERE ttfw_ms IS NOT NULL) AS ttfw_p95_ms,
           sum(tool_failed)::float8 / nullif(sum(tool_total), 0) AS tool_failure_rate,
           avg(asr_conf_avg) AS asr_confidence_avg,
           avg(interruptions) AS interruptions_per_call,
           count(*) FILTER (WHERE cardinality(flags) > 0) AS flagged_calls
      FROM c GROUP BY g
  ),
  t AS (
    SELECT c.g, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.ms) AS turn_p50_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY x.ms) AS turn_p95_ms,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY x.ms) AS turn_p99_ms
      FROM c CROSS JOIN LATERAL unnest(c.turn_ms) AS x(ms) GROUP BY c.g
  )
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.calls DESC), '[]'::jsonb) INTO v_out FROM (
    SELECT a.*, t.turn_p50_ms, t.turn_p95_ms, t.turn_p99_ms FROM a LEFT JOIN t ON t.g = a.g
  ) r;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.obs_voice_dashboard(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obs_voice_dashboard(integer, text) TO authenticated, service_role;


-- 6b) Good/total counts per window for burn-rate SLOs on REAL traffic (same shape idea as slo_multi_window_counts).
CREATE OR REPLACE FUNCTION public.obs_sli_counts(p_windows integer[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_out jsonb;
BEGIN
  IF NOT public.synthetic_is_operator() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_windows IS NULL OR cardinality(p_windows) = 0 OR cardinality(p_windows) > 8 THEN
    RAISE EXCEPTION 'p_windows must contain 1 to 8 windows' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('window_minutes', w.m, 'sli', s.sli, 'good', s.good, 'total', s.total)), '[]'::jsonb)
    INTO v_out
    FROM (SELECT DISTINCT greatest(1, least(x, 1440)) AS m FROM unnest(p_windows) AS x) w
    CROSS JOIN LATERAL (
      SELECT 'answer'::text AS sli, count(*) FILTER (WHERE t.answered) AS good, count(*) AS total
        FROM public.call_traces t
       WHERE NOT t.is_synthetic AND coalesce(t.started_at, t.created_at) >= now() - make_interval(mins => w.m)
      UNION ALL
      SELECT 'booking', count(*) FILTER (WHERE t.booked), count(*)
        FROM public.call_traces t
       WHERE NOT t.is_synthetic AND t.booking_attempted AND coalesce(t.started_at, t.created_at) >= now() - make_interval(mins => w.m)
    ) s;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.obs_sli_counts(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obs_sli_counts(integer[]) TO authenticated, service_role;

-- 7) Bad calls -> the EXISTING AI Quality queue ------------------------------------------------
-- Widen the finding kinds. Constraint name is looked up (it was auto-named) and replaced idempotently.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'public.ai_quality_findings'::regclass AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%hallucination%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_quality_findings DROP CONSTRAINT %I', v_name);
  END LOOP;
  ALTER TABLE public.ai_quality_findings ADD CONSTRAINT ai_quality_findings_kind_check CHECK (kind IN
    ('hallucination', 'price_error', 'missed_booking', 'missed_upsell', 'compliance_miss', 'knowledge_gap',
     'long_silence', 'repeated_ask', 'abrupt_hangup', 'low_asr_confidence', 'slow_response', 'tool_failure'));
END;
$$;

-- Service role only. Creates a placeholder review (quality_version = 0) when none exists so findings have a parent;
-- the real reviewer overwrites it (upsert on call_id) and call-quality-review treats version 0 as "not reviewed yet".
CREATE OR REPLACE FUNCTION public.enqueue_call_quality_flags(p_user_id uuid, p_call_id uuid, p_flags jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_call_at timestamptz;
  v_review_id uuid;
  v_inserted integer := 0;
  v_flag jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_flags) IS DISTINCT FROM 'array' OR jsonb_array_length(p_flags) = 0 THEN RETURN 0; END IF;
  SELECT c.call_datetime INTO v_call_at FROM public.calls c WHERE c.id = p_call_id AND c.user_id = p_user_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  INSERT INTO public.ai_quality_reviews (user_id, call_id, call_at, ai_status, quality_version)
  VALUES (p_user_id, p_call_id, v_call_at, 'skipped', 0)
  ON CONFLICT (call_id) DO NOTHING;
  SELECT r.id INTO v_review_id FROM public.ai_quality_reviews r WHERE r.call_id = p_call_id AND r.user_id = p_user_id;
  IF v_review_id IS NULL THEN RETURN 0; END IF;

  FOR v_flag IN SELECT * FROM jsonb_array_elements(p_flags) LOOP
    IF v_flag->>'kind' NOT IN ('long_silence', 'repeated_ask', 'abrupt_hangup', 'low_asr_confidence', 'slow_response', 'tool_failure') THEN CONTINUE; END IF;
    INSERT INTO public.ai_quality_findings (user_id, review_id, call_id, kind, severity, title, detail, turn_index, fingerprint)
    VALUES (p_user_id, v_review_id, p_call_id, v_flag->>'kind',
            CASE WHEN v_flag->>'severity' IN ('low', 'medium', 'high', 'critical') THEN v_flag->>'severity' ELSE 'medium' END,
            left(coalesce(v_flag->>'title', 'Flagged call'), 160), left(coalesce(v_flag->>'detail', ''), 600),
            CASE WHEN (v_flag->>'turn_index') ~ '^[0-9]{1,6}$' THEN (v_flag->>'turn_index')::integer END,
            left(coalesce(v_flag->>'fingerprint', v_flag->>'kind'), 200))
    ON CONFLICT (call_id, fingerprint) DO NOTHING;
    IF FOUND THEN v_inserted := v_inserted + 1; END IF;
  END LOOP;
  RETURN v_inserted;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_call_quality_flags(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_call_quality_flags(uuid, uuid, jsonb) TO service_role;

-- 8) Cost-aware retention ------------------------------------------------------------------------
--   live events: 14 days | timelines of healthy calls: cleared after 30 days (numbers stay) | flagged timelines: 90 days
--   call_traces numeric rows: 400 days | alert log: 180 days | audit log: never deleted (immutable).
CREATE OR REPLACE FUNCTION public.obs_purge(p_events_days integer DEFAULT 14, p_timeline_days integer DEFAULT 30, p_flagged_days integer DEFAULT 90)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_events bigint; v_timelines bigint; v_traces bigint; v_alerts bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.call_trace_events WHERE occurred_at < now() - make_interval(days => greatest(1, p_events_days));
  GET DIAGNOSTICS v_events = ROW_COUNT;
  UPDATE public.call_traces SET timeline = '{}'::jsonb
   WHERE timeline <> '{}'::jsonb
     AND ((cardinality(flags) = 0 AND created_at < now() - make_interval(days => greatest(1, p_timeline_days)))
          OR created_at < now() - make_interval(days => greatest(1, p_flagged_days)));
  GET DIAGNOSTICS v_timelines = ROW_COUNT;
  DELETE FROM public.call_traces WHERE created_at < now() - interval '400 days';
  GET DIAGNOSTICS v_traces = ROW_COUNT;
  DELETE FROM public.observability_alert_log WHERE created_at < now() - interval '180 days';
  GET DIAGNOSTICS v_alerts = ROW_COUNT;
  RETURN jsonb_build_object('events', v_events, 'timelines_cleared', v_timelines, 'traces', v_traces, 'alert_log', v_alerts);
END;
$$;
REVOKE ALL ON FUNCTION public.obs_purge(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.obs_purge(integer, integer, integer) TO service_role;

-- 8b) Cron bridge: identical to the original (20271102000000) with ONE more allowed function.
CREATE OR REPLACE FUNCTION public.synthetic_cron_tick(p_function text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_secret text;
BEGIN
  IF p_function NOT IN ('synthetic-probe', 'slo-evaluate', 'observability-alerts') THEN
    RAISE EXCEPTION 'function % is not allowed', p_function USING ERRCODE = '22023';
  END IF;

  v_base := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF coalesce(v_base, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_base || '/' || p_function,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
    body := p_body
  );
END;
$$;
REVOKE ALL ON FUNCTION public.synthetic_cron_tick(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.synthetic_cron_tick(text, jsonb) TO service_role;

-- 9) Schedules (skipped with a NOTICE when pg_cron is absent; see docs/runbooks/voice-observability.md) --
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-obs-alerts', '*/2 * * * *', $c$select public.synthetic_cron_tick('observability-alerts', '{}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-obs-purge', '20 3 * * *', $c$select public.obs_purge(14, 30, 90)$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: schedule observability-alerts (every 2 min) and obs_purge (daily) manually';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'could not schedule observability jobs: %', SQLERRM;
END;
$$;
