/*
# Payroll provider connectors (Gusto / ADP / Paychex / Rippling)

## What this migration does
Backend for /dashboard/payroll-connectors: export approved HOURS, COMMISSIONS and TIPS for a pay
period to an outside payroll provider, either as a provider-ready file or (Gusto) pushed through
the provider's API.

- `payroll_connections`         one row per (account owner, provider): mode (file | api), settings, company
- `payroll_connection_secrets`  OAuth tokens, ENCRYPTED, service-role only (Gusto API mode)
- `payroll_employee_links`      Vireek employee <-> provider employee id (file number / worker id / uuid)
- `payroll_exports`             one batch per export: period, status, totals, warnings, file checksum
- `payroll_export_lines`        one row per employee in the batch (hours, commission, tips, delivery result)
- `payroll_export_sources`      the exact timesheets / commission records / tips a batch consumed
- `payroll_export_events`       audit trail of every state change
- `can_manage_payroll_connectors()` permission helper (account owner OR can_view_billing, same as commissions)
- RPCs: get_payroll_export_preview, create_payroll_export, void_payroll_export,
        record_payroll_export_download, mark_payroll_export_submitted, save_payroll_connection,
        set_payroll_employee_link, set_payroll_employee_links, get_payroll_mapping, get_payroll_export_detail

## Sources (read, never changed, by this migration)
- hours        timesheets      status = 'approved', pay_run_item_id IS NULL, work_date inside the period
- commissions  commission_records  status = 'approved', pay_run_item_id IS NULL, earned_date <= period end
                               (earned + adjustment + clawback; a NEGATIVE net per employee is never exported,
                               it carries forward, exactly like commission statements do)
- tips         tips            status = 'paid', pay_run_item_id IS NULL, created_at::date <= period end

## Money safety
1. A source row can belong to ONE active export (partial unique index) -> no double export, even under races
   (creation is serialised per account with an advisory lock).
2. A source already attached to a Vireek pay run is never exported; a source already exported can never be
   attached to a Vireek pay run (guard trigger raises PAYROLL_EXPORT_LOCK). Void the export to release it.
3. Voiding releases the sources. It does NOT recall data already sent to a provider, so voiding a delivered
   batch requires an explicit acknowledgement.
4. Nothing here posts to the general ledger: like commission statements paid outside Vireek, the outside
   provider owns withholding and cash. Vireek only records what was handed over.

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Tokens never touch an RLS-readable table: `payroll_connection_secrets` has RLS on, zero policies and
   revoked privileges (service role only; encrypted by the edge function).
3. Clients can READ connections / links / exports / lines / events when can_manage_payroll_connectors().
   They can NEVER write them directly: every write goes through a SECURITY DEFINER RPC that re-checks the
   permission and validates input, or through the edge function (service role).
*/

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_payroll_connectors()
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
        AND tm.account_owner_id = public.get_account_owner_id()
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_payroll_connectors() TO authenticated;

CREATE OR REPLACE FUNCTION public._require_payroll_connector_access()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_payroll_connectors() THEN
    RAISE EXCEPTION 'Not authorized to manage payroll connectors' USING ERRCODE = '42501';
  END IF;
  RETURN public.get_account_owner_id();
END;
$$;
REVOKE ALL ON FUNCTION public._require_payroll_connector_access() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 2. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payroll_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                  -- account owner id
  provider text NOT NULL CHECK (provider IN ('gusto', 'adp', 'paychex', 'rippling')),
  mode text NOT NULL DEFAULT 'file' CHECK (mode IN ('file', 'api')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  external_company_id text CHECK (external_company_id IS NULL OR char_length(external_company_id) <= 80),
  company_name text CHECK (company_name IS NULL OR char_length(company_name) <= 200),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,            -- validated by _payroll_clean_settings
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,                -- server-written (e.g. companies the OAuth user can access)
  connected_by uuid,
  last_exported_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

DROP TRIGGER IF EXISTS trg_payroll_connections_touch ON public.payroll_connections;
CREATE TRIGGER trg_payroll_connections_touch BEFORE UPDATE ON public.payroll_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.payroll_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_connections FROM anon, authenticated;
GRANT SELECT ON public.payroll_connections TO authenticated;
DROP POLICY IF EXISTS "payroll_connections_select" ON public.payroll_connections;
CREATE POLICY "payroll_connections_select" ON public.payroll_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_connectors());

-- Secrets: service role only.
CREATE TABLE IF NOT EXISTS public.payroll_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.payroll_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.
COMMENT ON TABLE public.payroll_connection_secrets IS
  'Encrypted payroll-provider OAuth tokens. Service role only: no RLS policies and no grants for anon/authenticated.';

-- =============================================================
-- 3. EMPLOYEE LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payroll_employee_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.payroll_connections (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  external_job_id text CHECK (external_job_id IS NULL OR char_length(external_job_id) <= 80),
  external_label text CHECK (external_label IS NULL OR char_length(external_label) <= 200),
  match_source text NOT NULL DEFAULT 'manual' CHECK (match_source IN ('manual', 'email', 'name')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, employee_id),
  UNIQUE (connection_id, external_id)
);

