/*
  # Incumbent data ingest (CSV-first) — invoices, line items, payments, equipment

  Extends the import wizard (20260929000000_competitor_data_import_engine.sql,
  20270415000000_import_wizard_rollback.sql) beyond customers/jobs.

  ## Design
  - customers / jobs / equipment (existing tables): provenance via external_source + external_id
    (customers/jobs already have them; equipment gets them here). Unique per account, partial index.
  - invoices / line items / payments land in NEW read-only tables external_invoices,
    external_invoice_lines, external_payments (source_system + source_id, unique per account).
    WHY NOT `invoices` / `ar_invoices`: those tables drive customer emails, reminders, statements,
    sales-tax, collections and the general ledger. The incumbent stays the system of record, so
    its history must never be re-billed, re-taxed or posted to the GL. Reference data only.
  - Money is integer cents everywhere. Totals check is deterministic SQL.
  - Clients can READ (RLS, tenant scoped). They can NEVER write: all writes go through
    SECURITY DEFINER RPCs that require can_run_data_imports(). A trigger blocks any other
    UPDATE/DELETE on the external ledger tables (read-only "external").
  - import_external_apply / import_external_rollback are idempotent and record effects in
    data_import_row_effects so rollback is exact.
*/

-- =============================================================
-- 1. widen existing constraints
-- =============================================================
ALTER TABLE data_import_jobs DROP CONSTRAINT IF EXISTS data_import_jobs_import_type_check;
ALTER TABLE data_import_jobs ADD CONSTRAINT data_import_jobs_import_type_check
  CHECK (import_type IN ('customers', 'jobs', 'invoices', 'line_items', 'payments', 'equipment'));

ALTER TABLE data_import_row_effects DROP CONSTRAINT IF EXISTS data_import_row_effects_entity_type_check;
ALTER TABLE data_import_row_effects ADD CONSTRAINT data_import_row_effects_entity_type_check
  CHECK (entity_type IN ('customer', 'job', 'invoice', 'line_item', 'payment', 'equipment'));

-- =============================================================
-- 2. equipment provenance
-- =============================================================
ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_user_extsource_extid_unique
  ON equipment(user_id, external_source, external_id)
  WHERE external_id IS NOT NULL AND external_source IS NOT NULL;

-- =============================================================
-- 3. external ledger tables (read-only reference data)
-- =============================================================
CREATE TABLE IF NOT EXISTS external_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source_system text NOT NULL,
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_source_id text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_source_id text,
  invoice_number text,
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('draft', 'sent', 'paid', 'partial', 'void', 'unknown')),
  issued_on date,
  due_on date,
  paid_on date,
  subtotal_cents bigint,
  tax_cents bigint,
  total_cents bigint NOT NULL,
  balance_cents bigint,
  lines_total_cents bigint,
  line_count integer NOT NULL DEFAULT 0,
  totals_verified boolean,
  is_external boolean NOT NULL DEFAULT true CHECK (is_external),
  import_job_id uuid REFERENCES data_import_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_system, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_invoices_customer ON external_invoices(user_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_ext_invoices_issued ON external_invoices(user_id, issued_on DESC);

CREATE TABLE IF NOT EXISTS external_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source_system text NOT NULL,
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  invoice_id uuid NOT NULL REFERENCES external_invoices(id) ON DELETE CASCADE,
  invoice_source_id text NOT NULL,
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('part', 'labor', 'other')),
  description text,
  sku text,
  quantity numeric(14, 3) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL,
  is_external boolean NOT NULL DEFAULT true CHECK (is_external),
  import_job_id uuid REFERENCES data_import_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_system, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_lines_invoice ON external_invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS external_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source_system text NOT NULL,
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  invoice_id uuid REFERENCES external_invoices(id) ON DELETE SET NULL,
  invoice_source_id text,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  method text NOT NULL DEFAULT 'other' CHECK (method IN ('cash', 'check', 'card', 'bank_transfer', 'other')),
  paid_on date,
  reference text,
  is_external boolean NOT NULL DEFAULT true CHECK (is_external),
  import_job_id uuid REFERENCES data_import_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_system, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_payments_invoice ON external_payments(invoice_id);

ALTER TABLE external_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payments ENABLE ROW LEVEL SECURITY;

