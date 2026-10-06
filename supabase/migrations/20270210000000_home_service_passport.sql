/*
  # Vireek Home Service Passport

  A portable, sealed, buyer-ready record of a home's equipment and service life,
  issued at the moment of sale (or for an inspector / insurer / lender).

  ## Integrity model
  - FACTS (equipment, ages, warranties, service history, permits, known problems,
    predicted maintenance) are derived server-side from operational tables.
    Nobody types them into the passport.
  - PROJECTIONS (expected future costs) come from the app's Home Budget model.
    The server only sanitises and bounds them, and labels them as estimates.
  - Issued snapshots are SHA-256 sealed and immutable (trigger). Only revoke and
    view counters change afterwards.
  - Issuing requires the manager to confirm the homeowner's consent.
  - Public payload never contains: customer name/phone/email, technician names,
    invoice amounts, margins, internal notes or photos.

  ## Objects
  home_permits                    : permits logged against a customer's property (RLS, account-scoped)
  home_passport_transfers         : sealed issued passports (no client writes)
  home_passport_equipment_rows()  : internal derived equipment view
  build_home_passport_payload()   : internal canonical builder
  home_passport_clean_projections : internal sanitiser
  get_home_service_passport()     : manager live read
  issue_home_passport_transfer()  : manager issues sealed link
  revoke_home_passport_transfer() : manager revokes
  verify_home_passport()          : public (anon) verification
  Depends on: identity_is_manager() (technician identity graph migration).
*/

