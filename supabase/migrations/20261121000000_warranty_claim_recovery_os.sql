/*
  # Service Warranty Claim Recovery OS

  ## Why
  Field techs replace parts that are still under *manufacturer* warranty all
  the time, but nothing in this project ever turned that into money back.
  `equipment.warranty_expires_at` (20260927000001_create_equipment_tables.sql)
  and `check-warranty-alerts` only warn that a *customer's* unit warranty is
  ending — they say nothing about a job the shop already did on a unit that
  was still covered, whose parts/labor cost could be recovered from the
  manufacturer/distributor.

  ## What this does
  - `warranty_claims`: one row per manufacturer warranty claim. Optionally
    linked to `jobs` and `equipment` (both nullable — a claim can be logged
    even if the equipment record was deleted later).
  - `packet_checklist` (jsonb): tracks which documents are gathered
    (proof of purchase, defect photo, serial photo, invoice, diagnosis)
    before submission — this is the "claim packet" the office assembles.
  - `claim_deadline` + `deadline_alert_stage` / `deadline_alert_sent_at`:
    same alert-once-per-stage pattern as
    20260928000000_warranty_intelligence.sql, driven by the scheduled
    check-warranty-claim-deadlines edge function (not a DB trigger — a
    deadline doesn't fire on any INSERT/UPDATE, it just becomes true as a
    date passes).
  - `warranty_eligible_jobs` view: joins the EXISTING `job_equipment` +
    `equipment` tables to surface completed jobs performed while the unit
    was still under manufacturer warranty and that have no claim yet —
    this is the "detect warranty-eligible jobs" half of the feature.
    security_invoker=true so it always applies the querying user's own RLS
    (see 20260925000000_underpriced_job_detection.sql for precedent).
  - `notify_warranty_claim_deadline` on `profiles`, `warranty_claim_id` on
    `notifications` — same pattern as `notify_warranty_alert` /
    `equipment_id` from 20260928000000_warranty_intelligence.sql.

  ## RLS
  Same ownership pattern as every other per-tenant table in this project:
  scoped to `public.get_account_owner_id()`.
*/

-- Reuse the shared updated_at trigger function if it already exists in
-- this project; create it if not (CREATE OR REPLACE is safe either way).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS warranty_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,

  customer_name text NOT NULL DEFAULT '',
  customer_phone text,
  property_address text,

  manufacturer text,
  distributor text,
  model_number text,
  serial_number text,
  part_description text,
  failure_description text,

  install_date date,
  failure_date date,
  warranty_expires_at date,
  claim_deadline date,
  deadline_alert_stage text CHECK (deadline_alert_stage IN ('due_soon', 'overdue')),
  deadline_alert_sent_at timestamptz,

  status text NOT NULL DEFAULT 'eligible'
    CHECK (status IN ('eligible', 'packet_pending', 'submitted', 'approved', 'denied', 'credit_received', 'closed')),

  part_cost_cents integer,
  labor_cost_cents integer,
  claimed_amount_cents integer,
  approved_amount_cents integer,
  credit_received_cents integer,
  credit_received_at date,
  credit_method text CHECK (credit_method IN ('account_credit', 'check', 'ach', 'other')),

  rma_number text,
  claim_number text,
  submitted_at timestamptz,
  denial_reason text,

  packet_checklist jsonb NOT NULL DEFAULT
    '{"proof_of_purchase": false, "defect_photo": false, "serial_photo": false, "invoice": false, "diagnosis_report": false}'::jsonb,

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warranty_claims_user_created ON warranty_claims(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims(status);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_job_id ON warranty_claims(job_id);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_equipment_id ON warranty_claims(equipment_id);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_deadline
  ON warranty_claims(claim_deadline)
  WHERE claim_deadline IS NOT NULL AND status NOT IN ('denied', 'closed', 'credit_received');

DROP TRIGGER IF EXISTS trg_warranty_claims_updated_at ON warranty_claims;
CREATE TRIGGER trg_warranty_claims_updated_at
  BEFORE UPDATE ON warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE warranty_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_warranty_claims" ON warranty_claims;
CREATE POLICY "select_own_warranty_claims" ON warranty_claims FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_warranty_claims" ON warranty_claims;
CREATE POLICY "insert_own_warranty_claims" ON warranty_claims FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_warranty_claims" ON warranty_claims;
CREATE POLICY "update_own_warranty_claims" ON warranty_claims FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_warranty_claims" ON warranty_claims;
CREATE POLICY "delete_own_warranty_claims" ON warranty_claims FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Notifications + profile opt-out, same shape as warranty_alert.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_warranty_claim_deadline boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_warranty_claim_id
  ON notifications(warranty_claim_id)
  WHERE warranty_claim_id IS NOT NULL;

-- Detects warranty-eligible jobs: a completed job performed on a unit
-- (via the existing job_equipment link) while it was still inside
-- manufacturer warranty, with no claim logged for that job+unit yet.
CREATE OR REPLACE VIEW warranty_eligible_jobs
WITH (security_invoker = true) AS
SELECT
  j.id AS job_id,
  j.user_id,
  j.customer_name,
  j.customer_phone,
  j.address AS property_address,
  j.service_type,
  j.completed_at,
  j.invoice_amount,
  e.id AS equipment_id,
  e.equipment_type,
  e.make AS manufacturer,
  e.model AS model_number,
  e.serial_number,
  e.install_date,
  e.warranty_expires_at
FROM job_equipment je
JOIN jobs j ON j.id = je.job_id
JOIN equipment e ON e.id = je.equipment_id
WHERE j.job_status = 'completed'
  AND j.completed_at IS NOT NULL
  AND e.warranty_expires_at IS NOT NULL
  AND j.completed_at::date <= e.warranty_expires_at
  AND NOT EXISTS (
    SELECT 1 FROM warranty_claims wc
    WHERE wc.job_id = j.id AND wc.equipment_id = e.id
  );

COMMENT ON VIEW warranty_eligible_jobs IS
  'Completed jobs performed on equipment that was still inside manufacturer warranty at completion time, with no warranty_claims row yet for that job+unit. security_invoker=true so it always applies the querying user''s own RLS.';
