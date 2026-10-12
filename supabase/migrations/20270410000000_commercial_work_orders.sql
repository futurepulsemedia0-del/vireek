/*
  # Commercial Work Orders

  ## Why
  Commercial customers (property managers, facilities teams, GCs) issue a
  purchase order, approve the scope, then expect several scheduled visits
  billed individually against a not-to-exceed (NTE) cap.

  ## Tables
  - work_orders        PO number, site + site contact, approval status, NTE cap
  - work_order_visits  multi-visit scheduling, technician, per-visit billing

  ## Access
  Every row is scoped to the account via `public.get_account_owner_id()`.
  Work orders carry billing data, so reads AND writes additionally require
  `public.can_manage_work_orders()`: the account owner, or a team member with
  permissions.can_view_billing = true (same gate as the UI).

  ## Integrity (enforced in the database, not only the UI)
  - customer_id / assigned_technician_id must belong to the same account
  - work cannot start (in_progress / completed) until approval is approved
    or not_required
  - a visit can only be billed (ready_to_bill / invoiced / paid) once completed
  - non-void billable amounts can never exceed the work order's NTE cap
  - visit numbers and WO-00001 style numbers are assigned race-free
  - invoiced / paid visits cannot be deleted (void them first)
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- ACCESS HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_work_orders()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_work_orders() TO authenticated;

-- =============================================================
-- WORK ORDERS
-- =============================================================
CREATE TABLE IF NOT EXISTS work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,

  work_order_number text,
  po_number text,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 5000),

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approver_name text,
  approved_at timestamptz,
  approval_notes text,

  site_name text,
  site_address text,
  site_contact_name text,
  site_contact_phone text,
  site_contact_email text,

  not_to_exceed_cents integer CHECK (not_to_exceed_cents IS NULL OR not_to_exceed_cents >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_number
  ON work_orders(user_id, work_order_number) WHERE work_order_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_user_created
  ON work_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_orders_user_status
  ON work_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_work_orders_po
  ON work_orders(user_id, po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_customer
  ON work_orders(customer_id);

-- =============================================================
-- VISITS
-- =============================================================
CREATE TABLE IF NOT EXISTS work_order_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  visit_number integer,

  scheduled_start timestamptz,
  scheduled_end timestamptz,
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_access')),
  completed_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 5000),

  billing_status text NOT NULL DEFAULT 'unbilled'
    CHECK (billing_status IN ('unbilled', 'ready_to_bill', 'invoiced', 'paid', 'void')),
  billable_amount_cents integer CHECK (billable_amount_cents IS NULL OR billable_amount_cents >= 0),
  invoice_reference text,
  billed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_order_visits_schedule_chk
    CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_visits_number
  ON work_order_visits(work_order_id, visit_number);
CREATE INDEX IF NOT EXISTS idx_work_order_visits_user_start
  ON work_order_visits(user_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_work_order_visits_tech
  ON work_order_visits(assigned_technician_id) WHERE assigned_technician_id IS NOT NULL;

-- =============================================================
-- TRIGGER: work order integrity
-- =============================================================
CREATE OR REPLACE FUNCTION public.work_orders_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A work order cannot be moved to another account' USING ERRCODE = '42501';
  END IF;

  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Customer does not belong to this account' USING ERRCODE = '42501';
  END IF;

  -- Race-free WO-00001 numbering: serialise per account on the profile row.
  IF TG_OP = 'INSERT' AND NEW.work_order_number IS NULL THEN
    PERFORM 1 FROM profiles WHERE id = NEW.user_id FOR UPDATE;
    SELECT COALESCE(MAX(substring(work_order_number FROM 4)::bigint), 0) + 1
      INTO v_next
      FROM work_orders
      WHERE user_id = NEW.user_id AND work_order_number ~ '^WO-[0-9]+$';
    NEW.work_order_number := 'WO-' || lpad(v_next::text, 5, '0');
  END IF;

  -- Approval timestamp follows the approval decision.
  IF NEW.approval_status IN ('approved', 'rejected')
     AND (TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM NEW.approval_status) THEN
    NEW.approved_at := now();
  ELSIF NEW.approval_status IN ('pending', 'not_required') THEN
    NEW.approved_at := NULL;
  END IF;

  IF NEW.status IN ('in_progress', 'completed')
     AND NEW.approval_status NOT IN ('approved', 'not_required') THEN
    RAISE EXCEPTION 'This work order must be approved before work can start'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_work_orders_before_write ON work_orders;
CREATE TRIGGER trigger_work_orders_before_write
  BEFORE INSERT OR UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_before_write();

DROP TRIGGER IF EXISTS trigger_touch_work_orders ON work_orders;
CREATE TRIGGER trigger_touch_work_orders
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- TRIGGER: visit integrity (+ NTE cap, approval gate, billing rules)
-- =============================================================
CREATE OR REPLACE FUNCTION public.work_order_visits_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_approval text;
  v_wo_status text;
  v_nte integer;
  v_committed bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.work_order_id IS DISTINCT FROM OLD.work_order_id THEN
    RAISE EXCEPTION 'A visit cannot be moved to another work order' USING ERRCODE = '23514';
  END IF;

  -- Lock the parent: serialises numbering and NTE checks per work order.
  SELECT user_id, approval_status, status, not_to_exceed_cents
    INTO v_owner, v_approval, v_wo_status, v_nte
    FROM work_orders WHERE id = NEW.work_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work order not found' USING ERRCODE = '23503';
  END IF;

  -- The parent decides the owner; RLS WITH CHECK then rejects cross-account writes.
  NEW.user_id := v_owner;

  IF NEW.assigned_technician_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.id = NEW.assigned_technician_id AND tm.account_owner_id = v_owner
  ) THEN
    RAISE EXCEPTION 'Technician does not belong to this account' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.visit_number IS NULL THEN
    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO NEW.visit_number
      FROM work_order_visits WHERE work_order_id = NEW.work_order_id;
  END IF;

  IF NEW.status IN ('in_progress', 'completed')
     AND v_approval NOT IN ('approved', 'not_required') THEN
    RAISE EXCEPTION 'This work order must be approved before a visit can start'
      USING ERRCODE = '23514';
  END IF;

  IF v_wo_status = 'cancelled' AND NEW.status IN ('scheduled', 'in_progress')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    RAISE EXCEPTION 'This work order is cancelled' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := now();
  ELSIF NEW.status <> 'completed' THEN
    NEW.completed_at := NULL;
  END IF;

  IF NEW.billing_status IN ('ready_to_bill', 'invoiced', 'paid') THEN
    IF NEW.status <> 'completed' THEN
      RAISE EXCEPTION 'Only completed visits can be billed' USING ERRCODE = '23514';
    END IF;
    IF NEW.billable_amount_cents IS NULL THEN
      RAISE EXCEPTION 'Enter a billable amount before billing this visit' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.billing_status = 'invoiced' AND NEW.billed_at IS NULL THEN
    NEW.billed_at := now();
  END IF;

  -- Not-to-exceed cap across all live visits of this work order.
  IF v_nte IS NOT NULL
     AND NEW.billing_status <> 'void'
     AND NEW.status <> 'cancelled'
     AND COALESCE(NEW.billable_amount_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(billable_amount_cents), 0) INTO v_committed
      FROM work_order_visits
      WHERE work_order_id = NEW.work_order_id
        AND id IS DISTINCT FROM NEW.id
        AND billing_status <> 'void'
        AND status <> 'cancelled';
    IF v_committed + NEW.billable_amount_cents > v_nte THEN
      RAISE EXCEPTION 'Visit billing would exceed the work order not-to-exceed amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_work_order_visits_before_write ON work_order_visits;
CREATE TRIGGER trigger_work_order_visits_before_write
  BEFORE INSERT OR UPDATE ON work_order_visits
  FOR EACH ROW EXECUTE FUNCTION public.work_order_visits_before_write();

DROP TRIGGER IF EXISTS trigger_touch_work_order_visits ON work_order_visits;
CREATE TRIGGER trigger_touch_work_order_visits
  BEFORE UPDATE ON work_order_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.work_order_visits_before_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.billing_status IN ('invoiced', 'paid') THEN
    RAISE EXCEPTION 'Billed visits cannot be deleted. Void the billing first.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_work_order_visits_before_delete ON work_order_visits;
CREATE TRIGGER trigger_work_order_visits_before_delete
  BEFORE DELETE ON work_order_visits
  FOR EACH ROW EXECUTE FUNCTION public.work_order_visits_before_delete();

-- =============================================================
-- RLS
-- =============================================================
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_work_orders" ON work_orders;
CREATE POLICY "select_own_work_orders" ON work_orders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "insert_own_work_orders" ON work_orders;
CREATE POLICY "insert_own_work_orders" ON work_orders FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "update_own_work_orders" ON work_orders;
CREATE POLICY "update_own_work_orders" ON work_orders FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "delete_own_work_orders" ON work_orders;
CREATE POLICY "delete_own_work_orders" ON work_orders FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "select_own_work_order_visits" ON work_order_visits;
CREATE POLICY "select_own_work_order_visits" ON work_order_visits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "insert_own_work_order_visits" ON work_order_visits;
CREATE POLICY "insert_own_work_order_visits" ON work_order_visits FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "update_own_work_order_visits" ON work_order_visits;
CREATE POLICY "update_own_work_order_visits" ON work_order_visits FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "delete_own_work_order_visits" ON work_order_visits;
CREATE POLICY "delete_own_work_order_visits" ON work_order_visits FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());
