/*
  # Vehicle Management (/dashboard/vehicles)

  Builds on the existing fleet tables (vehicles, vehicle_expenses,
  vehicle_maintenance_schedules). It does NOT recreate them.

  - vehicles: + notes, + updated_at (vin / fuel_type already exist).
  - vehicle_assignments: assignment history (who drove which vehicle, when).
    Written only through assign_vehicle() so history and
    vehicles.assigned_technician_id can never drift apart.
  - vehicle_inspections: immutable inspection records with a JSON checklist.
  - vehicle_documents + private storage bucket "vehicle-documents".
  - complete_vehicle_maintenance(): atomic "mark serviced" (schedule +
    optional expense + odometer).
  - vehicle_assignable_technicians(): technician list for the account
    (team members cannot read other team_members rows through RLS).
  - Odometer triggers: a higher reading on an expense or inspection raises
    vehicles.odometer_miles (never lowers it).

  Everything is scoped by public.get_account_owner_id(), like the rest of
  the fleet tables, so owners AND team members see the same account data.
*/

-- =============================================================
-- VEHICLES: extra columns
-- =============================================================

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_notes_len_check') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_notes_len_check
      CHECK (notes IS NULL OR char_length(notes) <= 2000);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- VEHICLE_ASSIGNMENTS (history; written via assign_vehicle only)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text NOT NULL,
  assigned_by uuid DEFAULT auth.uid(),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_assignments_open
  ON vehicle_assignments(vehicle_id) WHERE unassigned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_vehicle
  ON vehicle_assignments(vehicle_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_user
  ON vehicle_assignments(user_id);

ALTER TABLE vehicle_assignments ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON vehicle_assignments FROM anon, authenticated;

DROP POLICY IF EXISTS "select_own_vehicle_assignments" ON vehicle_assignments;
CREATE POLICY "select_own_vehicle_assignments" ON vehicle_assignments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_INSPECTIONS (immutable records: no UPDATE policy)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  inspection_type text NOT NULL CHECK (inspection_type IN ('pre_trip', 'post_trip', 'safety', 'annual', 'dot')),
  result text NOT NULL CHECK (result IN ('pass', 'needs_attention', 'fail')),
  inspected_at timestamptz NOT NULL DEFAULT now(),
  inspected_by uuid DEFAULT auth.uid(),
  odometer_miles numeric CHECK (odometer_miles IS NULL OR odometer_miles >= 0),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checklist) = 'array'),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_vehicle
  ON vehicle_inspections(vehicle_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_user
  ON vehicle_inspections(user_id);

ALTER TABLE vehicle_inspections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_inspections" ON vehicle_inspections;
CREATE POLICY "select_own_vehicle_inspections" ON vehicle_inspections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_vehicle_inspections" ON vehicle_inspections;
CREATE POLICY "insert_own_vehicle_inspections" ON vehicle_inspections FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_vehicle_inspections" ON vehicle_inspections;
CREATE POLICY "delete_own_vehicle_inspections" ON vehicle_inspections FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_DOCUMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('registration', 'insurance', 'inspection', 'title', 'warranty', 'permit', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 15728640),
  issued_on date,
  expires_on date,
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle
  ON vehicle_documents(vehicle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_expiry
  ON vehicle_documents(user_id, expires_on) WHERE expires_on IS NOT NULL;

ALTER TABLE vehicle_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_documents" ON vehicle_documents;
CREATE POLICY "select_own_vehicle_documents" ON vehicle_documents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_vehicle_documents" ON vehicle_documents;
CREATE POLICY "insert_own_vehicle_documents" ON vehicle_documents FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_vehicle_documents" ON vehicle_documents;
CREATE POLICY "update_own_vehicle_documents" ON vehicle_documents FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_vehicle_documents" ON vehicle_documents;
CREATE POLICY "delete_own_vehicle_documents" ON vehicle_documents FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Private bucket. First path segment = account owner id (NOT auth.uid(), so
-- team members can upload into their account's folder too).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-documents',
  'vehicle-documents',
  false,
  15728640, -- 15 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "account_manage_vehicle_documents" ON storage.objects;
CREATE POLICY "account_manage_vehicle_documents"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'vehicle-documents' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text)
WITH CHECK (bucket_id = 'vehicle-documents' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

-- =============================================================
-- ODOMETER TRIGGERS (a higher reading raises the vehicle odometer)
-- =============================================================

CREATE OR REPLACE FUNCTION public.vehicle_bump_odometer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.odometer_miles IS NOT NULL THEN
    UPDATE vehicles
       SET odometer_miles = NEW.odometer_miles
     WHERE id = NEW.vehicle_id
       AND odometer_miles < NEW.odometer_miles;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vehicle_expenses_bump_odometer ON vehicle_expenses;
CREATE TRIGGER trg_vehicle_expenses_bump_odometer
  AFTER INSERT ON vehicle_expenses
  FOR EACH ROW EXECUTE FUNCTION public.vehicle_bump_odometer();

DROP TRIGGER IF EXISTS trg_vehicle_inspections_bump_odometer ON vehicle_inspections;
CREATE TRIGGER trg_vehicle_inspections_bump_odometer
  AFTER INSERT ON vehicle_inspections
  FOR EACH ROW EXECUTE FUNCTION public.vehicle_bump_odometer();

-- =============================================================
-- RPC: technicians of this account (RLS hides other team_members rows)
-- =============================================================

CREATE OR REPLACE FUNCTION public.vehicle_assignable_technicians()
RETURNS TABLE (id uuid, member_name text, member_email text, invite_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id, tm.member_name, tm.member_email, tm.invite_status
    FROM team_members tm
   WHERE tm.account_owner_id = public.get_account_owner_id()
     AND tm.role = 'technician'
   ORDER BY lower(COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email));
$$;

-- =============================================================
-- RPC: assign / unassign (atomic; keeps history in sync)
-- =============================================================

CREATE OR REPLACE FUNCTION public.assign_vehicle(
  p_vehicle_id uuid,
  p_technician_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
  v_current uuid;
  v_name text;
  v_assignment_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT status, assigned_technician_id INTO v_status, v_current
    FROM vehicles WHERE id = p_vehicle_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vehicle not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_technician_id IS NOT NULL THEN
    IF v_status = 'retired' THEN
      RAISE EXCEPTION 'A retired vehicle cannot be assigned' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(NULLIF(btrim(member_name), ''), member_email) INTO v_name
      FROM team_members
     WHERE id = p_technician_id AND account_owner_id = v_owner
       AND role = 'technician' AND invite_status = 'active';
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Technician not found or not active' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF v_current IS NOT DISTINCT FROM p_technician_id THEN
    RETURN NULL; -- nothing to change
  END IF;

  UPDATE vehicle_assignments SET unassigned_at = now()
   WHERE vehicle_id = p_vehicle_id AND unassigned_at IS NULL;

  UPDATE vehicles SET assigned_technician_id = p_technician_id WHERE id = p_vehicle_id;

  IF p_technician_id IS NOT NULL THEN
    INSERT INTO vehicle_assignments (user_id, vehicle_id, technician_id, technician_name, notes)
    VALUES (v_owner, p_vehicle_id, p_technician_id, v_name, NULLIF(btrim(p_notes), ''))
    RETURNING id INTO v_assignment_id;
  END IF;

  RETURN v_assignment_id;
END;
$$;

-- =============================================================
-- RPC: mark a maintenance schedule serviced (atomic)
-- Runs with the caller's rights, so RLS applies to every statement.
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_vehicle_maintenance(
  p_schedule_id uuid,
  p_service_date date DEFAULT current_date,
  p_odometer numeric DEFAULT NULL,
  p_cost numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sched vehicle_maintenance_schedules%ROWTYPE;
  v_vehicle_odo numeric;
  v_odo numeric;
BEGIN
  SELECT * INTO v_sched FROM vehicle_maintenance_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Maintenance schedule not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_service_date > current_date + 1 THEN
    RAISE EXCEPTION 'Service date cannot be in the future' USING ERRCODE = '22023';
  END IF;
  IF p_cost IS NOT NULL AND p_cost < 0 THEN
    RAISE EXCEPTION 'Cost cannot be negative' USING ERRCODE = '22023';
  END IF;

  SELECT odometer_miles INTO v_vehicle_odo FROM vehicles WHERE id = v_sched.vehicle_id FOR UPDATE;
  v_odo := COALESCE(p_odometer, v_vehicle_odo);
  IF v_odo IS NULL OR v_odo < 0 THEN
    RAISE EXCEPTION 'Invalid odometer reading' USING ERRCODE = '22023';
  END IF;

  UPDATE vehicle_maintenance_schedules
     SET last_service_date = p_service_date, last_service_miles = v_odo
   WHERE id = p_schedule_id;

  IF COALESCE(p_cost, 0) > 0 THEN
    INSERT INTO vehicle_expenses (user_id, vehicle_id, expense_type, amount, expense_date, odometer_miles, notes)
    VALUES (
      v_sched.user_id, v_sched.vehicle_id, 'maintenance', p_cost, p_service_date, v_odo,
      left(concat_ws(' - ', v_sched.name, NULLIF(btrim(p_notes), '')), 500)
    );
  END IF;

  UPDATE vehicles SET odometer_miles = v_odo
   WHERE id = v_sched.vehicle_id AND odometer_miles < v_odo;
END;
$$;

REVOKE ALL ON FUNCTION public.vehicle_assignable_technicians() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vehicle_assignable_technicians() TO authenticated;
REVOKE ALL ON FUNCTION public.assign_vehicle(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_vehicle(uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_vehicle_maintenance(uuid, date, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_vehicle_maintenance(uuid, date, numeric, numeric, text) TO authenticated;
