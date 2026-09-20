/*
  # Equipment & Job-Equipment tables

  These tables have been referenced by CustomerDetailPage.tsx,
  JobEquipmentLinker.tsx, WarrantyIntelligence.tsx and
  check-warranty-alerts since they were written, but were never actually
  created — meaning the entire equipment/warranty feature has been
  silently broken (every query fails with "relation does not exist").
  Column names here match the real UI (CustomerDetailPage.tsx uses
  `make`, not the unused `brand` in lib/supabase.ts's stray type).
*/

CREATE TABLE IF NOT EXISTS equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_type text NOT NULL,
  make text,
  model text,
  serial_number text,
  install_date date,
  install_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  warranty_expires_at date,
  warranty_notes text,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'removed')),
  expected_lifespan_years integer NOT NULL DEFAULT 15,
  service_interval_months integer NOT NULL DEFAULT 12,
  last_service_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_user_id ON equipment(user_id);
CREATE INDEX IF NOT EXISTS idx_equipment_customer_id ON equipment(customer_id);

ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_equipment" ON equipment FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_equipment" ON equipment FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_equipment" ON equipment FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_equipment" ON equipment FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS job_equipment (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  service_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_job_equipment_equipment_id ON job_equipment(equipment_id);

ALTER TABLE job_equipment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_job_equipment" ON job_equipment FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
CREATE POLICY "insert_own_job_equipment" ON job_equipment FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
CREATE POLICY "delete_own_job_equipment" ON job_equipment FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
