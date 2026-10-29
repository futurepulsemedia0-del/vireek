/*
  # Change Orders for Install Projects

  Scope changes on a project: number, reason, line items, markup, cost and
  schedule impact, customer e-signature, approval and billing.

  Status flow (enforced in the database, not only in the UI):
      draft -> sent -> approved | rejected
      draft | sent -> voided          (withdrawn)
      sent | rejected -> draft        (revise and resend)
  Approved and voided are final. A mistake in an approved change order is
  corrected with a new change order.

  What approval does (atomically, in one transaction):
    - install_projects.approved_change_cents      += cost delta
    - install_projects.approved_change_cost_cents += internal cost estimate
    - install_projects.approved_schedule_days     += schedule delta
    - install_projects.target_end_date            += schedule delta (if set)
  Revised contract = contract_value_cents (original) + approved_change_cents.
  Percent-based progress draws keep billing against the ORIGINAL contract, so
  create_project_invoice() / release_project_retainage() are NOT touched and
  nothing can be billed twice. Each approved change order is invoiced
  separately by invoice_change_order() (no retainage on change orders).

  E-signature reuses the native system (signature_requests with
  document_type = 'custom', document_id = install_change_orders.id). When the
  customer signs or declines, a trigger on signature_requests moves the change
  order. The trigger can never break signing: failures become warnings and the
  dashboard re-runs the same logic through sync_change_orders().

  - Additive only. Existing functions and policies are not replaced.
  - All rows are scoped to get_account_owner_id() and can_manage_install_projects().
  - Totals are computed by the database; the client cannot forge them.
  - Safe to run more than once.
*/

-- =============================================================
-- 1. Project rollup columns (maintained only by this feature)
-- =============================================================

ALTER TABLE install_projects
  ADD COLUMN IF NOT EXISTS approved_change_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_change_cost_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_schedule_days integer NOT NULL DEFAULT 0;

-- =============================================================
-- 2. Table
-- =============================================================

