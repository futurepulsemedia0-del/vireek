/*
  # Home Intelligence Graph — monthly energy readings per property

  ## Why
  The Home Intelligence Graph combines home age, equipment age, repair history,
  maintenance, warranty, climate and property type into per-system failure
  risk. The one input Vireek had no data source for is energy behaviour: a
  furnace or AC that is quietly losing efficiency shows up as rising
  consumption long before it fails.

  ## What this does
  Adds ONE new table, `home_energy_readings`: one row per property per month
  (kWh, optional cost). Purely additive: no existing table, column, policy or
  function is touched. The graph is computed client-side from existing tables
  (src/lib/homeIntelligenceGraph.ts) and uses these rows only when present, so
  the feature keeps working if this migration has not been applied yet.

  ## Security
  Same ownership model as customer_sites: rows belong to the account owner
  (public.get_account_owner_id()), so team members read/write the owner's data.
  The site must belong to the same owner (enforced by trigger, not just by
  the foreign key), so a row can never point at another account's property.
*/

CREATE TABLE IF NOT EXISTS home_energy_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  energy_kwh numeric(12, 2) NOT NULL,
  cost_usd numeric(10, 2),
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_energy_readings_kwh_range CHECK (energy_kwh >= 0 AND energy_kwh <= 1000000),
  CONSTRAINT home_energy_readings_cost_range CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= 10000000)),
  CONSTRAINT home_energy_readings_month_start CHECK (period_start = date_trunc('month', period_start)::date),
  CONSTRAINT home_energy_readings_source_valid CHECK (source IN ('manual', 'import', 'utility')),
  CONSTRAINT home_energy_readings_one_per_month UNIQUE (site_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_home_energy_readings_site_period
  ON home_energy_readings (site_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_home_energy_readings_user_id
  ON home_energy_readings (user_id);

-- A reading may only reference a property owned by the same account.
CREATE OR REPLACE FUNCTION public.home_energy_readings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_sites s WHERE s.id = NEW.site_id AND s.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Property does not belong to this account.' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_home_energy_readings_guard ON home_energy_readings;
CREATE TRIGGER trg_home_energy_readings_guard
  BEFORE INSERT OR UPDATE ON home_energy_readings
  FOR EACH ROW EXECUTE FUNCTION public.home_energy_readings_guard();

ALTER TABLE home_energy_readings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_energy_readings" ON home_energy_readings;
CREATE POLICY "select_own_home_energy_readings" ON home_energy_readings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_home_energy_readings" ON home_energy_readings;
CREATE POLICY "insert_own_home_energy_readings" ON home_energy_readings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_home_energy_readings" ON home_energy_readings;
CREATE POLICY "update_own_home_energy_readings" ON home_energy_readings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_home_energy_readings" ON home_energy_readings;
CREATE POLICY "delete_own_home_energy_readings" ON home_energy_readings FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

COMMENT ON TABLE home_energy_readings IS
  'Monthly energy consumption per property. Feeds the energy-behaviour signal of the Home Intelligence Graph.';
