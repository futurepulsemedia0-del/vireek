/*
# Payroll provider integrations (Gusto first; ADP, Paychex, QuickBooks Payroll next)

Replaces the CSV-only payroll hand-off with provider connectors:
approved HOURS, OVERTIME and COMMISSIONS go to the provider as a reviewed, approved,
idempotent batch. Vireek never submits/finalises a payroll at the provider and never moves money:
it only fills the provider's own unprocessed pay period, and the employer still reviews and runs it there.

## Tables (all user_id = ACCOUNT OWNER id, get_account_owner_id())
- payroll_connections         one row per owner + provider (settings, status, company)
- payroll_connection_secrets  OAuth tokens, ENCRYPTED by the edge functions, service-role only
- payroll_employee_links      Vireek employee <-> provider employee (suggested by name, CONFIRMED by a person)
- payroll_sync_batches        one reviewed hand-off for a pay period (draft > pending_approval > approved > syncing > synced/partial/failed)
- payroll_sync_lines          frozen per-employee snapshot: regular hrs, overtime hrs, commission
- payroll_sync_sources        which timesheets / commission statements a live batch has claimed (UNIQUE while live = never sent twice)
- payroll_sync_events         audit trail

## Safety rules
1. Clients can only READ. Every write is an RPC (permission + ownership checked) or service-role only.
2. A timesheet / commission statement can belong to ONE live batch (partial unique index).
3. Approval re-checks that nothing underneath the batch changed (drift check) and that every line is mapped.
4. A BEFORE UPDATE guard stops a Vireek pay run from also paying anything already handed to a provider.
   (If you never use Vireek pay runs it never fires. To remove it: DROP TRIGGER trg_payroll_sync_guard_ts ON timesheets;
   and DROP TRIGGER trg_payroll_sync_guard_cr ON commission_records;)
5. Only hourly W-2 employees get hours (salaried staff are never sent hours); 1099 contractors are listed as skipped.

Idempotent migration: safe to run more than once.
*/

DO $$
BEGIN
  IF to_regclass('public.employees') IS NULL OR to_regclass('public.timesheets') IS NULL
     OR to_regclass('public.commission_records') IS NULL OR to_regclass('public.commission_statements') IS NULL THEN
    RAISE EXCEPTION 'Run the payroll (20261204000000) and commissions (20270402000000) migrations first.';
  END IF;
  IF to_regprocedure('public.has_account_permission(text)') IS NULL THEN
    RAISE EXCEPTION 'public.has_account_permission(text) is missing (it is created by 20271110000000_pm_integrations.sql).';
  END IF;
END $$;

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_payroll_sync()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_payroll_sync() TO authenticated;

CREATE OR REPLACE FUNCTION public._require_payroll_sync_access()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_payroll_sync() THEN
    RAISE EXCEPTION 'Not authorized to manage payroll integrations' USING ERRCODE = '42501';
  END IF;
  RETURN public.get_account_owner_id();
END;
$$;
REVOKE ALL ON FUNCTION public._require_payroll_sync_access() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payroll_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('gusto', 'adp', 'paychex', 'quickbooks_payroll')),
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  external_company_id text,
  company_name text,
  settings jsonb NOT NULL DEFAULT '{"regular_name":"Regular Hours","overtime_name":"Overtime","commission_name":"Commission","require_separate_approver":false}'::jsonb,
  connected_by uuid,
  last_error text,
  last_verified_at timestamptz,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_connections_owner_provider ON public.payroll_connections (user_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_connections_live_company
  ON public.payroll_connections (provider, external_company_id)
  WHERE status <> 'disconnected' AND external_company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.payroll_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.payroll_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_employee_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.payroll_connections (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  external_employee_id text NOT NULL,
  external_name text,
  match_method text NOT NULL DEFAULT 'manual' CHECK (match_method IN ('auto_name', 'manual')),
  confirmed boolean NOT NULL DEFAULT false,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, employee_id),
  UNIQUE (connection_id, external_employee_id)
);

