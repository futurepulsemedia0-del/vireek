/*
  # Insurance Claim Intake (Restoration workflow)

  Restoration jobs (water damage, fire damage, mold, storm/wind) almost
  always run alongside a property-insurance claim. This gives restoration
  accounts a dedicated place to capture and track that claim — carrier,
  policy/claim numbers, adjuster contact, and where it stands in the
  claims pipeline — instead of burying it in free-text lead/job notes.

  Internal-only, unlike quotes and customer self-reschedule: adjusters and
  customers never see this table directly, so there's no token-based RPC
  layer here — just the same simple owner-scoped RLS as every other
  tenant table (leads, jobs, quotes, ...).
*/

CREATE TABLE IF NOT EXISTS insurance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  property_address text,
  loss_type text NOT NULL DEFAULT 'water_damage'
    CHECK (loss_type IN ('water_damage', 'fire_damage', 'smoke_damage', 'mold', 'storm_wind', 'other')),
  date_of_loss date,
  insurance_carrier text,
  policy_number text,
  claim_number text,
  adjuster_name text,
  adjuster_phone text,
  adjuster_email text,
  deductible_cents integer,
  estimated_damage_cents integer,
  status text NOT NULL DEFAULT 'intake'
    CHECK (status IN ('intake', 'documentation', 'submitted_to_carrier', 'adjuster_scheduled', 'approved', 'denied', 'in_repair', 'closed')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_user_id ON insurance_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_status ON insurance_claims(status);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_lead_id ON insurance_claims(lead_id);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_job_id ON insurance_claims(job_id);

ALTER TABLE insurance_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_insurance_claims" ON insurance_claims;
CREATE POLICY "select_own_insurance_claims" ON insurance_claims FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_insurance_claims" ON insurance_claims;
CREATE POLICY "insert_own_insurance_claims" ON insurance_claims FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_insurance_claims" ON insurance_claims;
CREATE POLICY "update_own_insurance_claims" ON insurance_claims FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_insurance_claims" ON insurance_claims;
CREATE POLICY "delete_own_insurance_claims" ON insurance_claims FOR DELETE TO authenticated USING (user_id = auth.uid());
