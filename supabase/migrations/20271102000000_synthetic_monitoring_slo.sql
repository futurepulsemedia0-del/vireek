/*
  # Synthetic monitoring + SLOs for the voice pipeline

  ## Why
  /status was hand-maintained and the Overview health strip only shows configuration state.
  Neither proves that a real caller reaches the real AI and gets a booking. This migration adds
  the storage + server-side logic for scheduled synthetic test calls through the REAL AI path:

    probe caller (Vapi) --dials--> target number --> production assistant --> vapi-webhook
         --> calls/jobs rows --> DB trigger --> dispatch-webhook --> synthetic-webhook-sink

  Per run we record five SLIs (availability, answer latency, speech-recognition accuracy,
  booking success, webhook delivery), burn error budgets against SLO definitions, open/resolve
  incidents automatically and expose a public status feed.

  ## Safety rules (enforced here, not just by convention)
  - A probe target may ONLY point at a profile flagged is_synthetic_tenant = true (trigger).
    Probes therefore never create calls/jobs in a customer account.
  - Cleanup of synthetic calls/jobs only touches is_synthetic_tenant profiles.
  - All new tables have RLS enabled and NO policies: only the service role (edge functions) writes,
    staff read through SECURITY DEFINER RPCs that re-check profiles.is_staff.
  - Probe infrastructure errors (status 'error') never count against an SLO; only product faults do.

  ## Requires (already in your project)
  profiles(id, is_staff), is_vireek_staff(uuid), auth.uid(), auth.role().
  Optional: pg_cron + pg_net (cron is skipped with a NOTICE when pg_cron is missing) and the
  database settings app.settings.edge_function_base_url / app.settings.push_dispatch_secret that
  the existing webhook triggers already use.

  ## Idempotent
  Safe to run more than once.
*/

-- =============================================================
-- 0) Synthetic-tenant flag
-- =============================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_synthetic_tenant boolean NOT NULL DEFAULT false;

-- =============================================================
-- 1) Operator helper (service role or Vireek staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.synthetic_is_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.role() = 'service_role', false)
      OR coalesce(public.is_vireek_staff(auth.uid()), false);
$$;
REVOKE ALL ON FUNCTION public.synthetic_is_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.synthetic_is_operator() TO authenticated, service_role;

