/*
  # AIA-style pay applications (G702 summary + G703 continuation sheet)

  Adds a schedule of values (SOV) to install projects and monthly pay
  applications with: % complete per line, stored materials, retainage taken
  from the project's existing retainage_percent, and previous-billed
  carry-forward from the prior issued application.

  - New tables only: install_sov_lines, install_pay_apps, install_pay_app_lines.
    No existing table or function is changed.
  - Same permission model as install projects (can_manage_install_projects()).
  - SOV lines are edited directly under RLS (guarded by trigger). Pay
    applications are READ-ONLY for clients: every write goes through the
    SECURITY DEFINER functions below, so totals are always server-computed.
  - A draft is "live" (re-synced from the SOV and prior application on every
    save). Issuing freezes it: description, scheduled value and previous
    amounts are snapshotted on the application, so later SOV or project edits
    never alter an issued G702/G703.
  - Money is integer cents. Retainage = (amount * basis points + 5000) / 10000
    on the grand totals — identical to retainageOf() in src/lib/payApps.ts.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS install_sov_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  item_no text NOT NULL CHECK (length(btrim(item_no)) BETWEEN 1 AND 20),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  scheduled_value_cents bigint NOT NULL DEFAULT 0
    CHECK (scheduled_value_cents >= 0 AND scheduled_value_cents <= 100000000000),
  change_order_ref text CHECK (change_order_ref IS NULL OR length(btrim(change_order_ref)) BETWEEN 1 AND 40),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_sov_item_no ON install_sov_lines(project_id, item_no);
CREATE INDEX IF NOT EXISTS idx_install_sov_project ON install_sov_lines(project_id, sort_order);

CREATE TABLE IF NOT EXISTS install_pay_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  application_no integer NOT NULL CHECK (application_no > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  period_to date NOT NULL,
  application_date date NOT NULL DEFAULT current_date,
  retainage_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (retainage_percent >= 0 AND retainage_percent <= 25),
  retainage_release_cents bigint NOT NULL DEFAULT 0 CHECK (retainage_release_cents >= 0),
  notes text,
  original_contract_cents bigint NOT NULL DEFAULT 0,
  change_orders_cents bigint NOT NULL DEFAULT 0,
  contract_to_date_cents bigint NOT NULL DEFAULT 0,
  completed_stored_cents bigint NOT NULL DEFAULT 0,
  retainage_work_cents bigint NOT NULL DEFAULT 0,
  retainage_stored_cents bigint NOT NULL DEFAULT 0,
  total_retainage_cents bigint NOT NULL DEFAULT 0,
  earned_less_retainage_cents bigint NOT NULL DEFAULT 0,
  previous_certificates_cents bigint NOT NULL DEFAULT 0,
  current_payment_due_cents bigint NOT NULL DEFAULT 0,
  balance_to_finish_cents bigint NOT NULL DEFAULT 0,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  issued_at timestamptz,
  paid_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, application_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_pay_apps_one_draft ON install_pay_apps(project_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_install_pay_apps_project ON install_pay_apps(project_id, application_no DESC);
CREATE INDEX IF NOT EXISTS idx_install_pay_apps_invoice ON install_pay_apps(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS install_pay_app_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  pay_app_id uuid NOT NULL REFERENCES install_pay_apps(id) ON DELETE CASCADE,
  sov_line_id uuid REFERENCES install_sov_lines(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  item_no text NOT NULL,
  description text NOT NULL,
  scheduled_value_cents bigint NOT NULL CHECK (scheduled_value_cents >= 0),
  change_order_ref text,
  previous_cents bigint NOT NULL DEFAULT 0 CHECK (previous_cents >= 0),
  this_period_cents bigint NOT NULL DEFAULT 0,
  stored_cents bigint NOT NULL DEFAULT 0 CHECK (stored_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_pay_app_lines_sov ON install_pay_app_lines(pay_app_id, sov_line_id) WHERE sov_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_pay_app_lines_app ON install_pay_app_lines(pay_app_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_install_pay_app_lines_sov_ref ON install_pay_app_lines(sov_line_id) WHERE sov_line_id IS NOT NULL;

-- =============================================================
-- SOV GUARD (direct client writes): owner forced, project checked,
-- values locked once a line is on an issued / paid application.
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_sov_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Project deletion cascades here: the parent is already gone, so allow it.
    IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = OLD.project_id) THEN
      RETURN OLD;
    END IF;
  ELSE
    NEW.item_no := btrim(NEW.item_no);
    NEW.description := btrim(NEW.description);
    NEW.change_order_ref := NULLIF(btrim(COALESCE(NEW.change_order_ref, '')), '');
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.user_id := public.get_account_owner_id();
    IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_project';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id THEN RAISE EXCEPTION 'immutable_link'; END IF;
    NEW.updated_at := now();
    IF NEW.scheduled_value_cents = OLD.scheduled_value_cents
       AND NEW.change_order_ref IS NOT DISTINCT FROM OLD.change_order_ref THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM install_pay_app_lines l
      JOIN install_pay_apps a ON a.id = l.pay_app_id
     WHERE l.sov_line_id = OLD.id AND a.status IN ('issued', 'paid')
  ) INTO v_locked;
  IF v_locked THEN RAISE EXCEPTION 'sov_locked'; END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_install_sov_guard ON install_sov_lines;
CREATE TRIGGER trg_install_sov_guard
  BEFORE INSERT OR UPDATE OR DELETE ON install_sov_lines
  FOR EACH ROW EXECUTE FUNCTION public.install_sov_guard();

-- =============================================================
-- ROW LEVEL SECURITY
--   SOV lines: full CRUD (trigger-guarded).
--   Pay applications + lines: SELECT only — writes go through the RPCs.
-- =============================================================

ALTER TABLE install_sov_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pay_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pay_app_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS install_sov_lines_select ON install_sov_lines;
CREATE POLICY install_sov_lines_select ON install_sov_lines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());
DROP POLICY IF EXISTS install_sov_lines_insert ON install_sov_lines;
CREATE POLICY install_sov_lines_insert ON install_sov_lines FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());
DROP POLICY IF EXISTS install_sov_lines_update ON install_sov_lines;
CREATE POLICY install_sov_lines_update ON install_sov_lines FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());
DROP POLICY IF EXISTS install_sov_lines_delete ON install_sov_lines;
CREATE POLICY install_sov_lines_delete ON install_sov_lines FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

DROP POLICY IF EXISTS install_pay_apps_select ON install_pay_apps;
CREATE POLICY install_pay_apps_select ON install_pay_apps FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

DROP POLICY IF EXISTS install_pay_app_lines_select ON install_pay_app_lines;
CREATE POLICY install_pay_app_lines_select ON install_pay_app_lines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

-- =============================================================
-- RECALC (internal) — the SQL twin of calculateApplication()
-- Re-syncs a DRAFT from the SOV + prior issued application, validates
-- every rule, and writes the G702 totals. Never granted to clients.
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_pay_app_recalc(p_app uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a install_pay_apps%ROWTYPE;
  p install_projects%ROWTYPE;
  r record;
  v_prev_app uuid;
  v_prev_cert bigint;
  v_bps bigint;
  v_orig bigint := 0;
  v_co bigint := 0;
  v_work bigint := 0;
  v_stored bigint := 0;
  v_total bigint;
  v_ret_work bigint;
  v_ret_stored bigint;
  v_ret_total bigint;
  v_earned bigint;
BEGIN
  SELECT * INTO a FROM install_pay_apps WHERE id = p_app FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pay_app_not_found'; END IF;
  IF auth.uid() IS NULL OR a.user_id IS DISTINCT FROM public.get_account_owner_id() OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF a.status <> 'draft' THEN RAISE EXCEPTION 'pay_app_locked'; END IF;

  SELECT * INTO p FROM install_projects WHERE id = a.project_id AND user_id = a.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;

  SELECT x.id, x.earned_less_retainage_cents INTO v_prev_app, v_prev_cert
    FROM install_pay_apps x
   WHERE x.project_id = a.project_id
     AND x.status IN ('issued', 'paid')
     AND x.application_no < a.application_no
   ORDER BY x.application_no DESC
   LIMIT 1;
  v_prev_cert := COALESCE(v_prev_cert, 0);

  -- Every SOV line gets a row; rows whose SOV line was deleted are dropped.
  INSERT INTO install_pay_app_lines (user_id, project_id, pay_app_id, sov_line_id, sort_order, item_no, description, scheduled_value_cents, change_order_ref)
  SELECT a.user_id, a.project_id, a.id, s.id, s.sort_order, s.item_no, s.description, s.scheduled_value_cents, s.change_order_ref
    FROM install_sov_lines s
   WHERE s.project_id = a.project_id
  ON CONFLICT (pay_app_id, sov_line_id) WHERE sov_line_id IS NOT NULL DO NOTHING;

  DELETE FROM install_pay_app_lines WHERE pay_app_id = a.id AND sov_line_id IS NULL;

  FOR r IN
    SELECT l.id AS line_id,
           s.item_no AS item_no,
           s.description AS descr,
           s.scheduled_value_cents AS sv,
           s.change_order_ref AS co,
           s.sort_order AS so,
           COALESCE(pl.previous_cents + pl.this_period_cents, 0) AS d,
           l.this_period_cents AS e,
           l.stored_cents AS f
      FROM install_pay_app_lines l
      JOIN install_sov_lines s ON s.id = l.sov_line_id
      LEFT JOIN install_pay_app_lines pl ON pl.pay_app_id = v_prev_app AND pl.sov_line_id = l.sov_line_id
     WHERE l.pay_app_id = a.id
     ORDER BY s.sort_order, s.created_at, s.id
  LOOP
    IF r.d + r.e < 0 OR r.f < 0 THEN RAISE EXCEPTION 'pay_app_line_negative: %', r.item_no; END IF;
    IF r.d + r.e + r.f > r.sv THEN RAISE EXCEPTION 'pay_app_line_over: %', r.item_no; END IF;

    UPDATE install_pay_app_lines
       SET sort_order = r.so,
           item_no = r.item_no,
           description = r.descr,
           scheduled_value_cents = r.sv,
           change_order_ref = r.co,
           previous_cents = r.d
     WHERE id = r.line_id;

    IF r.co IS NULL THEN v_orig := v_orig + r.sv; ELSE v_co := v_co + r.sv; END IF;
    v_work := v_work + r.d + r.e;
    v_stored := v_stored + r.f;
  END LOOP;

  v_bps := round(p.retainage_percent * 100)::bigint;
  v_total := v_work + v_stored;
  v_ret_work := (v_work * v_bps + 5000) / 10000;
  v_ret_stored := (v_stored * v_bps + 5000) / 10000;
  IF a.retainage_release_cents > v_ret_work + v_ret_stored THEN RAISE EXCEPTION 'pay_app_release_exceeds'; END IF;
  v_ret_total := v_ret_work + v_ret_stored - a.retainage_release_cents;
  v_earned := v_total - v_ret_total;

  UPDATE install_pay_apps
     SET retainage_percent = p.retainage_percent,
         original_contract_cents = v_orig,
         change_orders_cents = v_co,
         contract_to_date_cents = v_orig + v_co,
         completed_stored_cents = v_total,
         retainage_work_cents = v_ret_work,
         retainage_stored_cents = v_ret_stored,
         total_retainage_cents = v_ret_total,
         earned_less_retainage_cents = v_earned,
         previous_certificates_cents = v_prev_cert,
         current_payment_due_cents = v_earned - v_prev_cert,
         balance_to_finish_cents = v_orig + v_co - v_earned,
         updated_at = now()
   WHERE id = a.id;
END $$;

-- =============================================================
-- SAVE DRAFT — creates the project's single draft if needed
-- p_lines: [{"sov_line_id": uuid, "this_period_cents": int, "stored_cents": int}, ...]
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_install_pay_app(
  p_project_id uuid,
  p_period_to date,
  p_application_date date,
  p_notes text,
  p_retainage_release_cents bigint,
  p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p install_projects%ROWTYPE;
  rec record;
  v_app uuid;
  v_no integer;
  v_last_period date;
  v_en numeric;
  v_fn numeric;
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO p FROM install_projects WHERE id = p_project_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
  IF p_period_to IS NULL THEN RAISE EXCEPTION 'pay_app_period_invalid'; END IF;
  IF COALESCE(p_retainage_release_cents, 0) < 0 THEN RAISE EXCEPTION 'pay_app_release_exceeds'; END IF;
  IF jsonb_typeof(COALESCE(p_lines, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'pay_app_bad_payload'; END IF;

  SELECT max(period_to) INTO v_last_period
    FROM install_pay_apps
   WHERE project_id = p.id AND status IN ('issued', 'paid');
  IF v_last_period IS NOT NULL AND p_period_to < v_last_period THEN RAISE EXCEPTION 'pay_app_period_invalid'; END IF;

  SELECT id INTO v_app FROM install_pay_apps WHERE project_id = p.id AND status = 'draft';
  IF v_app IS NULL THEN
    SELECT COALESCE(max(application_no), 0) + 1 INTO v_no FROM install_pay_apps WHERE project_id = p.id;
    INSERT INTO install_pay_apps (user_id, project_id, application_no, period_to, application_date, retainage_percent, created_by)
    VALUES (v_owner, p.id, v_no, p_period_to, COALESCE(p_application_date, current_date), p.retainage_percent, auth.uid())
    RETURNING id INTO v_app;
  END IF;

  UPDATE install_pay_apps
     SET period_to = p_period_to,
         application_date = COALESCE(p_application_date, current_date),
         notes = NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), ''),
         retainage_release_cents = COALESCE(p_retainage_release_cents, 0),
         updated_at = now()
   WHERE id = v_app;

  -- Make sure every current SOV line has a row, then apply the entered amounts.
  INSERT INTO install_pay_app_lines (user_id, project_id, pay_app_id, sov_line_id, sort_order, item_no, description, scheduled_value_cents, change_order_ref)
  SELECT v_owner, p.id, v_app, s.id, s.sort_order, s.item_no, s.description, s.scheduled_value_cents, s.change_order_ref
    FROM install_sov_lines s
   WHERE s.project_id = p.id
  ON CONFLICT (pay_app_id, sov_line_id) WHERE sov_line_id IS NOT NULL DO NOTHING;

  FOR rec IN SELECT value AS v FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) LOOP
    IF jsonb_typeof(rec.v) IS DISTINCT FROM 'object'
       OR jsonb_typeof(rec.v -> 'sov_line_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(rec.v -> 'this_period_cents') IS DISTINCT FROM 'number'
       OR jsonb_typeof(rec.v -> 'stored_cents') IS DISTINCT FROM 'number'
       OR (rec.v ->> 'sov_line_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'pay_app_bad_payload';
    END IF;

    v_en := (rec.v ->> 'this_period_cents')::numeric;
    v_fn := (rec.v ->> 'stored_cents')::numeric;
    IF v_en <> trunc(v_en) OR v_fn <> trunc(v_fn) OR abs(v_en) > 1000000000000 OR v_fn > 1000000000000 THEN
      RAISE EXCEPTION 'pay_app_bad_payload';
    END IF;
    IF v_fn < 0 THEN RAISE EXCEPTION 'pay_app_line_negative'; END IF;

    UPDATE install_pay_app_lines
       SET this_period_cents = v_en::bigint,
           stored_cents = v_fn::bigint
     WHERE pay_app_id = v_app
       AND sov_line_id = (rec.v ->> 'sov_line_id')::uuid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'pay_app_bad_payload'; END IF;
  END LOOP;

  PERFORM public.install_pay_app_recalc(v_app);
  RETURN v_app;
END $$;

-- =============================================================
-- STATUS TRANSITIONS
--   issue   draft  -> issued   (re-validates, SOV must equal the contract)
--   paid    issued -> paid
--   unpaid  paid   -> issued
--   void    issued -> void     (latest application only, no open invoice)
--   discard draft  -> deleted
-- =============================================================

CREATE OR REPLACE FUNCTION public.transition_install_pay_app(p_pay_app_id uuid, p_action text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_project uuid;
  v_latest integer;
  a install_pay_apps%ROWTYPE;
  p install_projects%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT project_id INTO v_project FROM install_pay_apps WHERE id = p_pay_app_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'pay_app_not_found'; END IF;

  -- Same lock order as save_install_pay_app: project first, then the application.
  SELECT * INTO p FROM install_projects WHERE id = v_project AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  SELECT * INTO a FROM install_pay_apps WHERE id = p_pay_app_id FOR UPDATE;

  IF p_action = 'issue' THEN
    IF a.status <> 'draft' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
    IF p.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
    IF p.contract_value_cents <= 0 THEN RAISE EXCEPTION 'no_contract_value'; END IF;
    PERFORM public.install_pay_app_recalc(a.id);
    SELECT * INTO a FROM install_pay_apps WHERE id = p_pay_app_id;
    IF NOT EXISTS (SELECT 1 FROM install_pay_app_lines WHERE pay_app_id = a.id) THEN RAISE EXCEPTION 'pay_app_no_lines'; END IF;
    IF a.original_contract_cents <> p.contract_value_cents THEN RAISE EXCEPTION 'pay_app_sov_mismatch'; END IF;
    UPDATE install_pay_apps SET status = 'issued', issued_at = now(), updated_at = now() WHERE id = a.id;

  ELSIF p_action = 'paid' THEN
    IF a.status <> 'issued' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
    UPDATE install_pay_apps SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = a.id;

  ELSIF p_action = 'unpaid' THEN
    IF a.status <> 'paid' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
    UPDATE install_pay_apps SET status = 'issued', paid_at = NULL, updated_at = now() WHERE id = a.id;

  ELSIF p_action = 'void' THEN
    IF a.status <> 'issued' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
    SELECT max(application_no) INTO v_latest
      FROM install_pay_apps
     WHERE project_id = a.project_id AND status IN ('issued', 'paid');
    IF a.application_no <> v_latest THEN RAISE EXCEPTION 'pay_app_not_latest'; END IF;
    IF EXISTS (SELECT 1 FROM install_pay_apps WHERE project_id = a.project_id AND status = 'draft') THEN
      RAISE EXCEPTION 'pay_app_draft_exists';
    END IF;
    IF a.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = a.invoice_id AND status <> 'void') THEN
      RAISE EXCEPTION 'pay_app_invoiced';
    END IF;
    UPDATE install_pay_apps SET status = 'void', updated_at = now() WHERE id = a.id;

  ELSIF p_action = 'discard' THEN
    IF a.status <> 'draft' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
    DELETE FROM install_pay_apps WHERE id = a.id;

  ELSE
    RAISE EXCEPTION 'pay_app_bad_transition';
  END IF;

  RETURN p_pay_app_id;
END $$;

-- =============================================================
-- INVOICE FROM AN ISSUED APPLICATION (draft invoice in Invoicing)
-- Two lines so the invoice mirrors G702 lines 6 and 7 and sums to line 8.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_install_pay_app_invoice(p_pay_app_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_project uuid;
  a install_pay_apps%ROWTYPE;
  p install_projects%ROWTYPE;
  v_email text;
  v_phone text;
  v_items jsonb;
  v_inv uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT project_id INTO v_project FROM install_pay_apps WHERE id = p_pay_app_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'pay_app_not_found'; END IF;

  SELECT * INTO p FROM install_projects WHERE id = v_project AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  SELECT * INTO a FROM install_pay_apps WHERE id = p_pay_app_id FOR UPDATE;

  IF a.status <> 'issued' THEN RAISE EXCEPTION 'pay_app_bad_transition'; END IF;
  IF a.current_payment_due_cents <= 0 THEN RAISE EXCEPTION 'pay_app_nothing_due'; END IF;
  IF a.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = a.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'pay_app_already_invoiced';
  END IF;

  v_items := jsonb_build_array(jsonb_build_object(
    'description', 'Pay application #' || a.application_no || ' — total earned less retainage, work through ' || to_char(a.period_to, 'Mon DD, YYYY'),
    'quantity', 1,
    'unit_price_cents', a.earned_less_retainage_cents));
  IF a.previous_certificates_cents <> 0 THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'description', 'Less previous certificates for payment',
      'quantity', 1,
      'unit_price_cents', -a.previous_certificates_cents));
  END IF;

  SELECT email, phone INTO v_email, v_phone FROM customers WHERE id = p.customer_id AND user_id = v_owner;

  INSERT INTO invoices (user_id, quote_id, customer_name, customer_email, customer_phone, line_items, tax_percent, notes, due_date)
  VALUES (v_owner, p.quote_id, p.customer_name, v_email, v_phone, v_items, 0,
          'Project ' || COALESCE(p.project_number, '') || ' — pay application #' || a.application_no, p_due_date)
  RETURNING id INTO v_inv;

  UPDATE install_pay_apps SET invoice_id = v_inv, updated_at = now() WHERE id = a.id;
  RETURN v_inv;
END $$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.install_pay_app_recalc(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_install_pay_app(uuid, date, date, text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_install_pay_app(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_install_pay_app_invoice(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_install_pay_app(uuid, date, date, text, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_install_pay_app(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_install_pay_app_invoice(uuid, date) TO authenticated;
