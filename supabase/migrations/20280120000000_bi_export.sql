/*
# BI export (scheduled signed files to S3 / GCS + read-only Postgres views for Power BI)

## What this migration adds
- `bi_export_targets`     customer-owned buckets (Amazon S3 or Google Cloud Storage): config only
- `bi_export_secrets`     ENCRYPTED bucket secrets + per-account manifest signing secret. Service role only.
- `bi_export_schedules`   what to deliver (tables, snapshot|incremental, personal-data mode, interval)
- `bi_export_state`       incremental watermark per schedule and table
- `bi_export_runs`        one row per delivery run (history, counters, error)
- `bi_reader_roles`       dedicated read-only Postgres logins mapped to ONE tenant each
- `bi_*` views            documented read-only contract for Power BI / Tableau / Looker (docs/BI_EXPORT.md)
- `bi_pii_*` views        personal columns only, rows returned only when personal data is permitted

## Security model
1. Tenant scoping: every view filters on bi_tenant_id():
   - Supabase login (JWT): get_account_owner_id(), only when can_export_data() is true
   - dedicated reader login: the single tenant it was created for (matched on session_user, which a client
     cannot change), only while not revoked
   Anything else resolves to NULL = zero rows.
2. No PII unless permitted: `bi_*` views contain NO personal column. `bi_pii_*` views return rows only when
   bi_pii_allowed() is true (permission can_export_pii; owners always pass).
3. Read-only: reader logins hold SELECT on views only, 60 s statement timeout, default_transaction_read_only.
4. Secrets: bi_export_secrets has RLS on, zero policies, revoked privileges.
5. Clients can READ targets/schedules/runs with can_manage_data_platform(); all writes go through the
   `bi-export-run` edge function (service role) which re-checks permissions.
*/