CREATE TABLE IF NOT EXISTS install_change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  co_number text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  reason text NOT NULL DEFAULT 'customer_request'
    CHECK (reason IN ('customer_request', 'unforeseen_condition', 'code_requirement', 'design_change', 'owner_supplied', 'other')),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  markup_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (markup_percent >= 0 AND markup_percent <= 100),
  subtotal_cents bigint NOT NULL DEFAULT 0,
  markup_cents bigint NOT NULL DEFAULT 0,
  cost_delta_cents bigint NOT NULL DEFAULT 0,
  estimated_cost_cents bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0 AND estimated_cost_cents <= 100000000000),
  schedule_delta_days integer NOT NULL DEFAULT 0 CHECK (schedule_delta_days BETWEEN -365 AND 365),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'approved', 'rejected', 'voided')),
  signature_request_id uuid REFERENCES signature_requests(id) ON DELETE SET NULL,
  sent_at timestamptz,
  decided_at timestamptz,
  decided_by_name text,
  decision_note text,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  invoiced_gross_cents bigint,
  invoiced_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_change_orders_project_seq
  ON install_change_orders(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_install_change_orders_user_status
  ON install_change_orders(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_install_change_orders_signature
  ON install_change_orders(signature_request_id) WHERE signature_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_change_orders_invoice
  ON install_change_orders(invoice_id) WHERE invoice_id IS NOT NULL;

-- =============================================================
-- 3. Triggers
-- =============================================================

-- Owner is forced (never trusted from the client), the project is locked so
-- numbering is race-free, and every new change order starts as a clean draft.
CREATE OR REPLACE FUNCTION public.install_change_orders_force_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_seq integer;
BEGIN
  NEW.user_id := public.get_account_owner_id();
  IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT status INTO v_status FROM install_projects
   WHERE id = NEW.project_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_project'; END IF;
  IF v_status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM install_change_orders WHERE project_id = NEW.project_id;
  NEW.seq := v_seq;
  NEW.co_number := 'CO-' || CASE WHEN v_seq < 1000 THEN lpad(v_seq::text, 3, '0') ELSE v_seq::text END;
  NEW.created_by := auth.uid();

  NEW.status := 'draft';
  NEW.signature_request_id := NULL;
  NEW.sent_at := NULL;
  NEW.decided_at := NULL;
  NEW.decided_by_name := NULL;
  NEW.decision_note := NULL;
  NEW.invoice_id := NULL;
  NEW.invoiced_gross_cents := NULL;
  NEW.invoiced_at := NULL;
  RETURN NEW;
END $$;

-- Validation, totals and the status machine.
-- Status, signature, decision and invoice fields can only be changed by the
-- SECURITY DEFINER functions below (they set a transaction-local flag) or by a
-- foreign-key action such as ON DELETE SET NULL (trigger depth > 1).
CREATE OR REPLACE FUNCTION public.install_change_orders_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_internal boolean := COALESCE(current_setting('vireek.co_internal', true), '') = '1';
  v_item jsonb;
  v_desc text;
  v_qty numeric;
  v_unit numeric;
  v_sub numeric := 0;
  v_markup numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id OR NEW.seq <> OLD.seq
       OR NEW.co_number IS DISTINCT FROM OLD.co_number THEN
      RAISE EXCEPTION 'immutable_link';
    END IF;

    IF NOT v_internal AND pg_trigger_depth() <= 1 THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.signature_request_id IS DISTINCT FROM OLD.signature_request_id
         OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
         OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
         OR NEW.decided_by_name IS DISTINCT FROM OLD.decided_by_name
         OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
         OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
         OR NEW.invoiced_gross_cents IS DISTINCT FROM OLD.invoiced_gross_cents
         OR NEW.invoiced_at IS DISTINCT FROM OLD.invoiced_at THEN
        RAISE EXCEPTION 'change_order_fields_locked';
      END IF;
      IF OLD.status <> 'draft' AND (
           NEW.title IS DISTINCT FROM OLD.title
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.line_items IS DISTINCT FROM OLD.line_items
        OR NEW.markup_percent IS DISTINCT FROM OLD.markup_percent
        OR NEW.estimated_cost_cents IS DISTINCT FROM OLD.estimated_cost_cents
        OR NEW.schedule_delta_days IS DISTINCT FROM OLD.schedule_delta_days) THEN
        RAISE EXCEPTION 'change_order_locked';
      END IF;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('sent', 'voided'))
      OR (OLD.status = 'sent' AND NEW.status IN ('approved', 'rejected', 'voided', 'draft'))
      OR (OLD.status = 'rejected' AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION 'invalid_transition';
    END IF;
  END IF;

  IF jsonb_typeof(NEW.line_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_line_items';
  END IF;
  IF jsonb_array_length(NEW.line_items) > 100 THEN
    RAISE EXCEPTION 'too_many_line_items';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.line_items) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_item -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_item -> 'unit_price_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_line_items';
    END IF;
    v_desc := btrim(v_item ->> 'description');
    v_qty := (v_item ->> 'quantity')::numeric;
    v_unit := (v_item ->> 'unit_price_cents')::numeric;
    IF length(v_desc) < 1 OR length(v_desc) > 200
       OR v_qty <= 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2)
       OR v_unit <> trunc(v_unit) OR abs(v_unit) > 100000000 THEN
      RAISE EXCEPTION 'invalid_line_items';
    END IF;
    v_sub := v_sub + round(v_qty * v_unit);
  END LOOP;

  v_markup := round(v_sub * NEW.markup_percent / 100);
  NEW.subtotal_cents := v_sub::bigint;
  NEW.markup_cents := v_markup::bigint;
  NEW.cost_delta_cents := (v_sub + v_markup)::bigint;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_change_orders_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_co_01_owner ON install_change_orders;
CREATE TRIGGER trg_co_01_owner BEFORE INSERT ON install_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.install_change_orders_force_owner();
DROP TRIGGER IF EXISTS trg_co_02_guard ON install_change_orders;
CREATE TRIGGER trg_co_02_guard BEFORE INSERT OR UPDATE ON install_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.install_change_orders_guard();
DROP TRIGGER IF EXISTS trg_co_03_stamp ON install_change_orders;
CREATE TRIGGER trg_co_03_stamp BEFORE INSERT OR UPDATE ON install_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.install_change_orders_stamp();

-- The approved totals on a project can only move through approval.
CREATE OR REPLACE FUNCTION public.install_projects_guard_change_totals()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('vireek.co_internal', true), '') = '1' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.approved_change_cents := 0;
    NEW.approved_change_cost_cents := 0;
    NEW.approved_schedule_days := 0;
    RETURN NEW;
  END IF;
  IF NEW.approved_change_cents IS DISTINCT FROM OLD.approved_change_cents
     OR NEW.approved_change_cost_cents IS DISTINCT FROM OLD.approved_change_cost_cents
     OR NEW.approved_schedule_days IS DISTINCT FROM OLD.approved_schedule_days THEN
    RAISE EXCEPTION 'change_totals_locked';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ip_04_change_totals ON install_projects;
