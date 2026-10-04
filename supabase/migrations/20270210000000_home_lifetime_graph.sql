/*
  # Vireek Home Lifetime Graph

  The HOME is a permanent entity (a customer_sites row). Owners are *periods*
  (home_ownership_periods), so Equipment, Repairs, Replacements, Permits,
  Contractors, Warranty, Costs, Risks and Future interventions belong to the
  home and survive any change of owner.

  - New tables: home_ownership_periods, home_contractors, home_permits,
    home_interventions (all RLS-scoped to the account).
  - Ownership periods are written only by a trigger / transfer_home_ownership().
  - Purely additive; existing tables are untouched.
*/

-- =============================================================
-- HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.home_force_account_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.user_id := public.get_account_owner_id();
  IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.home_validate_links()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := to_jsonb(NEW);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_sites WHERE id = NEW.site_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_home';
  END IF;
  IF v->>'job_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = (v->>'job_id')::uuid AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_job';
  END IF;
  IF v->>'equipment_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment WHERE id = (v->>'equipment_id')::uuid AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_equipment';
  END IF;
  IF v->>'vendor_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vendors WHERE id = (v->>'vendor_id')::uuid AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_vendor';
  END IF;
  IF v->>'contractor_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM home_contractors WHERE id = (v->>'contractor_id')::uuid AND site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'invalid_contractor';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================
-- OWNERSHIP PERIODS  (the home outlives its owners)
-- =============================================================

CREATE TABLE IF NOT EXISTS home_ownership_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  started_at date NOT NULL DEFAULT CURRENT_DATE,
  ended_at date,
  transfer_reason text CHECK (transfer_reason IN
    ('sale', 'inheritance', 'new_tenant', 'property_manager_change', 'correction', 'other')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_home_ownership_site ON home_ownership_periods(site_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_ownership_one_open
  ON home_ownership_periods(site_id) WHERE ended_at IS NULL;

ALTER TABLE home_ownership_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_home_ownership" ON home_ownership_periods;
CREATE POLICY "select_own_home_ownership" ON home_ownership_periods
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Backfill: every existing site gets its first (open) period.
INSERT INTO home_ownership_periods (user_id, site_id, customer_id, started_at)
SELECT s.user_id, s.id, s.customer_id, s.created_at::date
FROM customer_sites s
WHERE NOT EXISTS (SELECT 1 FROM home_ownership_periods p WHERE p.site_id = s.id);

CREATE OR REPLACE FUNCTION public.home_ownership_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reason text := NULLIF(current_setting('vireek.transfer_reason', true), '');
  v_notes  text := NULLIF(current_setting('vireek.transfer_notes', true), '');
  v_date   date := COALESCE(NULLIF(current_setting('vireek.transfer_date', true), '')::date, CURRENT_DATE);
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO home_ownership_periods (user_id, site_id, customer_id, started_at)
      VALUES (NEW.user_id, NEW.id, NEW.customer_id, CURRENT_DATE);
    ELSIF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
      UPDATE home_ownership_periods
         SET ended_at = GREATEST(v_date, started_at),
             transfer_reason = COALESCE(v_reason, 'other'),
             notes = COALESCE(v_notes, notes)
       WHERE site_id = NEW.id AND ended_at IS NULL;
      INSERT INTO home_ownership_periods (user_id, site_id, customer_id, started_at)
      VALUES (NEW.user_id, NEW.id, NEW.customer_id,
              GREATEST(v_date, COALESCE((SELECT max(ended_at) FROM home_ownership_periods WHERE site_id = NEW.id), v_date)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home_ownership_sync failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_home_ownership_sync ON customer_sites;
CREATE TRIGGER trg_home_ownership_sync
  AFTER INSERT OR UPDATE OF customer_id ON customer_sites
  FOR EACH ROW EXECUTE FUNCTION public.home_ownership_sync();

-- =============================================================
-- CONTRACTORS (external parties who worked on this home)
-- =============================================================

CREATE TABLE IF NOT EXISTS home_contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  trade text,
  license_number text,
  phone text,
  email text,
  role text NOT NULL DEFAULT 'other'
    CHECK (role IN ('primary', 'subcontractor', 'previous_provider', 'inspector', 'other')),
  first_worked_on date,
  last_worked_on date,
  insured boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_contractors_site ON home_contractors(site_id);

-- =============================================================
-- PERMITS
-- =============================================================

CREATE TABLE IF NOT EXISTS home_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  contractor_id uuid REFERENCES home_contractors(id) ON DELETE SET NULL,
  permit_type text NOT NULL DEFAULT 'other'
    CHECK (permit_type IN ('building', 'mechanical', 'electrical', 'plumbing', 'gas', 'roofing', 'fire_safety', 'other')),
  permit_number text,
  jurisdiction text,
  description text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'applied', 'issued', 'inspection_pending', 'passed', 'failed', 'closed', 'expired', 'withdrawn')),
  applied_on date,
  issued_on date,
  expires_on date,
  final_inspection_on date,
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  document_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_permits_site ON home_permits(site_id);

-- =============================================================
-- FUTURE INTERVENTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS home_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  rationale text,
  intervention_type text NOT NULL DEFAULT 'maintenance'
    CHECK (intervention_type IN ('maintenance', 'repair', 'replacement', 'inspection', 'upgrade')),
  target_date date,
  est_cost_low_cents integer CHECK (est_cost_low_cents IS NULL OR est_cost_low_cents >= 0),
  est_cost_high_cents integer CHECK (est_cost_high_cents IS NULL OR est_cost_high_cents >= 0),
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('predicted', 'proposed', 'scheduled', 'completed', 'dismissed')),
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('system', 'staff', 'ai')),
  completed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (est_cost_low_cents IS NULL OR est_cost_high_cents IS NULL OR est_cost_low_cents <= est_cost_high_cents)
);
CREATE INDEX IF NOT EXISTS idx_home_interventions_site ON home_interventions(site_id, status);