CREATE TABLE IF NOT EXISTS public.payroll_sync_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.payroll_connections (id) ON DELETE CASCADE,
  provider text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'syncing', 'synced', 'partial', 'failed', 'cancelled')),
  line_count integer NOT NULL DEFAULT 0,
  regular_hours numeric(12, 3) NOT NULL DEFAULT 0,
  overtime_hours numeric(12, 3) NOT NULL DEFAULT 0,
  commission_cents bigint NOT NULL DEFAULT 0,
  snapshot_hash text,
  created_by uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  review_note text,
  cancel_reason text,
  external_payroll_id text,
  run_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_payroll_sync_batches_owner ON public.payroll_sync_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_sync_batches_conn_status ON public.payroll_sync_batches (connection_id, status);

CREATE TABLE IF NOT EXISTS public.payroll_sync_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.payroll_sync_batches (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees (id) ON DELETE RESTRICT,
  employee_name text NOT NULL,
  pay_type text NOT NULL,
  send_hours boolean NOT NULL DEFAULT false,
  regular_hours numeric(12, 3) NOT NULL DEFAULT 0 CHECK (regular_hours >= 0),
  overtime_hours numeric(12, 3) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  commission_cents bigint NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  line_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'unchanged', 'skipped', 'failed')),
  skip_reason text,
  external_ref text,
  error_code text,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.payroll_sync_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.payroll_sync_batches (id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('timesheet', 'commission_statement')),
  source_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_sync_sources_live ON public.payroll_sync_sources (source_type, source_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_sync_sources_batch ON public.payroll_sync_sources (batch_id);

CREATE TABLE IF NOT EXISTS public.payroll_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid,
  batch_id uuid,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_sync_events_owner ON public.payroll_sync_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_sync_events_batch ON public.payroll_sync_events (batch_id, created_at DESC);

-- updated_at touch (reuses the project's trigger function)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_connections', 'payroll_employee_links', 'payroll_sync_batches', 'payroll_sync_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================
-- 3. RLS: read-only for clients, tokens unreachable
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_connections', 'payroll_employee_links', 'payroll_sync_batches', 'payroll_sync_lines', 'payroll_sync_sources', 'payroll_sync_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_payroll_sync())', t || '_select', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

ALTER TABLE public.payroll_connection_secrets ENABLE ROW LEVEL SECURITY;   -- no policies: service role only
REVOKE ALL ON public.payroll_connection_secrets FROM anon, authenticated;

-- =============================================================
-- 4. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._payroll_sync_event(p_owner uuid, p_conn uuid, p_batch uuid, p_event text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO payroll_sync_events (user_id, connection_id, batch_id, event, detail, actor)
  VALUES (p_owner, p_conn, p_batch, p_event, COALESCE(p_detail, '{}'::jsonb), auth.uid());
$$;
REVOKE ALL ON FUNCTION public._payroll_sync_event(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Everything that COULD be handed over for a period. skip_reason IS NOT NULL rows are shown but never sent / claimed.
CREATE OR REPLACE FUNCTION public._payroll_sync_eligible(p_owner uuid, p_start date, p_end date)
RETURNS TABLE (source_type text, source_id uuid, employee_id uuid, regular_hours numeric, overtime_hours numeric, commission_cents bigint, skip_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'timesheet'::text, t.id, t.employee_id, t.regular_hours::numeric, t.overtime_hours::numeric, 0::bigint,
         CASE WHEN e.employment_type = '1099' THEN 'contractor_not_supported' END
  FROM timesheets t JOIN employees e ON e.id = t.employee_id
  WHERE t.user_id = p_owner AND t.status = 'approved' AND t.pay_run_item_id IS NULL
    AND t.work_date BETWEEN p_start AND p_end
    AND (e.pay_type = 'hourly' OR e.employment_type = '1099')
    AND NOT EXISTS (SELECT 1 FROM payroll_sync_sources s WHERE s.source_type = 'timesheet' AND s.source_id = t.id AND s.released_at IS NULL)
  UNION ALL
  SELECT 'commission_statement'::text, s.id, s.employee_id, 0::numeric, 0::numeric, s.net_cents,
         CASE WHEN e.employment_type = '1099' THEN 'contractor_not_supported' END
  FROM commission_statements s JOIN employees e ON e.id = s.employee_id
  WHERE s.user_id = p_owner AND s.status = 'approved' AND s.period_end <= p_end AND s.net_cents > 0
    AND NOT EXISTS (SELECT 1 FROM commission_records r WHERE r.statement_id = s.id AND r.pay_run_item_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM payroll_sync_sources x WHERE x.source_type = 'commission_statement' AND x.source_id = s.id AND x.released_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public._payroll_sync_eligible(uuid, date, date) FROM PUBLIC, anon, authenticated;

-- Number of unsent lines whose underlying timesheets / statements no longer match the frozen snapshot.
CREATE OR REPLACE FUNCTION public._payroll_sync_drift(p_batch_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::integer
  FROM payroll_sync_lines l
  CROSS JOIN LATERAL (
    SELECT
      COALESCE((SELECT sum(t.regular_hours) FROM payroll_sync_sources s JOIN timesheets t ON t.id = s.source_id
                WHERE s.batch_id = l.batch_id AND s.source_type = 'timesheet' AND s.released_at IS NULL AND s.employee_id = l.employee_id
                  AND t.status = 'approved' AND t.pay_run_item_id IS NULL), 0) AS reg,
      COALESCE((SELECT sum(t.overtime_hours) FROM payroll_sync_sources s JOIN timesheets t ON t.id = s.source_id
                WHERE s.batch_id = l.batch_id AND s.source_type = 'timesheet' AND s.released_at IS NULL AND s.employee_id = l.employee_id
                  AND t.status = 'approved' AND t.pay_run_item_id IS NULL), 0) AS ot,
      COALESCE((SELECT sum(cs.net_cents) FROM payroll_sync_sources s JOIN commission_statements cs ON cs.id = s.source_id
                WHERE s.batch_id = l.batch_id AND s.source_type = 'commission_statement' AND s.released_at IS NULL AND s.employee_id = l.employee_id
                  AND cs.status = 'approved'
                  AND NOT EXISTS (SELECT 1 FROM commission_records r WHERE r.statement_id = cs.id AND r.pay_run_item_id IS NOT NULL)), 0) AS comm
  ) cur
  WHERE l.batch_id = p_batch_id AND l.skip_reason IS NULL AND l.status IN ('pending', 'failed')
    AND (cur.reg <> l.regular_hours OR cur.ot <> l.overtime_hours OR cur.comm <> l.commission_cents);
$$;
REVOKE ALL ON FUNCTION public._payroll_sync_drift(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. DOUBLE-PAY GUARD (Vireek pay run vs provider hand-off)
-- =============================================================

CREATE OR REPLACE FUNCTION public._payroll_sync_guard_ts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.pay_run_item_id IS NOT NULL AND OLD.pay_run_item_id IS DISTINCT FROM NEW.pay_run_item_id
     AND EXISTS (SELECT 1 FROM payroll_sync_sources s WHERE s.source_type = 'timesheet' AND s.source_id = NEW.id AND s.released_at IS NULL) THEN
    RAISE EXCEPTION 'payroll_sync_locked: a timesheet in this pay period was already handed to your payroll provider. Exclude that period from the Vireek pay run, or cancel the provider batch first.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._payroll_sync_guard_cr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.pay_run_item_id IS NOT NULL AND OLD.pay_run_item_id IS DISTINCT FROM NEW.pay_run_item_id AND NEW.statement_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM payroll_sync_sources s WHERE s.source_type = 'commission_statement' AND s.source_id = NEW.statement_id AND s.released_at IS NULL) THEN
    RAISE EXCEPTION 'payroll_sync_locked: a commission statement was already handed to your payroll provider. Exclude it from the Vireek pay run, or cancel the provider batch first.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_sync_guard_ts ON public.timesheets;
CREATE TRIGGER trg_payroll_sync_guard_ts BEFORE UPDATE OF pay_run_item_id ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public._payroll_sync_guard_ts();
DROP TRIGGER IF EXISTS trg_payroll_sync_guard_cr ON public.commission_records;
CREATE TRIGGER trg_payroll_sync_guard_cr BEFORE UPDATE OF pay_run_item_id ON public.commission_records
  FOR EACH ROW EXECUTE FUNCTION public._payroll_sync_guard_cr();

-- =============================================================
-- 6. CLIENT RPCs (authenticated, permission + ownership checked)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_payroll_sync_settings(p_connection_id uuid, p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_payroll_sync_access();
  v_norm jsonb;
  k text;
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN RAISE EXCEPTION 'Settings must be an object.'; END IF;
  FOREACH k IN ARRAY ARRAY['regular_name', 'overtime_name', 'commission_name'] LOOP
    IF p_settings ? k AND (jsonb_typeof(p_settings -> k) <> 'string' OR char_length(btrim(p_settings ->> k)) NOT BETWEEN 1 AND 60) THEN
      RAISE EXCEPTION '% must be 1 to 60 characters.', k;
    END IF;
  END LOOP;
  IF p_settings ? 'require_separate_approver' AND jsonb_typeof(p_settings -> 'require_separate_approver') <> 'boolean' THEN
    RAISE EXCEPTION 'require_separate_approver must be true or false.';
  END IF;
  v_norm := jsonb_build_object(
    'regular_name', COALESCE(NULLIF(btrim(p_settings ->> 'regular_name'), ''), 'Regular Hours'),
    'overtime_name', COALESCE(NULLIF(btrim(p_settings ->> 'overtime_name'), ''), 'Overtime'),
    'commission_name', COALESCE(NULLIF(btrim(p_settings ->> 'commission_name'), ''), 'Commission'),
    'require_separate_approver', COALESCE((p_settings ->> 'require_separate_approver')::boolean, false)
  );
  UPDATE payroll_connections SET settings = v_norm WHERE id = p_connection_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll connection not found.'; END IF;
  PERFORM public._payroll_sync_event(v_owner, p_connection_id, NULL, 'settings_saved', v_norm);
  RETURN v_norm;
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_payroll_sync_settings(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_payroll_employee_link(p_connection_id uuid, p_employee_id uuid, p_external_id text, p_external_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_payroll_sync_access();
  v_ext text := btrim(COALESCE(p_external_id, ''));
  v_id uuid;
BEGIN
  IF v_ext = '' OR char_length(v_ext) > 80 THEN RAISE EXCEPTION 'Choose the matching employee in your payroll provider.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM payroll_connections WHERE id = p_connection_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Payroll connection not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Employee not found.'; END IF;
  IF EXISTS (SELECT 1 FROM payroll_employee_links WHERE connection_id = p_connection_id AND external_employee_id = v_ext AND employee_id <> p_employee_id AND confirmed) THEN
    RAISE EXCEPTION 'That provider employee is already linked to another employee.';
  END IF;
  DELETE FROM payroll_employee_links WHERE connection_id = p_connection_id AND external_employee_id = v_ext AND employee_id <> p_employee_id AND NOT confirmed;
  INSERT INTO payroll_employee_links (user_id, connection_id, employee_id, external_employee_id, external_name, match_method, confirmed, confirmed_by, confirmed_at)
  VALUES (v_owner, p_connection_id, p_employee_id, v_ext, NULLIF(btrim(COALESCE(p_external_name, '')), ''), 'manual', true, auth.uid(), now())
  ON CONFLICT (connection_id, employee_id) DO UPDATE
    SET external_employee_id = EXCLUDED.external_employee_id, external_name = EXCLUDED.external_name, match_method = 'manual',
        confirmed = true, confirmed_by = auth.uid(), confirmed_at = now()
  RETURNING id INTO v_id;
  PERFORM public._payroll_sync_event(v_owner, p_connection_id, NULL, 'employee_linked', jsonb_build_object('employee_id', p_employee_id, 'external_id', v_ext));
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.confirm_payroll_employee_link(uuid, uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_payroll_employee_link(p_link_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_payroll_sync_access();
  v_conn uuid;
BEGIN
  DELETE FROM payroll_employee_links WHERE id = p_link_id AND user_id = v_owner RETURNING connection_id INTO v_conn;
  IF v_conn IS NULL THEN RAISE EXCEPTION 'Link not found.'; END IF;
  PERFORM public._payroll_sync_event(v_owner, v_conn, NULL, 'employee_unlinked', jsonb_build_object('link_id', p_link_id));
END;
$$;
GRANT EXECUTE ON FUNCTION public.remove_payroll_employee_link(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.build_payroll_sync_batch(p_connection_id uuid, p_start date, p_end date)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_payroll_sync_access();
  v_conn payroll_connections%ROWTYPE;
  v_batch uuid;
  v_sendable integer;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN RAISE EXCEPTION 'Choose a valid pay period (end on or after start).'; END IF;
  IF p_end - p_start > 62 THEN RAISE EXCEPTION 'A batch can cover at most 62 days.'; END IF;
  SELECT * INTO v_conn FROM payroll_connections WHERE id = p_connection_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll connection not found.'; END IF;
  IF v_conn.status <> 'connected' THEN RAISE EXCEPTION 'Reconnect this payroll provider before building a batch.'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payroll_sync_build:' || v_owner::text, 0));

  INSERT INTO payroll_sync_batches (user_id, connection_id, provider, period_start, period_end, created_by)
  VALUES (v_owner, p_connection_id, v_conn.provider, p_start, p_end, auth.uid())
  RETURNING id INTO v_batch;

  INSERT INTO payroll_sync_lines (user_id, batch_id, employee_id, employee_name, pay_type, send_hours, regular_hours, overtime_hours, commission_cents, line_hash, status, skip_reason)
  SELECT v_owner, v_batch, e.id, e.full_name, e.pay_type, (e.pay_type = 'hourly' AND e.employment_type = 'w2'),
         round(a.reg, 3), round(a.ot, 3), a.comm,
         md5(concat_ws('|', e.id::text, round(a.reg, 3)::text, round(a.ot, 3)::text, a.comm::text, p_start::text, p_end::text)),
         CASE WHEN a.skip IS NULL THEN 'pending' ELSE 'skipped' END, a.skip
  FROM (
    SELECT x.employee_id, sum(x.regular_hours) AS reg, sum(x.overtime_hours) AS ot, sum(x.commission_cents)::bigint AS comm, max(x.skip_reason) AS skip
    FROM public._payroll_sync_eligible(v_owner, p_start, p_end) x
    GROUP BY x.employee_id
  ) a JOIN employees e ON e.id = a.employee_id
  WHERE a.reg > 0 OR a.ot > 0 OR a.comm > 0;

  SELECT count(*) INTO v_sendable FROM payroll_sync_lines WHERE batch_id = v_batch AND skip_reason IS NULL;
  IF v_sendable = 0 THEN
    RAISE EXCEPTION 'Nothing to sync for this period: no approved hourly timesheets or approved commission statements that are not already in a pay run or another batch.';
  END IF;

  INSERT INTO payroll_sync_sources (user_id, batch_id, source_type, source_id, employee_id)
  SELECT v_owner, v_batch, x.source_type, x.source_id, x.employee_id
  FROM public._payroll_sync_eligible(v_owner, p_start, p_end) x
  WHERE x.skip_reason IS NULL
    AND EXISTS (SELECT 1 FROM payroll_sync_lines l WHERE l.batch_id = v_batch AND l.employee_id = x.employee_id AND l.skip_reason IS NULL);

  UPDATE payroll_sync_batches b SET
    line_count = (SELECT count(*) FROM payroll_sync_lines WHERE batch_id = v_batch AND skip_reason IS NULL),
    regular_hours = (SELECT COALESCE(sum(regular_hours), 0) FROM payroll_sync_lines WHERE batch_id = v_batch AND skip_reason IS NULL),
    overtime_hours = (SELECT COALESCE(sum(overtime_hours), 0) FROM payroll_sync_lines WHERE batch_id = v_batch AND skip_reason IS NULL),
    commission_cents = (SELECT COALESCE(sum(commission_cents), 0) FROM payroll_sync_lines WHERE batch_id = v_batch AND skip_reason IS NULL),
    snapshot_hash = (SELECT md5(COALESCE(string_agg(line_hash, ',' ORDER BY employee_id), '')) FROM payroll_sync_lines WHERE batch_id = v_batch)
  WHERE b.id = v_batch;

  PERFORM public._payroll_sync_event(v_owner, p_connection_id, v_batch, 'batch_built', jsonb_build_object('start', p_start, 'end', p_end, 'lines', v_sendable));
  RETURN v_batch;
END;
$$;
GRANT EXECUTE ON FUNCTION public.build_payroll_sync_batch(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.transition_payroll_sync_batch(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_payroll_sync_access();
  b payroll_sync_batches%ROWTYPE;
  v_conn payroll_connections%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_new text;
BEGIN
  SELECT * INTO b FROM payroll_sync_batches WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found.'; END IF;
  SELECT * INTO v_conn FROM payroll_connections WHERE id = b.connection_id;

  IF p_action = 'submit' THEN
    IF b.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft batch can be submitted.'; END IF;
    v_new := 'pending_approval';
    UPDATE payroll_sync_batches SET status = v_new, submitted_by = auth.uid(), submitted_at = now(), review_note = NULL WHERE id = p_id;

  ELSIF p_action = 'approve' THEN
    IF b.status <> 'pending_approval' THEN RAISE EXCEPTION 'Only a batch awaiting approval can be approved.'; END IF;
    IF COALESCE((v_conn.settings ->> 'require_separate_approver')::boolean, false) AND b.submitted_by IS NOT DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Your settings require a different person to approve this batch than the one who submitted it.';
    END IF;
    IF v_conn.status <> 'connected' THEN RAISE EXCEPTION 'Reconnect the payroll provider before approving.'; END IF;
    IF EXISTS (
      SELECT 1 FROM payroll_sync_lines l
      WHERE l.batch_id = p_id AND l.skip_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM payroll_employee_links k WHERE k.connection_id = b.connection_id AND k.employee_id = l.employee_id AND k.confirmed)
    ) THEN
      RAISE EXCEPTION 'Link every employee in this batch to their payroll-provider record before approving.';
    END IF;
    IF public._payroll_sync_drift(p_id) > 0 THEN
      RAISE EXCEPTION 'Timesheets or commission statements changed after this batch was built. Cancel it and build a new one.';
    END IF;
    v_new := 'approved';
    UPDATE payroll_sync_batches SET status = v_new, approved_by = auth.uid(), approved_at = now() WHERE id = p_id;

  ELSIF p_action = 'return' THEN
    IF b.status <> 'pending_approval' THEN RAISE EXCEPTION 'Only a batch awaiting approval can be returned.'; END IF;
    IF v_note IS NULL THEN RAISE EXCEPTION 'Add a note so the preparer knows what to fix.'; END IF;
    v_new := 'draft';
    UPDATE payroll_sync_batches SET status = v_new, review_note = v_note, submitted_by = NULL, submitted_at = NULL WHERE id = p_id;

  ELSIF p_action = 'cancel' THEN
    IF b.status NOT IN ('draft', 'pending_approval', 'approved', 'failed') THEN
      RAISE EXCEPTION 'A batch that is syncing, partly or fully sent cannot be cancelled. Correct it in your payroll provider.';
    END IF;
    IF EXISTS (SELECT 1 FROM payroll_sync_lines WHERE batch_id = p_id AND status IN ('sent', 'unchanged')) THEN
      RAISE EXCEPTION 'Some lines were already sent to the provider, so this batch cannot be cancelled.';
    END IF;
    IF v_note IS NULL THEN RAISE EXCEPTION 'Add a reason for cancelling.'; END IF;
    v_new := 'cancelled';
    UPDATE payroll_sync_batches SET status = v_new, cancel_reason = v_note WHERE id = p_id;
    UPDATE payroll_sync_sources SET released_at = now() WHERE batch_id = p_id AND released_at IS NULL;

  ELSE
    RAISE EXCEPTION 'Unknown action.';
  END IF;

  PERFORM public._payroll_sync_event(v_owner, b.connection_id, p_id, 'batch_' || p_action, jsonb_build_object('note', v_note, 'status', v_new));
  PERFORM public.log_audit_event(v_owner, 'payroll_sync_batch_' || p_action, 'payroll_sync_batches', p_id::text);
  RETURN v_new;
END;
$$;
GRANT EXECUTE ON FUNCTION public.transition_payroll_sync_batch(uuid, text, text) TO authenticated;

-- =============================================================
-- 7. SERVICE-ROLE FUNCTIONS (edge functions only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.payroll_sync_suggest_links(p_owner uuid, p_connection_id uuid, p_suggestions jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s jsonb;
  v_n integer := 0;
  v_emp uuid;
  v_ext text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payroll_connections WHERE id = p_connection_id AND user_id = p_owner) THEN RAISE EXCEPTION 'Payroll connection not found.'; END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(p_suggestions, '[]'::jsonb)) LOOP
    v_emp := NULLIF(s ->> 'employee_id', '')::uuid;
    v_ext := NULLIF(btrim(s ->> 'external_id'), '');
    CONTINUE WHEN v_emp IS NULL OR v_ext IS NULL;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM employees WHERE id = v_emp AND user_id = p_owner);
    CONTINUE WHEN EXISTS (SELECT 1 FROM payroll_employee_links WHERE connection_id = p_connection_id AND (employee_id = v_emp OR external_employee_id = v_ext));
    INSERT INTO payroll_employee_links (user_id, connection_id, employee_id, external_employee_id, external_name, match_method, confirmed)
    VALUES (p_owner, p_connection_id, v_emp, v_ext, left(s ->> 'external_name', 160), 'auto_name', false);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_sync_claim(p_owner uuid, p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b payroll_sync_batches%ROWTYPE;
  c payroll_connections%ROWTYPE;
  v_lines jsonb;
BEGIN
  SELECT * INTO b FROM payroll_sync_batches WHERE id = p_batch_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found.'; END IF;
  SELECT * INTO c FROM payroll_connections WHERE id = b.connection_id FOR UPDATE;
  IF c.status <> 'connected' THEN RAISE EXCEPTION 'Reconnect the payroll provider first.'; END IF;
  IF b.status = 'syncing' AND c.sync_locked_until IS NOT NULL AND c.sync_locked_until > now() THEN
    RAISE EXCEPTION 'sync_in_progress: this batch is already being sent.';
  END IF;
  IF b.status NOT IN ('approved', 'partial', 'failed', 'syncing') THEN
    RAISE EXCEPTION 'Only an approved batch can be sent (current status: %).', b.status;
  END IF;
  IF c.sync_locked_until IS NOT NULL AND c.sync_locked_until > now() AND b.status <> 'syncing' THEN
    RAISE EXCEPTION 'sync_in_progress: another batch is being sent for this connection.';
  END IF;
  IF public._payroll_sync_drift(p_batch_id) > 0 THEN
    RAISE EXCEPTION 'Timesheets or commission statements changed after approval. Cancel this batch and build a new one.';
  END IF;

  UPDATE payroll_connections SET sync_locked_until = now() + interval '10 minutes' WHERE id = c.id;
  UPDATE payroll_sync_batches SET status = 'syncing', run_count = run_count + 1, started_at = now(), finished_at = NULL, last_error = NULL WHERE id = p_batch_id;

  UPDATE payroll_sync_lines l SET status = 'failed', error_code = 'not_linked', error_message = 'This employee is not linked to a payroll-provider record.'
  WHERE l.batch_id = p_batch_id AND l.skip_reason IS NULL AND l.status IN ('pending', 'failed')
    AND NOT EXISTS (SELECT 1 FROM payroll_employee_links k WHERE k.connection_id = b.connection_id AND k.employee_id = l.employee_id AND k.confirmed);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_id', l.id, 'employee_id', l.employee_id, 'employee_name', l.employee_name, 'external_employee_id', k.external_employee_id,
      'regular_hours', l.regular_hours, 'overtime_hours', l.overtime_hours, 'commission_cents', l.commission_cents,
      'send_hours', l.send_hours, 'line_hash', l.line_hash) ORDER BY l.employee_name), '[]'::jsonb)
  INTO v_lines
  FROM payroll_sync_lines l
  JOIN payroll_employee_links k ON k.connection_id = b.connection_id AND k.employee_id = l.employee_id AND k.confirmed
  WHERE l.batch_id = p_batch_id AND l.skip_reason IS NULL AND l.status IN ('pending', 'failed');

  PERFORM public._payroll_sync_event(p_owner, c.id, p_batch_id, 'sync_started', jsonb_build_object('run', b.run_count + 1));
  RETURN jsonb_build_object(
    'batch', jsonb_build_object('id', b.id, 'provider', b.provider, 'period_start', b.period_start, 'period_end', b.period_end,
                                'external_payroll_id', b.external_payroll_id, 'connection_id', b.connection_id),
    'settings', c.settings, 'external_company_id', c.external_company_id, 'environment', c.environment, 'lines', v_lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_sync_record_line(p_owner uuid, p_batch_id uuid, p_line_id uuid, p_status text, p_external_ref text, p_error_code text, p_error_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('sent', 'unchanged', 'failed') THEN RAISE EXCEPTION 'Invalid line status.'; END IF;
  UPDATE payroll_sync_lines SET
    status = p_status, external_ref = left(p_external_ref, 120), attempts = attempts + 1,
    error_code = CASE WHEN p_status = 'failed' THEN left(p_error_code, 60) END,
    error_message = CASE WHEN p_status = 'failed' THEN left(p_error_message, 400) END,
    sent_at = CASE WHEN p_status IN ('sent', 'unchanged') THEN now() ELSE sent_at END
  WHERE id = p_line_id AND batch_id = p_batch_id AND user_id = p_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_sync_finish(p_owner uuid, p_batch_id uuid, p_error text, p_external_payroll_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b payroll_sync_batches%ROWTYPE;
  v_done integer;
  v_open integer;
  v_status text;
BEGIN
  SELECT * INTO b FROM payroll_sync_batches WHERE id = p_batch_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found.'; END IF;
  SELECT count(*) FILTER (WHERE status IN ('sent', 'unchanged')), count(*) FILTER (WHERE status IN ('pending', 'failed'))
  INTO v_done, v_open FROM payroll_sync_lines WHERE batch_id = p_batch_id AND skip_reason IS NULL;
  v_status := CASE WHEN v_open = 0 AND v_done > 0 THEN 'synced' WHEN v_done > 0 THEN 'partial' ELSE 'failed' END;

  UPDATE payroll_sync_batches SET status = v_status, finished_at = now(), last_error = left(p_error, 400),
    external_payroll_id = COALESCE(NULLIF(p_external_payroll_id, ''), external_payroll_id) WHERE id = p_batch_id;
  UPDATE payroll_connections SET sync_locked_until = NULL, last_error = CASE WHEN v_status = 'synced' THEN NULL ELSE left(p_error, 400) END WHERE id = b.connection_id;

  UPDATE commission_statements cs SET exported_at = now()
  WHERE cs.id IN (
    SELECT s.source_id FROM payroll_sync_sources s
    JOIN payroll_sync_lines l ON l.batch_id = s.batch_id AND l.employee_id = s.employee_id
    WHERE s.batch_id = p_batch_id AND s.source_type = 'commission_statement' AND s.released_at IS NULL AND l.status IN ('sent', 'unchanged'))
    AND cs.exported_at IS NULL;

  PERFORM public._payroll_sync_event(p_owner, b.connection_id, p_batch_id, 'sync_finished', jsonb_build_object('status', v_status, 'sent', v_done, 'open', v_open, 'error', left(p_error, 200)));
  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_sync_disconnect(p_owner uuid, p_connection_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cancelled integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payroll_connections WHERE id = p_connection_id AND user_id = p_owner) THEN RAISE EXCEPTION 'Payroll connection not found.'; END IF;
  WITH c AS (
    UPDATE payroll_sync_batches SET status = 'cancelled', cancel_reason = 'Provider disconnected'
    WHERE connection_id = p_connection_id AND status IN ('draft', 'pending_approval', 'approved')
      AND NOT EXISTS (SELECT 1 FROM payroll_sync_lines l WHERE l.batch_id = payroll_sync_batches.id AND l.status IN ('sent', 'unchanged'))
    RETURNING id),
  r AS (
    UPDATE payroll_sync_sources SET released_at = now() WHERE batch_id IN (SELECT id FROM c) AND released_at IS NULL RETURNING id)
  SELECT count(*) INTO v_cancelled FROM c;
  DELETE FROM payroll_connection_secrets WHERE connection_id = p_connection_id;
  UPDATE payroll_connections SET status = 'disconnected', sync_locked_until = NULL WHERE id = p_connection_id;
  PERFORM public._payroll_sync_event(p_owner, p_connection_id, NULL, 'disconnected', '{}'::jsonb);
  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_sync_suggest_links(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_sync_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_sync_record_line(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_sync_finish(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_sync_disconnect(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_sync_suggest_links(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_sync_claim(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_sync_record_line(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_sync_finish(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_sync_disconnect(uuid, uuid) TO service_role;