-- 1) Permits ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS home_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  permit_type text NOT NULL CHECK (length(btrim(permit_type)) BETWEEN 1 AND 80),
  permit_number text CHECK (permit_number IS NULL OR length(permit_number) <= 60),
  jurisdiction text CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 120),
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('applied', 'issued', 'inspection_pending', 'passed', 'failed', 'expired', 'closed')),
  issued_on date,
  expires_on date,
  finalized_on date,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_permits_dates_check CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX IF NOT EXISTS idx_home_permits_customer ON home_permits(customer_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS idx_home_permits_job ON home_permits(job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.home_permits_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND auth.uid() IS NOT NULL THEN
    NEW.user_id := public.get_account_owner_id();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.customer_id := OLD.customer_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;

  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = NEW.user_id AND j.customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'Job does not belong to this customer' USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_home_permits_before_write ON home_permits;
CREATE TRIGGER trg_home_permits_before_write
  BEFORE INSERT OR UPDATE ON home_permits
  FOR EACH ROW EXECUTE FUNCTION public.home_permits_before_write();

ALTER TABLE home_permits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_permits" ON home_permits;
CREATE POLICY "select_own_home_permits" ON home_permits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_home_permits" ON home_permits;
CREATE POLICY "insert_own_home_permits" ON home_permits FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_home_permits" ON home_permits;
CREATE POLICY "update_own_home_permits" ON home_permits FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_home_permits" ON home_permits;
CREATE POLICY "delete_own_home_permits" ON home_permits FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

GRANT ALL ON home_permits TO service_role;

-- 2) Sealed transfers ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS home_passport_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  recipient_type text NOT NULL
    CHECK (recipient_type IN ('buyer', 'agent', 'inspector', 'insurer', 'lender', 'owner')),
  token_hash text NOT NULL UNIQUE,
  label text CHECK (label IS NULL OR length(label) <= 80),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  issued_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  customer_consent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_hpt_customer ON home_passport_transfers(customer_id, issued_at DESC);

CREATE OR REPLACE FUNCTION public.hpt_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.recipient_type IS DISTINCT FROM OLD.recipient_type
     OR NEW.customer_consent_at IS DISTINCT FROM OLD.customer_consent_at
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Issued home passports are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Home passport is already revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hpt_guard_immutable ON home_passport_transfers;
CREATE TRIGGER trg_hpt_guard_immutable
  BEFORE UPDATE ON home_passport_transfers
  FOR EACH ROW EXECUTE FUNCTION public.hpt_guard_immutable();

ALTER TABLE home_passport_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hpt_select" ON home_passport_transfers;
CREATE POLICY "hpt_select" ON home_passport_transfers FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
-- No INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER RPCs below write.
REVOKE INSERT, UPDATE, DELETE ON home_passport_transfers FROM authenticated, anon;

-- 3) Derived equipment rows (internal) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_passport_equipment_rows(p_owner uuid, p_customer_id uuid)
RETURNS TABLE (
  label text,
  equipment_type text,
  make text,
  model text,
  serial_number text,
  install_date date,
  age_years numeric,
  lifespan_years integer,
  remaining_years numeric,
  status text,
  warranty_expires_at date,
  warranty_status text,
  warranty_notes text,
  last_service_date date,
  service_interval_months integer,
  next_service_due date,
  overdue boolean,
  service_count integer,
  repair_count_24m integer,
  alert_level text,
  alert_due date,
  condition text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT e.*,
      coalesce(nullif(btrim(concat_ws(' ', e.make, e.model)), ''), e.equipment_type) AS lbl
    FROM equipment e
    WHERE e.user_id = p_owner AND e.customer_id = p_customer_id
  ),
  links AS (
    SELECT je.equipment_id,
      count(*) FILTER (WHERE j.job_status = 'completed') AS svc,
      count(*) FILTER (
        WHERE j.job_status = 'completed'
          AND coalesce(j.completed_at, j.scheduled_datetime) >= now() - interval '24 months'
          AND coalesce(nullif(je.service_type, ''), j.service_type, '')
              !~* 'maint|tune|inspect|clean|flush|check|service\s*plan|seasonal|filter|annual|install'
      ) AS rep
    FROM job_equipment je
    JOIN jobs j ON j.id = je.job_id AND j.user_id = p_owner
    WHERE je.equipment_id IN (SELECT id FROM base)
    GROUP BY je.equipment_id
  ),
  alerts AS (
    SELECT a.equipment_id,
      CASE WHEN bool_or(a.risk_level = 'high') THEN 'high'
           WHEN bool_or(a.risk_level = 'medium') THEN 'medium'
           ELSE 'low' END AS lvl,
      min(a.predicted_service_due) AS due
    FROM equipment_maintenance_alerts a
    WHERE a.is_dismissed = false AND a.equipment_id IN (SELECT id FROM base)
    GROUP BY a.equipment_id
  ),
  d AS (
    SELECT
      b.lbl, b.equipment_type, b.make, b.model, b.serial_number, b.install_date, b.status,
      b.warranty_expires_at, b.warranty_notes, b.last_service_date, b.service_interval_months,
      b.expected_lifespan_years AS lifespan,
      CASE WHEN b.install_date IS NOT NULL
           THEN round(greatest(0, (current_date - b.install_date) / 365.25), 1) END AS age,
      CASE WHEN coalesce(b.last_service_date, b.install_date) IS NOT NULL AND b.service_interval_months > 0
           THEN (coalesce(b.last_service_date, b.install_date)
                 + make_interval(months => b.service_interval_months))::date END AS next_due,
      coalesce(l.svc, 0)::integer AS svc,
      coalesce(l.rep, 0)::integer AS rep,
      al.lvl, al.due
    FROM base b
    LEFT JOIN links l ON l.equipment_id = b.id
    LEFT JOIN alerts al ON al.equipment_id = b.id
  )
  SELECT
    d.lbl, d.equipment_type, d.make, d.model, d.serial_number, d.install_date, d.age,
    d.lifespan,
    CASE WHEN d.age IS NOT NULL THEN round(greatest(0, d.lifespan - d.age), 1) END,
    d.status, d.warranty_expires_at,
    CASE WHEN d.warranty_expires_at IS NULL THEN 'unknown'
         WHEN d.warranty_expires_at < current_date THEN 'expired'
         ELSE 'active' END,
    left(d.warranty_notes, 200),
    d.last_service_date, d.service_interval_months, d.next_due,
    (d.status = 'active' AND d.next_due IS NOT NULL AND d.next_due < current_date),
    d.svc, d.rep, d.lvl, d.due,
    CASE
      WHEN d.status <> 'active' THEN 'retired'
      WHEN d.lvl = 'high' OR d.rep >= 3 OR (d.age IS NOT NULL AND d.age >= d.lifespan) THEN 'attention'
      WHEN d.lvl = 'medium'
        OR (d.next_due IS NOT NULL AND d.next_due < current_date)
        OR (d.age IS NOT NULL AND d.lifespan - d.age <= 3) THEN 'watch'
      WHEN d.age IS NULL THEN 'unknown'
      ELSE 'good'
    END
  FROM d
  ORDER BY (d.status = 'active') DESC, d.lbl;