-- =============================================================
-- 2) Probe targets (one row per region + number under test)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.synthetic_probe_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region text NOT NULL,
  label text NOT NULL,
  target_number text NOT NULL,
  tenant_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  probe_caller_number text NOT NULL,
  probe_phone_number_id text NOT NULL,
  probe_assistant_id text NOT NULL,
  scenario_key text NOT NULL DEFAULT 'book_hvac_repair',
  interval_minutes integer NOT NULL DEFAULT 15,
  active boolean NOT NULL DEFAULT true,
  sink_token text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spt_region_check CHECK (region ~ '^[a-z0-9-]{2,32}$'),
  CONSTRAINT spt_target_e164 CHECK (target_number ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT spt_caller_e164 CHECK (probe_caller_number ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT spt_interval_check CHECK (interval_minutes BETWEEN 5 AND 1440),
  CONSTRAINT spt_scenario_check CHECK (scenario_key ~ '^[a-z0-9_]{3,48}$'),
  CONSTRAINT spt_distinct_numbers CHECK (target_number <> probe_caller_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_spt_target_number ON public.synthetic_probe_targets (target_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_spt_tenant_caller ON public.synthetic_probe_targets (tenant_user_id, probe_caller_number);
CREATE INDEX IF NOT EXISTS idx_spt_due ON public.synthetic_probe_targets (next_run_at) WHERE active;

CREATE OR REPLACE FUNCTION public.synthetic_targets_require_synthetic_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.tenant_user_id AND p.is_synthetic_tenant) THEN
    RAISE EXCEPTION 'synthetic probe targets must point at a profile with is_synthetic_tenant = true (tenant %)', NEW.tenant_user_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_spt_require_synthetic_tenant ON public.synthetic_probe_targets;
CREATE TRIGGER trg_spt_require_synthetic_tenant
  BEFORE INSERT OR UPDATE OF tenant_user_id ON public.synthetic_probe_targets
  FOR EACH ROW EXECUTE FUNCTION public.synthetic_targets_require_synthetic_tenant();

ALTER TABLE public.synthetic_probe_targets ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 3) Probe runs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.synthetic_probe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES public.synthetic_probe_targets(id) ON DELETE CASCADE,
  region text NOT NULL,
  scenario_key text NOT NULL,
  status text NOT NULL DEFAULT 'dialing',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  vapi_call_id text,
  answered boolean,
  answer_latency_ms integer,
  asr_accuracy numeric(5, 4),
  booking_ok boolean,
  webhook_ok boolean,
  webhook_latency_ms integer,
  target_call_id uuid,
  job_id uuid,
  failure_stage text,
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  verify_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT spr_status_check CHECK (status IN ('dialing', 'verifying', 'passed', 'failed', 'error')),
  CONSTRAINT spr_stage_check CHECK (failure_stage IS NULL OR failure_stage IN ('dial', 'answer', 'speech', 'booking', 'webhook', 'probe')),
  CONSTRAINT spr_accuracy_check CHECK (asr_accuracy IS NULL OR (asr_accuracy >= 0 AND asr_accuracy <= 1))
);
CREATE INDEX IF NOT EXISTS idx_spr_target_started ON public.synthetic_probe_runs (target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_spr_started ON public.synthetic_probe_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_spr_open ON public.synthetic_probe_runs (started_at) WHERE status IN ('dialing', 'verifying');
CREATE UNIQUE INDEX IF NOT EXISTS uq_spr_vapi_call ON public.synthetic_probe_runs (vapi_call_id) WHERE vapi_call_id IS NOT NULL;

ALTER TABLE public.synthetic_probe_runs ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 4) SLI events (one row per SLI per finished run)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.synthetic_sli_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.synthetic_probe_runs(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.synthetic_probe_targets(id) ON DELETE CASCADE,
  region text NOT NULL,
  sli text NOT NULL,
  good boolean NOT NULL,
  value numeric,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sse_sli_check CHECK (sli IN ('availability', 'answer_latency', 'asr_accuracy', 'booking_success', 'webhook_delivery')),
  CONSTRAINT sse_unique_per_run UNIQUE (run_id, sli)
);
CREATE INDEX IF NOT EXISTS idx_sse_sli_time ON public.synthetic_sli_events (sli, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sse_region_sli_time ON public.synthetic_sli_events (region, sli, recorded_at DESC);

ALTER TABLE public.synthetic_sli_events ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 5) Webhook receipts (written by synthetic-webhook-sink)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.synthetic_webhook_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES public.synthetic_probe_targets(id) ON DELETE CASCADE,
  event text NOT NULL,
  record_id text,
  record_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_bytes integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_swr_lookup ON public.synthetic_webhook_receipts (target_id, event, record_id);
CREATE INDEX IF NOT EXISTS idx_swr_received ON public.synthetic_webhook_receipts (received_at);

ALTER TABLE public.synthetic_webhook_receipts ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 6) SLO definitions
-- =============================================================
CREATE TABLE IF NOT EXISTS public.slo_definitions (
  key text PRIMARY KEY,
  label text NOT NULL,
  sli text NOT NULL,
  objective numeric(7, 6) NOT NULL,
  window_days integer NOT NULL DEFAULT 30,
  region text,
  component_id text NOT NULL DEFAULT 'voice-ai',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slo_key_check CHECK (key ~ '^[a-z0-9_]{3,48}$'),
  CONSTRAINT slo_sli_check CHECK (sli IN ('availability', 'answer_latency', 'asr_accuracy', 'booking_success', 'webhook_delivery')),
  CONSTRAINT slo_objective_check CHECK (objective > 0 AND objective < 1),
  CONSTRAINT slo_window_check CHECK (window_days BETWEEN 1 AND 90)
);
ALTER TABLE public.slo_definitions ENABLE ROW LEVEL SECURITY;

INSERT INTO public.slo_definitions (key, label, sli, objective, window_days, component_id) VALUES
  ('voice_availability', 'AI answers the call', 'availability', 0.995, 30, 'voice-ai'),
  ('voice_answer_latency', 'AI speaks within the latency threshold', 'answer_latency', 0.990, 30, 'voice-ai'),
  ('voice_asr_accuracy', 'Speech recognition above the accuracy threshold', 'asr_accuracy', 0.950, 30, 'voice-ai'),
  ('voice_booking_success', 'Booking is created from the call', 'booking_success', 0.990, 30, 'crm-sync'),
  ('webhook_delivery', 'Outbound webhook delivered in time', 'webhook_delivery', 0.995, 30, 'api')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 7) Incidents (manual + synthetic) and their updates
