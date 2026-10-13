/*
  # Vireek Home Risk & Capital Underwriting Engine

  - home_capital_plans    : immutable snapshots of every underwriting run (risk index, grade,
                            10-year plan, inputs, engine version) -> auditable history and trend.
  - home_capital_actions  : one row per recommended action the team has acted on, linking it to the
                            Quote, Job, Financing offer and Warranty claim it produced.

  Purely additive. Reuses home_force_account_owner() / home_validate_links() from the Home Lifetime
  Graph migration (20270210000000_home_lifetime_graph.sql) - apply that one first.
*/

-- =============================================================
-- SNAPSHOTS (insert-only: a plan is evidence, never edited)
-- =============================================================

CREATE TABLE IF NOT EXISTS home_capital_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  engine_version text NOT NULL,
  risk_index smallint NOT NULL CHECK (risk_index BETWEEN 0 AND 100),
  grade text NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'E')),
  risk_tolerance numeric(4, 3) NOT NULL CHECK (risk_tolerance BETWEEN 0.1 AND 0.6),
  ten_year_total_cents bigint NOT NULL CHECK (ten_year_total_cents >= 0),
  summary jsonb NOT NULL,
  items jsonb NOT NULL,
  years jsonb NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_capital_plans_site ON home_capital_plans(site_id, created_at DESC);

-- =============================================================
-- ACTIONS (the hand-off record)
-- =============================================================

CREATE TABLE IF NOT EXISTS home_capital_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES home_capital_plans(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  item_key text NOT NULL CHECK (length(btrim(item_key)) > 0),
  action text NOT NULL CHECK (action IN ('repair', 'replace', 'maintain', 'inspect', 'insure')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'quoted', 'scheduled', 'financing', 'completed', 'dismissed')),
  est_cost_cents integer CHECK (est_cost_cents IS NULL OR est_cost_cents >= 0),
  target_date date,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  financing_offer_id uuid REFERENCES financing_offers(id) ON DELETE SET NULL,
  warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE SET NULL,
  completed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_home_capital_actions_site ON home_capital_actions(site_id, status);

CREATE OR REPLACE FUNCTION public.home_capital_validate_links()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM home_capital_plans WHERE id = NEW.plan_id AND site_id = NEW.site_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_plan';
  END IF;
  IF NEW.quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quotes WHERE id = NEW.quote_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_quote';
  END IF;
  IF NEW.financing_offer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM financing_offers WHERE id = NEW.financing_offer_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_financing_offer';
  END IF;
  IF NEW.warranty_claim_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warranty_claims WHERE id = NEW.warranty_claim_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_warranty_claim';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================
-- RLS + TRIGGERS
-- =============================================================

ALTER TABLE home_capital_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_home_capital_plans" ON home_capital_plans;
CREATE POLICY "select_own_home_capital_plans" ON home_capital_plans
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_home_capital_plans" ON home_capital_plans;
CREATE POLICY "insert_own_home_capital_plans" ON home_capital_plans
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trg_home_01_owner ON home_capital_plans;
CREATE TRIGGER trg_home_01_owner BEFORE INSERT ON home_capital_plans
  FOR EACH ROW EXECUTE FUNCTION public.home_force_account_owner();
DROP TRIGGER IF EXISTS trg_home_02_links ON home_capital_plans;
CREATE TRIGGER trg_home_02_links BEFORE INSERT ON home_capital_plans
  FOR EACH ROW EXECUTE FUNCTION public.home_validate_links();

ALTER TABLE home_capital_actions ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text := 'home_capital_actions';
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS "select_own_%s" ON %I', t, t);
  EXECUTE format('CREATE POLICY "select_own_%s" ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t, t);
  EXECUTE format('DROP POLICY IF EXISTS "insert_own_%s" ON %I', t, t);
  EXECUTE format('CREATE POLICY "insert_own_%s" ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id())', t, t);
  EXECUTE format('DROP POLICY IF EXISTS "update_own_%s" ON %I', t, t);
  EXECUTE format('CREATE POLICY "update_own_%s" ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id())', t, t);
  EXECUTE format('DROP POLICY IF EXISTS "delete_own_%s" ON %I', t, t);
  EXECUTE format('CREATE POLICY "delete_own_%s" ON %I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id())', t, t);
END $$;

DROP TRIGGER IF EXISTS trg_home_01_owner ON home_capital_actions;
CREATE TRIGGER trg_home_01_owner BEFORE INSERT ON home_capital_actions
  FOR EACH ROW EXECUTE FUNCTION public.home_force_account_owner();
DROP TRIGGER IF EXISTS trg_home_02_links ON home_capital_actions;
CREATE TRIGGER trg_home_02_links BEFORE INSERT OR UPDATE ON home_capital_actions
  FOR EACH ROW EXECUTE FUNCTION public.home_validate_links();
DROP TRIGGER IF EXISTS trg_home_03_capital_links ON home_capital_actions;
CREATE TRIGGER trg_home_03_capital_links BEFORE INSERT OR UPDATE ON home_capital_actions
  FOR EACH ROW EXECUTE FUNCTION public.home_capital_validate_links();
DROP TRIGGER IF EXISTS set_home_capital_actions_updated_at ON home_capital_actions;
CREATE TRIGGER set_home_capital_actions_updated_at BEFORE UPDATE ON home_capital_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