$$;

REVOKE ALL ON FUNCTION public.home_passport_equipment_rows(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 4) Projection sanitiser (internal) ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.home_passport_clean_projections(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  k text;
  v_years jsonb := '[]'::jsonb;
  v_cats jsonb := '[]'::jsonb;
  v_asm jsonb := '[]'::jsonb;
  v_conf text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;

  FOREACH k IN ARRAY ARRAY['annual', 'annualLow', 'annualHigh', 'fiveYear', 'fiveYearLow', 'fiveYearHigh', 'suggestedMonthlyReserve'] LOOP
    IF jsonb_typeof(p -> k) IS DISTINCT FROM 'number' THEN
      RETURN NULL;
    END IF;
    IF (p ->> k)::numeric NOT BETWEEN 0 AND 5000000 THEN
      RETURN NULL;
    END IF;
  END LOOP;

  v_conf := CASE WHEN p ->> 'confidence' IN ('low', 'medium', 'high') THEN p ->> 'confidence' ELSE 'low' END;

  IF jsonb_typeof(p -> 'years') = 'array' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'year', y.n, 'maintenance', y.m, 'expectedFailure', y.f, 'total', y.t) ORDER BY y.n), '[]'::jsonb)
    INTO v_years
    FROM (
      SELECT
        round((e ->> 'year')::numeric)::integer AS n,
        least(5000000, greatest(0, (e ->> 'maintenance')::numeric)) AS m,
        least(5000000, greatest(0, (e ->> 'expectedFailure')::numeric)) AS f,
        least(5000000, greatest(0, (e ->> 'total')::numeric)) AS t
      FROM jsonb_array_elements(p -> 'years') AS e
      WHERE jsonb_typeof(e -> 'maintenance') = 'number'
        AND jsonb_typeof(e -> 'expectedFailure') = 'number'
        AND jsonb_typeof(e -> 'total') = 'number'
        AND CASE WHEN jsonb_typeof(e -> 'year') = 'number'
                 THEN (e ->> 'year')::numeric BETWEEN 1 AND 5 ELSE false END
      LIMIT 5
    ) y;
  END IF;

  IF jsonb_typeof(p -> 'categories') = 'array' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key', c.k, 'label', c.l, 'annual', c.a, 'fiveYear', c.f, 'equipmentCount', c.n)), '[]'::jsonb)
    INTO v_cats
    FROM (
      SELECT
        e ->> 'key' AS k,
        left(coalesce(e ->> 'label', e ->> 'key'), 40) AS l,
        least(5000000, greatest(0, (e ->> 'annual')::numeric)) AS a,
        least(5000000, greatest(0, (e ->> 'fiveYear')::numeric)) AS f,
        least(1000, greatest(0, round((e ->> 'equipmentCount')::numeric)))::integer AS n
      FROM jsonb_array_elements(p -> 'categories') AS e
      WHERE (e ->> 'key') IN ('hvac', 'water_heater', 'plumbing', 'electrical', 'roof', 'safety')
        AND jsonb_typeof(e -> 'annual') = 'number'
        AND jsonb_typeof(e -> 'fiveYear') = 'number'
        AND jsonb_typeof(e -> 'equipmentCount') = 'number'
      LIMIT 6
    ) c;
  END IF;

  IF jsonb_typeof(p -> 'assumptions') = 'array' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(left(a.t, 240))), '[]'::jsonb)
    INTO v_asm
    FROM (
      SELECT e #>> '{}' AS t
      FROM jsonb_array_elements(p -> 'assumptions') AS e
      WHERE jsonb_typeof(e) = 'string'
      LIMIT 8
    ) a;
  END IF;

  RETURN jsonb_build_object(
    'model', 'vireek.home_budget.v1',
    'annual', (p ->> 'annual')::numeric,
    'annualLow', (p ->> 'annualLow')::numeric,
    'annualHigh', (p ->> 'annualHigh')::numeric,
    'fiveYear', (p ->> 'fiveYear')::numeric,
    'fiveYearLow', (p ->> 'fiveYearLow')::numeric,
    'fiveYearHigh', (p ->> 'fiveYearHigh')::numeric,
    'suggestedMonthlyReserve', (p ->> 'suggestedMonthlyReserve')::numeric,
    'confidence', v_conf,
    'years', v_years,
    'categories', v_cats,
    'assumptions', v_asm
  );
