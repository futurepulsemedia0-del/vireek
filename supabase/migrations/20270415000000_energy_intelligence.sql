/*
  # Vireek Energy Intelligence

  Utility usage -> weather-response model -> anomalies -> equipment impact ->
  upgrade opportunities -> savings -> forecast. Purely additive: nothing existing
  is dropped, renamed or rewritten.

  - energy_usage_periods  The account's utility-bill history per customer (and optionally per
                          site). electric = kWh, gas = therms. Entered by hand or CSV-imported
                          from the dashboard; a utility API (Green Button / UtilityAPI style)
                          can write the same table later without any schema change.
  - energy_analyses       Append-only audit log of every analysis. Only the energy-intelligence
                          Edge Function (service role) writes it, so a report cannot be forged
                          through the REST API.

  Requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT), which is the Supabase default.
*/

-- =============================================================
-- 1. energy_usage_periods
-- =============================================================

CREATE TABLE IF NOT EXISTS energy_usage_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  fuel text NOT NULL CHECK (fuel IN ('electric', 'gas')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  usage numeric(14, 3) NOT NULL CHECK (usage >= 0),
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'api')),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT energy_usage_periods_range CHECK (period_end > period_start AND period_end - period_start <= 70),
  CONSTRAINT uq_energy_usage_period UNIQUE NULLS NOT DISTINCT (customer_id, site_id, fuel, period_start)
);

CREATE INDEX IF NOT EXISTS idx_energy_usage_user ON energy_usage_periods(user_id);
CREATE INDEX IF NOT EXISTS idx_energy_usage_customer ON energy_usage_periods(customer_id, period_start DESC);

COMMENT ON TABLE energy_usage_periods IS 'Utility bill history. electric = kWh, gas = therms. period_end is the next meter-read date (exclusive).';
COMMENT ON COLUMN energy_usage_periods.cost_cents IS 'Total billed amount for the period, in cents. NULL when unknown.';

ALTER TABLE energy_usage_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_energy_usage" ON energy_usage_periods;
CREATE POLICY "select_own_energy_usage" ON energy_usage_periods FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_energy_usage" ON energy_usage_periods;
CREATE POLICY "insert_own_energy_usage" ON energy_usage_periods FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM customers c WHERE c.id = customer_id AND c.user_id = public.get_account_owner_id())
  );

DROP POLICY IF EXISTS "update_own_energy_usage" ON energy_usage_periods;
CREATE POLICY "update_own_energy_usage" ON energy_usage_periods FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_energy_usage" ON energy_usage_periods;
CREATE POLICY "delete_own_energy_usage" ON energy_usage_periods FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_energy_usage_updated_at ON energy_usage_periods;
CREATE TRIGGER trigger_energy_usage_updated_at
  BEFORE UPDATE ON energy_usage_periods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. energy_analyses (append-only audit log)
-- =============================================================

CREATE TABLE IF NOT EXISTS energy_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  requested_by uuid,
  engine_version text NOT NULL,
  annual_cost_cents bigint,
  expected_savings_cents bigint,
  anomaly_count integer NOT NULL DEFAULT 0,
  efficiency_score integer,
  confidence text,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_energy_analyses_user ON energy_analyses(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_energy_analyses_customer ON energy_analyses(customer_id, created_at DESC);

ALTER TABLE energy_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_energy_analyses" ON energy_analyses;
CREATE POLICY "select_own_energy_analyses" ON energy_analyses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT / UPDATE / DELETE policy on purpose: only the service role writes this table.
