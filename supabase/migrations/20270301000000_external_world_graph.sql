/*
  # External World Graph

  ## Why
  The Business World Model (src/lib/worldModel.ts) only knows the business.
  This migration adds storage for the world OUTSIDE it, joined to the
  model's derived "property" nodes by `property_key` (= the node key,
  e.g. 'property:123 main st, austin, tx').

  ## Tables
  - external_world_locations: one row per property — coordinates, state,
    county FIPS (geocoded server-side by external-world-sync).
  - external_world_signals: live external data per location. One row per
    (location, signal_key), overwritten on refresh, with source + as_of +
    expires_at so staleness is always explicit.
      nws_alerts / nws_forecast  (NOAA National Weather Service)
      nasa_climate               (NASA POWER 30-year climatology)
      fema_nri                   (FEMA National Risk Index, county)
      eia_electricity            (EIA retail electricity price, state)
  - external_world_facts: owner-entered facts for domains with no reliable
    free API (regulations, permits, labor, market, competitors, suppliers,
    construction, incentives, economy). Never auto-generated.

  ## Security
  Same model as business_causal_edges: all rows belong to the account
  owner (get_account_owner_id()), team members read/write through that.
*/

CREATE TABLE IF NOT EXISTS external_world_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  property_key text NOT NULL,
  address text NOT NULL,
  latitude double precision,
  longitude double precision,
  state text,
  county_fips text,
  county_name text,
  geocode_status text NOT NULL DEFAULT 'pending'
    CHECK (geocode_status IN ('pending', 'geocoded', 'not_found')),
  geocoded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_external_world_locations_property UNIQUE (user_id, property_key)
);

CREATE TABLE IF NOT EXISTS external_world_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  location_id uuid NOT NULL REFERENCES external_world_locations(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('weather', 'climate', 'hazards', 'energy')),
  signal_key text NOT NULL
    CHECK (signal_key IN ('nws_alerts', 'nws_forecast', 'nasa_climate', 'fema_nri', 'eia_electricity')),
  value jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(value) = 'object'),
  source text NOT NULL,
  source_url text,
  as_of timestamptz,
  expires_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_external_world_signals_location_key UNIQUE (location_id, signal_key)
);

CREATE TABLE IF NOT EXISTS external_world_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  domain text NOT NULL CHECK (domain IN
    ('regulations', 'permits', 'labor', 'market', 'competitors', 'suppliers',
     'construction', 'incentives', 'economy', 'other')),
  scope text NOT NULL DEFAULT 'national' CHECK (scope IN ('national', 'state', 'county', 'local')),
  region text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  detail text,
  impact text NOT NULL DEFAULT 'neutral' CHECK (impact IN ('positive', 'negative', 'neutral')),
  effective_date date,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_world_facts_region_required
    CHECK (scope = 'national' OR (region IS NOT NULL AND length(btrim(region)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_external_world_locations_user ON external_world_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_external_world_signals_user_loc ON external_world_signals(user_id, location_id);
CREATE INDEX IF NOT EXISTS idx_external_world_facts_user ON external_world_facts(user_id, domain, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_world_locations', 'external_world_signals', 'external_world_facts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "owner_all_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "owner_all_%1$s" ON %1$I FOR ALL TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id())',
      t
    );
  END LOOP;
END $$;