END;
$$;

REVOKE ALL ON FUNCTION public.home_passport_clean_projections(jsonb) FROM PUBLIC, anon, authenticated;

-- 5) Canonical payload builder (internal) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.build_home_passport_payload(p_owner uuid, p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust customers%ROWTYPE;
  v_site customer_sites%ROWTYPE;
  v_company text;
  v_equipment jsonb;
  v_history jsonb;
  v_permits jsonb;
  v_problems jsonb;
  v_predicted jsonb;
  v_health jsonb;
  v_summary jsonb;
  v_safety_count integer;
  v_safety_last date;
  v_gap_count integer;
BEGIN
  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id AND user_id = p_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_site FROM customer_sites
  WHERE customer_id = p_customer_id
  ORDER BY is_primary DESC, created_at
  LIMIT 1;

  SELECT p.company_name INTO v_company FROM profiles p WHERE p.id = p_owner;

  -- Equipment (public shape: no internal ids)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'label', r.label, 'equipment_type', r.equipment_type, 'make', r.make, 'model', r.model,
    'serial_number', r.serial_number, 'install_date', r.install_date, 'age_years', r.age_years,
    'lifespan_years', r.lifespan_years, 'remaining_years', r.remaining_years, 'status', r.status,
    'warranty_expires_at', r.warranty_expires_at, 'warranty_status', r.warranty_status,
    'warranty_notes', r.warranty_notes, 'last_service_date', r.last_service_date,
    'service_interval_months', r.service_interval_months, 'next_service_due', r.next_service_due,
    'service_count', r.service_count, 'repair_count_24m', r.repair_count_24m, 'condition', r.condition
  )), '[]'::jsonb)
  INTO v_equipment
  FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r;

  -- Service history (completed jobs; no amounts, no technician, no notes)
  SELECT coalesce(jsonb_agg(h.item ORDER BY h.d DESC), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT
      coalesce(j.completed_at, j.scheduled_datetime)::date AS d,
      jsonb_build_object(
        'date', coalesce(j.completed_at, j.scheduled_datetime)::date,
        'service_type', j.service_type,
        'equipment', (
          SELECT coalesce(jsonb_agg(coalesce(nullif(btrim(concat_ws(' ', e.make, e.model)), ''), e.equipment_type)), '[]'::jsonb)
          FROM job_equipment je JOIN equipment e ON e.id = je.equipment_id
          WHERE je.job_id = j.id
        ),
        'was_rework', coalesce(j.is_rework, false),
        'evidence_verified', j.evidence_verified_at IS NOT NULL
      ) AS item
    FROM jobs j
    WHERE j.user_id = p_owner AND j.customer_id = p_customer_id AND j.job_status = 'completed'
    ORDER BY coalesce(j.completed_at, j.scheduled_datetime) DESC NULLS LAST
    LIMIT 100
  ) h;

  -- Permits
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'permit_type', hp.permit_type, 'permit_number', hp.permit_number, 'jurisdiction', hp.jurisdiction,
    'status', hp.status, 'issued_on', hp.issued_on, 'expires_on', hp.expires_on, 'finalized_on', hp.finalized_on
  ) ORDER BY hp.issued_on DESC NULLS LAST, hp.created_at DESC), '[]'::jsonb)
  INTO v_permits
  FROM home_permits hp
  WHERE hp.user_id = p_owner AND hp.customer_id = p_customer_id;

  -- Known problems
  SELECT count(*)::integer, max(coalesce(j.completed_at, j.scheduled_datetime))::date
  INTO v_safety_count, v_safety_last
  FROM jobs j
  WHERE j.user_id = p_owner AND j.customer_id = p_customer_id AND j.safety_flag = true;

  SELECT count(*)::integer INTO v_gap_count
  FROM jobs j
  JOIN job_compliance_reviews cr ON cr.job_id = j.id
  WHERE j.user_id = p_owner AND j.customer_id = p_customer_id
    AND j.job_status = 'completed'
    AND cr.permit_likelihood = 'likely_required'
    AND NOT EXISTS (SELECT 1 FROM home_permits hp WHERE hp.job_id = j.id);

  SELECT coalesce(jsonb_agg(s.item ORDER BY s.rnk, s.title), '[]'::jsonb)
  INTO v_problems
  FROM (
    SELECT
      CASE a.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 3 ELSE 5 END AS rnk,
      a.predicted_issue AS title,
      jsonb_build_object(
        'kind', 'open_alert', 'severity', a.risk_level,
        'equipment', coalesce(nullif(btrim(concat_ws(' ', e.make, e.model)), ''), e.equipment_type),
        'title', a.predicted_issue, 'detail', a.recommended_action) AS item
    FROM equipment_maintenance_alerts a
    JOIN equipment e ON e.id = a.equipment_id
    WHERE e.user_id = p_owner AND e.customer_id = p_customer_id
      AND a.is_dismissed = false AND e.status = 'active'
    UNION ALL
    SELECT 2, r.label || ' is past its expected service life',
      jsonb_build_object('kind', 'past_expected_life', 'severity', 'high', 'equipment', r.label,
        'title', r.label || ' is past its expected service life',
        'detail', 'Installed ' || coalesce(r.install_date::text, 'unknown') || '; expected life ' || r.lifespan_years || ' years. Budget for replacement.')
    FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r
    WHERE r.status = 'active' AND r.age_years IS NOT NULL AND r.age_years >= r.lifespan_years
    UNION ALL
    SELECT 2, r.label || ' has needed repeated repairs',
      jsonb_build_object('kind', 'recurring_repair', 'severity', 'high', 'equipment', r.label,
        'title', r.label || ' has needed repeated repairs',
        'detail', r.repair_count_24m || ' repair visits in the last 24 months.')
    FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r
    WHERE r.status = 'active' AND r.repair_count_24m >= 3
    UNION ALL
    SELECT 4, r.label || ' is overdue for service',
      jsonb_build_object('kind', 'overdue_service', 'severity', 'medium', 'equipment', r.label,
        'title', r.label || ' is overdue for service',
        'detail', 'Service was due ' || r.next_service_due::text || '.')
    FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r
    WHERE r.overdue
    UNION ALL
    SELECT CASE WHEN v_safety_last >= current_date - 365 THEN 1 ELSE 3 END,
      v_safety_count || ' past service visit(s) recorded a safety concern',
      jsonb_build_object('kind', 'safety_flag',
        'severity', CASE WHEN v_safety_last >= current_date - 365 THEN 'high' ELSE 'medium' END,
        'equipment', NULL,
        'title', v_safety_count || ' past service visit(s) recorded a safety concern',
        'detail', 'Most recent: ' || coalesce(v_safety_last::text, 'unknown') || '. Ask the seller for the technician''s findings.')
    WHERE v_safety_count > 0
    UNION ALL
    SELECT 3, v_gap_count || ' completed job(s) may have required a permit — none on file',
      jsonb_build_object('kind', 'permit_gap', 'severity', 'medium', 'equipment', NULL,
        'title', v_gap_count || ' completed job(s) may have required a permit — none on file',
        'detail', 'Confirm permit status with the local building department before closing.')
    WHERE v_gap_count > 0
  ) s;

  -- Predicted maintenance
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'equipment', r.label, 'next_due', r.next_service_due, 'overdue', r.overdue,
    'predicted_issue_due', r.alert_due
  ) ORDER BY r.next_service_due), '[]'::jsonb)
  INTO v_predicted
  FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r
  WHERE r.status = 'active' AND (r.next_service_due IS NOT NULL OR r.alert_due IS NOT NULL);

  -- Home Health score (reused, never recomputed here)
  SELECT jsonb_build_object('score', hs.score, 'grade', hs.grade, 'confidence', hs.confidence, 'computed_at', hs.computed_at)
  INTO v_health
  FROM home_health_scores hs
  WHERE hs.user_id = p_owner AND hs.customer_id = p_customer_id
    AND hs.computed_at > now() - interval '180 days';

  -- Summary
  SELECT jsonb_build_object(
    'active_equipment', count(*) FILTER (WHERE r.status = 'active'),
    'retired_equipment', count(*) FILTER (WHERE r.status <> 'active'),
    'needs_attention', count(*) FILTER (WHERE r.condition = 'attention'),
    'on_watch', count(*) FILTER (WHERE r.condition = 'watch'),
    'overdue_service', count(*) FILTER (WHERE r.overdue),
    'warranties_active', count(*) FILTER (WHERE r.status = 'active' AND r.warranty_status = 'active'),
    'warranties_expiring_12m', count(*) FILTER (
      WHERE r.status = 'active' AND r.warranty_status = 'active' AND r.warranty_expires_at <= current_date + 365),
    'avg_remaining_years', round(avg(r.remaining_years) FILTER (WHERE r.status = 'active'), 1),
    'record_completeness_pct', coalesce(round(100.0 * count(*) FILTER (
      WHERE r.status = 'active' AND r.install_date IS NOT NULL AND r.last_service_date IS NOT NULL AND r.make IS NOT NULL)
      / nullif(count(*) FILTER (WHERE r.status = 'active'), 0)), 0),
    'service_visits', jsonb_array_length(v_history),
    'first_service_date', (SELECT min((e ->> 'date')::date) FROM jsonb_array_elements(v_history) e),
    'open_problems', jsonb_array_length(v_problems),
    'permits_on_file', jsonb_array_length(v_permits)
  )
  INTO v_summary
  FROM public.home_passport_equipment_rows(p_owner, p_customer_id) r;

  RETURN jsonb_build_object(
    'schema', 'vireek.home_service_passport.v1',
    'generated_at', now(),
    'serviced_by', v_company,
    'property', jsonb_build_object(
      'address', coalesce(nullif(btrim(v_site.address), ''), nullif(btrim(v_cust.address), '')),
      'city', v_site.city, 'state', v_site.state, 'postal_code', v_site.postal_code,
      'property_kind', v_cust.customer_type
    ),
    'summary', v_summary,
    'health', v_health,
    'equipment', v_equipment,
    'service_history', v_history,
    'permits', v_permits,
    'known_problems', v_problems,
    'predicted_maintenance', v_predicted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_home_passport_payload(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 6) Manager live read -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_home_service_passport(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only a manager can view home passports' USING ERRCODE = '42501';
  END IF;
  RETURN public.build_home_passport_payload(public.get_account_owner_id(), p_customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_home_service_passport(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_service_passport(uuid) TO authenticated;

-- 7) Issue sealed transfer -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_home_passport_transfer(
  p_customer_id uuid,
  p_recipient_type text DEFAULT 'buyer',
  p_label text DEFAULT NULL,
  p_valid_days integer DEFAULT 90,
  p_customer_consent boolean DEFAULT false,
  p_projections jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_payload jsonb;
  v_proj jsonb;
  v_snapshot jsonb;
  v_hash text;
  v_token text;
  v_id uuid;
  v_expires timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only a manager can issue a home passport' USING ERRCODE = '42501';
  END IF;
  IF p_customer_consent IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Homeowner consent must be confirmed' USING ERRCODE = '22023';
  END IF;
  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('buyer', 'agent', 'inspector', 'insurer', 'lender', 'owner') THEN
    RAISE EXCEPTION 'Invalid recipient type' USING ERRCODE = '22023';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 365 THEN
    RAISE EXCEPTION 'valid_days must be between 1 and 365' USING ERRCODE = '22023';
  END IF;

  v_owner := public.get_account_owner_id();

  IF (SELECT count(*) FROM home_passport_transfers t
      WHERE t.customer_id = p_customer_id AND t.account_owner_id = v_owner
        AND t.revoked_at IS NULL AND t.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'Too many active passport links — revoke one first' USING ERRCODE = '54000';
  END IF;

  v_payload := public.build_home_passport_payload(v_owner, p_customer_id);
  v_proj := public.home_passport_clean_projections(p_projections);

  v_snapshot := v_payload || jsonb_build_object(
    'recipient_type', p_recipient_type,
    'projections', v_proj,
    'consent_confirmed_at', now()
  );

  v_hash := encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(days => p_valid_days);

  INSERT INTO home_passport_transfers (
    account_owner_id, customer_id, recipient_type, token_hash, label, snapshot, snapshot_hash,
    issued_by, customer_consent_at, expires_at
  ) VALUES (
    v_owner, p_customer_id, p_recipient_type,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    left(nullif(btrim(p_label), ''), 80),
    v_snapshot, v_hash, auth.uid(), now(), v_expires
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('transfer_id', v_id, 'token', v_token, 'expires_at', v_expires, 'snapshot_hash', v_hash);
END;
$$;

REVOKE ALL ON FUNCTION public.issue_home_passport_transfer(uuid, text, text, integer, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_home_passport_transfer(uuid, text, text, integer, boolean, jsonb) TO authenticated;

-- 8) Revoke ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_home_passport_transfer(p_transfer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  UPDATE home_passport_transfers
  SET revoked_at = now()
  WHERE id = p_transfer_id
    AND account_owner_id = public.get_account_owner_id()
    AND revoked_at IS NULL;

  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM home_passport_transfers
    WHERE id = p_transfer_id AND account_owner_id = public.get_account_owner_id()
  ) THEN
    RAISE EXCEPTION 'Passport link not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_home_passport_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_home_passport_transfer(uuid) TO authenticated;

-- 9) Public verification (anon) --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_home_passport(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row home_passport_transfers%ROWTYPE;
  v_status text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_row FROM home_passport_transfers
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF encode(sha256(convert_to(v_row.snapshot::text, 'UTF8')), 'hex') <> v_row.snapshot_hash THEN
    RETURN jsonb_build_object('status', 'tampered');
  END IF;

  v_status := CASE
    WHEN v_row.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v_row.expires_at <= now() THEN 'expired'
    ELSE 'valid'
  END;

  IF v_status = 'valid' THEN
    UPDATE home_passport_transfers
    SET view_count = view_count + 1, last_viewed_at = now()
    WHERE id = v_row.id;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'issued_at', v_row.issued_at,
    'expires_at', v_row.expires_at,
    'recipient_type', v_row.recipient_type,
    'snapshot_hash', v_row.snapshot_hash,
    'snapshot', CASE WHEN v_status = 'valid' THEN v_row.snapshot ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_home_passport(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_home_passport(text) TO anon, authenticated;
