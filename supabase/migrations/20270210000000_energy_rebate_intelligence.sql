/*
  # Vireek Energy + Rebate Intelligence

  Property -> equipment -> replacement -> incentive -> outcome.
  Purely additive: nothing existing is dropped, renamed or rewritten.

  - incentive_programs     Incentive catalog. owner_user_id IS NULL = platform catalog
                           (read-only for every account). A non-null owner_user_id is a
                           PRIVATE program the account entered itself (local utility, supplier
                           promo). The engine never invents a program: no row, no incentive.
  - utility_territories    postal code -> utility lookup (platform + private rows).
  - rebate_analyses        Append-only audit log of every engine run. Only the
                           rebate-intelligence Edge Function (service role) writes it.
  - rebate_applications    The outcome ledger (identified -> submitted -> approved/denied -> paid).
                           This is the moat: realization rates learned from real outcomes
                           feed back into every future estimate.
  - rebate_network_realization()  k-anonymous aggregate (>= 5 decisions from >= 3 accounts),
                           service-role only. Never exposes another account's rows.
*/

-- =============================================================
-- 1. incentive_programs
-- =============================================================

CREATE TABLE IF NOT EXISTS incentive_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 160),
  level text NOT NULL CHECK (level IN ('federal', 'state', 'local', 'utility', 'manufacturer')),
  administrator text,
  jurisdiction_state text CHECK (jurisdiction_state IS NULL OR jurisdiction_state ~ '^[A-Z]{2}$'),
  utility_name text,
  postal_prefixes text[] NOT NULL DEFAULT '{}',
  measure_types text[] NOT NULL CHECK (cardinality(measure_types) > 0),
  incentive_kind text NOT NULL CHECK (incentive_kind IN ('rebate', 'tax_credit', 'loan', 'instant_discount')),
  payout_timing text NOT NULL DEFAULT 'post_install' CHECK (payout_timing IN ('point_of_sale', 'post_install', 'tax_filing')),
  amount_type text NOT NULL CHECK (amount_type IN ('flat', 'percent_of_cost', 'per_ton', 'per_unit')),
  amount_value numeric(12, 3) NOT NULL CHECK (amount_value >= 0),
  max_amount_cents integer CHECK (max_amount_cents IS NULL OR max_amount_cents >= 0),
  min_efficiency jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(min_efficiency) = 'object'),
  income_tiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(income_tiers) = 'array'),
  requires_owner_occupied boolean NOT NULL DEFAULT false,
  requires_pre_approval boolean NOT NULL DEFAULT false,
  requires_participating_contractor boolean NOT NULL DEFAULT false,
  exclusive_group text,
  start_date date,
  end_date date,
  funding_status text NOT NULL DEFAULT 'unknown' CHECK (funding_status IN ('open', 'limited', 'waitlist', 'closed', 'unknown')),
  source_url text,
  last_verified_at timestamptz,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incentive_programs_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_programs_platform_slug
  ON incentive_programs(slug) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_programs_owner_slug
  ON incentive_programs(owner_user_id, slug) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incentive_programs_state ON incentive_programs(jurisdiction_state) WHERE is_active;

COMMENT ON TABLE incentive_programs IS 'Incentive catalog. owner_user_id NULL = platform catalog (service role only); otherwise a private program entered by that account.';
COMMENT ON COLUMN incentive_programs.amount_value IS 'Cents for flat / per_ton / per_unit; percent (0-100) for percent_of_cost.';
COMMENT ON COLUMN incentive_programs.income_tiers IS '[{"max_ami_pct":80,"share_pct":100},{"max_ami_pct":150,"share_pct":50}] - share_pct scales the computed amount; households above the last tier are ineligible.';
COMMENT ON COLUMN incentive_programs.min_efficiency IS 'Minimums keyed seer2 / eer2 / hspf2 / afue / uef; energy_star = 1 requires an ENERGY STAR certified unit.';

ALTER TABLE incentive_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_incentive_programs" ON incentive_programs;
CREATE POLICY "select_incentive_programs" ON incentive_programs FOR SELECT TO authenticated
  USING (owner_user_id IS NULL OR owner_user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_incentive_programs" ON incentive_programs;
CREATE POLICY "insert_own_incentive_programs" ON incentive_programs FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_incentive_programs" ON incentive_programs;
CREATE POLICY "update_own_incentive_programs" ON incentive_programs FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_incentive_programs" ON incentive_programs;
CREATE POLICY "delete_own_incentive_programs" ON incentive_programs FOR DELETE TO authenticated
  USING (owner_user_id = auth.uid());

DROP TRIGGER IF EXISTS trigger_incentive_programs_updated_at ON incentive_programs;
CREATE TRIGGER trigger_incentive_programs_updated_at
  BEFORE UPDATE ON incentive_programs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. utility_territories
-- =============================================================

CREATE TABLE IF NOT EXISTS utility_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  postal_code text NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  utility_name text NOT NULL CHECK (char_length(btrim(utility_name)) BETWEEN 2 AND 120),
  utility_type text NOT NULL DEFAULT 'electric' CHECK (utility_type IN ('electric', 'gas', 'both')),
  source_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_utility_territories
  ON utility_territories(COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), postal_code, lower(utility_name), utility_type);
