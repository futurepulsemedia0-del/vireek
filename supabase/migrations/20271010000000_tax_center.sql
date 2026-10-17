/*
  # Tax Center (/dashboard/tax)

  - tax_settings:          one row per account (provider, default class, filing cadence).
  - tax_classes:           per-service tax treatment (taxable / reduced / exempt).
  - tax_jurisdictions:     rate stack by postal code / state (manual or TaxJar-synced).
  - tax_exemptions:        customer exemption / resale certificates.
  - tax_provider_credentials: TaxJar API key. RLS enabled with NO policies on
    purpose -> only the service-role edge function can read or write it.
  - price_book_items.tax_class_id: links each catalog service to a tax class.
  - get_tax_report_invoices(): billing-gated RPC feeding the filing-ready report.

  All tables are scoped to the ACCOUNT OWNER (get_account_owner_id()) and gated
  to the owner or a team member with permissions.can_view_billing = true.
  Fully additive: no existing column or policy is changed.
*/

-- =============================================================
-- ACCESS HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_tax()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_tax() TO authenticated;

CREATE OR REPLACE FUNCTION public.touch_tax_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

-- =============================================================
-- TAX CLASSES
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  treatment text NOT NULL DEFAULT 'taxable' CHECK (treatment IN ('taxable', 'reduced', 'exempt')),
  -- % of the jurisdiction rate that applies when treatment = 'reduced' (0-100)
  reduced_percent numeric(6,2) NOT NULL DEFAULT 100 CHECK (reduced_percent >= 0 AND reduced_percent <= 100),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_classes_user_name ON tax_classes(user_id, lower(name));

-- =============================================================
-- TAX JURISDICTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  level text NOT NULL DEFAULT 'state' CHECK (level IN ('state', 'county', 'city', 'district')),
  state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  -- exact 5-digit ZIPs, or a prefix ending in * (e.g. '787*'). Empty = state-wide (level 'state' only).
  postal_codes text[] NOT NULL DEFAULT '{}',
  rate_percent numeric(7,4) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 30),
  effective_from date,
  effective_to date,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'taxjar')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_tax_jurisdictions_user ON tax_jurisdictions(user_id, active);

-- =============================================================
-- TAX EXEMPTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 160),
  reason text NOT NULL DEFAULT 'resale'
    CHECK (reason IN ('resale', 'nonprofit', 'government', 'agricultural', 'manufacturing', 'other')),
  certificate_number text,
  -- States the certificate is valid in. Empty = all states.
  states text[] NOT NULL DEFAULT '{}',
  issued_on date,
  expires_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_exemptions_user ON tax_exemptions(user_id, status);

-- =============================================================
-- TAX SETTINGS (one row per account)
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  provider text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual', 'taxjar')),
  default_tax_class_id uuid REFERENCES tax_classes(id) ON DELETE SET NULL,
  filing_frequency text NOT NULL DEFAULT 'quarterly' CHECK (filing_frequency IN ('monthly', 'quarterly', 'annually')),
  taxjar_connected boolean NOT NULL DEFAULT false,
  taxjar_last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- PROVIDER CREDENTIALS (service-role only: RLS on, zero policies)
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_provider_credentials (
  user_id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'taxjar',
  api_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tax_provider_credentials ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- RLS + triggers for the four client-facing tables
-- =============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_classes', 'tax_jurisdictions', 'tax_exemptions', 'tax_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "select_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "select_own_%1$s" ON %1$I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_tax())', t);
    EXECUTE format('DROP POLICY IF EXISTS "insert_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "insert_own_%1$s" ON %1$I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_tax())', t);
    EXECUTE format('DROP POLICY IF EXISTS "update_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "update_own_%1$s" ON %1$I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_tax()) WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_tax())', t);
    EXECUTE format('DROP POLICY IF EXISTS "delete_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "delete_own_%1$s" ON %1$I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_tax())', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION public.touch_tax_updated_at()', t);
  END LOOP;
END $$;

-- =============================================================
-- PER-SERVICE TAX CLASS on the price book
-- =============================================================
ALTER TABLE price_book_items
  ADD COLUMN IF NOT EXISTS tax_class_id uuid REFERENCES tax_classes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_price_book_items_tax_class ON price_book_items(tax_class_id) WHERE tax_class_id IS NOT NULL;

-- =============================================================
-- FILING REPORT SOURCE: invoices + job address, billing-gated
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_tax_report_invoices(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_result jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_tax() THEN
    RAISE EXCEPTION 'Not authorized to view tax reports' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'Invalid report period' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      i.id,
      i.invoice_number,
      i.customer_name,
      i.status,
      i.line_items,
      COALESCE(i.tax_percent, 0) AS tax_percent,
      COALESCE(i.sent_at, i.created_at) AS billed_at,
      j.customer_id,
      j.address
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id AND j.user_id = v_owner
    WHERE i.user_id = v_owner
      AND i.status IN ('sent', 'viewed', 'paid')
      AND COALESCE(i.sent_at, i.created_at)::date BETWEEN p_from AND p_to
    ORDER BY COALESCE(i.sent_at, i.created_at)
    LIMIT 20000
  ) r;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tax_report_invoices(date, date) TO authenticated;
