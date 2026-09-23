/*
  # Franchise Governance Layer (Pricing / Territory / Brand+Compliance /
  #  Benchmark / Royalty / Procurement)

  Builds on 20260923000000_franchise_command_center.sql. Every table here
  is owned by the franchise_group's HQ (auth.uid() = franchise_groups.owner_id)
  — same trust boundary as hq_manage_franchise_locations. Cross-tenant
  writes into a branch's own tables (price_book_items, vendors) are done
  by SECURITY DEFINER functions that re-check HQ ownership every call,
  exactly like get_franchise_dashboard_stats already does for reads.
*/

-- =============================================================
-- royalty rate lives on the location itself — HQ sets it
-- =============================================================
ALTER TABLE franchise_locations
ADD COLUMN IF NOT EXISTS royalty_rate_pct numeric(5,2) NOT NULL DEFAULT 6.00;

-- =============================================================
-- 1) PRICING: corporate price policies, optionally pushed to branches
-- =============================================================
CREATE TABLE IF NOT EXISTS franchise_price_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  service_name text NOT NULL,
  category text,
  pricing_model text NOT NULL DEFAULT 'flat' CHECK (pricing_model IN ('flat', 'starting_at', 'range', 'hourly')),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  price_max_cents integer CHECK (price_max_cents IS NULL OR price_max_cents >= price_cents),
  unit_label text,
  enforcement text NOT NULL DEFAULT 'recommended' CHECK (enforcement IN ('mandatory', 'recommended_floor', 'recommended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fpp_group ON franchise_price_policies(franchise_group_id);
ALTER TABLE franchise_price_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_manage_price_policies" ON franchise_price_policies;
CREATE POLICY "hq_manage_price_policies" ON franchise_price_policies FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));

-- Push a policy down into every active branch's own price_book_items.
-- mandatory: overwrite price. recommended_floor: only raise if below floor.
-- recommended: never touches branch data (informational only).
CREATE OR REPLACE FUNCTION public.push_price_policy_to_locations(p_policy_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy record;
  v_loc record;
  v_existing record;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_policy FROM franchise_price_policies
  WHERE id = p_policy_id
    AND franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Policy not found or not authorized'; END IF;
  IF v_policy.enforcement = 'recommended' THEN RETURN 0; END IF;

  FOR v_loc IN
    SELECT location_profile_id FROM franchise_locations
    WHERE franchise_group_id = v_policy.franchise_group_id AND status = 'active' AND location_profile_id IS NOT NULL
  LOOP
    SELECT id, price_cents INTO v_existing FROM price_book_items
    WHERE user_id = v_loc.location_profile_id AND lower(service_name) = lower(v_policy.service_name)
    LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO price_book_items (user_id, service_name, category, pricing_model, price_cents, price_max_cents, unit_label)
      VALUES (v_loc.location_profile_id, v_policy.service_name, v_policy.category, v_policy.pricing_model, v_policy.price_cents, v_policy.price_max_cents, v_policy.unit_label);
      v_count := v_count + 1;
    ELSIF v_policy.enforcement = 'mandatory' THEN
      UPDATE price_book_items SET price_cents = v_policy.price_cents, price_max_cents = v_policy.price_max_cents,
        pricing_model = v_policy.pricing_model, updated_at = now() WHERE id = v_existing.id;
      v_count := v_count + 1;
    ELSIF v_policy.enforcement = 'recommended_floor' AND v_existing.price_cents < v_policy.price_cents THEN
      UPDATE price_book_items SET price_cents = v_policy.price_cents, updated_at = now() WHERE id = v_existing.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.push_price_policy_to_locations(uuid) TO authenticated;

-- =============================================================
-- 2) TERRITORY: zip-code assignment per branch, no overlap when exclusive
-- =============================================================
CREATE TABLE IF NOT EXISTS franchise_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES franchise_locations(id) ON DELETE CASCADE,
  zip_codes text[] NOT NULL DEFAULT '{}',
  exclusive boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id)
);