CREATE INDEX IF NOT EXISTS idx_utility_territories_postal ON utility_territories(postal_code);

ALTER TABLE utility_territories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_utility_territories" ON utility_territories;
CREATE POLICY "select_utility_territories" ON utility_territories FOR SELECT TO authenticated
  USING (owner_user_id IS NULL OR owner_user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_utility_territories" ON utility_territories;
CREATE POLICY "insert_own_utility_territories" ON utility_territories FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_utility_territories" ON utility_territories;
CREATE POLICY "delete_own_utility_territories" ON utility_territories FOR DELETE TO authenticated
  USING (owner_user_id = auth.uid());

-- =============================================================
-- 3. rebate_analyses (append-only audit log)
-- =============================================================

CREATE TABLE IF NOT EXISTS rebate_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  requested_by uuid,
  engine_version text NOT NULL,
  state text,
  postal_code text,
  install_target_date date,
  best_option_key text,
  total_potential_cents integer NOT NULL DEFAULT 0,
  total_expected_cents integer NOT NULL DEFAULT 0,
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rebate_analyses_user ON rebate_analyses(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rebate_analyses_customer ON rebate_analyses(customer_id, created_at DESC);

ALTER TABLE rebate_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_rebate_analyses" ON rebate_analyses;
CREATE POLICY "select_rebate_analyses" ON rebate_analyses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- INSERT/UPDATE/DELETE intentionally NOT granted: only the rebate-intelligence
-- Edge Function (service role) writes rows, so a report can't be forged via REST.

-- =============================================================
-- 4. rebate_applications (the outcome ledger = the moat)
-- =============================================================

CREATE TABLE IF NOT EXISTS rebate_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES rebate_analyses(id) ON DELETE SET NULL,
  program_id uuid REFERENCES incentive_programs(id) ON DELETE SET NULL,
  program_name text NOT NULL CHECK (char_length(btrim(program_name)) BETWEEN 2 AND 160),
  option_key text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'identified'
    CHECK (status IN ('identified', 'proposed', 'submitted', 'approved', 'paid', 'denied', 'withdrawn')),
  estimated_cents integer NOT NULL DEFAULT 0 CHECK (estimated_cents >= 0),
  approved_cents integer CHECK (approved_cents IS NULL OR approved_cents >= 0),
  paid_cents integer CHECK (paid_cents IS NULL OR paid_cents >= 0),
  denial_reason text,
  submitted_at timestamptz,
  decided_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rebate_applications_user ON rebate_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rebate_applications_customer ON rebate_applications(customer_id);
CREATE INDEX IF NOT EXISTS idx_rebate_applications_program_status ON rebate_applications(program_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rebate_applications_once
  ON rebate_applications(user_id, analysis_id, program_id, COALESCE(option_key, ''))
  WHERE analysis_id IS NOT NULL AND program_id IS NOT NULL;

ALTER TABLE rebate_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rebate_applications" ON rebate_applications;
CREATE POLICY "select_own_rebate_applications" ON rebate_applications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_rebate_applications" ON rebate_applications;
CREATE POLICY "insert_own_rebate_applications" ON rebate_applications FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM customers c WHERE c.id = rebate_applications.customer_id AND c.user_id = public.get_account_owner_id())
  );

DROP POLICY IF EXISTS "update_own_rebate_applications" ON rebate_applications;
CREATE POLICY "update_own_rebate_applications" ON rebate_applications FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_rebate_applications" ON rebate_applications;
CREATE POLICY "delete_own_rebate_applications" ON rebate_applications FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_rebate_applications_updated_at ON rebate_applications;
CREATE TRIGGER trigger_rebate_applications_updated_at
  BEFORE UPDATE ON rebate_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 5. Network realization (k-anonymous, service role only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rebate_network_realization(p_program_ids uuid[])
RETURNS TABLE (program_id uuid, decided integer, successes integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.program_id,
         count(*)::integer AS decided,
         (count(*) FILTER (WHERE a.status IN ('approved', 'paid')))::integer AS successes
  FROM rebate_applications a
  JOIN incentive_programs p ON p.id = a.program_id AND p.owner_user_id IS NULL
  WHERE a.program_id = ANY (p_program_ids)
    AND a.status IN ('approved', 'paid', 'denied')
  GROUP BY a.program_id
  HAVING count(*) >= 5 AND count(DISTINCT a.user_id) >= 3;
$$;

REVOKE ALL ON FUNCTION public.rebate_network_realization(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebate_network_realization(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rebate_network_realization(uuid[]) TO service_role;

-- =============================================================
-- 6. Platform seed: federal programs only (statute-level facts).
--    State / utility / manufacturer programs are NEVER guessed: they
--    come from verified imports or from the account's own entries.
-- =============================================================

INSERT INTO incentive_programs
  (owner_user_id, slug, name, level, administrator, measure_types, incentive_kind, payout_timing,
   amount_type, amount_value, max_amount_cents, min_efficiency, income_tiers,
   requires_owner_occupied, requires_pre_approval, requires_participating_contractor,
   exclusive_group, start_date, end_date, funding_status, source_url, last_verified_at, notes)
VALUES
  (NULL, 'federal-25c-heat-pump', 'Federal 25C credit - heat pumps (ENDED)', 'federal', 'IRS',
   ARRAY['heat_pump_hvac', 'heat_pump_water_heater'], 'tax_credit', 'tax_filing',
   'percent_of_cost', 30, 200000, '{}'::jsonb, '[]'::jsonb,
   true, false, false, 'federal-25c', NULL, DATE '2025-12-31', 'closed',
   'https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit', now(),
   'Terminated by Public Law 119-21 for property placed in service after 2025-12-31. Kept so the engine can explain WHY it is not offered for 2026+ installs and still model 2025 installs.'),
  (NULL, 'federal-25c-central-ac-furnace', 'Federal 25C credit - central AC / furnace / boiler (ENDED)', 'federal', 'IRS',
   ARRAY['central_ac', 'furnace', 'boiler'], 'tax_credit', 'tax_filing',
   'percent_of_cost', 30, 60000, '{}'::jsonb, '[]'::jsonb,
   true, false, false, 'federal-25c', NULL, DATE '2025-12-31', 'closed',
   'https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit', now(),
   'Terminated by Public Law 119-21 for property placed in service after 2025-12-31.'),
  (NULL, 'federal-hear-heat-pump-hvac', 'DOE HEAR rebate - heat pump HVAC (income-qualified)', 'federal', 'State energy office (DOE Home Electrification and Appliance Rebates)',
   ARRAY['heat_pump_hvac'], 'rebate', 'point_of_sale',
   'percent_of_cost', 100, 800000, '{}'::jsonb,
   '[{"max_ami_pct":80,"share_pct":100},{"max_ami_pct":150,"share_pct":50}]'::jsonb,
   true, true, true, 'doe-home-rebates', NULL, NULL, 'unknown',
   'https://www.energy.gov/scep/home-energy-rebates-programs', now(),
   'Statutory cap per measure; funded and launched STATE BY STATE. Confirm the state program is open, the household income vs area median income, and contractor enrollment before promising it.'),
  (NULL, 'federal-hear-heat-pump-water-heater', 'DOE HEAR rebate - heat pump water heater (income-qualified)', 'federal', 'State energy office (DOE Home Electrification and Appliance Rebates)',
   ARRAY['heat_pump_water_heater'], 'rebate', 'point_of_sale',
   'percent_of_cost', 100, 175000, '{}'::jsonb,
   '[{"max_ami_pct":80,"share_pct":100},{"max_ami_pct":150,"share_pct":50}]'::jsonb,
   true, true, true, 'doe-home-rebates', NULL, NULL, 'unknown',
   'https://www.energy.gov/scep/home-energy-rebates-programs', now(),
   'Statutory cap per measure; launched state by state. Verify with the state energy office.'),
  (NULL, 'federal-hear-panel-upgrade', 'DOE HEAR rebate - electrical panel upgrade (income-qualified)', 'federal', 'State energy office (DOE Home Electrification and Appliance Rebates)',
   ARRAY['panel_upgrade'], 'rebate', 'point_of_sale',
   'percent_of_cost', 100, 400000, '{}'::jsonb,
   '[{"max_ami_pct":80,"share_pct":100},{"max_ami_pct":150,"share_pct":50}]'::jsonb,
   true, true, true, 'doe-home-rebates', NULL, NULL, 'unknown',
   'https://www.energy.gov/scep/home-energy-rebates-programs', now(),
   'Statutory cap per measure; launched state by state. Verify with the state energy office.')
ON CONFLICT (slug) WHERE owner_user_id IS NULL DO NOTHING;
