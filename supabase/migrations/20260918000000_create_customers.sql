/*
  # Customers module

  Adds a first-class `customers` table so a single contact can be tracked
  across their whole lifecycle (lead -> job -> repeat customer) instead of
  living as disconnected name/phone strings on `leads`, `jobs`, and `calls`.

  This migration is purely additive:
  - `customers` is a brand new table (RLS-scoped per account owner, same
    pattern as `leads`).
  - `leads`, `jobs`, and `calls` each get a new nullable `customer_id`
    column (ON DELETE SET NULL), so existing rows and existing app code
    keep working untouched — nothing is backfilled or made required here.
*/

-- =============================================================
-- CUSTOMERS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  phone text,
  email text,
  address text,
  customer_type text NOT NULL DEFAULT 'residential'
    CHECK (customer_type IN ('residential', 'commercial')),
  lifecycle_stage text NOT NULL DEFAULT 'lead'
    CHECK (lifecycle_stage IN ('lead', 'active', 'vip', 'inactive')),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'call', 'lead', 'job', 'import')),
  last_contacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One customer per phone/email per account — keeps auto-linking from
-- calls/leads from silently creating duplicate contacts. Partial indexes
-- so multiple customers with no phone/email are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_phone_unique
  ON customers(user_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_email_unique
  ON customers(user_id, email) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_lifecycle_stage ON customers(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_customers" ON customers;
CREATE POLICY "select_own_customers"
ON customers FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_customers" ON customers;
CREATE POLICY "insert_own_customers"
ON customers FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_customers" ON customers;
CREATE POLICY "update_own_customers"
ON customers FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_customers" ON customers;
CREATE POLICY "delete_own_customers"
ON customers FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- Reuses the existing public.update_updated_at() trigger function
-- (defined in 20260821101135_create_data_tables.sql).
DROP TRIGGER IF EXISTS trigger_customers_updated_at ON customers;
CREATE TRIGGER trigger_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- LINK EXISTING TABLES TO CUSTOMERS (additive, nullable)
-- =============================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_customer_id ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_calls_customer_id ON calls(customer_id);