DROP TRIGGER IF EXISTS trg_payroll_links_touch ON public.payroll_employee_links;
CREATE TRIGGER trg_payroll_links_touch BEFORE UPDATE ON public.payroll_employee_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.payroll_employee_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_employee_links FROM anon, authenticated;
GRANT SELECT ON public.payroll_employee_links TO authenticated;
DROP POLICY IF EXISTS "payroll_links_select" ON public.payroll_employee_links;
CREATE POLICY "payroll_links_select" ON public.payroll_employee_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_connectors());

-- =============================================================
-- 4. EXPORTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payroll_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid REFERENCES public.payroll_connections (id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('gusto', 'adp', 'paychex', 'rippling')),
  delivery text NOT NULL DEFAULT 'file' CHECK (delivery IN ('file', 'api')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'delivering', 'delivered', 'partial', 'failed', 'void')),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 80),
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_name text,
  file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  downloaded_at timestamptz,
  external_ref text,
  last_error text,
  lock_until timestamptz,
  delivered_at timestamptz,
  delivered_by uuid,
  created_by uuid,
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_exports_idempotency
  ON public.payroll_exports (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_exports_user_created ON public.payroll_exports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_exports_provider_period ON public.payroll_exports (user_id, provider, period_start, period_end);

DROP TRIGGER IF EXISTS trg_payroll_exports_touch ON public.payroll_exports;
CREATE TRIGGER trg_payroll_exports_touch BEFORE UPDATE ON public.payroll_exports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.payroll_export_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  export_id uuid NOT NULL REFERENCES public.payroll_exports (id) ON DELETE CASCADE,
  employee_id uuid REFERENCES public.employees (id) ON DELETE SET NULL,
  employee_name text NOT NULL,                              -- snapshot, survives employee edits
  external_id text NOT NULL,                                -- snapshot of the provider id used
  external_job_id text,
  regular_hours numeric(10,3) NOT NULL DEFAULT 0 CHECK (regular_hours >= 0),
  overtime_hours numeric(10,3) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  commission_cents bigint NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  tip_cents bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'unchanged', 'conflict', 'error')),
  delivery_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_export_lines_employee
  ON public.payroll_export_lines (export_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_export_lines_export ON public.payroll_export_lines (export_id);

DROP TRIGGER IF EXISTS trg_payroll_export_lines_touch ON public.payroll_export_lines;
CREATE TRIGGER trg_payroll_export_lines_touch BEFORE UPDATE ON public.payroll_export_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.payroll_export_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  export_id uuid NOT NULL REFERENCES public.payroll_exports (id) ON DELETE CASCADE,
  employee_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('timesheet', 'commission', 'tip')),
  source_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- THE double-export guarantee: one source row can sit in at most one ACTIVE export.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_export_sources_active
  ON public.payroll_export_sources (source_type, source_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_payroll_export_sources_export ON public.payroll_export_sources (export_id);

CREATE TABLE IF NOT EXISTS public.payroll_export_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  export_id uuid NOT NULL REFERENCES public.payroll_exports (id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('created', 'downloaded', 'submitted', 'delivery_started', 'delivered', 'delivery_partial', 'delivery_failed', 'voided')),
  message text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_export_events_export ON public.payroll_export_events (export_id, created_at);

ALTER TABLE public.payroll_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_export_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_export_sources ENABLE ROW LEVEL SECURITY;   -- no policies: RPC / service role only
ALTER TABLE public.payroll_export_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_exports, public.payroll_export_lines, public.payroll_export_sources, public.payroll_export_events FROM anon, authenticated;
GRANT SELECT ON public.payroll_exports, public.payroll_export_lines, public.payroll_export_events TO authenticated;

DROP POLICY IF EXISTS "payroll_exports_select" ON public.payroll_exports;
CREATE POLICY "payroll_exports_select" ON public.payroll_exports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_connectors());
DROP POLICY IF EXISTS "payroll_export_lines_select" ON public.payroll_export_lines;
CREATE POLICY "payroll_export_lines_select" ON public.payroll_export_lines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_connectors());
DROP POLICY IF EXISTS "payroll_export_events_select" ON public.payroll_export_events;
CREATE POLICY "payroll_export_events_select" ON public.payroll_export_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_connectors());

-- =============================================================
-- 5. DOUBLE-PAY GUARD (Vireek pay run vs. external export)
--    create_pay_run() attaches rows by setting pay_run_item_id. If that row was already exported to an
--    outside provider the whole pay run is refused (fail closed) instead of paying the same hours twice.
-- =============================================================

CREATE OR REPLACE FUNCTION public._payroll_export_guard_pay_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.pay_run_item_id IS NOT NULL AND OLD.pay_run_item_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.payroll_export_sources s
       WHERE s.source_type = TG_ARGV[0] AND s.source_id = NEW.id AND s.active
     )
  THEN
    RAISE EXCEPTION 'PAYROLL_EXPORT_LOCK: a % in this pay run was already exported to an outside payroll provider. Void that export (Payroll connectors > History) before including it in a Vireek pay run.', TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._payroll_export_guard_pay_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_payroll_export_guard ON public.timesheets;