-- Read only. No INSERT/UPDATE/DELETE policy exists on purpose.
DROP POLICY IF EXISTS "select_own_external_invoices" ON external_invoices;
CREATE POLICY "select_own_external_invoices" ON external_invoices FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_external_invoice_lines" ON external_invoice_lines;
CREATE POLICY "select_own_external_invoice_lines" ON external_invoice_lines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_external_payments" ON external_payments;
CREATE POLICY "select_own_external_payments" ON external_payments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE ON external_invoices, external_invoice_lines, external_payments FROM authenticated, anon;

-- Defense in depth: even a service-role client cannot edit the ledger outside the import RPCs.
CREATE OR REPLACE FUNCTION public.external_ledger_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('vireek.external_import', true), '') <> 'on' THEN
    RAISE EXCEPTION 'External (imported) records are read-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ext_invoices_guard ON external_invoices;
CREATE TRIGGER trg_ext_invoices_guard BEFORE UPDATE OR DELETE ON external_invoices
  FOR EACH ROW EXECUTE FUNCTION public.external_ledger_guard();
DROP TRIGGER IF EXISTS trg_ext_lines_guard ON external_invoice_lines;
CREATE TRIGGER trg_ext_lines_guard BEFORE UPDATE OR DELETE ON external_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.external_ledger_guard();
DROP TRIGGER IF EXISTS trg_ext_payments_guard ON external_payments;
CREATE TRIGGER trg_ext_payments_guard BEFORE UPDATE OR DELETE ON external_payments
  FOR EACH ROW EXECUTE FUNCTION public.external_ledger_guard();

-- Deterministic totals check: sum(lines) must equal subtotal (or total - tax when no subtotal).
CREATE OR REPLACE FUNCTION public._external_invoice_recompute(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sum bigint;
  v_cnt integer;
  v_inv external_invoices%ROWTYPE;
BEGIN
  PERFORM set_config('vireek.external_import', 'on', true);
  SELECT * INTO v_inv FROM external_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(total_cents), 0), COUNT(*) INTO v_sum, v_cnt
    FROM external_invoice_lines WHERE invoice_id = p_invoice_id;
  UPDATE external_invoices
     SET lines_total_cents = CASE WHEN v_cnt > 0 THEN v_sum END,
         line_count = v_cnt,
         totals_verified = CASE WHEN v_cnt = 0 THEN NULL
                                ELSE v_sum = COALESCE(v_inv.subtotal_cents, v_inv.total_cents - COALESCE(v_inv.tax_cents, 0)) END
   WHERE id = p_invoice_id;
END;
$$;
REVOKE ALL ON FUNCTION public._external_invoice_recompute(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 4. saved column mappings (per account + source + import type)
-- =============================================================
CREATE TABLE IF NOT EXISTS import_saved_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source text NOT NULL CHECK (source IN ('csv', 'service_titan', 'jobber', 'housecall_pro')),
  import_type text NOT NULL CHECK (import_type IN ('customers', 'jobs', 'invoices', 'line_items', 'payments', 'equipment')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, import_type)
);
ALTER TABLE import_saved_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_import_saved_mappings" ON import_saved_mappings;
CREATE POLICY "select_own_import_saved_mappings" ON import_saved_mappings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_import_saved_mappings" ON import_saved_mappings;
CREATE POLICY "insert_own_import_saved_mappings" ON import_saved_mappings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports());
DROP POLICY IF EXISTS "update_own_import_saved_mappings" ON import_saved_mappings;
CREATE POLICY "update_own_import_saved_mappings" ON import_saved_mappings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports());
DROP POLICY IF EXISTS "delete_own_import_saved_mappings" ON import_saved_mappings;
CREATE POLICY "delete_own_import_saved_mappings" ON import_saved_mappings FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports());