-- 0. Prerequisites
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','leads','calls','jobs','quotes','job_cost_entries','revenue_recovery_events','metric_snapshots','profiles','team_members','custom_roles'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['public.get_account_owner_id()','public.can_export_data()','public.can_manage_data_platform()','public.has_account_permission(text)','public.dp_touch_updated_at()'] LOOP
    IF to_regprocedure(t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'BI export migration: missing prerequisites (apply the Data Platform and Data Exports migrations first): %', array_to_string(missing, ', ');
  END IF;
END $$;

-- 1. Permission helpers
CREATE OR REPLACE FUNCTION public.bi_has_permission(p_user uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user IS NULL THEN false
    WHEN NOT EXISTS (SELECT 1 FROM public.team_members WHERE user_id = p_user)
      THEN EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user)
    ELSE COALESCE((
      SELECT CASE
        WHEN cr.permissions ? p_key THEN (cr.permissions ->> p_key) = 'true'
        ELSE COALESCE((tm.permissions ->> p_key) = 'true', false)
      END
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = p_user
      LIMIT 1
    ), false)
  END;
$$;
REVOKE ALL ON FUNCTION public.bi_has_permission(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bi_has_permission(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.bi_can_export_pii()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.can_export_data() AND public.has_account_permission('can_export_pii'), false);
$$;
REVOKE ALL ON FUNCTION public.bi_can_export_pii() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_can_export_pii() TO authenticated;

-- 2. Targets, secrets, schedules, state, runs
CREATE TABLE IF NOT EXISTS public.bi_export_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK (provider IN ('s3', 'gcs')),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 3 AND 222),
  region text NOT NULL DEFAULT 'auto' CHECK (char_length(region) BETWEEN 2 AND 32),
  prefix text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 128),
  access_key_id text NOT NULL CHECK (char_length(access_key_id) BETWEEN 8 AND 128),
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'connected', 'error')),
  last_tested_at timestamptz,
  last_error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_export_targets_user_name ON public.bi_export_targets (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_bi_export_targets_user ON public.bi_export_targets (user_id);
DROP TRIGGER IF EXISTS trg_bi_touch_targets ON public.bi_export_targets;
CREATE TRIGGER trg_bi_touch_targets BEFORE UPDATE ON public.bi_export_targets
  FOR EACH ROW EXECUTE FUNCTION public.dp_touch_updated_at();
ALTER TABLE public.bi_export_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_targets_select" ON public.bi_export_targets;
CREATE POLICY "bi_export_targets_select" ON public.bi_export_targets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE TABLE IF NOT EXISTS public.bi_export_secrets (
  ref_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('target', 'signing')),
  user_id uuid NOT NULL,
  secret_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ref_id, kind)
);
ALTER TABLE public.bi_export_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bi_export_secrets FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.bi_export_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  target_id uuid NOT NULL REFERENCES public.bi_export_targets (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  datasets text[] NOT NULL
    CHECK (cardinality(datasets) BETWEEN 1 AND 8
      AND datasets <@ ARRAY['customers','leads','calls','jobs','quotes','job_costs','revenue_recovery','metrics_daily']::text[]),
  mode text NOT NULL DEFAULT 'incremental' CHECK (mode IN ('snapshot', 'incremental')),
  pii_mode text NOT NULL DEFAULT 'omit' CHECK (pii_mode IN ('omit', 'hashed', 'full')),
  pii_authorized_by uuid,
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes IN (60, 360, 1440, 10080)),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pii_mode = 'omit' OR pii_authorized_by IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_export_schedules_user_name ON public.bi_export_schedules (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_bi_export_schedules_due ON public.bi_export_schedules (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_bi_export_schedules_target ON public.bi_export_schedules (target_id);
DROP TRIGGER IF EXISTS trg_bi_touch_schedules ON public.bi_export_schedules;
CREATE TRIGGER trg_bi_touch_schedules BEFORE UPDATE ON public.bi_export_schedules
  FOR EACH ROW EXECUTE FUNCTION public.dp_touch_updated_at();
ALTER TABLE public.bi_export_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_schedules_select" ON public.bi_export_schedules;
CREATE POLICY "bi_export_schedules_select" ON public.bi_export_schedules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE TABLE IF NOT EXISTS public.bi_export_state (
  schedule_id uuid NOT NULL REFERENCES public.bi_export_schedules (id) ON DELETE CASCADE,
  dataset text NOT NULL,
  user_id uuid NOT NULL,
  watermark text,
  rows_total bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  PRIMARY KEY (schedule_id, dataset)
);
ALTER TABLE public.bi_export_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_state_select" ON public.bi_export_state;
CREATE POLICY "bi_export_state_select" ON public.bi_export_state FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE TABLE IF NOT EXISTS public.bi_export_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  schedule_id uuid REFERENCES public.bi_export_schedules (id) ON DELETE SET NULL,
  schedule_name text NOT NULL DEFAULT '',
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  requested_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bi_export_runs_user_started ON public.bi_export_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bi_export_runs_schedule ON public.bi_export_runs (schedule_id, started_at DESC);
ALTER TABLE public.bi_export_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_runs_select" ON public.bi_export_runs;
CREATE POLICY "bi_export_runs_select" ON public.bi_export_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE OR REPLACE FUNCTION public.bi_claim_due(p_limit integer)
RETURNS SETOF public.bi_export_schedules
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.bi_export_schedules s
  SET locked_until = now() + interval '15 minutes'
  WHERE s.id IN (
    SELECT id FROM public.bi_export_schedules
    WHERE enabled AND next_run_at <= now() AND (locked_until IS NULL OR locked_until < now()) AND consecutive_failures < 8
    ORDER BY next_run_at
    LIMIT greatest(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING s.*;
$$;
REVOKE ALL ON FUNCTION public.bi_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bi_claim_due(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bi_export_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bi_export_runs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bi_export_schedules') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bi_export_schedules;
  END IF;
END $$;

-- 3. Reader logins + tenant / PII resolution
CREATE TABLE IF NOT EXISTS public.bi_reader_roles (
  role_name text PRIMARY KEY CHECK (role_name ~ '^bi_[0-9a-f]{12}$'),
  user_id uuid NOT NULL,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  include_pii boolean NOT NULL DEFAULT false,
  pii_authorized_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (include_pii = false OR pii_authorized_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_bi_reader_roles_user ON public.bi_reader_roles (user_id);
ALTER TABLE public.bi_reader_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_reader_roles_select" ON public.bi_reader_roles;
CREATE POLICY "bi_reader_roles_select" ON public.bi_reader_roles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE OR REPLACE FUNCTION public.bi_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT r.user_id FROM public.bi_reader_roles r WHERE r.role_name = session_user AND r.revoked_at IS NULL LIMIT 1),
    CASE WHEN public.can_export_data() THEN public.get_account_owner_id() END
  );
$$;
REVOKE ALL ON FUNCTION public.bi_tenant_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_tenant_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bi_pii_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (r.include_pii AND public.bi_has_permission(r.pii_authorized_by, 'can_export_pii'))
       FROM public.bi_reader_roles r WHERE r.role_name = session_user AND r.revoked_at IS NULL LIMIT 1),
    (public.can_export_data() AND public.has_account_permission('can_export_pii')),
    false
  );
$$;
REVOKE ALL ON FUNCTION public.bi_pii_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_pii_allowed() TO authenticated, service_role;

-- 4. Read-only view contract v1 (generated from the Data Platform catalog; a unit test guards drift)
CREATE OR REPLACE VIEW public.bi_customers WITH (security_barrier = true) AS
SELECT c.id, c.customer_type, c.lifecycle_stage, c.source, c.tags, c.marketing_opt_in, c.marketing_opt_in_at, c.last_contacted_at, c.created_at, c.updated_at
FROM public.customers c
WHERE c.user_id = public.bi_tenant_id() AND c.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.bi_pii_customers WITH (security_barrier = true) AS
SELECT c.id, c.name, c.phone, c.email, c.address
FROM public.customers c
WHERE c.user_id = public.bi_tenant_id() AND c.deleted_at IS NULL AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_leads WITH (security_barrier = true) AS
SELECT l.id, l.customer_id, l.call_id, l.service_interested, l.stage, l.quote_amount, l.follow_up_count, l.quote_sent_at, l.stage_updated_at, l.tags, l.created_at, l.updated_at
FROM public.leads l
WHERE l.user_id = public.bi_tenant_id() AND l.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.bi_pii_leads WITH (security_barrier = true) AS
SELECT l.id, l.name, l.phone, l.email
FROM public.leads l
WHERE l.user_id = public.bi_tenant_id() AND l.deleted_at IS NULL AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_calls WITH (security_barrier = true) AS
SELECT k.id, k.customer_id, k.call_datetime, k.duration_seconds, k.status, k.sentiment, k.is_emergency, k.is_voicemail, k.call_score, k.lead_score, k.lead_source, k.intent, k.booking_outcome, k.created_at, k.updated_at
FROM public.calls k
WHERE k.user_id = public.bi_tenant_id();

CREATE OR REPLACE VIEW public.bi_pii_calls WITH (security_barrier = true) AS
SELECT k.id, k.caller_name, k.caller_phone
FROM public.calls k
WHERE k.user_id = public.bi_tenant_id() AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_jobs WITH (security_barrier = true) AS
SELECT j.id, j.customer_id, j.lead_id, j.call_id, j.service_type, j.customer_type, j.job_status, j.assigned_technician_id, j.scheduled_datetime, j.started_at, j.completed_at, j.first_response_at, j.duration_minutes, j.expected_duration_minutes, j.invoice_amount, j.invoice_status, j.is_rework, j.created_at, j.updated_at
FROM public.jobs j
WHERE j.user_id = public.bi_tenant_id();

CREATE OR REPLACE VIEW public.bi_pii_jobs WITH (security_barrier = true) AS
SELECT j.id, j.customer_name, j.address
FROM public.jobs j
WHERE j.user_id = public.bi_tenant_id() AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_quotes WITH (security_barrier = true) AS
SELECT q.id, q.lead_id, q.line_items, q.tax_percent, q.status, q.sent_at, q.responded_at, q.valid_until, q.created_at, q.updated_at
FROM public.quotes q
WHERE q.user_id = public.bi_tenant_id();

CREATE OR REPLACE VIEW public.bi_pii_quotes WITH (security_barrier = true) AS
SELECT q.id, q.customer_name, q.customer_email, q.customer_phone
FROM public.quotes q
WHERE q.user_id = public.bi_tenant_id() AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_job_costs WITH (security_barrier = true) AS
SELECT e.id, e.job_id, e.category, e.description, e.quantity, e.unit_cost_cents, e.total_cost_cents, e.team_member_id, e.created_at, e.updated_at
FROM public.job_cost_entries e
WHERE e.user_id = public.bi_tenant_id();

CREATE OR REPLACE VIEW public.bi_revenue_recovery WITH (security_barrier = true) AS
SELECT r.id, r.source_type, r.source_table, r.source_id, r.lead_id, r.call_id, r.occurred_at, r.estimated_value_cents, r.status, r.recovery_method, r.recovered_job_id, r.recovered_amount_cents, r.follow_up_count, r.resolved_at, r.created_at, r.updated_at
FROM public.revenue_recovery_events r
WHERE r.user_id = public.bi_tenant_id();

CREATE OR REPLACE VIEW public.bi_pii_revenue_recovery WITH (security_barrier = true) AS
SELECT r.id, r.customer_name, r.customer_phone
FROM public.revenue_recovery_events r
WHERE r.user_id = public.bi_tenant_id() AND public.bi_pii_allowed();

CREATE OR REPLACE VIEW public.bi_metrics_daily WITH (security_barrier = true) AS
SELECT m.id, m.metric_id, m.day, m.value, m.numerator, m.denominator, m.sample_size, m.definition_version, m.computed_at, m.updated_at
FROM public.metric_snapshots m
WHERE m.user_id = public.bi_tenant_id();


DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['bi_customers', 'bi_pii_customers', 'bi_leads', 'bi_pii_leads', 'bi_calls', 'bi_pii_calls', 'bi_jobs', 'bi_pii_jobs', 'bi_quotes', 'bi_pii_quotes', 'bi_job_costs', 'bi_revenue_recovery', 'bi_pii_revenue_recovery', 'bi_metrics_daily'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v);
  END LOOP;
END $$;

COMMENT ON VIEW public.bi_customers IS 'BI contract v1. One row per customer, no personal columns. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_leads IS 'BI contract v1. One row per lead, no personal columns. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_calls IS 'BI contract v1. One row per call, no personal columns, no transcript. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_jobs IS 'BI contract v1. One row per job, no personal columns. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_quotes IS 'BI contract v1. One row per quote, no personal columns. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_job_costs IS 'BI contract v1. One row per job cost entry (cents). Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_revenue_recovery IS 'BI contract v1. One row per revenue recovery event (cents), no personal columns. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_metrics_daily IS 'BI contract v1. Daily value of every semantic metric. Tenant-scoped by bi_tenant_id().';
COMMENT ON VIEW public.bi_pii_customers IS 'Personal columns of bi_customers (join on id). Empty unless personal data is permitted.';
COMMENT ON VIEW public.bi_pii_leads IS 'Personal columns of bi_leads (join on id). Empty unless personal data is permitted.';
COMMENT ON VIEW public.bi_pii_calls IS 'Personal columns of bi_calls (join on id). Empty unless personal data is permitted.';
COMMENT ON VIEW public.bi_pii_jobs IS 'Personal columns of bi_jobs (join on id). Empty unless personal data is permitted.';
COMMENT ON VIEW public.bi_pii_quotes IS 'Personal columns of bi_quotes (join on id). Empty unless personal data is permitted.';
COMMENT ON VIEW public.bi_pii_revenue_recovery IS 'Personal columns of bi_revenue_recovery (join on id). Empty unless personal data is permitted.';

-- 5. Reader login provisioning (service role only; called by the bi-export-run edge function).
--    If the migration role lacks CREATEROLE the call raises a clear error; nothing else is affected.
CREATE OR REPLACE FUNCTION public.bi_provision_reader(
  p_owner uuid, p_by uuid, p_label text, p_password text, p_include_pii boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_view text;
BEGIN
  IF p_owner IS NULL OR p_by IS NULL THEN RAISE EXCEPTION 'owner and creator are required'; END IF;
  IF p_password IS NULL OR char_length(p_password) < 24 THEN RAISE EXCEPTION 'password must be at least 24 characters'; END IF;
  IF (SELECT count(*) FROM public.bi_reader_roles WHERE user_id = p_owner AND revoked_at IS NULL) >= 5 THEN
    RAISE EXCEPTION 'reader limit reached (5 active logins per account)';
  END IF;
  IF COALESCE(p_include_pii, false) AND NOT public.bi_has_permission(p_by, 'can_export_pii') THEN
    RAISE EXCEPTION 'personal data requires the can_export_pii permission';
  END IF;

  v_role := 'bi_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  BEGIN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 5', v_role, p_password);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'The database role that owns this function cannot create logins (CREATEROLE is required).';
  END;
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_role, '60s');
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', v_role);
  EXECUTE format('ALTER ROLE %I SET search_path = public', v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.bi_tenant_id() TO %I', v_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.bi_pii_allowed() TO %I', v_role);
  FOREACH v_view IN ARRAY ARRAY['bi_customers', 'bi_leads', 'bi_calls', 'bi_jobs', 'bi_quotes', 'bi_job_costs', 'bi_revenue_recovery', 'bi_metrics_daily'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO %I', v_view, v_role);
  END LOOP;
  IF COALESCE(p_include_pii, false) THEN
    FOREACH v_view IN ARRAY ARRAY['bi_pii_customers', 'bi_pii_leads', 'bi_pii_calls', 'bi_pii_jobs', 'bi_pii_quotes', 'bi_pii_revenue_recovery'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO %I', v_view, v_role);
    END LOOP;
  END IF;

  INSERT INTO public.bi_reader_roles (role_name, user_id, label, include_pii, pii_authorized_by, created_by)
  VALUES (v_role, p_owner, left(COALESCE(p_label, ''), 80), COALESCE(p_include_pii, false),
          CASE WHEN COALESCE(p_include_pii, false) THEN p_by END, p_by);
  RETURN v_role;
END;
$$;
REVOKE ALL ON FUNCTION public.bi_provision_reader(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bi_provision_reader(uuid, uuid, text, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.bi_revoke_reader(p_owner uuid, p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  IF p_role IS NULL OR p_role !~ '^bi_[0-9a-f]{12}$' THEN RAISE EXCEPTION 'invalid reader name'; END IF;
  UPDATE public.bi_reader_roles SET revoked_at = now()
   WHERE role_name = p_role AND user_id = p_owner AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN false; END IF;
  BEGIN
    EXECUTE format('ALTER ROLE %I NOLOGIN', p_role);
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_role;
    EXECUTE format('DROP OWNED BY %I', p_role);
    EXECUTE format('DROP ROLE %I', p_role);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.bi_revoke_reader(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bi_revoke_reader(uuid, text) TO service_role;

COMMENT ON TABLE public.bi_export_secrets IS 'Encrypted BI export credentials and manifest signing secrets. Service role only.';
COMMENT ON TABLE public.bi_export_runs IS 'History of BI export deliveries (scheduled and manual).';

/*
## Scheduling (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  select cron.schedule('bi-export-tick', '*/15 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/bi-export-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','cron')
    ); $$);
*/