CREATE TRIGGER trg_payroll_export_guard BEFORE UPDATE OF pay_run_item_id ON public.timesheets
  FOR EACH ROW WHEN (OLD.pay_run_item_id IS NULL AND NEW.pay_run_item_id IS NOT NULL)
  EXECUTE FUNCTION public._payroll_export_guard_pay_run('timesheet');

DROP TRIGGER IF EXISTS trg_payroll_export_guard ON public.commission_records;
CREATE TRIGGER trg_payroll_export_guard BEFORE UPDATE OF pay_run_item_id ON public.commission_records
  FOR EACH ROW WHEN (OLD.pay_run_item_id IS NULL AND NEW.pay_run_item_id IS NOT NULL)
  EXECUTE FUNCTION public._payroll_export_guard_pay_run('commission');

DROP TRIGGER IF EXISTS trg_payroll_export_guard ON public.tips;
CREATE TRIGGER trg_payroll_export_guard BEFORE UPDATE OF pay_run_item_id ON public.tips
  FOR EACH ROW WHEN (OLD.pay_run_item_id IS NULL AND NEW.pay_run_item_id IS NOT NULL)
  EXECUTE FUNCTION public._payroll_export_guard_pay_run('tip');

-- =============================================================
-- 6. INTERNAL HELPERS
-- =============================================================

