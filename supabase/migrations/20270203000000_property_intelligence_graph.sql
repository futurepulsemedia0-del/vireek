/*
  # Vireek Property Intelligence Graph

  Connects a customer site to REAL external property data so Vireek knows the property
  BEFORE the caller speaks to a technician:

    Address -> Parcel/APN -> characteristics -> building age -> sq ft -> permits
            -> equipment history -> climate -> utility -> energy -> service history

  ## What this adds
  - property_intelligence_profiles : one row per customer_site. Curated facts only (no raw vendor payloads),
      per-field provenance (field_sources) and per-provider status (provider_status).
  - property_intelligence_permits  : building permits attached to a site (deduplicated per source record).
  - property_intelligence_lookups  : usage ledger for every external lookup (cost control, daily caps, audit).

  ## Privacy by design (deliberate)
  - NO owner name, NO sale price, NO assessed/tax value is stored or used. Property records contain personal
    data and price signals; using them to personalise quotes invites privacy and price-discrimination risk.
    Only physical facts that change how a technician prepares are kept.
  - Rows are written ONLY by the `property-intelligence` edge function / voice webhook (service role).
    Authenticated users get SELECT only, so provenance cannot be forged from the browser.

  ## Nothing existing is modified.
  Requires: customer_sites (20261112000000), customers, get_account_owner_id().
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 1. PROFILES  (one per site)
-- =============================================================

CREATE TABLE IF NOT EXISTS property_intelligence_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL UNIQUE REFERENCES customer_sites(id) ON DELETE CASCADE,

  -- Address / geography
  address_key text NOT NULL,
  formatted_address text,
  latitude double precision,
  longitude double precision,
  state_fips text,
  county_fips text,
  census_tract text,

  -- Parcel / characteristics (no owner, no price, no tax value)
  apn text,
  property_type text,
  year_built integer CHECK (year_built IS NULL OR year_built BETWEEN 1600 AND 2200),
  living_sqft integer CHECK (living_sqft IS NULL OR living_sqft BETWEEN 1 AND 5000000),
  lot_sqft integer CHECK (lot_sqft IS NULL OR lot_sqft BETWEEN 1 AND 2000000000),
  bedrooms numeric(4,1),
  bathrooms numeric(4,1),
  stories numeric(4,1),
  heating_type text,
  cooling_type text,
  has_heating boolean,
  has_cooling boolean,
  last_sale_date date,

  -- Environment
  climate jsonb NOT NULL DEFAULT '{}'::jsonb,
  energy jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance + health
  field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'partial', 'failed')),
  fetched_at timestamptz,
  refresh_after timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_profiles_user_address
  ON property_intelligence_profiles(user_id, address_key);

DROP TRIGGER IF EXISTS trg_pi_profiles_updated_at ON property_intelligence_profiles;
CREATE TRIGGER trg_pi_profiles_updated_at
  BEFORE UPDATE ON property_intelligence_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE property_intelligence_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pi_profiles" ON property_intelligence_profiles;
CREATE POLICY "select_own_pi_profiles" ON property_intelligence_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. PERMITS
-- =============================================================

CREATE TABLE IF NOT EXISTS property_intelligence_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_record_id text NOT NULL,
  permit_number text,
  permit_type text,
  work_category text NOT NULL DEFAULT 'other'
    CHECK (work_category IN ('hvac', 'plumbing', 'electrical', 'roofing', 'solar', 'water_heater', 'gas', 'structural', 'other')),
  status text,
  description text,
  issued_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_permits_site_date
  ON property_intelligence_permits(site_id, issued_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_pi_permits_user ON property_intelligence_permits(user_id);

ALTER TABLE property_intelligence_permits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pi_permits" ON property_intelligence_permits;
CREATE POLICY "select_own_pi_permits" ON property_intelligence_permits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. LOOKUP LEDGER (cost control + audit)
-- =============================================================

CREATE TABLE IF NOT EXISTS property_intelligence_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('dashboard', 'voice')),
  outcome text NOT NULL CHECK (outcome IN ('ready', 'partial', 'failed', 'rate_limited')),
  providers_called text[] NOT NULL DEFAULT '{}',
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_lookups_user_created
  ON property_intelligence_lookups(user_id, created_at DESC);

ALTER TABLE property_intelligence_lookups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pi_lookups" ON property_intelligence_lookups;
CREATE POLICY "select_own_pi_lookups" ON property_intelligence_lookups FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

COMMENT ON TABLE property_intelligence_profiles IS
  'Curated external property facts per customer_site. No owner/price/tax data by design. Written by service role only.';