CREATE TRIGGER trg_ip_04_change_totals BEFORE INSERT OR UPDATE ON install_projects
  FOR EACH ROW EXECUTE FUNCTION public.install_projects_guard_change_totals();

-- =============================================================
-- 4. Row level security (same rule as every install-project table)
-- =============================================================

ALTER TABLE install_change_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS install_change_orders_select ON install_change_orders;
CREATE POLICY install_change_orders_select ON install_change_orders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

DROP POLICY IF EXISTS install_change_orders_insert ON install_change_orders;
CREATE POLICY install_change_orders_insert ON install_change_orders FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

DROP POLICY IF EXISTS install_change_orders_update ON install_change_orders;
CREATE POLICY install_change_orders_update ON install_change_orders FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());

-- Only drafts can be deleted; everything else is withdrawn (voided) and kept.
DROP POLICY IF EXISTS install_change_orders_delete ON install_change_orders;
CREATE POLICY install_change_orders_delete ON install_change_orders FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects() AND status = 'draft');

-- =============================================================
-- 5. Internal helpers (not callable from the browser)
-- =============================================================

CREATE OR REPLACE FUNCTION public._co_owner()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN v_owner;
END $$;

-- Approves a SENT change order and applies it to the project. Idempotent:
-- anything that is not 'sent' is ignored.
CREATE OR REPLACE FUNCTION public._co_apply_approval(p_id uuid, p_signer text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  co install_change_orders%ROWTYPE;
  p install_projects%ROWTYPE;
  v_new_end date;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR co.status <> 'sent' THEN RETURN false; END IF;

  SELECT * INTO p FROM install_projects WHERE id = co.project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;

  v_new_end := p.target_end_date;
  IF co.schedule_delta_days <> 0 AND p.target_end_date IS NOT NULL THEN
    v_new_end := p.target_end_date + co.schedule_delta_days;
    IF p.start_date IS NOT NULL AND v_new_end < p.start_date THEN
      RAISE EXCEPTION 'schedule_before_start';
    END IF;
  END IF;

  PERFORM set_config('vireek.co_internal', '1', true);
  UPDATE install_projects
     SET approved_change_cents = approved_change_cents + co.cost_delta_cents,
         approved_change_cost_cents = approved_change_cost_cents + co.estimated_cost_cents,
         approved_schedule_days = approved_schedule_days + co.schedule_delta_days,
         target_end_date = v_new_end
   WHERE id = p.id;
  UPDATE install_change_orders
     SET status = 'approved', decided_at = now(), decided_by_name = left(btrim(COALESCE(p_signer, '')), 160)
   WHERE id = co.id;
  PERFORM set_config('vireek.co_internal', '', true);
  RETURN true;
END $$;

-- Reads the e-signature outcome for one SENT change order and moves it.
-- completed -> approved, declined -> rejected, voided/expired -> back to draft.
CREATE OR REPLACE FUNCTION public._co_sync_one(p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  co install_change_orders%ROWTYPE;
  v_sr_status text;
  v_sr_reason text;
  v_signer text;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF co.status <> 'sent' OR co.signature_request_id IS NULL THEN RETURN co.status; END IF;

  SELECT status, decline_reason INTO v_sr_status, v_sr_reason
    FROM signature_requests WHERE id = co.signature_request_id;
  IF NOT FOUND THEN RETURN co.status; END IF;

  IF v_sr_status = 'completed' THEN
    SELECT COALESCE(NULLIF(btrim(s.signed_name), ''), s.name) INTO v_signer
      FROM signature_signers s
     WHERE s.request_id = co.signature_request_id AND s.status = 'signed'
     ORDER BY (s.role = 'signer') DESC, s.signed_at DESC NULLS LAST
     LIMIT 1;
    PERFORM public._co_apply_approval(co.id, COALESCE(v_signer, 'Customer'));
  ELSIF v_sr_status = 'declined' THEN
    PERFORM set_config('vireek.co_internal', '1', true);
    UPDATE install_change_orders
       SET status = 'rejected', decided_at = now(),
           decision_note = NULLIF(left(btrim(COALESCE(v_sr_reason, '')), 500), '')
     WHERE id = co.id;
    PERFORM set_config('vireek.co_internal', '', true);
  ELSIF v_sr_status IN ('voided', 'expired') THEN
    PERFORM set_config('vireek.co_internal', '1', true);
    UPDATE install_change_orders
       SET status = 'draft', signature_request_id = NULL, sent_at = NULL
     WHERE id = co.id;
    PERFORM set_config('vireek.co_internal', '', true);
  END IF;

  RETURN (SELECT status FROM install_change_orders WHERE id = p_id);
END $$;

-- =============================================================
-- 6. E-signature hook (never allowed to break signing)
-- =============================================================

CREATE OR REPLACE FUNCTION public.change_orders_on_signature_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_co uuid;
BEGIN
  SELECT id INTO v_co FROM install_change_orders
   WHERE signature_request_id = NEW.id AND status = 'sent' LIMIT 1;
  IF v_co IS NOT NULL THEN
    BEGIN
      PERFORM public._co_sync_one(v_co);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'change order % could not be synced: %', v_co, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_change_orders_signature ON signature_requests;
CREATE TRIGGER trg_change_orders_signature
  AFTER UPDATE OF status ON signature_requests
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.change_orders_on_signature_change();

-- =============================================================
-- 7. Public RPCs
-- =============================================================

-- Links a draft to the signature request the dashboard just created.
CREATE OR REPLACE FUNCTION public.mark_change_order_sent(p_id uuid, p_signature_request_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._co_owner();
  co install_change_orders%ROWTYPE;
  v_proj_status text;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status <> 'draft' THEN RAISE EXCEPTION 'invalid_transition'; END IF;

  SELECT status INTO v_proj_status FROM install_projects WHERE id = co.project_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF v_proj_status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
  IF co.cost_delta_cents = 0 AND co.schedule_delta_days = 0 THEN RAISE EXCEPTION 'change_order_empty'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM signature_requests sr
     WHERE sr.id = p_signature_request_id
       AND sr.user_id IN (v_owner, auth.uid())
       AND sr.document_type = 'custom'
       AND sr.document_id = co.id
       AND sr.status NOT IN ('voided', 'expired', 'declined')
  ) THEN
    RAISE EXCEPTION 'signature_mismatch';
  END IF;

  PERFORM set_config('vireek.co_internal', '1', true);
  UPDATE install_change_orders
     SET status = 'sent', signature_request_id = p_signature_request_id, sent_at = now(),
         decided_at = NULL, decided_by_name = NULL, decision_note = NULL
   WHERE id = co.id;
  PERFORM set_config('vireek.co_internal', '', true);

  RETURN public._co_sync_one(co.id);
END $$;

-- Re-checks every SENT change order of a project against its signature.
-- Never raises for one bad row: returns {changed, error}.
CREATE OR REPLACE FUNCTION public.sync_change_orders(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._co_owner();
  r record;
  v_changed integer := 0;
  v_error text := NULL;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = p_project_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;

  FOR r IN
    SELECT id FROM install_change_orders
     WHERE project_id = p_project_id AND user_id = v_owner
       AND status = 'sent' AND signature_request_id IS NOT NULL
     ORDER BY seq
  LOOP
    BEGIN
      IF public._co_sync_one(r.id) <> 'sent' THEN v_changed := v_changed + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'error', v_error);
END $$;

-- Withdraws a draft or sent change order (and its open signature request).
CREATE OR REPLACE FUNCTION public.void_change_order(p_id uuid, p_reason text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._co_owner();
  co install_change_orders%ROWTYPE;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'invalid_transition'; END IF;

  PERFORM set_config('vireek.co_internal', '1', true);
  UPDATE install_change_orders
     SET status = 'voided', decided_at = now(),
         decision_note = NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '')
   WHERE id = co.id;
  PERFORM set_config('vireek.co_internal', '', true);

  IF co.signature_request_id IS NOT NULL THEN
    UPDATE signature_requests SET status = 'voided', voided_at = now()
     WHERE id = co.signature_request_id AND status IN ('sent', 'viewed', 'partially_signed');
  END IF;
  RETURN 'voided';
END $$;

-- Sent or rejected -> draft so it can be revised and sent again.
CREATE OR REPLACE FUNCTION public.reopen_change_order(p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._co_owner();
  co install_change_orders%ROWTYPE;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status NOT IN ('sent', 'rejected') THEN RAISE EXCEPTION 'invalid_transition'; END IF;

  PERFORM set_config('vireek.co_internal', '1', true);
  UPDATE install_change_orders
     SET status = 'draft', signature_request_id = NULL, sent_at = NULL,
         decided_at = NULL, decided_by_name = NULL, decision_note = NULL
   WHERE id = co.id;
  PERFORM set_config('vireek.co_internal', '', true);

  IF co.status = 'sent' AND co.signature_request_id IS NOT NULL THEN
    UPDATE signature_requests SET status = 'voided', voided_at = now()
     WHERE id = co.signature_request_id AND status IN ('sent', 'viewed', 'partially_signed');
  END IF;
  RETURN 'draft';
END $$;

-- Draft invoice for an approved change order (a negative total is a credit).
CREATE OR REPLACE FUNCTION public.invoice_change_order(p_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._co_owner();
  co install_change_orders%ROWTYPE;
  p install_projects%ROWTYPE;
  v_email text;
  v_phone text;
  v_inv uuid;
BEGIN
  SELECT * INTO co FROM install_change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status <> 'approved' THEN RAISE EXCEPTION 'change_order_not_approved'; END IF;
  IF co.cost_delta_cents = 0 THEN RAISE EXCEPTION 'nothing_to_invoice'; END IF;
  IF co.invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM invoices WHERE id = co.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'already_invoiced';
  END IF;

  SELECT * INTO p FROM install_projects WHERE id = co.project_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF p.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;

  SELECT email, phone INTO v_email, v_phone FROM customers WHERE id = p.customer_id AND user_id = v_owner;

  INSERT INTO invoices (user_id, quote_id, customer_name, customer_email, customer_phone, line_items, tax_percent, notes, due_date)
  VALUES (v_owner, p.quote_id, p.customer_name, v_email, v_phone,
          jsonb_build_array(jsonb_build_object(
            'description', 'Change order ' || co.co_number || ' — ' || co.title,
            'quantity', 1,
            'unit_price_cents', co.cost_delta_cents)),
          0,
          'Project ' || COALESCE(p.project_number, '') || ' — change order ' || co.co_number,
          p_due_date)
  RETURNING id INTO v_inv;

  PERFORM set_config('vireek.co_internal', '1', true);
  UPDATE install_change_orders
     SET invoice_id = v_inv, invoiced_gross_cents = co.cost_delta_cents, invoiced_at = now()
   WHERE id = co.id;
  PERFORM set_config('vireek.co_internal', '', true);

  RETURN v_inv;
END $$;

REVOKE ALL ON FUNCTION public._co_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._co_apply_approval(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._co_sync_one(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_change_order_sent(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_change_orders(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_change_order(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_change_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_change_order(uuid, date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mark_change_order_sent(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_change_orders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_change_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_change_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_change_order(uuid, date) TO authenticated;
