/*
  # Vireek AI Security Center

  ## What this adds
  1. ai_security_settings        - per-account policy (PII mode, prompt-injection mode, sandbox
                                   mode, provider allowlist, anomaly alerts, API-key max age)
  2. ai_agent_sandbox_policies   - per-agent least-privilege sandbox (data domains, record cap,
                                   external send, writes)
  3. ai_security_events          - append-only security event log. NEVER stores raw prompts or
                                   PII - only rule ids, counts, scores and fingerprints.
  4. can_manage_ai_security()    - owner OR team member / custom role with can_manage_security
  5. RPCs (dashboard)            - upsert_ai_security_settings, upsert/delete_ai_agent_sandbox_policy,
                                   set_ai_security_event_status, ai_security_event_counts,
                                   ai_security_isolation_audit
  6. RPCs (service role only)    - evaluate_ai_request (policy engine), record_ai_security_events,
                                   ai_security_run_anomaly_scan (hourly via pg_cron when available)

  RLS mirrors the existing governance migrations: SELECT scoped to get_account_owner_id() AND
  can_manage_ai_security(); no client INSERT/UPDATE/DELETE policies - every write goes through a
  SECURITY DEFINER RPC or the service role.
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_ai_security()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_manage_security', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_security', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_ai_security() TO authenticated;

-- =============================================================
-- SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_security_settings (
  user_id uuid PRIMARY KEY,
  pii_mode text NOT NULL DEFAULT 'sensitive' CHECK (pii_mode IN ('off', 'sensitive', 'full')),
  injection_mode text NOT NULL DEFAULT 'sanitize' CHECK (injection_mode IN ('monitor', 'sanitize', 'block')),
  injection_block_score integer NOT NULL DEFAULT 70 CHECK (injection_block_score BETWEEN 20 AND 100),
  sandbox_mode text NOT NULL DEFAULT 'audit' CHECK (sandbox_mode IN ('off', 'audit', 'enforce')),
  allowed_providers text[] CHECK (
    allowed_providers IS NULL
    OR allowed_providers <@ ARRAY['gemini', 'groq', 'cerebras', 'cloudflare', 'openrouter', 'anthropic']::text[]
  ),
  anomaly_alerts_enabled boolean NOT NULL DEFAULT true,
  api_key_max_age_days integer NOT NULL DEFAULT 90 CHECK (api_key_max_age_days BETWEEN 7 AND 730),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_security_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_ai_security_settings" ON public.ai_security_settings;
CREATE POLICY "managers_select_ai_security_settings" ON public.ai_security_settings
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());

-- =============================================================
-- AGENT SANDBOX POLICIES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_agent_sandbox_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_source text NOT NULL CHECK (char_length(agent_source) BETWEEN 2 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  allowed_domains text[] NOT NULL DEFAULT '{}' CHECK (
    allowed_domains <@ ARRAY['customers', 'financial', 'location', 'equipment', 'recordings', 'contracts', 'business_decisions']::text[]
  ),
  max_records_per_run integer CHECK (max_records_per_run IS NULL OR max_records_per_run > 0),
  allow_external_send boolean NOT NULL DEFAULT false,
  allow_write boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_source)
);

ALTER TABLE public.ai_agent_sandbox_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_ai_agent_sandbox" ON public.ai_agent_sandbox_policies;
CREATE POLICY "managers_select_ai_agent_sandbox" ON public.ai_agent_sandbox_policies
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());

-- =============================================================
-- SECURITY EVENTS (append-only; only status columns may change)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'prompt_injection', 'pii_redacted', 'output_leak', 'sandbox_violation',
    'provider_denied', 'anomaly', 'policy_change'
  )),
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  source text NOT NULL DEFAULT 'ai-core',
  task text,
  agent_source text,
  risk_score integer CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('logged', 'open', 'acknowledged', 'resolved', 'false_positive')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_security_events_user_created
  ON public.ai_security_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_security_events_user_type_created
  ON public.ai_security_events (user_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_security_events_open
  ON public.ai_security_events (user_id, severity) WHERE status = 'open';

ALTER TABLE public.ai_security_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_ai_security_events" ON public.ai_security_events;
CREATE POLICY "managers_select_ai_security_events" ON public.ai_security_events
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());

CREATE OR REPLACE FUNCTION public.ai_security_events_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.task IS DISTINCT FROM OLD.task
     OR NEW.agent_source IS DISTINCT FROM OLD.agent_source
     OR NEW.risk_score IS DISTINCT FROM OLD.risk_score
     OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ai_security_events is append-only; only status fields may change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_security_events_guard_update ON public.ai_security_events;
CREATE TRIGGER trg_ai_security_events_guard_update
  BEFORE UPDATE ON public.ai_security_events
  FOR EACH ROW EXECUTE FUNCTION public.ai_security_events_guard_update();

-- =============================================================
-- DASHBOARD RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_ai_security_settings(
  p_pii_mode text,
  p_injection_mode text,
  p_injection_block_score integer,
  p_sandbox_mode text,
  p_allowed_providers text[],
  p_anomaly_alerts_enabled boolean,
  p_api_key_max_age_days integer
)
RETURNS public.ai_security_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_providers text[] := CASE WHEN p_allowed_providers IS NULL OR cardinality(p_allowed_providers) = 0 THEN NULL ELSE p_allowed_providers END;
  v_before public.ai_security_settings;
  v_row public.ai_security_settings;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_before FROM public.ai_security_settings WHERE user_id = v_owner;

  INSERT INTO public.ai_security_settings AS s (
    user_id, pii_mode, injection_mode, injection_block_score, sandbox_mode,
    allowed_providers, anomaly_alerts_enabled, api_key_max_age_days, updated_by, updated_at
  ) VALUES (
    v_owner, p_pii_mode, p_injection_mode, p_injection_block_score, p_sandbox_mode,
    v_providers, p_anomaly_alerts_enabled, p_api_key_max_age_days, auth.uid(), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    pii_mode = EXCLUDED.pii_mode,
    injection_mode = EXCLUDED.injection_mode,
    injection_block_score = EXCLUDED.injection_block_score,
    sandbox_mode = EXCLUDED.sandbox_mode,
    allowed_providers = EXCLUDED.allowed_providers,
    anomaly_alerts_enabled = EXCLUDED.anomaly_alerts_enabled,
    api_key_max_age_days = EXCLUDED.api_key_max_age_days,
    updated_by = EXCLUDED.updated_by,
    updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO public.ai_security_events (user_id, event_type, severity, source, status, detail)
  VALUES (v_owner, 'policy_change', 'info', 'dashboard', 'logged', jsonb_build_object(
    'actor_id', auth.uid(),
    'before', CASE WHEN v_before.user_id IS NULL THEN NULL ELSE to_jsonb(v_before) - 'user_id' - 'updated_by' END,
    'after', to_jsonb(v_row) - 'user_id' - 'updated_by'
  ));

  PERFORM public.log_audit_event(v_owner, 'ai_security.settings_updated', 'ai_security_settings', v_owner::text);
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_ai_agent_sandbox_policy(
  p_agent_source text,
  p_enabled boolean,
  p_allowed_domains text[],
  p_max_records integer,
  p_allow_external_send boolean,
  p_allow_write boolean
)
RETURNS public.ai_agent_sandbox_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.ai_agent_sandbox_policies;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.ai_agent_sandbox_policies AS a (
    user_id, agent_source, enabled, allowed_domains, max_records_per_run,
    allow_external_send, allow_write, updated_at
  ) VALUES (
    v_owner, p_agent_source, p_enabled, COALESCE(p_allowed_domains, '{}'), p_max_records,
    p_allow_external_send, p_allow_write, now()
  )
  ON CONFLICT (user_id, agent_source) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    allowed_domains = EXCLUDED.allowed_domains,
    max_records_per_run = EXCLUDED.max_records_per_run,
    allow_external_send = EXCLUDED.allow_external_send,
    allow_write = EXCLUDED.allow_write,
    updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO public.ai_security_events (user_id, event_type, severity, source, agent_source, status, detail)
  VALUES (v_owner, 'policy_change', 'info', 'dashboard', p_agent_source, 'logged',
          jsonb_build_object('actor_id', auth.uid(), 'sandbox', to_jsonb(v_row) - 'user_id' - 'id'));

  PERFORM public.log_audit_event(v_owner, 'ai_security.sandbox_updated', 'ai_agent_sandbox_policies', v_row.id::text);
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_ai_agent_sandbox_policy(p_agent_source text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.ai_agent_sandbox_policies WHERE user_id = v_owner AND agent_source = p_agent_source;

  INSERT INTO public.ai_security_events (user_id, event_type, severity, source, agent_source, status, detail)
  VALUES (v_owner, 'policy_change', 'info', 'dashboard', p_agent_source, 'logged',
          jsonb_build_object('actor_id', auth.uid(), 'sandbox_removed', true));

  PERFORM public.log_audit_event(v_owner, 'ai_security.sandbox_removed', 'ai_agent_sandbox_policies', p_agent_source);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_ai_security_event_status(p_event_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('acknowledged', 'resolved', 'false_positive') THEN
    RAISE EXCEPTION 'Invalid status %', p_status;
  END IF;

  UPDATE public.ai_security_events
     SET status = p_status, resolved_by = auth.uid(), resolved_at = now()
   WHERE id = p_event_id AND user_id = v_owner;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  PERFORM public.log_audit_event(v_owner, 'ai_security.event_' || p_status, 'ai_security_events', p_event_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_security_event_counts(p_days integer DEFAULT 14)
RETURNS TABLE (day date, event_type text, severity text, total integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT (e.created_at AT TIME ZONE 'UTC')::date, e.event_type, e.severity, COUNT(*)::integer
    FROM public.ai_security_events e
   WHERE e.user_id = v_owner
     AND e.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90))
     AND e.event_type <> 'policy_change'
   GROUP BY 1, 2, 3
   ORDER BY 1;
END;
$$;

-- Tenant isolation audit: every public table that carries a tenant column must have RLS on and
-- no wide-open (USING true) client-reachable policy. Returns schema metadata only - no tenant data.
CREATE OR REPLACE FUNCTION public.ai_security_isolation_audit()
RETURNS TABLE (table_name text, rls_enabled boolean, policy_count integer, open_policy_count integer, risk text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'Not authorized to manage AI security' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH tenant_tables AS (
    SELECT c.oid, c.relname::text AS name, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname IN ('user_id', 'account_owner_id')
            AND NOT a.attisdropped
       )
  ), pol AS (
    SELECT t.name,
           COUNT(p.policyname)::integer AS total,
           COUNT(*) FILTER (
             WHERE p.permissive = 'PERMISSIVE'
               AND p.cmd IN ('SELECT', 'ALL', 'UPDATE', 'DELETE')
               AND btrim(COALESCE(p.qual, '')) IN ('true', '(true)')
               AND p.roles && ARRAY['public', 'anon', 'authenticated']::name[]
           )::integer AS open_count
      FROM tenant_tables t
      LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = t.name
     GROUP BY t.name
  )
  SELECT t.name, t.rls, pol.total, pol.open_count,
         CASE
           WHEN NOT t.rls THEN 'critical'
           WHEN pol.open_count > 0 THEN 'high'
           ELSE 'ok'
         END
    FROM tenant_tables t
    JOIN pol ON pol.name = t.name
   ORDER BY CASE WHEN NOT t.rls THEN 0 WHEN pol.open_count > 0 THEN 1 ELSE 2 END, t.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_ai_security_settings(text, text, integer, text, text[], boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ai_agent_sandbox_policy(text, boolean, text[], integer, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_ai_agent_sandbox_policy(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_ai_security_event_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_security_event_counts(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_security_isolation_audit() TO authenticated;

-- =============================================================
-- POLICY ENGINE (service role only) - single source of truth for edge functions
-- =============================================================

CREATE OR REPLACE FUNCTION public.evaluate_ai_request(
  p_user_id uuid,
  p_agent_source text DEFAULT NULL,
  p_task text DEFAULT NULL,
  p_data_domains text[] DEFAULT '{}',
  p_external_send boolean DEFAULT false,
  p_writes boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.ai_security_settings;
  sb public.ai_agent_sandbox_policies;
  v_reasons text[] := '{}';
  v_default_domains text[] := ARRAY['customers', 'equipment', 'business_decisions'];
  v_allowed text[];
  v_bad text[];
  v_decision text := 'allow';
  v_fingerprint text;
BEGIN
  SELECT * INTO s FROM public.ai_security_settings WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    s.pii_mode := 'sensitive';
    s.injection_mode := 'sanitize';
    s.injection_block_score := 70;
    s.sandbox_mode := 'audit';
    s.allowed_providers := NULL;
    s.anomaly_alerts_enabled := true;
  END IF;

  IF s.sandbox_mode <> 'off' AND p_agent_source IS NOT NULL THEN
    SELECT * INTO sb FROM public.ai_agent_sandbox_policies
     WHERE user_id = p_user_id AND agent_source = p_agent_source;

    IF FOUND AND NOT sb.enabled THEN
      v_reasons := v_reasons || 'agent_disabled';
    END IF;

    v_allowed := CASE WHEN FOUND THEN sb.allowed_domains ELSE v_default_domains END;
    SELECT COALESCE(array_agg(d), '{}') INTO v_bad
      FROM unnest(COALESCE(p_data_domains, '{}')) AS d
     WHERE NOT (d = ANY (v_allowed));
    IF cardinality(v_bad) > 0 THEN
      v_reasons := v_reasons || ('domain_not_allowed:' || array_to_string(v_bad, ','));
    END IF;

    IF p_external_send AND NOT COALESCE(sb.allow_external_send, false) THEN
      v_reasons := v_reasons || 'external_send_not_allowed';
    END IF;
    IF p_writes AND NOT COALESCE(sb.allow_write, false) THEN
      v_reasons := v_reasons || 'write_not_allowed';
    END IF;

    IF cardinality(v_reasons) > 0 THEN
      v_decision := CASE WHEN s.sandbox_mode = 'enforce' THEN 'deny' ELSE 'audit_only' END;

      v_fingerprint := md5(p_agent_source || '|' || array_to_string(v_reasons, '|'));
      IF NOT EXISTS (
        SELECT 1 FROM public.ai_security_events e
         WHERE e.user_id = p_user_id AND e.event_type = 'sandbox_violation'
           AND e.detail ->> 'fingerprint' = v_fingerprint
           AND e.created_at >= now() - interval '10 minutes'
      ) THEN
        INSERT INTO public.ai_security_events (user_id, event_type, severity, source, task, agent_source, status, detail)
        VALUES (
          p_user_id, 'sandbox_violation',
          CASE WHEN v_decision = 'deny' THEN 'high' ELSE 'medium' END,
          'policy-engine', p_task, p_agent_source,
          'open',
          jsonb_build_object('fingerprint', v_fingerprint, 'reasons', to_jsonb(v_reasons),
                             'decision', v_decision, 'domains', to_jsonb(COALESCE(p_data_domains, '{}')))
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'settings', jsonb_build_object(
      'pii_mode', s.pii_mode,
      'injection_mode', s.injection_mode,
      'injection_block_score', s.injection_block_score,
      'sandbox_mode', s.sandbox_mode,
      'allowed_providers', to_jsonb(s.allowed_providers),
      'anomaly_alerts_enabled', s.anomaly_alerts_enabled
    ),
    'sandbox', jsonb_build_object(
      'decision', v_decision,
      'reasons', to_jsonb(v_reasons),
      'max_records_per_run', sb.max_records_per_run
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_ai_security_events(p_user_id uuid, p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev jsonb;
  v_inserted integer := 0;
  v_recent integer;
  v_type text;
  v_sev text;
BEGIN
  IF p_user_id IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::integer INTO v_recent FROM public.ai_security_events
   WHERE user_id = p_user_id AND created_at >= now() - interval '1 hour';

  FOR ev IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_type := ev ->> 'event_type';
    v_sev := COALESCE(ev ->> 'severity', 'info');
    IF v_type NOT IN ('prompt_injection', 'pii_redacted', 'output_leak', 'sandbox_violation', 'provider_denied', 'anomaly') THEN
      CONTINUE;
    END IF;
    IF v_sev NOT IN ('info', 'low', 'medium', 'high', 'critical') THEN
      v_sev := 'info';
    END IF;
    -- Flood protection: under a burst, keep medium+ events and drop info/low noise.
    IF v_recent > 1000 AND v_sev IN ('info', 'low') THEN
      CONTINUE;
    END IF;

    INSERT INTO public.ai_security_events (
      user_id, event_type, severity, source, task, agent_source, risk_score, detail, status
    ) VALUES (
      p_user_id, v_type, v_sev,
      COALESCE(left(ev ->> 'source', 80), 'ai-core'),
      left(ev ->> 'task', 80),
      left(ev ->> 'agent_source', 80),
      CASE WHEN ev ->> 'risk_score' IS NOT NULL THEN LEAST(GREATEST((ev ->> 'risk_score')::integer, 0), 100) END,
      COALESCE(ev -> 'detail', '{}'::jsonb),
      CASE WHEN v_sev IN ('info', 'low') THEN 'logged' ELSE 'open' END
    );
    v_inserted := v_inserted + 1;
    v_recent := v_recent + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

-- =============================================================
-- ANOMALY SCAN (hourly) - flags a metric whose last-hour count is far above its 7-day hourly baseline
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_security_run_anomaly_scan()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_enabled boolean;
  v_current integer;
  v_avg numeric;
  v_sd numeric;
  v_sev text;
  v_created integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT e.user_id, e.event_type
      FROM public.ai_security_events e
     WHERE e.created_at >= now() - interval '1 hour'
       AND e.event_type IN ('prompt_injection', 'sandbox_violation', 'pii_redacted', 'output_leak')
  LOOP
    SELECT COALESCE((SELECT s.anomaly_alerts_enabled FROM public.ai_security_settings s WHERE s.user_id = r.user_id), true)
      INTO v_enabled;
    IF NOT v_enabled THEN CONTINUE; END IF;

    SELECT COUNT(*)::integer INTO v_current FROM public.ai_security_events
     WHERE user_id = r.user_id AND event_type = r.event_type AND created_at >= now() - interval '1 hour';

    SELECT COALESCE(avg(b.c), 0), COALESCE(stddev_samp(b.c), 0) INTO v_avg, v_sd
      FROM (
        SELECT g.h, COUNT(e.id)::numeric AS c
          FROM generate_series(
                 date_trunc('hour', now()) - interval '168 hours',
                 date_trunc('hour', now()) - interval '1 hour',
                 interval '1 hour') AS g(h)
          LEFT JOIN public.ai_security_events e
            ON e.user_id = r.user_id AND e.event_type = r.event_type
           AND e.created_at >= g.h AND e.created_at < g.h + interval '1 hour'
         GROUP BY g.h
      ) b;

    IF v_current >= 5 AND v_current > v_avg + 3 * GREATEST(v_sd, 1) THEN
      IF EXISTS (
        SELECT 1 FROM public.ai_security_events a
         WHERE a.user_id = r.user_id AND a.event_type = 'anomaly'
           AND a.detail ->> 'metric' = r.event_type
           AND a.created_at >= now() - interval '6 hours'
      ) THEN
        CONTINUE;
      END IF;

      v_sev := CASE WHEN v_current >= 25 THEN 'critical' ELSE 'high' END;

      INSERT INTO public.ai_security_events (user_id, event_type, severity, source, status, detail)
      VALUES (r.user_id, 'anomaly', v_sev, 'anomaly-scan', 'open', jsonb_build_object(
        'metric', r.event_type, 'last_hour', v_current,
        'baseline_avg', round(v_avg, 2), 'baseline_sd', round(v_sd, 2)
      ));

      INSERT INTO public.notifications (user_id, type, title, message, action_url)
      VALUES (r.user_id, 'security_alert', 'AI security anomaly detected',
              format('Unusual spike in "%s" events (%s in the last hour vs ~%s typical).',
                     replace(r.event_type, '_', ' '), v_current, round(v_avg, 1)),
              '/dashboard/security-center');

      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_ai_request(uuid, text, text, text[], boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ai_security_events(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_security_run_anomaly_scan() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_ai_request(uuid, text, text, text[], boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ai_security_events(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_security_run_anomaly_scan() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-ai-security-anomaly-scan');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-ai-security-anomaly-scan', '7 * * * *', 'select public.ai_security_run_anomaly_scan()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

COMMENT ON TABLE public.ai_security_events IS
  'Append-only AI security event log. Never stores raw prompts, model output or PII - only rule ids, counts, scores and fingerprints.';
