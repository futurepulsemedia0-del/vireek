/*
  # Vireek Incentive Decision Engine

  Property + equipment + location + project + customer + utility + program +
  effective date  ->  eligible incentives  ->  net project economics.
  Purely additive: nothing existing is dropped or rewritten.

  - incentive_programs           the account's OWN catalog of rebates / credits / grants.
                                 The engine never invents programs or amounts; it only
                                 evaluates what the owner has entered and verified here.
  - customer_incentive_profiles  remembered per-customer inputs (utility, rates, ownership...)
                                 so they are not re-typed on every quote. Written only by the
                                 incentive-decision-engine Edge Function (service role).
  - incentive_assessments        append-only audit log of every assessment. Written only by the
                                 Edge Function, so a result can't be forged through the REST API.
  - quotes.incentive_*           small cached summary for list views.
*/

-- =============================================================
-- Helper: may the caller see incentive economics for this account?
-- (same rule as the Quote Truth Engine: owner or can_view_billing)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_view_incentives(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = p_owner
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE tm.account_owner_id = p_owner
        AND lower(tm.member_email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_incentives(uuid) TO authenticated;

-- =============================================================
-- 1. Program catalog (owner-maintained)
-- =============================================================

CREATE TABLE IF NOT EXISTS incentive_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 160),
  program_type text NOT NULL DEFAULT 'utility_rebate'
    CHECK (program_type IN ('utility_rebate', 'manufacturer_rebate', 'government_rebate', 'tax_credit', 'financing', 'grant', 'other')),
  administrator text,
  country text NOT NULL DEFAULT 'US' CHECK (char_length(btrim(country)) BETWEEN 2 AND 3),
  states text[] NOT NULL DEFAULT '{}',
  postal_prefixes text[] NOT NULL DEFAULT '{}',
  utility_names text[] NOT NULL DEFAULT '{}',
  equipment_types text[] NOT NULL DEFAULT '{}',
  customer_kind text NOT NULL DEFAULT 'any' CHECK (customer_kind IN ('any', 'residential', 'commercial')),
  requires_owner_occupied boolean NOT NULL DEFAULT false,
  requires_income_qualified boolean NOT NULL DEFAULT false,
  min_building_age_years integer CHECK (min_building_age_years IS NULL OR min_building_age_years >= 0),
  max_building_age_years integer CHECK (max_building_age_years IS NULL OR max_building_age_years >= 0),
  efficiency_metric text,
  min_efficiency_value numeric CHECK (min_efficiency_value IS NULL OR min_efficiency_value >= 0),
  min_project_cents integer CHECK (min_project_cents IS NULL OR min_project_cents >= 0),
  benefit_kind text NOT NULL DEFAULT 'fixed' CHECK (benefit_kind IN ('fixed', 'percent', 'per_unit')),
  benefit_value numeric NOT NULL CHECK (benefit_value >= 0),
  cap_cents integer CHECK (cap_cents IS NULL OR cap_cents >= 0),
  percent_basis text NOT NULL DEFAULT 'project' CHECK (percent_basis IN ('project', 'equipment')),
  delivery text NOT NULL DEFAULT 'mail_in' CHECK (delivery IN ('instant', 'mail_in', 'tax_credit')),
  stack_group text,
  funding_status text NOT NULL DEFAULT 'available' CHECK (funding_status IN ('available', 'waitlist', 'exhausted', 'unknown')),
  effective_start date,
  effective_end date,
  verified_at timestamptz,
  source_url text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incentive_programs_percent_range CHECK (benefit_kind <> 'percent' OR benefit_value <= 100),
  CONSTRAINT incentive_programs_dates CHECK (effective_end IS NULL OR effective_start IS NULL OR effective_end >= effective_start),
  CONSTRAINT incentive_programs_age_range CHECK (
    min_building_age_years IS NULL OR max_building_age_years IS NULL OR max_building_age_years >= min_building_age_years
  )
);

CREATE INDEX IF NOT EXISTS idx_incentive_programs_user ON incentive_programs(user_id, is_active, effective_end);

COMMENT ON TABLE incentive_programs IS 'Rebates, credits and grants the account owner has entered. benefit_value is cents for fixed / per_unit and a 0-100 percentage for percent.';
COMMENT ON COLUMN incentive_programs.stack_group IS 'Programs that share a stack_group are mutually exclusive: only the best one is counted.';
COMMENT ON COLUMN incentive_programs.verified_at IS 'When the owner last checked the program details at the source. Entries older than 180 days are never shown as confirmed.';

ALTER TABLE incentive_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_incentive_programs" ON incentive_programs;
CREATE POLICY "select_own_incentive_programs" ON incentive_programs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_incentive_programs" ON incentive_programs;
CREATE POLICY "insert_own_incentive_programs" ON incentive_programs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_incentive_programs" ON incentive_programs;
CREATE POLICY "update_own_incentive_programs" ON incentive_programs FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_incentive_programs" ON incentive_programs;
CREATE POLICY "delete_own_incentive_programs" ON incentive_programs FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================
-- 2. Remembered per-customer project inputs
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_incentive_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  country text,
  state text,
  postal_code text,
  utility_name text,
  owner_occupied boolean,
  income_qualified boolean,
  building_year_built smallint CHECK (building_year_built IS NULL OR building_year_built BETWEEN 1700 AND 2200),
  electric_rate_cents_per_kwh numeric CHECK (electric_rate_cents_per_kwh IS NULL OR electric_rate_cents_per_kwh >= 0),
  gas_rate_cents_per_therm numeric CHECK (gas_rate_cents_per_therm IS NULL OR gas_rate_cents_per_therm >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_incentive_profiles_customer_unique UNIQUE (customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_incentive_profiles_user ON customer_incentive_profiles(user_id);

ALTER TABLE customer_incentive_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_customer_incentive_profiles" ON customer_incentive_profiles;
CREATE POLICY "select_customer_incentive_profiles" ON customer_incentive_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- INSERT/UPDATE/DELETE intentionally NOT granted: only the
-- incentive-decision-engine Edge Function's service-role client writes rows.

-- =============================================================
-- 3. Assessments (append-only audit log)
-- =============================================================

CREATE TABLE IF NOT EXISTS incentive_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  customer_id uuid,
  requested_by uuid,
  engine_version text NOT NULL,
  effective_date date NOT NULL,
  total_cents integer NOT NULL,
  confirmed_cents integer NOT NULL CHECK (confirmed_cents >= 0),
  potential_cents integer NOT NULL CHECK (potential_cents >= 0),
  net_cost_confirmed_cents integer NOT NULL,
  net_cost_best_cents integer NOT NULL,
  payback_months_best numeric(8, 1),
  programs_considered integer NOT NULL DEFAULT 0,
  project jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incentive_assessments_quote ON incentive_assessments(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incentive_assessments_user ON incentive_assessments(user_id, created_at DESC);

ALTER TABLE incentive_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_incentive_assessments" ON incentive_assessments;
CREATE POLICY "select_incentive_assessments" ON incentive_assessments FOR SELECT TO authenticated
  USING (public.can_view_incentives(user_id));

-- INSERT/UPDATE/DELETE intentionally NOT granted (service-role Edge Function only).

-- =============================================================
-- 4. Cached summary on quotes (for list views)
-- =============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS incentive_confirmed_cents integer,
  ADD COLUMN IF NOT EXISTS incentive_potential_cents integer,
  ADD COLUMN IF NOT EXISTS incentive_assessed_at timestamptz;

COMMENT ON COLUMN quotes.incentive_potential_cents IS 'Best-case incentives from the most recent incentive-decision-engine run. Advisory only: never changes the quote total.';
