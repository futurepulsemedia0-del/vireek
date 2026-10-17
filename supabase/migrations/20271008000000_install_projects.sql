/*
  # Install Projects — multi-phase install projects

  Phases, milestones, progress billing (with retainage), linked jobs and
  materials for large installs (system replacements, solar, re-pipes...).

  - New tables only: install_projects, install_project_phases,
    install_project_milestones, install_project_billing,
    install_project_jobs, install_project_materials.
  - Every row is scoped to the account owner (get_account_owner_id()); the
    owner is FORCED by trigger on insert, so a client can never write into
    another account.
  - Billing-sensitive: owners and team members with can_view_billing only
    (same rule as the UI gate) — see can_manage_install_projects().
  - Invoices are created atomically by create_project_invoice() and
    release_project_retainage(), reusing the existing `invoices` table.
  - Purely additive; no existing table is changed except one new counter
    column on business_profile (project numbers PRJ-0001...).
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_install_projects()
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
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_install_projects() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_install_projects() TO authenticated;

ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS project_seq integer NOT NULL DEFAULT 0;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS install_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_number text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 160),
  site_address text,
  project_type text NOT NULL DEFAULT 'other'
    CHECK (project_type IN ('hvac', 'plumbing', 'electrical', 'solar', 'roofing', 'water_heater', 'other')),
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  contract_value_cents bigint NOT NULL DEFAULT 0 CHECK (contract_value_cents >= 0),
  estimated_labor_cost_cents bigint NOT NULL DEFAULT 0 CHECK (estimated_labor_cost_cents >= 0),
  retainage_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (retainage_percent >= 0 AND retainage_percent <= 25),
  start_date date,
  target_end_date date,
  completed_at timestamptz,
  retainage_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR target_end_date IS NULL OR target_end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_projects_number ON install_projects(user_id, project_number) WHERE project_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_projects_user_status ON install_projects(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_install_projects_customer ON install_projects(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS install_project_phases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'completed')),
  planned_start date,
  planned_end date,
  actual_start date,
  actual_end date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_start IS NULL OR planned_end IS NULL OR planned_end >= planned_start)
);

CREATE INDEX IF NOT EXISTS idx_install_phases_project ON install_project_phases(project_id, sort_order);

CREATE TABLE IF NOT EXISTS install_project_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid NOT NULL REFERENCES install_project_phases(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'inspection', 'delivery', 'sign_off')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  due_date date,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_milestones_project ON install_project_milestones(project_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_install_milestones_phase ON install_project_milestones(phase_id, sort_order);

CREATE TABLE IF NOT EXISTS install_project_billing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  milestone_id uuid REFERENCES install_project_milestones(id) ON DELETE SET NULL,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  percent_of_contract numeric(6,3) NOT NULL CHECK (percent_of_contract > 0 AND percent_of_contract <= 100),
  due_date date,
  sort_order integer NOT NULL DEFAULT 0,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  invoiced_gross_cents bigint,
  retainage_withheld_cents bigint NOT NULL DEFAULT 0 CHECK (retainage_withheld_cents >= 0),
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_billing_project ON install_project_billing(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_install_billing_invoice ON install_project_billing(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS install_project_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_install_project_jobs_project ON install_project_jobs(project_id);

CREATE TABLE IF NOT EXISTS install_project_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  quantity numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_label text,
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  vendor text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'ordered', 'delivered', 'installed')),
  expected_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_materials_project ON install_project_materials(project_id, status);

-- =============================================================
-- TRIGGERS
-- =============================================================

-- Owner is forced (never trusted from the client); projects also get a number.
CREATE OR REPLACE FUNCTION public.install_projects_force_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_seq integer;
BEGIN
  NEW.user_id := public.get_account_owner_id();
  IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF TG_TABLE_NAME = 'install_projects' THEN
    NEW.created_by := auth.uid();
    IF NEW.project_number IS NULL OR NEW.project_number = '' THEN
      INSERT INTO business_profile (user_id, project_seq) VALUES (NEW.user_id, 1)
      ON CONFLICT (user_id) DO UPDATE SET project_seq = business_profile.project_seq + 1
      RETURNING project_seq INTO v_seq;
      NEW.project_number := 'PRJ-' || lpad(v_seq::text, 4, '0');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_projects_validate_root()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'immutable_owner'; END IF;
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = NEW.customer_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_customer';
  END IF;
  IF NEW.quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quotes WHERE id = NEW.quote_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_quote';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    NEW.completed_at := now();
  ELSIF NEW.status <> 'completed' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_projects_validate_child()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb := to_jsonb(NEW);
  vo jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_total numeric;
  v_invoice_open boolean;
BEGIN
  -- Links are only re-validated when they are written (INSERT or a changed
  -- value), so FK actions such as ON DELETE SET NULL / cascades never trip.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id THEN
      RAISE EXCEPTION 'immutable_link';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_project';
  END IF;
  IF v->>'phase_id' IS NOT NULL AND v->>'phase_id' IS DISTINCT FROM vo->>'phase_id' AND NOT EXISTS (
    SELECT 1 FROM install_project_phases WHERE id = (v->>'phase_id')::uuid AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'invalid_phase';
  END IF;
  IF v->>'milestone_id' IS NOT NULL AND v->>'milestone_id' IS DISTINCT FROM vo->>'milestone_id' AND NOT EXISTS (
    SELECT 1 FROM install_project_milestones WHERE id = (v->>'milestone_id')::uuid AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'invalid_milestone';
  END IF;
  IF v->>'job_id' IS NOT NULL AND v->>'job_id' IS DISTINCT FROM vo->>'job_id' AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = (v->>'job_id')::uuid AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_job';
  END IF;
  IF v->>'part_id' IS NOT NULL AND v->>'part_id' IS DISTINCT FROM vo->>'part_id' AND NOT EXISTS (
    SELECT 1 FROM inventory_parts WHERE id = (v->>'part_id')::uuid AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_part';
  END IF;

  IF TG_TABLE_NAME = 'install_project_billing' THEN
    IF TG_OP = 'INSERT' OR NEW.percent_of_contract <> OLD.percent_of_contract THEN
      -- Serialize per project so concurrent edits can never exceed 100%.
      PERFORM 1 FROM install_projects WHERE id = NEW.project_id FOR UPDATE;
      SELECT COALESCE(SUM(percent_of_contract), 0) INTO v_total
        FROM install_project_billing WHERE project_id = NEW.project_id AND id <> NEW.id;
      IF v_total + NEW.percent_of_contract > 100.0005 THEN RAISE EXCEPTION 'billing_exceeds_contract'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.invoice_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id AND status <> 'void') INTO v_invoice_open;
        IF v_invoice_open THEN RAISE EXCEPTION 'billing_locked'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_projects_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_TABLE_NAME = 'install_project_milestones' THEN
    IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status <> 'done') THEN
      NEW.completed_at := now();
      NEW.completed_by := auth.uid();
    ELSIF NEW.status <> 'done' THEN
      NEW.completed_at := NULL;
      NEW.completed_by := NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'install_project_phases' THEN
    IF NEW.status IN ('in_progress', 'completed') AND NEW.actual_start IS NULL THEN
      NEW.actual_start := current_date;
    END IF;
    IF NEW.status = 'completed' AND NEW.actual_end IS NULL THEN
      NEW.actual_end := current_date;
    ELSIF NEW.status <> 'completed' THEN
      NEW.actual_end := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'install_projects', 'install_project_phases', 'install_project_milestones',
    'install_project_billing', 'install_project_jobs', 'install_project_materials'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_ip_01_owner ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_ip_02_validate ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.%s()',
      t, CASE WHEN t = 'install_projects' THEN 'install_projects_validate_root' ELSE 'install_projects_validate_child' END);
    IF t <> 'install_project_jobs' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_ip_03_stamp ON %I', t);
      EXECUTE format('CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp()', t);
    END IF;
  END LOOP;
END $$;

-- =============================================================
-- ROW LEVEL SECURITY — account-scoped + billing permission
-- =============================================================

DO $$
DECLARE
  t text;
  scope text := 'user_id = public.get_account_owner_id() AND public.can_manage_install_projects()';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'install_projects', 'install_project_phases', 'install_project_milestones',
    'install_project_billing', 'install_project_jobs', 'install_project_materials'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (%s)', t || '_select', t, scope);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (%s)', t || '_insert', t, scope);
    IF t <> 'install_project_jobs' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', t || '_update', t, scope, scope);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    IF t = 'install_project_billing' THEN
      -- An invoiced draw can only be removed once its invoice is void.
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (%s AND (invoice_id IS NULL OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.status = ''void'')))',
        t || '_delete', t, scope);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (%s)', t || '_delete', t, scope);
    END IF;
  END LOOP;
END $$;

-- =============================================================
-- PROGRESS BILLING → INVOICE (atomic)
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_project_invoice(p_billing_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  b install_project_billing%ROWTYPE;
  p install_projects%ROWTYPE;
  v_email text;
  v_phone text;
  v_gross bigint;
  v_ret bigint;
  v_items jsonb;
  v_inv uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO b FROM install_project_billing WHERE id = p_billing_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_not_found'; END IF;

  SELECT * INTO p FROM install_projects WHERE id = b.project_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
  IF p.contract_value_cents <= 0 THEN RAISE EXCEPTION 'no_contract_value'; END IF;

  IF b.invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM invoices WHERE id = b.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'already_invoiced';
  END IF;

  v_gross := round(p.contract_value_cents * b.percent_of_contract / 100.0)::bigint;
  v_ret := round(v_gross * p.retainage_percent / 100.0)::bigint;

  v_items := jsonb_build_array(jsonb_build_object(
    'description', 'Progress billing — ' || b.label || ' (' || trim_scale(b.percent_of_contract)::text || '% of contract)',
    'quantity', 1,
    'unit_price_cents', v_gross));
  IF v_ret > 0 THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'description', 'Less retainage held (' || trim_scale(p.retainage_percent)::text || '%)',
      'quantity', 1,
      'unit_price_cents', -v_ret));
  END IF;

  SELECT email, phone INTO v_email, v_phone FROM customers WHERE id = p.customer_id AND user_id = v_owner;

  INSERT INTO invoices (user_id, quote_id, customer_name, customer_email, customer_phone, line_items, tax_percent, notes, due_date)
  VALUES (v_owner, p.quote_id, p.customer_name, v_email, v_phone, v_items, 0,
          'Project ' || COALESCE(p.project_number, '') || ' — ' || p.name, p_due_date)
  RETURNING id INTO v_inv;

  UPDATE install_project_billing
     SET invoice_id = v_inv, invoiced_gross_cents = v_gross, retainage_withheld_cents = v_ret, invoiced_at = now()
   WHERE id = b.id;

  RETURN v_inv;
END $$;

CREATE OR REPLACE FUNCTION public.release_project_retainage(p_project_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p install_projects%ROWTYPE;
  v_held bigint;
  v_email text;
  v_phone text;
  v_inv uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO p FROM install_projects WHERE id = p_project_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p.status <> 'completed' THEN RAISE EXCEPTION 'project_not_completed'; END IF;
  IF p.retainage_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM invoices WHERE id = p.retainage_invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'already_released';
  END IF;

  SELECT COALESCE(SUM(b.retainage_withheld_cents), 0) INTO v_held
    FROM install_project_billing b
    JOIN invoices i ON i.id = b.invoice_id
   WHERE b.project_id = p.id AND i.status <> 'void';
  IF v_held <= 0 THEN RAISE EXCEPTION 'no_retainage_held'; END IF;

  SELECT email, phone INTO v_email, v_phone FROM customers WHERE id = p.customer_id AND user_id = v_owner;

  INSERT INTO invoices (user_id, quote_id, customer_name, customer_email, customer_phone, line_items, tax_percent, notes, due_date)
  VALUES (v_owner, p.quote_id, p.customer_name, v_email, v_phone,
          jsonb_build_array(jsonb_build_object(
            'description', 'Retainage release — ' || p.name, 'quantity', 1, 'unit_price_cents', v_held)),
          0, 'Project ' || COALESCE(p.project_number, '') || ' — retainage release', p_due_date)
  RETURNING id INTO v_inv;

  UPDATE install_projects SET retainage_invoice_id = v_inv WHERE id = p.id;
  RETURN v_inv;
END $$;

REVOKE ALL ON FUNCTION public.create_project_invoice(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_project_retainage(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project_invoice(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_project_retainage(uuid, date) TO authenticated;