-- =============================================================
CREATE TABLE IF NOT EXISTS public.status_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  impact text NOT NULL,
  status text NOT NULL DEFAULT 'investigating',
  component_id text NOT NULL,
  region text,
  source text NOT NULL DEFAULT 'manual',
  dedupe_key text,
  summary text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT si_impact_check CHECK (impact IN ('minor', 'major')),
  CONSTRAINT si_status_check CHECK (status IN ('investigating', 'monitoring', 'resolved')),
  CONSTRAINT si_source_check CHECK (source IN ('manual', 'synthetic'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_si_open_dedupe ON public.status_incidents (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_si_started ON public.status_incidents (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_si_open ON public.status_incidents (component_id) WHERE status <> 'resolved';

CREATE TABLE IF NOT EXISTS public.status_incident_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.status_incidents(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siu_status_check CHECK (status IN ('investigating', 'monitoring', 'resolved'))
);
CREATE INDEX IF NOT EXISTS idx_siu_incident ON public.status_incident_updates (incident_id, created_at DESC);

ALTER TABLE public.status_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_incident_updates ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 8) Server-side functions
-- =============================================================

-- 8a) Claim due targets atomically (SKIP LOCKED) and push their next_run_at.
CREATE OR REPLACE FUNCTION public.synthetic_claim_due_targets(p_limit integer DEFAULT 10)
RETURNS SETOF public.synthetic_probe_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT t.id
    FROM public.synthetic_probe_targets t
    WHERE t.active
      AND t.next_run_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.synthetic_probe_runs r
        WHERE r.target_id = t.id
          AND r.status IN ('dialing', 'verifying')
          AND r.started_at > now() - interval '20 minutes'
      )
    ORDER BY t.next_run_at
    LIMIT greatest(1, least(coalesce(p_limit, 10), 50))
    FOR UPDATE OF t SKIP LOCKED
  )
  UPDATE public.synthetic_probe_targets t
     SET next_run_at = now() + make_interval(mins => t.interval_minutes),
         updated_at = now()
    FROM due
   WHERE t.id = due.id
  RETURNING t.*;
END;
$$;
REVOKE ALL ON FUNCTION public.synthetic_claim_due_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.synthetic_claim_due_targets(integer) TO service_role;

-- 8b) Good/total counts per window / SLI / region (dashboard + burn-rate evaluator).
CREATE OR REPLACE FUNCTION public.slo_multi_window_counts(p_windows_minutes integer[])
RETURNS TABLE (window_minutes integer, sli text, region text, good bigint, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.synthetic_is_operator() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_windows_minutes IS NULL OR coalesce(array_length(p_windows_minutes, 1), 0) = 0
     OR array_length(p_windows_minutes, 1) > 8 THEN
    RAISE EXCEPTION 'p_windows_minutes must contain 1 to 8 values' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_windows_minutes) AS x(m) WHERE x.m IS NULL OR x.m < 1 OR x.m > 129600) THEN
    RAISE EXCEPTION 'each window must be between 1 and 129600 minutes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT w.m,
         e.sli,
         e.region,
         count(*) FILTER (WHERE e.good),
         count(*)
    FROM unnest(p_windows_minutes) AS w(m)
    JOIN public.synthetic_sli_events e
      ON e.recorded_at >= now() - make_interval(mins => w.m)
   GROUP BY w.m, e.sli, e.region;