CREATE INDEX IF NOT EXISTS idx_ft_group ON franchise_territories(franchise_group_id);
ALTER TABLE franchise_territories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_manage_territories" ON franchise_territories;
CREATE POLICY "hq_manage_territories" ON franchise_territories FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.check_territory_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_conflict_location uuid;
BEGIN
  IF NEW.exclusive THEN
    SELECT ft.location_id INTO v_conflict_location
    FROM franchise_territories ft
    WHERE ft.franchise_group_id = NEW.franchise_group_id
      AND ft.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND ft.exclusive
      AND ft.zip_codes && NEW.zip_codes
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Zip code overlap with an existing exclusive territory (location %)', v_conflict_location;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_check_territory_overlap ON franchise_territories;
CREATE TRIGGER trigger_check_territory_overlap
  BEFORE INSERT OR UPDATE ON franchise_territories
  FOR EACH ROW EXECUTE FUNCTION public.check_territory_overlap();

-- =============================================================
-- 3) BRAND STANDARDS + COMPLIANCE: one requirements engine for both
-- =============================================================
CREATE TABLE IF NOT EXISTS franchise_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  requirement_type text NOT NULL CHECK (requirement_type IN ('brand', 'compliance', 'safety', 'legal')),
  title text NOT NULL,
  description text,
  file_url text,
  is_required boolean NOT NULL DEFAULT true,
  recurs_every_days int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_freq_group ON franchise_requirements(franchise_group_id);
ALTER TABLE franchise_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_manage_requirements" ON franchise_requirements;
CREATE POLICY "hq_manage_requirements" ON franchise_requirements FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));
DROP POLICY IF EXISTS "branch_view_requirements" ON franchise_requirements;
CREATE POLICY "branch_view_requirements" ON franchise_requirements FOR SELECT TO authenticated
  USING (franchise_group_id IN (
    SELECT franchise_group_id FROM franchise_locations WHERE location_profile_id = auth.uid() AND status = 'active'
  ));

CREATE TABLE IF NOT EXISTS franchise_requirement_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES franchise_requirements(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES franchise_locations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'compliant', 'non_compliant', 'waived')),
  evidence_url text,
  reviewer_note text,
  reviewed_at timestamptz,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_frr_location ON franchise_requirement_records(location_id);
