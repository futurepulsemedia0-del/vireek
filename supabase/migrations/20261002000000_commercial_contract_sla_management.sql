/*
# Commercial Contract / SLA Management

## Why
Commercial customers (customer_type = 'commercial' on `customers`) are often
locked into a signed service agreement with committed response/resolution
times and financial penalties if the business misses them. Nothing in the
schema today tracks the contract itself, its SLA commitments, or a log of
when those commitments were missed. This gives the business (and any
franchise/enterprise reporting on top of it) a single source of truth for
that.

## What this does
- New table `commercial_contracts`: one row per signed agreement, optionally
  linked to a `customers` row and, for the specific job it was drawn up
  from, a `jobs` row. Carries the commercial terms (value, billing
  frequency, renewal behavior) and the SLA commitments themselves
  (response/resolution targets by priority, penalty percentage and cap).
- New table `contract_sla_breaches`: append-only log of every time a job
  missed a contract's SLA, with how late it was and the computed penalty,
  so "how many breaches this quarter / how much credit do we owe" is a
  simple query instead of a manual audit of tickets.
- Reuses the EXISTING `public.dispatch_customer_webhook()` function (same
  pattern as insurance_claims in 20260913050000_insurance_claims.sql) for
  both tables, so any webhook/CRM already connected under Integrations
  picks up `commercial_contract.created` and `sla_breach.created` events
  with no new delivery code.
- `updated_at` auto-touch trigger on `commercial_contracts`, reusing the
  existing `public.set_updated_at()` trigger function if present (falls
  back to creating it if this is the first migration to need it).

## What this does NOT do
This does not add a scheduled job to auto-flip `status` to
'expiring_soon' as `end_date` approaches — same reasoning as
20260928000000_warranty_intelligence.sql: there's no row-level DB event to
hang that on, it just becomes true as a date passes. The client computes
"expiring soon" from `end_date` for display today; if a daily digest/alert
is wanted later, follow the check-warranty-alerts edge function pattern.

## RLS
Same ownership pattern as every other per-tenant table in this project:
scoped to `public.get_account_owner_id()`.
*/

-- Reuse the shared updated_at trigger function if it already exists in
-- this project; create it if this happens to be the first migration that
-- needs it (CREATE OR REPLACE is safe either way).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS commercial_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,

  contract_number text,
  contract_name text NOT NULL,
  contract_type text NOT NULL DEFAULT 'service_agreement'
    CHECK (contract_type IN ('service_agreement', 'maintenance_contract', 'msa', 'sla_only', 'other')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'expiring_soon', 'expired', 'terminated', 'renewed')),

  start_date date,
  end_date date,
  auto_renew boolean NOT NULL DEFAULT false,
  renewal_notice_days integer NOT NULL DEFAULT 30,

  billing_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (billing_frequency IN ('monthly', 'quarterly', 'annual', 'one_time')),
  contract_value_cents integer,

  -- SLA commitments
  sla_response_minutes_standard integer,
  sla_response_minutes_critical integer,
  sla_resolution_hours integer,
  penalty_percentage numeric(5,2) DEFAULT 0,
  penalty_cap_percentage numeric(5,2) DEFAULT 100,

  signed_by text,
  signed_at date,
  document_url text,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commercial_contracts_user_status
  ON commercial_contracts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_commercial_contracts_customer
  ON commercial_contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_commercial_contracts_end_date
  ON commercial_contracts(end_date) WHERE status IN ('active', 'expiring_soon');

ALTER TABLE commercial_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_commercial_contracts" ON commercial_contracts;
CREATE POLICY "select_own_commercial_contracts"
ON commercial_contracts FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_commercial_contracts" ON commercial_contracts;
CREATE POLICY "insert_own_commercial_contracts"
ON commercial_contracts FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_commercial_contracts" ON commercial_contracts;
CREATE POLICY "update_own_commercial_contracts"
ON commercial_contracts FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_commercial_contracts" ON commercial_contracts;
CREATE POLICY "delete_own_commercial_contracts"
ON commercial_contracts FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_commercial_contracts ON commercial_contracts;
CREATE TRIGGER trigger_touch_commercial_contracts
  BEFORE UPDATE ON commercial_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_webhook_new_commercial_contract ON commercial_contracts;
CREATE TRIGGER trigger_webhook_new_commercial_contract
  AFTER INSERT ON commercial_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('commercial_contract.created');

-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_sla_breaches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,

  breach_type text NOT NULL DEFAULT 'response_time'
    CHECK (breach_type IN ('response_time', 'resolution_time', 'other')),
  severity text NOT NULL DEFAULT 'minor'
    CHECK (severity IN ('minor', 'major', 'critical')),

  expected_at timestamptz,
  actual_at timestamptz,
  minutes_over integer,
  penalty_amount_cents integer DEFAULT 0,
  resolved boolean NOT NULL DEFAULT false,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sla_breaches_contract
  ON contract_sla_breaches(contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sla_breaches_user_unresolved
  ON contract_sla_breaches(user_id) WHERE resolved = false;

ALTER TABLE contract_sla_breaches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_sla_breaches" ON contract_sla_breaches;
CREATE POLICY "select_own_sla_breaches"
ON contract_sla_breaches FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_sla_breaches" ON contract_sla_breaches;
CREATE POLICY "insert_own_sla_breaches"
ON contract_sla_breaches FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_sla_breaches" ON contract_sla_breaches;
CREATE POLICY "update_own_sla_breaches"
ON contract_sla_breaches FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_sla_breaches" ON contract_sla_breaches;
CREATE POLICY "delete_own_sla_breaches"
ON contract_sla_breaches FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_webhook_new_sla_breach ON contract_sla_breaches;
CREATE TRIGGER trigger_webhook_new_sla_breach
  AFTER INSERT ON contract_sla_breaches
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('sla_breach.created');