END;
$$;
REVOKE ALL ON FUNCTION public.slo_multi_window_counts(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.slo_multi_window_counts(integer[]) TO authenticated, service_role;

-- 8c) Open (or escalate) an incident, deduplicated by key.
CREATE OR REPLACE FUNCTION public.synthetic_open_incident(
  p_dedupe_key text,
  p_title text,
  p_impact text,
  p_component_id text,
  p_region text,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_impact text;
BEGIN
  IF p_impact NOT IN ('minor', 'major') THEN
    RAISE EXCEPTION 'invalid impact %', p_impact USING ERRCODE = '22023';
  END IF;

  SELECT i.id, i.impact INTO v_id, v_impact
    FROM public.status_incidents i
   WHERE i.dedupe_key = p_dedupe_key AND i.status <> 'resolved'
   FOR UPDATE;

  IF FOUND THEN
    IF p_impact = 'major' AND v_impact = 'minor' THEN
      UPDATE public.status_incidents SET impact = 'major', updated_at = now() WHERE id = v_id;
      INSERT INTO public.status_incident_updates (incident_id, status, message)
      VALUES (v_id, 'investigating', 'Impact escalated: ' || p_message);
      RETURN jsonb_build_object('id', v_id, 'created', false, 'escalated', true);
    END IF;
    RETURN jsonb_build_object('id', v_id, 'created', false, 'escalated', false);
  END IF;

  BEGIN
    INSERT INTO public.status_incidents (title, impact, status, component_id, region, source, dedupe_key, summary)
    VALUES (p_title, p_impact, 'investigating', p_component_id, p_region, 'synthetic', p_dedupe_key, p_message)
    RETURNING id INTO v_id;
    INSERT INTO public.status_incident_updates (incident_id, status, message)
    VALUES (v_id, 'investigating', p_message);
    RETURN jsonb_build_object('id', v_id, 'created', true, 'escalated', false);
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent evaluator won the race: treat as already open.
    RETURN jsonb_build_object('id', NULL, 'created', false, 'escalated', false);
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.synthetic_open_incident(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.synthetic_open_incident(text, text, text, text, text, text) TO service_role;

-- 8d) Resolve an open incident by key.
CREATE OR REPLACE FUNCTION public.synthetic_resolve_incident(p_dedupe_key text, p_message text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_title text;
  v_impact text;
BEGIN
  SELECT i.id, i.title, i.impact INTO v_id, v_title, v_impact
    FROM public.status_incidents i
   WHERE i.dedupe_key = p_dedupe_key AND i.status <> 'resolved'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resolved', false);
  END IF;

  UPDATE public.status_incidents
     SET status = 'resolved', resolved_at = now(), updated_at = now()
   WHERE id = v_id;
  INSERT INTO public.status_incident_updates (incident_id, status, message)
  VALUES (v_id, 'resolved', p_message);

  RETURN jsonb_build_object('resolved', true, 'id', v_id, 'title', v_title, 'impact', v_impact);
END;
$$;
REVOKE ALL ON FUNCTION public.synthetic_resolve_incident(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.synthetic_resolve_incident(text, text) TO service_role;

-- 8e) Staff dashboard payload (numbers are masked, tokens never leave the database).
CREATE OR REPLACE FUNCTION public.staff_reliability_overview(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_since timestamptz;
BEGIN
  IF NOT public.synthetic_is_operator() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_since := now() - make_interval(days => v_days);

  RETURN jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'slos', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'key', d.key, 'label', d.label, 'sli', d.sli, 'objective', d.objective,
        'window_days', d.window_days, 'region', d.region, 'component_id', d.component_id
      ) ORDER BY d.key)
      FROM public.slo_definitions d WHERE d.active), '[]'::jsonb),
    'targets', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'region', t.region, 'label', t.label,
        'target_number_masked', '••••' || right(t.target_number, 4),
        'scenario_key', t.scenario_key, 'interval_minutes', t.interval_minutes, 'active', t.active,
        'last_run', (
          SELECT jsonb_build_object('status', r.status, 'started_at', r.started_at, 'failure_stage', r.failure_stage)
          FROM public.synthetic_probe_runs r WHERE r.target_id = t.id ORDER BY r.started_at DESC LIMIT 1)
      ) ORDER BY t.region, t.label)
      FROM public.synthetic_probe_targets t), '[]'::jsonb),
    'recent_runs', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.started_at DESC)
      FROM (
        SELECT r.id, r.region, r.status, r.started_at, r.finished_at, r.answer_latency_ms, r.asr_accuracy,
               r.booking_ok, r.webhook_ok, r.webhook_latency_ms, r.failure_stage, left(r.error, 200) AS error
          FROM public.synthetic_probe_runs r
         ORDER BY r.started_at DESC
         LIMIT 40
      ) x), '[]'::jsonb),
    'latency', coalesce((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.region)
      FROM (
        SELECT e.region,
               count(*) AS samples,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY e.value))::numeric, 0) AS p50_ms,
               round((percentile_cont(0.95) WITHIN GROUP (ORDER BY e.value))::numeric, 0) AS p95_ms
          FROM public.synthetic_sli_events e
         WHERE e.sli = 'answer_latency' AND e.value IS NOT NULL AND e.recorded_at >= v_since
         GROUP BY e.region
      ) l), '[]'::jsonb),
    'incidents', coalesce((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.started_at DESC)
      FROM (
        SELECT s.id, s.title, s.impact, s.status, s.component_id, s.region, s.source, s.started_at, s.resolved_at
          FROM public.status_incidents s
         ORDER BY s.started_at DESC
         LIMIT 20
      ) i), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_reliability_overview(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_reliability_overview(integer) TO authenticated, service_role;

-- 8f) Public status feed payload (no regions, no numbers, no tenant data).
CREATE OR REPLACE FUNCTION public.public_status_feed()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_good bigint;
  v_total bigint;
