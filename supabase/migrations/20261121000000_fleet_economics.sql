/*
  # Fleet Economics + Vehicle-to-Job Profitability

  Four tables, same idiom as equipment_lifecycle / warranty_intelligence:

  - vehicles: the fleet roster (one row per truck/van).
  - vehicle_expenses: fuel, maintenance, insurance, downtime line items
    logged against a vehicle over time.
  - job_vehicle_trips: which vehicle rolled to which job, and how many
    miles/minutes that roll took. This is the join that lets a truck-roll
    cost be attributed to a specific job.
  - vehicle_job_profitability: output table written by the
    compute-fleet-economics scheduled function — one row per job, with
    the computed truck-roll cost, revenue, and margin. The page reads
    this table directly instead of joining/aggregating on every load.
*/

-- =============================================================
-- VEHICLES
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  label text NOT NULL,
  make text,
  model text,
  year integer,
  license_plate text,
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_shop', 'retired')),
  odometer_miles numeric NOT NULL DEFAULT 0,
  monthly_payment_cost numeric NOT NULL DEFAULT 0,
  monthly_insurance_cost numeric NOT NULL DEFAULT 0,
  purchase_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_user_id ON vehicles(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicles" ON vehicles;
CREATE POLICY "select_own_vehicles" ON vehicles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_vehicles" ON vehicles;
CREATE POLICY "insert_own_vehicles" ON vehicles FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_vehicles" ON vehicles;
CREATE POLICY "update_own_vehicles" ON vehicles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_vehicles" ON vehicles;
CREATE POLICY "delete_own_vehicles" ON vehicles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_EXPENSES
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  expense_type text NOT NULL CHECK (expense_type IN ('fuel', 'maintenance', 'repair', 'insurance', 'downtime', 'other')),
  amount numeric NOT NULL DEFAULT 0,
  expense_date date NOT NULL DEFAULT current_date,
  odometer_miles numeric,
  downtime_hours numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_expenses_vehicle_id ON vehicle_expenses(vehicle_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_expenses_user_id ON vehicle_expenses(user_id);

ALTER TABLE vehicle_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_expenses" ON vehicle_expenses;
CREATE POLICY "select_own_vehicle_expenses" ON vehicle_expenses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_vehicle_expenses" ON vehicle_expenses;
CREATE POLICY "insert_own_vehicle_expenses" ON vehicle_expenses FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_vehicle_expenses" ON vehicle_expenses;
CREATE POLICY "update_own_vehicle_expenses" ON vehicle_expenses FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_vehicle_expenses" ON vehicle_expenses;
CREATE POLICY "delete_own_vehicle_expenses" ON vehicle_expenses FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB_VEHICLE_TRIPS
-- =============================================================

CREATE TABLE IF NOT EXISTS job_vehicle_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  miles_driven numeric NOT NULL DEFAULT 0,
  minutes_driven numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_job_vehicle_trips_vehicle_id ON job_vehicle_trips(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_job_vehicle_trips_job_id ON job_vehicle_trips(job_id);

ALTER TABLE job_vehicle_trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_vehicle_trips" ON job_vehicle_trips;
CREATE POLICY "select_own_job_vehicle_trips" ON job_vehicle_trips FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_job_vehicle_trips" ON job_vehicle_trips;
CREATE POLICY "insert_own_job_vehicle_trips" ON job_vehicle_trips FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_job_vehicle_trips" ON job_vehicle_trips;
CREATE POLICY "update_own_job_vehicle_trips" ON job_vehicle_trips FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_job_vehicle_trips" ON job_vehicle_trips;
CREATE POLICY "delete_own_job_vehicle_trips" ON job_vehicle_trips FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- VEHICLE_JOB_PROFITABILITY (output of compute-fleet-economics)
-- =============================================================

CREATE TABLE IF NOT EXISTS vehicle_job_profitability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  miles_driven numeric NOT NULL DEFAULT 0,
  truck_roll_cost numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  gross_profit numeric NOT NULL DEFAULT 0,
  margin_pct numeric,
  metric_snapshot jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_job_profitability_user_id ON vehicle_job_profitability(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_job_profitability_vehicle_id ON vehicle_job_profitability(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_job_profitability_margin ON vehicle_job_profitability(margin_pct);

ALTER TABLE vehicle_job_profitability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vehicle_job_profitability" ON vehicle_job_profitability;
CREATE POLICY "select_own_vehicle_job_profitability" ON vehicle_job_profitability FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