-- Validates + normalises connection settings. Mirrors validateSettings() in
-- supabase/functions/_shared/payroll-connectors/engine.ts.
CREATE OR REPLACE FUNCTION public._payroll_clean_settings(p_provider text, p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_defaults jsonb := jsonb_build_object(
    'earnings', jsonb_build_object('regular', 'Regular Hours', 'overtime', 'Overtime', 'commission', 'Commission', 'tips', 'Paycheck Tips'),
    'adp', jsonb_build_object('co_code', '', 'batch_prefix', 'VRK')
  );
  v_in jsonb := coalesce(p_settings, '{}'::jsonb);
  v_out jsonb := v_defaults;
  k text;
  sk text;
  v text;
BEGIN
  IF jsonb_typeof(v_in) <> 'object' THEN RAISE EXCEPTION 'Settings must be an object'; END IF;
  FOR k IN SELECT jsonb_object_keys(v_in) LOOP
    IF k NOT IN ('earnings', 'adp') THEN RAISE EXCEPTION 'Unknown setting: %', k; END IF;
    IF jsonb_typeof(v_in -> k) <> 'object' THEN RAISE EXCEPTION 'Setting % must be an object', k; END IF;
    FOR sk IN SELECT jsonb_object_keys(v_in -> k) LOOP
      IF jsonb_typeof(v_in -> k -> sk) <> 'string' THEN RAISE EXCEPTION 'Setting %.% must be text', k, sk; END IF;
      v := btrim(v_in -> k ->> sk);
      IF k = 'earnings' THEN
        IF sk NOT IN ('regular', 'overtime', 'commission', 'tips') THEN RAISE EXCEPTION 'Unknown earning: %', sk; END IF;
        IF v !~ '^[A-Za-z0-9][A-Za-z0-9 _/&.-]{0,39}$' THEN
          RAISE EXCEPTION 'Earning name for % must be 1-40 letters, numbers, spaces or _ / & . -', sk;
        END IF;
      ELSIF sk = 'co_code' THEN
        IF v !~ '^[A-Za-z0-9]{0,6}$' THEN RAISE EXCEPTION 'ADP company code must be up to 6 letters or numbers'; END IF;
      ELSIF sk = 'batch_prefix' THEN
        IF v !~ '^[A-Za-z0-9]{0,4}$' THEN RAISE EXCEPTION 'ADP batch prefix must be up to 4 letters or numbers'; END IF;
      ELSE
        RAISE EXCEPTION 'Unknown ADP setting: %', sk;
      END IF;
      v_out := jsonb_set(v_out, ARRAY[k, sk], to_jsonb(v));
    END LOOP;
  END LOOP;
  -- Gusto earning names are fixed by the Gusto API.
  IF p_provider = 'gusto' THEN
    v_out := jsonb_set(v_out, '{earnings}', v_defaults -> 'earnings');
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public._payroll_clean_settings(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._payroll_check_period(p_start date, p_end date)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'INVALID_PERIOD: choose a start date on or before the end date';
  END IF;
  IF p_end - p_start > 92 THEN
    RAISE EXCEPTION 'INVALID_PERIOD: a payroll export can cover at most 93 days';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._payroll_check_period(date, date) FROM PUBLIC, anon, authenticated;

-- Everything exportable for one account + connection + period. Used by BOTH the preview and the real
-- export so what the owner reviews is exactly what is exported. Rows without a provider id carry the
-- 'unmapped' flag; a negative commission net is zeroed and flagged (it carries forward).
CREATE OR REPLACE FUNCTION public._payroll_export_compute(p_owner uuid, p_connection_id uuid, p_start date, p_end date)
RETURNS TABLE (
  employee_id uuid,
  employee_name text,
  external_id text,
  external_job_id text,
  regular_hours numeric,
  overtime_hours numeric,
  commission_cents bigint,
  tip_cents bigint,
  timesheet_ids uuid[],
  commission_ids uuid[],
  tip_ids uuid[],
  flags text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH emp AS (
    SELECT e.id, e.full_name, e.team_member_id, l.external_id, l.external_job_id
    FROM public.employees e
    LEFT JOIN public.payroll_employee_links l ON l.employee_id = e.id AND l.connection_id = p_connection_id
    WHERE e.user_id = p_owner AND e.active
  ),
  ts AS (
    SELECT t.employee_id AS emp_id, round(sum(t.regular_hours), 3) AS reg, round(sum(t.overtime_hours), 3) AS ot, array_agg(t.id) AS ids
    FROM public.timesheets t
    WHERE t.user_id = p_owner AND t.status = 'approved' AND t.pay_run_item_id IS NULL
      AND t.work_date BETWEEN p_start AND p_end
      AND NOT EXISTS (SELECT 1 FROM public.payroll_export_sources s WHERE s.source_type = 'timesheet' AND s.source_id = t.id AND s.active)
    GROUP BY t.employee_id
  ),
  cr AS (
    SELECT c.employee_id AS emp_id, sum(c.commission_cents)::bigint AS total, array_agg(c.id) AS ids
    FROM public.commission_records c
    WHERE c.user_id = p_owner AND c.status = 'approved' AND c.pay_run_item_id IS NULL
      AND c.earned_date <= p_end
      AND NOT EXISTS (SELECT 1 FROM public.payroll_export_sources s WHERE s.source_type = 'commission' AND s.source_id = c.id AND s.active)
    GROUP BY c.employee_id
  ),
  tp AS (
    SELECT x.team_member_id AS tm_id, sum(x.amount_cents)::bigint AS total, array_agg(x.id) AS ids
    FROM public.tips x
    WHERE x.user_id = p_owner AND x.status = 'paid' AND x.pay_run_item_id IS NULL
      AND x.team_member_id IS NOT NULL AND x.created_at::date <= p_end
      AND NOT EXISTS (SELECT 1 FROM public.payroll_export_sources s WHERE s.source_type = 'tip' AND s.source_id = x.id AND s.active)
    GROUP BY x.team_member_id
  )
  SELECT
    emp.id,
    emp.full_name,
    emp.external_id,
    emp.external_job_id,
    coalesce(ts.reg, 0)::numeric,
    coalesce(ts.ot, 0)::numeric,
    (CASE WHEN coalesce(cr.total, 0) > 0 THEN cr.total ELSE 0 END)::bigint,
    coalesce(tp.total, 0)::bigint,
    coalesce(ts.ids, ARRAY[]::uuid[]),
    CASE WHEN coalesce(cr.total, 0) > 0 THEN cr.ids ELSE ARRAY[]::uuid[] END,
    coalesce(tp.ids, ARRAY[]::uuid[]),
    array_remove(ARRAY[
      CASE WHEN emp.external_id IS NULL THEN 'unmapped' END,
      CASE WHEN coalesce(cr.total, 0) < 0 THEN 'negative_commission' END
    ], NULL)
  FROM emp
  LEFT JOIN ts ON ts.emp_id = emp.id
  LEFT JOIN cr ON cr.emp_id = emp.id
  LEFT JOIN tp ON tp.tm_id = emp.team_member_id
  WHERE coalesce(ts.reg, 0) > 0 OR coalesce(ts.ot, 0) > 0 OR coalesce(cr.total, 0) <> 0 OR coalesce(tp.total, 0) > 0
  ORDER BY emp.full_name, emp.id;
$$;
REVOKE ALL ON FUNCTION public._payroll_export_compute(uuid, uuid, date, date) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 7. CONNECTIONS + MAPPING RPCs
-- =============================================================

-- Creates (file mode) or updates the saved profile for a provider. An existing API connection keeps its
-- mode / status / company; only the settings change.
CREATE OR REPLACE FUNCTION public.save_payroll_connection(p_provider text, p_settings jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_settings jsonb;
  v_id uuid;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('gusto', 'adp', 'paychex', 'rippling') THEN
    RAISE EXCEPTION 'Unsupported payroll provider';
  END IF;
  v_settings := public._payroll_clean_settings(p_provider, p_settings);

  INSERT INTO public.payroll_connections (user_id, provider, mode, status, settings, connected_by)
  VALUES (v_owner, p_provider, 'file', 'connected', v_settings, auth.uid())
  ON CONFLICT (user_id, provider) DO UPDATE SET settings = EXCLUDED.settings
  RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'payroll_connection_saved', 'payroll_connections', v_id::text);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_payroll_mapping(p_connection_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payroll_connections WHERE id = p_connection_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Connection not found';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', e.id,
      'name', e.full_name,
      'email', tm.member_email,
      'active', e.active,
      'pay_type', e.pay_type,
      'external_id', l.external_id,
      'external_job_id', l.external_job_id,
      'label', l.external_label,
      'match_source', l.match_source
    ) ORDER BY e.active DESC, e.full_name, e.id), '[]'::jsonb)
  INTO v_result
  FROM public.employees e
  LEFT JOIN public.team_members tm ON tm.id = e.team_member_id
  LEFT JOIN public.payroll_employee_links l ON l.employee_id = e.id AND l.connection_id = p_connection_id
  WHERE e.user_id = v_owner;
  RETURN v_result;
END;
$$;

-- Set (or clear, when p_external_id is blank) the provider id for one employee.
CREATE OR REPLACE FUNCTION public.set_payroll_employee_link(
  p_connection_id uuid,
  p_employee_id uuid,
  p_external_id text,
  p_external_job_id text DEFAULT NULL,
  p_label text DEFAULT NULL,
  p_match_source text DEFAULT 'manual'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_ext text := btrim(coalesce(p_external_id, ''));
  v_job text := nullif(btrim(coalesce(p_external_job_id, '')), '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payroll_connections WHERE id = p_connection_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Connection not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF v_ext = '' THEN
    DELETE FROM public.payroll_employee_links WHERE connection_id = p_connection_id AND employee_id = p_employee_id;
    RETURN;
  END IF;

  IF v_ext !~ '^[A-Za-z0-9][A-Za-z0-9 ._@+#/:-]{0,79}$' THEN
    RAISE EXCEPTION 'INVALID_EXTERNAL_ID: use 1-80 letters, numbers or . _ @ + # / : - (no leading symbol)';
  END IF;
  IF v_job IS NOT NULL AND v_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
    RAISE EXCEPTION 'INVALID_EXTERNAL_ID: the job id has unsupported characters';
  END IF;

  BEGIN
    INSERT INTO public.payroll_employee_links (user_id, connection_id, employee_id, external_id, external_job_id, external_label, match_source)
    VALUES (v_owner, p_connection_id, p_employee_id, v_ext, v_job, left(v_label, 200),
            CASE WHEN p_match_source IN ('manual', 'email', 'name') THEN p_match_source ELSE 'manual' END)
    ON CONFLICT (connection_id, employee_id) DO UPDATE SET
      external_id = EXCLUDED.external_id,
      external_job_id = EXCLUDED.external_job_id,
      external_label = EXCLUDED.external_label,
      match_source = EXCLUDED.match_source;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_EXTERNAL_ID: that provider id is already assigned to another employee';
  END;
END;
$$;

-- Bulk version used by "Auto-match": p_links = [{employee_id, external_id, external_job_id?, label?, match_source?}]
CREATE OR REPLACE FUNCTION public.set_payroll_employee_links(p_connection_id uuid, p_links jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_link jsonb;
  v_n integer := 0;
BEGIN
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' THEN RAISE EXCEPTION 'Links must be a list'; END IF;
  IF jsonb_array_length(p_links) > 500 THEN RAISE EXCEPTION 'Too many links in one request'; END IF;
  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    PERFORM public.set_payroll_employee_link(
      p_connection_id,
      (v_link ->> 'employee_id')::uuid,
      v_link ->> 'external_id',
      v_link ->> 'external_job_id',
      v_link ->> 'label',
      coalesce(v_link ->> 'match_source', 'manual')
    );
    v_n := v_n + 1;
  END LOOP;
  PERFORM public.log_audit_event(v_owner, 'payroll_links_bulk_set', 'payroll_connections', p_connection_id::text);
  RETURN v_n;
END;
$$;

-- =============================================================
-- 8. PREVIEW + CREATE EXPORT
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_payroll_export_preview(p_provider text, p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_conn public.payroll_connections%ROWTYPE;
  v_lines jsonb;
  v_totals jsonb;
  v_unmapped integer;
  v_negative integer;
  v_pending integer;
  v_overlap integer;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('gusto', 'adp', 'paychex', 'rippling') THEN
    RAISE EXCEPTION 'Unsupported payroll provider';
  END IF;
  PERFORM public._payroll_check_period(p_start, p_end);

  SELECT * INTO v_conn FROM public.payroll_connections WHERE user_id = v_owner AND provider = p_provider;

  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', r.employee_id,
      'employee_name', r.employee_name,
      'external_id', r.external_id,
      'external_job_id', r.external_job_id,
      'regular_hours', r.regular_hours,
      'overtime_hours', r.overtime_hours,
      'commission_cents', r.commission_cents,
      'tip_cents', r.tip_cents,
      'flags', to_jsonb(r.flags),
      'timesheet_count', cardinality(r.timesheet_ids),
      'commission_count', cardinality(r.commission_ids),
      'tip_count', cardinality(r.tip_ids)
    ) ORDER BY r.employee_name, r.employee_id), '[]'::jsonb),
    count(*) FILTER (WHERE 'unmapped' = ANY (r.flags)),
    count(*) FILTER (WHERE 'negative_commission' = ANY (r.flags)),
    jsonb_build_object(
      'employees', count(*) FILTER (WHERE r.external_id IS NOT NULL AND (r.regular_hours > 0 OR r.overtime_hours > 0 OR r.commission_cents > 0 OR r.tip_cents > 0)),
      'regular_hours', coalesce(sum(r.regular_hours) FILTER (WHERE r.external_id IS NOT NULL), 0),
      'overtime_hours', coalesce(sum(r.overtime_hours) FILTER (WHERE r.external_id IS NOT NULL), 0),
      'commission_cents', coalesce(sum(r.commission_cents) FILTER (WHERE r.external_id IS NOT NULL), 0),
      'tip_cents', coalesce(sum(r.tip_cents) FILTER (WHERE r.external_id IS NOT NULL), 0)
    )
  INTO v_lines, v_unmapped, v_negative, v_totals
  FROM public._payroll_export_compute(v_owner, v_conn.id, p_start, p_end) r;

  SELECT count(*) INTO v_pending FROM public.timesheets t
    WHERE t.user_id = v_owner AND t.status = 'pending' AND t.work_date BETWEEN p_start AND p_end;
  SELECT count(*) INTO v_overlap FROM public.payroll_exports x
    WHERE x.user_id = v_owner AND x.provider = p_provider AND x.status <> 'void'
      AND x.period_start <= p_end AND x.period_end >= p_start;

  IF v_unmapped > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'unmapped', 'count', v_unmapped,
      'message', v_unmapped || ' employee(s) have pay data but no provider ID yet. They are left out and stay available for the next export.');
  END IF;
  IF v_negative > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'negative_commission', 'count', v_negative,
      'message', v_negative || ' employee(s) have a negative commission balance (clawbacks). It carries forward and is not exported.');
  END IF;
  IF v_pending > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'pending_timesheets', 'count', v_pending,
      'message', v_pending || ' timesheet(s) in this period are still pending approval and are not included.');
  END IF;
  IF v_overlap > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'overlap', 'count', v_overlap,
      'message', 'You already exported this provider for an overlapping period. Items already exported are never included twice.');
  END IF;

  RETURN jsonb_build_object(
    'provider', p_provider,
    'period_start', p_start,
    'period_end', p_end,
    'connection', CASE WHEN v_conn.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_conn.id, 'mode', v_conn.mode, 'status', v_conn.status, 'company_name', v_conn.company_name,
      'external_company_id', v_conn.external_company_id) END,
    'lines', v_lines,
    'totals', v_totals,
    'warnings', v_warnings
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_payroll_export(
  p_provider text,
  p_start date,
  p_end date,
  p_delivery text DEFAULT 'file',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_conn public.payroll_connections%ROWTYPE;
  v_id uuid;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  r record;
  v_emps integer := 0;
  v_reg numeric := 0;
  v_ot numeric := 0;
  v_comm bigint := 0;
  v_tips bigint := 0;
  v_unmapped integer := 0;
  v_negative integer := 0;
  v_pending integer;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('gusto', 'adp', 'paychex', 'rippling') THEN
    RAISE EXCEPTION 'Unsupported payroll provider';
  END IF;
  IF p_delivery IS NULL OR p_delivery NOT IN ('file', 'api') THEN
    RAISE EXCEPTION 'Unsupported delivery method';
  END IF;
  PERFORM public._payroll_check_period(p_start, p_end);

  -- One export is built at a time per account, so two clicks can never claim the same rows.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':payroll_export', 0));

  IF v_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.payroll_exports WHERE user_id = v_owner AND idempotency_key = v_key;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  SELECT * INTO v_conn FROM public.payroll_connections WHERE user_id = v_owner AND provider = p_provider;
  IF v_conn.id IS NULL THEN
    RAISE EXCEPTION 'NO_CONNECTION: set up this provider first (Payroll connectors > Connections)';
  END IF;
  IF p_delivery = 'api' AND (v_conn.mode <> 'api' OR v_conn.status <> 'connected' OR v_conn.external_company_id IS NULL) THEN
    RAISE EXCEPTION 'API_NOT_CONNECTED: connect % and choose its company before sending through the API', p_provider;
  END IF;

  INSERT INTO public.payroll_exports (user_id, connection_id, provider, delivery, period_start, period_end, idempotency_key, created_by)
  VALUES (v_owner, v_conn.id, p_provider, p_delivery, p_start, p_end, v_key, auth.uid())
  RETURNING id INTO v_id;

  FOR r IN SELECT * FROM public._payroll_export_compute(v_owner, v_conn.id, p_start, p_end) LOOP
    IF 'unmapped' = ANY (r.flags) THEN v_unmapped := v_unmapped + 1; END IF;
    IF 'negative_commission' = ANY (r.flags) THEN v_negative := v_negative + 1; END IF;
    IF r.external_id IS NULL THEN CONTINUE; END IF;
    IF NOT (r.regular_hours > 0 OR r.overtime_hours > 0 OR r.commission_cents > 0 OR r.tip_cents > 0) THEN CONTINUE; END IF;

    INSERT INTO public.payroll_export_lines (user_id, export_id, employee_id, employee_name, external_id, external_job_id,
                                             regular_hours, overtime_hours, commission_cents, tip_cents)
    VALUES (v_owner, v_id, r.employee_id, r.employee_name, r.external_id, r.external_job_id,
            r.regular_hours, r.overtime_hours, r.commission_cents, r.tip_cents);

    INSERT INTO public.payroll_export_sources (user_id, export_id, employee_id, source_type, source_id)
    SELECT v_owner, v_id, r.employee_id, 'timesheet', x FROM unnest(r.timesheet_ids) AS x
    UNION ALL SELECT v_owner, v_id, r.employee_id, 'commission', x FROM unnest(r.commission_ids) AS x
    UNION ALL SELECT v_owner, v_id, r.employee_id, 'tip', x FROM unnest(r.tip_ids) AS x;

    v_emps := v_emps + 1;
    v_reg := v_reg + r.regular_hours;
    v_ot := v_ot + r.overtime_hours;
    v_comm := v_comm + r.commission_cents;
    v_tips := v_tips + r.tip_cents;
  END LOOP;

  IF v_emps = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_EXPORT: no approved hours, commissions or tips with a provider ID were found for this period';
  END IF;

  SELECT count(*) INTO v_pending FROM public.timesheets t
    WHERE t.user_id = v_owner AND t.status = 'pending' AND t.work_date BETWEEN p_start AND p_end;
  IF v_unmapped > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'unmapped', 'count', v_unmapped, 'message', v_unmapped || ' employee(s) without a provider ID were left out.');
  END IF;
  IF v_negative > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'negative_commission', 'count', v_negative, 'message', v_negative || ' negative commission balance(s) carried forward.');
  END IF;
  IF v_pending > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'pending_timesheets', 'count', v_pending, 'message', v_pending || ' pending timesheet(s) were not included.');
  END IF;

  UPDATE public.payroll_exports SET
    totals = jsonb_build_object('employees', v_emps, 'regular_hours', v_reg, 'overtime_hours', v_ot, 'commission_cents', v_comm, 'tip_cents', v_tips),
    warnings = v_warnings
  WHERE id = v_id;

  INSERT INTO public.payroll_export_events (user_id, export_id, event, message, actor)
  VALUES (v_owner, v_id, 'created', v_emps || ' employee(s), ' || p_start || ' to ' || p_end || ', ' || p_delivery, auth.uid());
  PERFORM public.log_audit_event(v_owner, 'payroll_export_created', 'payroll_exports', v_id::text);
  RETURN v_id;