ALTER TABLE franchise_requirement_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_requirement_records" ON franchise_requirement_records;
CREATE POLICY "select_requirement_records" ON franchise_requirement_records FOR SELECT TO authenticated
  USING (
    requirement_id IN (SELECT id FROM franchise_requirements WHERE franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
    OR location_id IN (SELECT id FROM franchise_locations WHERE location_profile_id = auth.uid())
  );
-- No direct INSERT/UPDATE policy — writes only via the two RPCs below,
-- so a branch can never mark itself "compliant" and HQ actions stay audited.

-- branch submits evidence for a requirement (status always goes to 'pending' for HQ review)
CREATE OR REPLACE FUNCTION public.submit_compliance_evidence(p_requirement_id uuid, p_evidence_url text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_location_id uuid; v_record_id uuid;
BEGIN
  SELECT id INTO v_location_id FROM franchise_locations WHERE location_profile_id = auth.uid() AND status = 'active'
    AND franchise_group_id = (SELECT franchise_group_id FROM franchise_requirements WHERE id = p_requirement_id);
  IF v_location_id IS NULL THEN RAISE EXCEPTION 'Not an active branch for this requirement'; END IF;

  INSERT INTO franchise_requirement_records (requirement_id, location_id, status, evidence_url)
  VALUES (p_requirement_id, v_location_id, 'pending', p_evidence_url)
  ON CONFLICT (requirement_id, location_id)
  DO UPDATE SET evidence_url = p_evidence_url, status = 'pending', reviewed_at = NULL
  RETURNING id INTO v_record_id;

  RETURN v_record_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_compliance_evidence(uuid, text) TO authenticated;

-- HQ reviews/approves
CREATE OR REPLACE FUNCTION public.review_compliance_record(p_record_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('compliant', 'non_compliant', 'waived', 'pending') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  UPDATE franchise_requirement_records SET status = p_status, reviewer_note = p_note, reviewed_at = now()
  WHERE id = p_record_id
    AND requirement_id IN (SELECT id FROM franchise_requirements WHERE franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));
  IF NOT FOUND THEN RAISE EXCEPTION 'Record not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.review_compliance_record(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_franchise_compliance_summary(p_group_id uuid)
RETURNS TABLE (location_id uuid, label text, total_requirements bigint, compliant_count bigint, non_compliant_count bigint, pending_count bigint, compliance_pct numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM franchise_groups WHERE id = p_group_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this franchise group';
  END IF;

  RETURN QUERY
  SELECT
    fl.id, fl.label,
    count(rr.id),
    count(rr.id) FILTER (WHERE rr.status = 'compliant'),
    count(rr.id) FILTER (WHERE rr.status = 'non_compliant'),
    count(rr.id) FILTER (WHERE rr.status = 'pending'),
    CASE WHEN count(rr.id) FILTER (WHERE rr.status IN ('compliant','non_compliant')) = 0 THEN NULL
      ELSE round(100.0 * count(rr.id) FILTER (WHERE rr.status = 'compliant') / count(rr.id) FILTER (WHERE rr.status IN ('compliant','non_compliant')), 1)
    END
  FROM franchise_locations fl
  LEFT JOIN franchise_requirement_records rr ON rr.location_id = fl.id
  WHERE fl.franchise_group_id = p_group_id AND fl.status = 'active'
  GROUP BY fl.id, fl.label;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_franchise_compliance_summary(uuid) TO authenticated;

-- =============================================================
-- 4) BENCHMARK: rank branches against the group on core metrics
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_franchise_benchmark(p_group_id uuid)
RETURNS TABLE (location_id uuid, label text, revenue_30d numeric, jobs_30d bigint, avg_rating numeric, revenue_percentile numeric, jobs_percentile numeric, rating_percentile numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM franchise_groups WHERE id = p_group_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this franchise group';
  END IF;

  RETURN QUERY
  WITH stats AS (
    SELECT
      fl.id AS location_id, fl.label,
      COALESCE((SELECT sum(j.invoice_amount) FROM jobs j WHERE j.user_id = fl.location_profile_id AND j.invoice_status = 'paid' AND j.created_at > now() - interval '30 days'), 0) AS revenue_30d,
      COALESCE((SELECT count(*) FROM jobs j WHERE j.user_id = fl.location_profile_id AND j.created_at > now() - interval '30 days'), 0) AS jobs_30d,
      (SELECT avg(r.rating) FROM review_requests r WHERE r.user_id = fl.location_profile_id AND r.rating IS NOT NULL AND r.sent_at > now() - interval '30 days') AS avg_rating
    FROM franchise_locations fl
    WHERE fl.franchise_group_id = p_group_id AND fl.status = 'active'
  )
  SELECT
    s.location_id, s.label, s.revenue_30d, s.jobs_30d, s.avg_rating,
    round((PERCENT_RANK() OVER (ORDER BY s.revenue_30d))::numeric * 100, 0),
    round((PERCENT_RANK() OVER (ORDER BY s.jobs_30d))::numeric * 100, 0),
    round((PERCENT_RANK() OVER (ORDER BY s.avg_rating))::numeric * 100, 0)
  FROM stats s;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_franchise_benchmark(uuid) TO authenticated;

-- =============================================================
-- 5) ROYALTY: computed from each branch's own paid job revenue
-- =============================================================
CREATE TABLE IF NOT EXISTS franchise_royalty_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES franchise_locations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  gross_revenue_cents bigint NOT NULL DEFAULT 0,
  royalty_rate_pct numeric(5,2) NOT NULL,
  royalty_amount_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'waived')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (location_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_frs_group ON franchise_royalty_statements(franchise_group_id, period_start DESC);
ALTER TABLE franchise_royalty_statements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_manage_royalty" ON franchise_royalty_statements;
CREATE POLICY "hq_manage_royalty" ON franchise_royalty_statements FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));
DROP POLICY IF EXISTS "branch_view_own_royalty" ON franchise_royalty_statements;
CREATE POLICY "branch_view_own_royalty" ON franchise_royalty_statements FOR SELECT TO authenticated
  USING (location_id IN (SELECT id FROM franchise_locations WHERE location_profile_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.generate_royalty_statements(p_group_id uuid, p_period_start date, p_period_end date)
RETURNS TABLE (id uuid, location_id uuid, royalty_amount_cents bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_loc record; v_gross numeric; v_new_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM franchise_groups WHERE id = p_group_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this franchise group';
  END IF;

  FOR v_loc IN SELECT id, location_profile_id, royalty_rate_pct FROM franchise_locations
    WHERE franchise_group_id = p_group_id AND status = 'active' AND location_profile_id IS NOT NULL
  LOOP
    SELECT COALESCE(sum(j.invoice_amount), 0) INTO v_gross FROM jobs j
    WHERE j.user_id = v_loc.location_profile_id AND j.invoice_status = 'paid'
      AND j.created_at::date BETWEEN p_period_start AND p_period_end;

    INSERT INTO franchise_royalty_statements (franchise_group_id, location_id, period_start, period_end, gross_revenue_cents, royalty_rate_pct, royalty_amount_cents)
    VALUES (p_group_id, v_loc.id, p_period_start, p_period_end, round(v_gross * 100), v_loc.royalty_rate_pct, round(v_gross * 100 * v_loc.royalty_rate_pct / 100))
    ON CONFLICT (location_id, period_start, period_end) DO NOTHING
    RETURNING franchise_royalty_statements.id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      id := v_new_id; location_id := v_loc.id;
      SELECT franchise_royalty_statements.royalty_amount_cents INTO royalty_amount_cents FROM franchise_royalty_statements WHERE franchise_royalty_statements.id = v_new_id;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_royalty_statements(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_royalty_statement_status(p_statement_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('issued', 'paid', 'waived') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE franchise_royalty_statements SET status = p_status, paid_at = CASE WHEN p_status = 'paid' THEN now() ELSE paid_at END
  WHERE id = p_statement_id AND franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_royalty_statement_status(uuid, text) TO authenticated;

-- =============================================================
-- 6) PROCUREMENT: HQ-negotiated vendors, pushed into each branch's own vendors list
-- =============================================================
CREATE TABLE IF NOT EXISTS franchise_approved_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  contact_name text,
  phone text,
  email text,
  negotiated_terms text,
  is_mandatory boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fav_group ON franchise_approved_vendors(franchise_group_id);
ALTER TABLE franchise_approved_vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_manage_approved_vendors" ON franchise_approved_vendors;
CREATE POLICY "hq_manage_approved_vendors" ON franchise_approved_vendors FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.push_vendor_to_locations(p_vendor_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_vendor record; v_loc record; v_count integer := 0;
BEGIN
  SELECT * INTO v_vendor FROM franchise_approved_vendors
  WHERE id = p_vendor_id AND franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found or not authorized'; END IF;

  FOR v_loc IN SELECT location_profile_id FROM franchise_locations
    WHERE franchise_group_id = v_vendor.franchise_group_id AND status = 'active' AND location_profile_id IS NOT NULL
  LOOP
    IF NOT EXISTS (SELECT 1 FROM vendors WHERE user_id = v_loc.location_profile_id AND lower(name) = lower(v_vendor.name)) THEN
      INSERT INTO vendors (user_id, name, contact_name, email, phone, category, payment_terms, notes)
      VALUES (v_loc.location_profile_id, v_vendor.name, v_vendor.contact_name, v_vendor.email, v_vendor.phone, v_vendor.category, v_vendor.negotiated_terms,
        CASE WHEN v_vendor.is_mandatory THEN 'Corporate-mandated vendor' ELSE 'Corporate-approved vendor' END);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.push_vendor_to_locations(uuid) TO authenticated;
