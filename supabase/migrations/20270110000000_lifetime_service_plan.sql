/*
  # Lifetime Service Plan — year built on a property

  ## Why
  The Lifetime Service Plan estimates a 10-year service roadmap per property.
  For systems with no equipment on record (HVAC, water heater, plumbing,
  electrical, roof) the only honest signal is the age of the building itself,
  so we need the year it was built.

  ## What this does
  Adds one nullable column to `customer_sites`. Purely additive: nothing is
  renamed, retyped or backfilled, every existing row stays valid with
  year_built = NULL, and the existing RLS policies (select/update by account
  owner) already cover the new column, so no policy changes are needed.

  The plan itself is computed client-side from existing tables (see
  src/lib/lifetimeServicePlan.ts), the same way the Home Health Score and Home
  Operating Budget are. `get_customer_site_hierarchy()` is intentionally left
  unchanged.
*/

ALTER TABLE customer_sites
  ADD COLUMN IF NOT EXISTS year_built smallint;

ALTER TABLE customer_sites
  DROP CONSTRAINT IF EXISTS customer_sites_year_built_range;

ALTER TABLE customer_sites
  ADD CONSTRAINT customer_sites_year_built_range
  CHECK (year_built IS NULL OR (year_built BETWEEN 1700 AND 2200));

COMMENT ON COLUMN customer_sites.year_built IS
  'Year the building was constructed. Drives home-age estimates in the Lifetime Service Plan. NULL = unknown.';