END;
$$;

-- =============================================================
-- 9. LIFECYCLE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_payroll_export_download(p_id uuid, p_file_name text, p_sha256 text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_status text;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid file checksum'; END IF;
  SELECT status INTO v_status FROM public.payroll_exports WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Export not found'; END IF;
  IF v_status = 'void' THEN RAISE EXCEPTION 'This export was voided'; END IF;

  UPDATE public.payroll_exports
    SET downloaded_at = now(), file_name = left(btrim(coalesce(p_file_name, '')), 200), file_sha256 = p_sha256
  WHERE id = p_id;
  INSERT INTO public.payroll_export_events (user_id, export_id, event, message, actor)
  VALUES (v_owner, p_id, 'downloaded', left(coalesce(p_file_name, ''), 200) || ' sha256:' || left(p_sha256, 12), auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payroll_export_submitted(p_id uuid, p_reference text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_exp public.payroll_exports%ROWTYPE;
BEGIN
  SELECT * INTO v_exp FROM public.payroll_exports WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF v_exp.id IS NULL THEN RAISE EXCEPTION 'Export not found'; END IF;
  IF v_exp.delivery <> 'file' THEN RAISE EXCEPTION 'API exports are marked delivered automatically'; END IF;
  IF v_exp.status <> 'ready' THEN RAISE EXCEPTION 'Only a ready export can be marked as submitted'; END IF;
  IF v_exp.downloaded_at IS NULL THEN RAISE EXCEPTION 'DOWNLOAD_REQUIRED: download the file first'; END IF;

  UPDATE public.payroll_exports SET
    status = 'delivered', delivered_at = now(), delivered_by = auth.uid(),
    external_ref = nullif(left(btrim(coalesce(p_reference, '')), 120), '')
  WHERE id = p_id;
  UPDATE public.payroll_connections SET last_exported_at = now() WHERE id = v_exp.connection_id;
  INSERT INTO public.payroll_export_events (user_id, export_id, event, message, actor)
  VALUES (v_owner, p_id, 'submitted', nullif(left(btrim(coalesce(p_reference, '')), 120), ''), auth.uid());
  PERFORM public.log_audit_event(v_owner, 'payroll_export_submitted', 'payroll_exports', p_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.void_payroll_export(p_id uuid, p_reason text, p_acknowledge_provider boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_exp public.payroll_exports%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 300 THEN
    RAISE EXCEPTION 'Enter a reason between 3 and 300 characters';
  END IF;
  SELECT * INTO v_exp FROM public.payroll_exports WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF v_exp.id IS NULL THEN RAISE EXCEPTION 'Export not found'; END IF;
  IF v_exp.status = 'void' THEN RETURN; END IF;
  IF v_exp.status = 'delivering' AND v_exp.lock_until IS NOT NULL AND v_exp.lock_until > now() THEN
    RAISE EXCEPTION 'IN_PROGRESS: this export is being sent right now, try again in a minute';
  END IF;
  IF v_exp.status IN ('delivered', 'partial') AND NOT coalesce(p_acknowledge_provider, false) THEN
    RAISE EXCEPTION 'ACK_REQUIRED: this export was already handed to %. Voiding releases the hours, commissions and tips here but does not recall them from the provider.', v_exp.provider;
  END IF;

  UPDATE public.payroll_export_sources SET active = false WHERE export_id = p_id AND active;
  UPDATE public.payroll_exports SET
    status = 'void', void_reason = v_reason, voided_at = now(), voided_by = auth.uid(), lock_until = NULL
  WHERE id = p_id;
  INSERT INTO public.payroll_export_events (user_id, export_id, event, message, actor)
  VALUES (v_owner, p_id, 'voided', v_reason, auth.uid());
  PERFORM public.log_audit_event(v_owner, 'payroll_export_voided', 'payroll_exports', p_id::text);
END;
$$;

-- Full detail for the History drawer. `drift` is true when the live source rows no longer add up to what
-- was exported (e.g. a tip was refunded or a timesheet was edited after the export).
CREATE OR REPLACE FUNCTION public.get_payroll_export_detail(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._require_payroll_connector_access();
  v_export jsonb;
  v_lines jsonb;
  v_events jsonb;
BEGIN
  SELECT to_jsonb(x) INTO v_export FROM public.payroll_exports x WHERE x.id = p_id AND x.user_id = v_owner;
  IF v_export IS NULL THEN RAISE EXCEPTION 'Export not found'; END IF;

  WITH cur_ts AS (
    SELECT s.employee_id AS emp_id, round(sum(t.regular_hours), 3) AS reg, round(sum(t.overtime_hours), 3) AS ot
    FROM public.payroll_export_sources s JOIN public.timesheets t ON t.id = s.source_id
    WHERE s.export_id = p_id AND s.source_type = 'timesheet' GROUP BY s.employee_id
  ), cur_cm AS (
    SELECT s.employee_id AS emp_id, sum(c.commission_cents) AS total
    FROM public.payroll_export_sources s JOIN public.commission_records c ON c.id = s.source_id
    WHERE s.export_id = p_id AND s.source_type = 'commission' GROUP BY s.employee_id
  ), cur_tp AS (
    SELECT s.employee_id AS emp_id, sum(x.amount_cents) FILTER (WHERE x.status = 'paid') AS total
    FROM public.payroll_export_sources s JOIN public.tips x ON x.id = s.source_id
    WHERE s.export_id = p_id AND s.source_type = 'tip' GROUP BY s.employee_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id,
      'employee_id', l.employee_id,
      'employee_name', l.employee_name,
      'external_id', l.external_id,
      'external_job_id', l.external_job_id,
      'regular_hours', l.regular_hours,
      'overtime_hours', l.overtime_hours,
      'commission_cents', l.commission_cents,
      'tip_cents', l.tip_cents,
      'delivery_status', l.delivery_status,
      'delivery_message', l.delivery_message,
      'drift', (
        coalesce(cur_ts.reg, 0) <> l.regular_hours OR coalesce(cur_ts.ot, 0) <> l.overtime_hours
        OR coalesce(cur_cm.total, 0) <> l.commission_cents OR coalesce(cur_tp.total, 0) <> l.tip_cents
      )
    ) ORDER BY l.employee_name, l.id), '[]'::jsonb)
  INTO v_lines
  FROM public.payroll_export_lines l
  LEFT JOIN cur_ts ON cur_ts.emp_id = l.employee_id
  LEFT JOIN cur_cm ON cur_cm.emp_id = l.employee_id
  LEFT JOIN cur_tp ON cur_tp.emp_id = l.employee_id
  WHERE l.export_id = p_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ev.id, 'event', ev.event, 'message', ev.message, 'created_at', ev.created_at)
         ORDER BY ev.created_at, ev.id), '[]'::jsonb)
  INTO v_events
  FROM public.payroll_export_events ev WHERE ev.export_id = p_id;

  RETURN jsonb_build_object('export', v_export, 'lines', v_lines, 'events', v_events);
END;
$$;

-- =============================================================
-- 10. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.save_payroll_connection(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_payroll_mapping(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_payroll_employee_link(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_payroll_employee_links(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_payroll_export_preview(text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_payroll_export(text, date, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_payroll_export_download(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_payroll_export_submitted(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_payroll_export(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_payroll_export_detail(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_payroll_connection(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payroll_mapping(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_payroll_employee_link(uuid, uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_payroll_employee_links(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payroll_export_preview(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payroll_export(text, date, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_payroll_export_download(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payroll_export_submitted(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_payroll_export(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payroll_export_detail(uuid) TO authenticated;