-- =============================================================
-- 5. apply RPC (idempotent upsert, one chunk per call, records effects)
-- =============================================================
CREATE OR REPLACE FUNCTION public.import_external_apply(p_job_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job data_import_jobs%ROWTYPE;
  v_row jsonb;
  v_idx integer := 0;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_src text;
  v_sid text;
  v_cust uuid;
  v_inv uuid;
  v_jobid uuid;
  v_new_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_touched uuid[] := '{}';
  v_etype text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_run_data_imports() THEN
    RAISE EXCEPTION 'Not authorized to import data' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'p_rows must be a JSON array of at most 500 rows';
  END IF;
  SELECT * INTO v_job FROM data_import_jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND OR v_job.status <> 'running' THEN
    RAISE EXCEPTION 'Import run not found or not running';
  END IF;
  IF v_job.import_type NOT IN ('invoices', 'line_items', 'payments', 'equipment') THEN
    RAISE EXCEPTION 'Unsupported import type for this function';
  END IF;
  v_src := v_job.source;
  v_etype := CASE v_job.import_type WHEN 'invoices' THEN 'invoice' WHEN 'line_items' THEN 'line_item'
                                    WHEN 'payments' THEN 'payment' ELSE 'equipment' END;
  PERFORM set_config('vireek.external_import', 'on', true);

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_idx := v_idx + 1;
    BEGIN
      v_sid := nullif(btrim(v_row ->> 'source_id'), '');
      IF v_sid IS NULL THEN RAISE EXCEPTION 'Missing source id'; END IF;

      IF v_job.import_type = 'invoices' THEN
        SELECT id INTO v_cust FROM customers WHERE user_id = v_owner AND external_source = v_src AND external_id = v_row ->> 'customer_source_id';
        SELECT id INTO v_jobid FROM jobs WHERE user_id = v_owner AND external_source = v_src AND external_id = v_row ->> 'job_source_id';
        v_new := jsonb_build_object(
          'customer_id', v_cust, 'customer_source_id', v_row ->> 'customer_source_id',
          'job_id', v_jobid, 'job_source_id', v_row ->> 'job_source_id',
          'invoice_number', v_row ->> 'invoice_number', 'status', coalesce(v_row ->> 'status', 'unknown'),
          'issued_on', v_row ->> 'issued_on', 'due_on', v_row ->> 'due_on', 'paid_on', v_row ->> 'paid_on',
          'subtotal_cents', (v_row ->> 'subtotal_cents')::bigint, 'tax_cents', (v_row ->> 'tax_cents')::bigint,
          'total_cents', (v_row ->> 'total_cents')::bigint, 'balance_cents', (v_row ->> 'balance_cents')::bigint);
        SELECT id, to_jsonb(e) - 'id' - 'user_id' - 'source_system' - 'source_id' - 'created_at' - 'updated_at' - 'import_job_id' - 'lines_total_cents' - 'line_count' - 'totals_verified' - 'is_external'
          INTO v_new_id, v_old FROM external_invoices e WHERE user_id = v_owner AND source_system = v_src AND source_id = v_sid;
        IF v_new_id IS NULL THEN
          INSERT INTO external_invoices (user_id, source_system, source_id, customer_id, customer_source_id, job_id, job_source_id, invoice_number, status,
            issued_on, due_on, paid_on, subtotal_cents, tax_cents, total_cents, balance_cents, import_job_id)
          VALUES (v_owner, v_src, v_sid, v_cust, v_new ->> 'customer_source_id', v_jobid, v_new ->> 'job_source_id', v_new ->> 'invoice_number', v_new ->> 'status',
            (v_new ->> 'issued_on')::date, (v_new ->> 'due_on')::date, (v_new ->> 'paid_on')::date,
            (v_new ->> 'subtotal_cents')::bigint, (v_new ->> 'tax_cents')::bigint, (v_new ->> 'total_cents')::bigint, (v_new ->> 'balance_cents')::bigint, p_job_id)
          RETURNING id INTO v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'created');
          v_created := v_created + 1; v_touched := v_touched || v_new_id;
        ELSIF (v_old - 'customer_id' - 'job_id') IS DISTINCT FROM (v_new - 'customer_id' - 'job_id') OR (v_old ->> 'customer_id') IS DISTINCT FROM (v_new ->> 'customer_id') OR (v_old ->> 'job_id') IS DISTINCT FROM (v_new ->> 'job_id') THEN
          UPDATE external_invoices SET customer_id = v_cust, customer_source_id = v_new ->> 'customer_source_id', job_id = v_jobid, job_source_id = v_new ->> 'job_source_id',
            invoice_number = v_new ->> 'invoice_number', status = v_new ->> 'status', issued_on = (v_new ->> 'issued_on')::date, due_on = (v_new ->> 'due_on')::date,
            paid_on = (v_new ->> 'paid_on')::date, subtotal_cents = (v_new ->> 'subtotal_cents')::bigint, tax_cents = (v_new ->> 'tax_cents')::bigint,
            total_cents = (v_new ->> 'total_cents')::bigint, balance_cents = (v_new ->> 'balance_cents')::bigint, import_job_id = p_job_id, updated_at = now()
          WHERE id = v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action, before_values) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'updated', v_old);
          v_updated := v_updated + 1; v_touched := v_touched || v_new_id;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;

      ELSIF v_job.import_type = 'line_items' THEN
        SELECT id INTO v_inv FROM external_invoices WHERE user_id = v_owner AND source_system = v_src AND source_id = v_row ->> 'invoice_source_id';
        IF v_inv IS NULL THEN RAISE EXCEPTION 'Invoice % not found — import invoices first', coalesce(v_row ->> 'invoice_source_id', '(blank)'); END IF;
        v_new := jsonb_build_object('invoice_id', v_inv, 'invoice_source_id', v_row ->> 'invoice_source_id', 'kind', coalesce(v_row ->> 'kind', 'other'),
          'description', v_row ->> 'description', 'sku', v_row ->> 'sku', 'quantity', (v_row ->> 'quantity')::numeric(14, 3),
          'unit_price_cents', coalesce((v_row ->> 'unit_price_cents')::bigint, 0), 'total_cents', (v_row ->> 'total_cents')::bigint);
        SELECT id, to_jsonb(e) - 'id' - 'user_id' - 'source_system' - 'source_id' - 'created_at' - 'import_job_id' - 'is_external'
          INTO v_new_id, v_old FROM external_invoice_lines e WHERE user_id = v_owner AND source_system = v_src AND source_id = v_sid;
        IF v_new_id IS NULL THEN
          INSERT INTO external_invoice_lines (user_id, source_system, source_id, invoice_id, invoice_source_id, kind, description, sku, quantity, unit_price_cents, total_cents, import_job_id)
          VALUES (v_owner, v_src, v_sid, v_inv, v_new ->> 'invoice_source_id', v_new ->> 'kind', v_new ->> 'description', v_new ->> 'sku',
            (v_new ->> 'quantity')::numeric, (v_new ->> 'unit_price_cents')::bigint, (v_new ->> 'total_cents')::bigint, p_job_id)
          RETURNING id INTO v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'created');
          v_created := v_created + 1; v_touched := v_touched || v_inv;
        ELSIF v_old IS DISTINCT FROM v_new THEN
          UPDATE external_invoice_lines SET invoice_id = v_inv, invoice_source_id = v_new ->> 'invoice_source_id', kind = v_new ->> 'kind', description = v_new ->> 'description',
            sku = v_new ->> 'sku', quantity = (v_new ->> 'quantity')::numeric, unit_price_cents = (v_new ->> 'unit_price_cents')::bigint,
            total_cents = (v_new ->> 'total_cents')::bigint, import_job_id = p_job_id WHERE id = v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action, before_values) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'updated', v_old);
          v_updated := v_updated + 1; v_touched := v_touched || v_inv;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;

      ELSIF v_job.import_type = 'payments' THEN
        SELECT id INTO v_inv FROM external_invoices WHERE user_id = v_owner AND source_system = v_src AND source_id = v_row ->> 'invoice_source_id';
        v_new := jsonb_build_object('invoice_id', v_inv, 'invoice_source_id', v_row ->> 'invoice_source_id', 'amount_cents', (v_row ->> 'amount_cents')::bigint,
          'method', coalesce(v_row ->> 'method', 'other'), 'paid_on', v_row ->> 'paid_on', 'reference', v_row ->> 'reference');
        SELECT id, to_jsonb(e) - 'id' - 'user_id' - 'source_system' - 'source_id' - 'created_at' - 'import_job_id' - 'is_external'
          INTO v_new_id, v_old FROM external_payments e WHERE user_id = v_owner AND source_system = v_src AND source_id = v_sid;
        IF v_new_id IS NULL THEN
          INSERT INTO external_payments (user_id, source_system, source_id, invoice_id, invoice_source_id, amount_cents, method, paid_on, reference, import_job_id)
          VALUES (v_owner, v_src, v_sid, v_inv, v_new ->> 'invoice_source_id', (v_new ->> 'amount_cents')::bigint, v_new ->> 'method',
            (v_new ->> 'paid_on')::date, v_new ->> 'reference', p_job_id)
          RETURNING id INTO v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'created');
          v_created := v_created + 1;
        ELSIF v_old IS DISTINCT FROM v_new THEN
          UPDATE external_payments SET invoice_id = v_inv, invoice_source_id = v_new ->> 'invoice_source_id', amount_cents = (v_new ->> 'amount_cents')::bigint,
            method = v_new ->> 'method', paid_on = (v_new ->> 'paid_on')::date, reference = v_new ->> 'reference', import_job_id = p_job_id WHERE id = v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action, before_values) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'updated', v_old);
          v_updated := v_updated + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;

      ELSE -- equipment
        SELECT id INTO v_cust FROM customers WHERE user_id = v_owner AND external_source = v_src AND external_id = v_row ->> 'customer_source_id';
        IF v_cust IS NULL THEN RAISE EXCEPTION 'Customer % not found — import customers first', coalesce(v_row ->> 'customer_source_id', '(blank)'); END IF;
        v_new := jsonb_build_object('customer_id', v_cust, 'equipment_type', coalesce(nullif(btrim(v_row ->> 'equipment_type'), ''), 'Equipment'),
          'make', v_row ->> 'make', 'model', v_row ->> 'model', 'serial_number', v_row ->> 'serial_number',
          'install_date', v_row ->> 'install_date', 'notes', v_row ->> 'notes');
        SELECT id, jsonb_build_object('customer_id', e.customer_id, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
                 'serial_number', e.serial_number, 'install_date', e.install_date, 'notes', e.notes)
          INTO v_new_id, v_old FROM equipment e WHERE user_id = v_owner AND external_source = v_src AND external_id = v_sid;
        IF v_new_id IS NULL THEN
          INSERT INTO equipment (user_id, customer_id, equipment_type, make, model, serial_number, install_date, notes, external_source, external_id)
          VALUES (v_owner, v_cust, v_new ->> 'equipment_type', v_new ->> 'make', v_new ->> 'model', v_new ->> 'serial_number',
            (v_new ->> 'install_date')::date, v_new ->> 'notes', v_src, v_sid)
          RETURNING id INTO v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'created');
          v_created := v_created + 1;
        ELSIF v_old IS DISTINCT FROM v_new THEN
          UPDATE equipment SET customer_id = v_cust, equipment_type = v_new ->> 'equipment_type', make = v_new ->> 'make', model = v_new ->> 'model',
            serial_number = v_new ->> 'serial_number', install_date = (v_new ->> 'install_date')::date, notes = v_new ->> 'notes' WHERE id = v_new_id;
          INSERT INTO data_import_row_effects (import_job_id, user_id, entity_type, entity_id, action, before_values) VALUES (p_job_id, v_owner, v_etype, v_new_id, 'updated', v_old);
          v_updated := v_updated + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('index', v_idx, 'message', left(SQLERRM, 300));
    END;
  END LOOP;

  -- totals check for every invoice touched by this chunk (invoices or their lines)
  IF array_length(v_touched, 1) IS NOT NULL THEN
    PERFORM public._external_invoice_recompute(i) FROM (SELECT DISTINCT unnest(v_touched) AS i) t;
  END IF;

  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'errors', v_errors);