BEGIN
  SELECT count(*) FILTER (WHERE e.good), count(*)
    INTO v_good, v_total
    FROM public.synthetic_sli_events e
   WHERE e.sli = 'availability' AND e.recorded_at >= now() - interval '30 days';

  RETURN jsonb_build_object(
    'generated_at', now(),
    'components', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', c.component_id, 'status', c.status) ORDER BY c.component_id)
      FROM (
        SELECT s.component_id,
               CASE WHEN bool_or(s.impact = 'major') THEN 'outage' ELSE 'degraded' END AS status
          FROM public.status_incidents s
         WHERE s.status <> 'resolved'
         GROUP BY s.component_id
      ) c), '[]'::jsonb),
    'incidents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'impact', i.impact, 'status', i.status,
        'component_id', i.component_id, 'summary', i.summary,
        'started_at', i.started_at, 'resolved_at', i.resolved_at,
        'updates', coalesce((
          SELECT jsonb_agg(jsonb_build_object('status', u.status, 'message', u.message, 'at', u.created_at) ORDER BY u.created_at DESC)
          FROM public.status_incident_updates u WHERE u.incident_id = i.id), '[]'::jsonb)
      ) ORDER BY i.started_at DESC)
      FROM (
        SELECT * FROM public.status_incidents
         WHERE started_at >= now() - interval '30 days'
         ORDER BY started_at DESC
         LIMIT 25
      ) i), '[]'::jsonb),
    'voice_availability_30d', CASE WHEN v_total >= 20 THEN round(v_good::numeric / v_total * 100, 3) ELSE NULL END,
    'probe_samples_30d', v_total
  );
END;
$$;
REVOKE ALL ON FUNCTION public.public_status_feed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_status_feed() TO service_role;

-- 8g) Retention + cleanup. Only ever touches is_synthetic_tenant profiles.
CREATE OR REPLACE FUNCTION public.synthetic_purge_artifacts(p_artifact_days integer DEFAULT 3, p_history_days integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_art integer := greatest(coalesce(p_artifact_days, 3), 1);
  v_hist integer := greatest(coalesce(p_history_days, 100), 95);
  v_receipts integer := 0;
  v_runs integer := 0;
  v_jobs integer := 0;
  v_calls integer := 0;
BEGIN
  DELETE FROM public.synthetic_webhook_receipts WHERE received_at < now() - interval '7 days';
  GET DIAGNOSTICS v_receipts = ROW_COUNT;

  DELETE FROM public.synthetic_probe_runs WHERE started_at < now() - make_interval(days => v_hist);
  GET DIAGNOSTICS v_runs = ROW_COUNT;

  BEGIN
    DELETE FROM public.jobs j
     USING public.profiles p
     WHERE j.user_id = p.id AND p.is_synthetic_tenant
       AND j.created_at < now() - make_interval(days => v_art);
    GET DIAGNOSTICS v_jobs = ROW_COUNT;

    DELETE FROM public.calls c
     USING public.profiles p
     WHERE c.user_id = p.id AND p.is_synthetic_tenant
       AND c.created_at < now() - make_interval(days => v_art);
    GET DIAGNOSTICS v_calls = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'synthetic_purge_artifacts: tenant cleanup skipped: %', SQLERRM;
  END;

  RETURN jsonb_build_object('receipts', v_receipts, 'runs', v_runs, 'jobs', v_jobs, 'calls', v_calls);
END;
$$;
REVOKE ALL ON FUNCTION public.synthetic_purge_artifacts(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.synthetic_purge_artifacts(integer, integer) TO service_role;

-- 8h) Cron -> edge function bridge (same settings the webhook triggers already use).
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
  IF p_function NOT IN ('synthetic-probe', 'slo-evaluate') THEN
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

-- =============================================================
-- 9) Schedules (skipped with a NOTICE when pg_cron is not installed)
-- =============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-synthetic-dispatch', '* * * * *',
      $c$select public.synthetic_cron_tick('synthetic-probe', '{"action":"dispatch"}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-synthetic-verify', '* * * * *',
      $c$select public.synthetic_cron_tick('synthetic-probe', '{"action":"verify"}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-slo-evaluate', '*/5 * * * *',
      $c$select public.synthetic_cron_tick('slo-evaluate', '{}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-synthetic-purge', '40 3 * * *',
      $c$select public.synthetic_purge_artifacts(3, 100)$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: schedule the four synthetic jobs manually (see docs/runbooks/synthetic-monitoring.md)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
