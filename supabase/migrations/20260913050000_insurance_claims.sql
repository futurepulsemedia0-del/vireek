/*
# Insurance claim capture (for restoration businesses)

## Why
Restoration businesses (water damage, fire damage, storm damage) mostly
deal with the customer's insurance, not out-of-pocket payment. There was
no schema anywhere for this — no way for the AI to record which insurer,
policy/claim number, or adjuster is involved so the office's claims
workflow can pick it up.

## What this does
- New table `insurance_claims`, loosely linked to `calls`/`jobs` (both
  nullable FKs — a claim can be captured before a job even exists yet,
  during the initial triage call).
- Reuses the EXISTING `public.dispatch_customer_webhook()` function
  (already powering the calls/leads/jobs -> customer webhook pipeline
  from 20260912010000_webhook_logs.sql) via one more trigger. No new
  delivery code needed — whatever webhook/CRM/Zapier a business already
  has connected under Integrations receives an `insurance_claim.created`
  event the same way it already receives `call.created` etc. This
  migration does NOT send email/SMS itself; it relies entirely on that
  existing, already-working path. A business with no webhook connected
  simply won't get this event automatically yet (same as any other
  event type today) until they set one up on the Integrations page.

## RLS
Same ownership pattern as every other per-tenant table in this project.
*/

CREATE TABLE IF NOT EXISTS insurance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text,
  customer_phone text,
  insurance_company text,
  policy_number text,
  claim_number text,
  date_of_loss date,
  damage_type text,
  adjuster_name text,
  adjuster_phone text,
  notes text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'submitted', 'approved', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_user_created
  ON insurance_claims(user_id, created_at DESC);

ALTER TABLE insurance_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_insurance_claims" ON insurance_claims;
CREATE POLICY "select_own_insurance_claims"
ON insurance_claims FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_insurance_claims" ON insurance_claims;
CREATE POLICY "insert_own_insurance_claims"
ON insurance_claims FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_insurance_claims" ON insurance_claims;
CREATE POLICY "update_own_insurance_claims"
ON insurance_claims FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

-- Reuses the existing generic dispatch function — no new trigger function.
DROP TRIGGER IF EXISTS trigger_webhook_new_insurance_claim ON insurance_claims;
CREATE TRIGGER trigger_webhook_new_insurance_claim
  AFTER INSERT ON insurance_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('insurance_claim.created');