END;
$$;
GRANT EXECUTE ON FUNCTION public.import_external_apply(uuid, jsonb) TO authenticated;

-- =============================================================
-- 6. rollback RPC (called by the edge function after it set the job to rolling_back)
-- =============================================================
CREATE OR REPLACE FUNCTION public.import_external_rollback(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job data_import_jobs%ROWTYPE;
  v_deleted integer := 0;
  v_restored integer := 0;
  e record;
  v_inv uuid[] := '{}';
  v_tmp uuid;
  n integer;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_run_data_imports() THEN
    RAISE EXCEPTION 'Not authorized to roll back imports' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM data_import_jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND OR v_job.status <> 'rolling_back' THEN RAISE EXCEPTION 'Import is not being rolled back'; END IF;
  IF v_job.import_type NOT IN ('invoices', 'line_items', 'payments', 'equipment') THEN
    RAISE EXCEPTION 'Unsupported import type for this function';
  END IF;
  PERFORM set_config('vireek.external_import', 'on', true);

  FOR e IN SELECT entity_type, entity_id, action, before_values FROM data_import_row_effects
            WHERE import_job_id = p_job_id AND user_id = v_owner ORDER BY created_at DESC, id LOOP
    IF e.action = 'created' THEN
      IF e.entity_type = 'line_item' THEN
        SELECT invoice_id INTO v_tmp FROM external_invoice_lines WHERE id = e.entity_id AND user_id = v_owner;
        IF v_tmp IS NOT NULL THEN v_inv := v_inv || v_tmp; END IF;
        DELETE FROM external_invoice_lines WHERE id = e.entity_id AND user_id = v_owner;
      ELSIF e.entity_type = 'payment' THEN DELETE FROM external_payments WHERE id = e.entity_id AND user_id = v_owner;
      ELSIF e.entity_type = 'invoice' THEN DELETE FROM external_invoices WHERE id = e.entity_id AND user_id = v_owner;
      ELSIF e.entity_type = 'equipment' THEN DELETE FROM equipment WHERE id = e.entity_id AND user_id = v_owner;
      END IF;
      GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted + n;
    ELSIF e.action = 'updated' AND e.before_values IS NOT NULL THEN
      IF e.entity_type = 'invoice' THEN
        UPDATE external_invoices SET customer_id = (e.before_values ->> 'customer_id')::uuid, customer_source_id = e.before_values ->> 'customer_source_id',
          job_id = (e.before_values ->> 'job_id')::uuid, job_source_id = e.before_values ->> 'job_source_id', invoice_number = e.before_values ->> 'invoice_number',
          status = e.before_values ->> 'status', issued_on = (e.before_values ->> 'issued_on')::date, due_on = (e.before_values ->> 'due_on')::date,
          paid_on = (e.before_values ->> 'paid_on')::date, subtotal_cents = (e.before_values ->> 'subtotal_cents')::bigint, tax_cents = (e.before_values ->> 'tax_cents')::bigint,
          total_cents = (e.before_values ->> 'total_cents')::bigint, balance_cents = (e.before_values ->> 'balance_cents')::bigint
        WHERE id = e.entity_id AND user_id = v_owner;
        v_inv := v_inv || e.entity_id;
      ELSIF e.entity_type = 'line_item' THEN
        UPDATE external_invoice_lines SET invoice_id = (e.before_values ->> 'invoice_id')::uuid, invoice_source_id = e.before_values ->> 'invoice_source_id',
          kind = e.before_values ->> 'kind', description = e.before_values ->> 'description', sku = e.before_values ->> 'sku',
          quantity = (e.before_values ->> 'quantity')::numeric, unit_price_cents = (e.before_values ->> 'unit_price_cents')::bigint,
          total_cents = (e.before_values ->> 'total_cents')::bigint WHERE id = e.entity_id AND user_id = v_owner;
        v_inv := v_inv || (e.before_values ->> 'invoice_id')::uuid;
      ELSIF e.entity_type = 'payment' THEN
        UPDATE external_payments SET invoice_id = (e.before_values ->> 'invoice_id')::uuid, invoice_source_id = e.before_values ->> 'invoice_source_id',
          amount_cents = (e.before_values ->> 'amount_cents')::bigint, method = e.before_values ->> 'method', paid_on = (e.before_values ->> 'paid_on')::date,
          reference = e.before_values ->> 'reference' WHERE id = e.entity_id AND user_id = v_owner;
      ELSIF e.entity_type = 'equipment' THEN
        UPDATE equipment SET customer_id = (e.before_values ->> 'customer_id')::uuid, equipment_type = e.before_values ->> 'equipment_type', make = e.before_values ->> 'make',
          model = e.before_values ->> 'model', serial_number = e.before_values ->> 'serial_number', install_date = (e.before_values ->> 'install_date')::date,
          notes = e.before_values ->> 'notes' WHERE id = e.entity_id AND user_id = v_owner;
      END IF;
      GET DIAGNOSTICS n = ROW_COUNT; v_restored := v_restored + n;
    END IF;
  END LOOP;

  PERFORM public._external_invoice_recompute(i) FROM (SELECT DISTINCT unnest(v_inv) AS i) t WHERE i IS NOT NULL;

  INSERT INTO audit_log (user_id, actor_id, actor_email, action, target_table, target_id, details)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()), 'data_import_rolled_back', 'data_import_jobs', p_job_id::text,
          jsonb_build_object('import_type', v_job.import_type, 'deleted', v_deleted, 'restored', v_restored));

  RETURN jsonb_build_object('deleted', v_deleted, 'restored', v_restored);
END;
$$;
GRANT EXECUTE ON FUNCTION public.import_external_rollback(uuid) TO authenticated;

COMMENT ON TABLE external_invoices IS 'Read-only invoice history imported from an incumbent system (ServiceTitan/Jobber/Housecall Pro CSV). Never billed, taxed, emailed or posted to the GL.';