-- =============================================================
-- RLS + TRIGGERS for the three writable tables
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['home_contractors', 'home_permits', 'home_interventions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "select_own_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "select_own_%s" ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "insert_own_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "insert_own_%s" ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "update_own_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "update_own_%s" ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "delete_own_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "delete_own_%s" ON %I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id())', t, t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_home_01_owner ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_home_01_owner BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.home_force_account_owner()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_home_02_links ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_home_02_links BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.home_validate_links()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS set_%s_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER set_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================
-- TRANSFER OWNERSHIP  (the home and its intelligence stay)
-- =============================================================

CREATE OR REPLACE FUNCTION public.transfer_home_ownership(
  p_site_id uuid,
  p_new_customer_id uuid,
  p_effective_date date DEFAULT CURRENT_DATE,
  p_reason text DEFAULT 'sale',
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_site customer_sites%ROWTYPE;
  v_role text;
  v_moved integer := 0;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  IF auth.uid() <> v_owner THEN
    SELECT role INTO v_role FROM team_members
     WHERE account_owner_id = v_owner
       AND member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
     LIMIT 1;
    IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'not_allowed'; END IF;
  END IF;

  IF p_reason NOT IN ('sale', 'inheritance', 'new_tenant', 'property_manager_change', 'correction', 'other') THEN
    RAISE EXCEPTION 'invalid_reason';
  END IF;
  IF p_effective_date IS NULL OR p_effective_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'invalid_effective_date';
  END IF;

  SELECT * INTO v_site FROM customer_sites WHERE id = p_site_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'home_not_found'; END IF;

  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_new_customer_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  IF v_site.customer_id = p_new_customer_id THEN RAISE EXCEPTION 'already_current_owner'; END IF;

  PERFORM set_config('vireek.transfer_reason', p_reason, true);
  PERFORM set_config('vireek.transfer_date', p_effective_date::text, true);
  PERFORM set_config('vireek.transfer_notes', COALESCE(p_notes, ''), true);

  -- The trigger closes the old period and opens the new one.
  UPDATE customer_sites SET customer_id = p_new_customer_id, is_primary = false WHERE id = p_site_id;

  -- Assets stay with the home. Jobs/invoices keep the customer who was billed.
  UPDATE equipment e SET customer_id = p_new_customer_id
   WHERE e.user_id = v_owner
     AND e.room_id IN (
       SELECT r.id FROM customer_site_rooms r
       JOIN customer_site_floors f ON f.id = r.floor_id
       JOIN customer_site_buildings b ON b.id = f.building_id
       WHERE b.site_id = p_site_id);
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  PERFORM set_config('vireek.transfer_reason', '', true);
  PERFORM set_config('vireek.transfer_date', '', true);
  PERFORM set_config('vireek.transfer_notes', '', true);

  RETURN jsonb_build_object(
    'site_id', p_site_id,
    'previous_customer_id', v_site.customer_id,
    'new_customer_id', p_new_customer_id,
    'equipment_moved', v_moved);
END $$;

REVOKE ALL ON FUNCTION public.transfer_home_ownership(uuid, uuid, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_home_ownership(uuid, uuid, date, text, text) TO authenticated;
