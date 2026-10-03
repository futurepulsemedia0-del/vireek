/*
  # Vireek Real-World Context Engine

  Before a technician is dispatched, build a Context Graph of the real-world situation:
  customer + property + weather + equipment + history + permits + parts + technician.

  ## What this adds
  - property_context_profiles : year built, size, type, heating fuel, utility provider (staff-entered, per customer or site).
  - job_context_snapshots     : append-only history of generated Context Graphs (nodes, edges, flags, readiness score, AI brief).
  - build_job_context_facts() : SECURITY INVOKER read-only RPC that gathers the internal facts. RLS applies to every table
                                it reads, so tenants are isolated by Postgres. It returns NO name/phone/email/address.

  Nothing existing is modified. Requires: jobs, customers, customer_sites, equipment, job_equipment, job_parts_required,
  inventory_stock_levels, technician_scorecards, job_compliance_reviews, weather_surge_events, get_account_owner_id().
*/

-- =============================================================
-- 1. PROPERTY PROFILES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.property_context_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  site_id uuid REFERENCES public.customer_sites(id) ON DELETE CASCADE,
  year_built integer CHECK (year_built IS NULL OR year_built BETWEEN 1700 AND 2100),
  square_feet integer CHECK (square_feet IS NULL OR square_feet BETWEEN 100 AND 5000000),
  property_type text CHECK (property_type IS NULL OR property_type IN
    ('single_family', 'multi_family', 'condo', 'townhouse', 'commercial', 'industrial', 'other')),
  heating_fuel text CHECK (heating_fuel IS NULL OR heating_fuel IN
    ('gas', 'electric', 'oil', 'propane', 'heat_pump', 'other', 'unknown')),
  utility_provider text CHECK (utility_provider IS NULL OR char_length(btrim(utility_provider)) BETWEEN 1 AND 120),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_property_context_customer_site
  ON public.property_context_profiles (customer_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_property_context_user ON public.property_context_profiles (user_id);

CREATE OR REPLACE FUNCTION public.property_context_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_context_touch ON public.property_context_profiles;
CREATE TRIGGER trg_property_context_touch
  BEFORE UPDATE ON public.property_context_profiles
  FOR EACH ROW EXECUTE FUNCTION public.property_context_touch();

ALTER TABLE public.property_context_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "property_context_select" ON public.property_context_profiles;
CREATE POLICY "property_context_select" ON public.property_context_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "property_context_insert" ON public.property_context_profiles;
CREATE POLICY "property_context_insert" ON public.property_context_profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.customers c WHERE c.id = property_context_profiles.customer_id AND c.user_id = public.get_account_owner_id())
  );

DROP POLICY IF EXISTS "property_context_update" ON public.property_context_profiles;
CREATE POLICY "property_context_update" ON public.property_context_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "property_context_delete" ON public.property_context_profiles;
CREATE POLICY "property_context_delete" ON public.property_context_profiles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

GRANT ALL ON public.property_context_profiles TO service_role;

-- =============================================================
-- 2. CONTEXT SNAPSHOTS (append-only history)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_context_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  readiness_score integer NOT NULL CHECK (readiness_score BETWEEN 0 AND 100),
  coverage_pct integer NOT NULL DEFAULT 0 CHECK (coverage_pct BETWEEN 0 AND 100),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  nodes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(nodes) = 'array'),
  edges jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(edges) = 'array'),
  flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(flags) = 'array'),
  sources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sources) = 'object'),
  brief jsonb CHECK (brief IS NULL OR jsonb_typeof(brief) = 'object'),
  ai_status text NOT NULL DEFAULT 'skipped' CHECK (ai_status IN ('ok', 'unavailable', 'skipped')),
  input_hash text,
  generated_by uuid DEFAULT auth.uid(),
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_context_job ON public.job_context_snapshots (job_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_context_user ON public.job_context_snapshots (user_id, generated_at DESC);

COMMENT ON TABLE public.job_context_snapshots IS
  'Vireek Real-World Context Engine: append-only Context Graph snapshots generated before dispatch.';

ALTER TABLE public.job_context_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "job_context_select" ON public.job_context_snapshots;
CREATE POLICY "job_context_select" ON public.job_context_snapshots FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_context_snapshots.job_id)
  );

DROP POLICY IF EXISTS "job_context_insert" ON public.job_context_snapshots;
CREATE POLICY "job_context_insert" ON public.job_context_snapshots FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_context_snapshots.job_id)
  );

GRANT ALL ON public.job_context_snapshots TO service_role;

-- =============================================================
-- 3. FACTS RPC (read-only, SECURITY INVOKER: RLS applies to every table)
-- =============================================================

CREATE OR REPLACE FUNCTION public.build_job_context_facts(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  j public.jobs%ROWTYPE;
  v_customer jsonb;
  v_property jsonb;
  v_equipment jsonb := '[]'::jsonb;
  v_equipment_source text := 'none';
  v_patterns jsonb := '[]'::jsonb;
  v_history jsonb;
  v_parts jsonb;
  v_tech jsonb;
  v_permit jsonb;
  v_alerts jsonb;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT_JOB_NOT_FOUND: unknown job' USING ERRCODE = 'P0001';
  END IF;

  -- Customer (no name / phone / email / address ever leaves this function)
  SELECT jsonb_build_object(
           'lifecycle_stage', c.lifecycle_stage,
           'customer_type', c.customer_type,
           'tags', to_jsonb(c.tags),
           'customer_since', c.created_at)
    INTO v_customer
    FROM public.customers c
   WHERE c.id = j.customer_id;

  -- Property profile (site-specific wins over customer-level)
  SELECT jsonb_build_object(
           'year_built', p.year_built,
           'square_feet', p.square_feet,
           'property_type', p.property_type,
           'heating_fuel', p.heating_fuel,
           'utility_provider', p.utility_provider)
    INTO v_property
    FROM public.property_context_profiles p
   WHERE p.customer_id = j.customer_id
     AND (p.site_id IS NULL OR p.site_id = j.site_id)
   ORDER BY (p.site_id IS NOT NULL) DESC
   LIMIT 1;

  -- Equipment linked to this job
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'type', e.equipment_type,
           'make', e.make,
           'model', e.model,
           'status', e.status,
           'age_years', CASE WHEN e.install_date IS NULL THEN NULL
                             ELSE round(((current_date - e.install_date) / 365.25)::numeric, 1) END,
           'expected_lifespan_years', e.expected_lifespan_years,
           'warranty_active', (e.warranty_expires_at IS NOT NULL AND e.warranty_expires_at >= current_date),
           'months_since_service', CASE WHEN e.last_service_date IS NULL THEN NULL
                                        ELSE round(((current_date - e.last_service_date) / 30.4)::numeric, 1) END,
           'service_interval_months', e.service_interval_months)), '[]'::jsonb)
    INTO v_equipment
    FROM public.job_equipment je
    JOIN public.equipment e ON e.id = je.equipment_id
   WHERE je.job_id = j.id;

  IF jsonb_array_length(v_equipment) > 0 THEN
    v_equipment_source := 'job';
  ELSIF j.customer_id IS NOT NULL THEN
    -- Fallback: the customer's active equipment on file
    SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_equipment FROM (
      SELECT jsonb_build_object(
               'type', e.equipment_type,
               'make', e.make,
               'model', e.model,
               'status', e.status,
               'age_years', CASE WHEN e.install_date IS NULL THEN NULL
                                 ELSE round(((current_date - e.install_date) / 365.25)::numeric, 1) END,
               'expected_lifespan_years', e.expected_lifespan_years,
               'warranty_active', (e.warranty_expires_at IS NOT NULL AND e.warranty_expires_at >= current_date),
               'months_since_service', CASE WHEN e.last_service_date IS NULL THEN NULL
                                            ELSE round(((current_date - e.last_service_date) / 30.4)::numeric, 1) END,
               'service_interval_months', e.service_interval_months) AS x
        FROM public.equipment e
       WHERE e.customer_id = j.customer_id AND e.status = 'active'
       ORDER BY e.created_at DESC
       LIMIT 5
    ) q;
    IF jsonb_array_length(v_equipment) > 0 THEN v_equipment_source := 'customer'; END IF;
  END IF;

  -- Failure patterns for the same make/model inside this business's own history (last 12 months)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'make', t.make, 'model', t.model, 'sample_jobs', s.n, 'rework_jobs', s.r)), '[]'::jsonb)
    INTO v_patterns
    FROM (
      SELECT DISTINCT e.make, e.model
        FROM public.job_equipment je
        JOIN public.equipment e ON e.id = je.equipment_id
       WHERE je.job_id = j.id AND e.make IS NOT NULL AND e.model IS NOT NULL
    ) t
    CROSS JOIN LATERAL (
      SELECT count(DISTINCT jb.id)::int AS n,
             (count(DISTINCT jb.id) FILTER (WHERE jb.is_rework IS TRUE))::int AS r
        FROM public.equipment e2
        JOIN public.job_equipment je2 ON je2.equipment_id = e2.id
        JOIN public.jobs jb ON jb.id = je2.job_id
       WHERE e2.user_id = v_owner
         AND lower(e2.make) = lower(t.make)
         AND lower(e2.model) = lower(t.model)
         AND jb.id <> j.id
         AND jb.created_at > now() - interval '12 months'
    ) s;

  -- Previous work for this customer
  SELECT jsonb_build_object(
           'jobs_24m', count(*) FILTER (WHERE jb.created_at > now() - interval '24 months'),
           'completed_24m', count(*) FILTER (WHERE jb.job_status = 'completed' AND jb.created_at > now() - interval '24 months'),
           'rework_24m', count(*) FILTER (WHERE jb.is_rework IS TRUE AND jb.created_at > now() - interval '24 months'),
           'disputed_24m', count(*) FILTER (WHERE jb.customer_disputed IS TRUE AND jb.created_at > now() - interval '24 months'),
           'same_service_90d', count(*) FILTER (
              WHERE jb.job_status = 'completed'
                AND j.service_type IS NOT NULL
                AND jb.service_type = j.service_type
                AND coalesce(jb.completed_at, jb.created_at) > now() - interval '90 days'),
           'last_completed_at', max(jb.completed_at))
    INTO v_history
    FROM public.jobs jb
   WHERE j.customer_id IS NOT NULL AND jb.customer_id = j.customer_id AND jb.id <> j.id;

  -- Parts availability
  SELECT jsonb_build_object(
           'required', count(*),
           'backordered', count(*) FILTER (WHERE r.status = 'backordered'),
           'short', count(*) FILTER (
              WHERE r.status IN ('needed', 'backordered') AND coalesce(st.available, 0) < r.quantity_required))
    INTO v_parts
    FROM public.job_parts_required r
    LEFT JOIN LATERAL (
      SELECT sum(s.quantity_on_hand - s.quantity_reserved) AS available
        FROM public.inventory_stock_levels s
       WHERE s.part_id = r.part_id
    ) st ON true
   WHERE r.job_id = j.id;

  -- Technician history
  IF j.assigned_technician_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'assigned', true,
             'first_time_fix_rate', sc.first_time_fix_rate,
             'callback_rate', sc.callback_rate,
             'csat_avg', sc.csat_avg,
             'same_service_completed', (
                SELECT count(*)::int FROM public.jobs jb
                 WHERE jb.assigned_technician_id = j.assigned_technician_id
                   AND jb.job_status = 'completed'
                   AND j.service_type IS NOT NULL AND jb.service_type = j.service_type),
             'prior_visits_to_customer', (
                SELECT count(*)::int FROM public.jobs jb
                 WHERE jb.assigned_technician_id = j.assigned_technician_id
                   AND jb.job_status = 'completed'
                   AND j.customer_id IS NOT NULL AND jb.customer_id = j.customer_id AND jb.id <> j.id))
      INTO v_tech
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT s.first_time_fix_rate, s.callback_rate, s.csat_avg
          FROM public.technician_scorecards s
         WHERE s.technician_id = j.assigned_technician_id
         ORDER BY s.period_end DESC
         LIMIT 1
      ) sc ON true;
  ELSE
    v_tech := jsonb_build_object('assigned', false);
  END IF;

  -- Permit signal (from the AI Permit Compliance review, if one was generated)
  SELECT jsonb_build_object('permit_likelihood', r.permit_likelihood, 'reviewed_at', r.generated_at)
    INTO v_permit
    FROM public.job_compliance_reviews r
   WHERE r.job_id = j.id;

  -- Active weather alerts already tracked by Weather Surge Intelligence
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event', a.event_type, 'severity', a.severity, 'headline', a.headline, 'expires_at', a.expires_at)), '[]'::jsonb)
    INTO v_alerts
    FROM (
      SELECT w.event_type, w.severity, w.headline, w.expires_at
        FROM public.weather_surge_events w
       WHERE w.resolved_at IS NULL
         AND (w.expires_at IS NULL OR w.expires_at > now())
         AND (w.effective_at IS NULL OR w.effective_at <= now() + interval '48 hours')
       ORDER BY w.effective_at DESC NULLS LAST
       LIMIT 5
    ) a;

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', j.id,
      'service_type', j.service_type,
      'status', j.job_status,
      'scheduled_datetime', j.scheduled_datetime,
      'is_rework', coalesce(j.is_rework, false)),
    'location', jsonb_build_object(
      'latitude', j.latitude,
      'longitude', j.longitude,
      'has_coordinates', (j.latitude IS NOT NULL AND j.longitude IS NOT NULL)),
    'customer', v_customer,
    'property', v_property,
    'equipment', v_equipment,
    'equipment_source', v_equipment_source,
    'model_patterns', v_patterns,
    'history', coalesce(v_history, '{}'::jsonb),
    'parts', coalesce(v_parts, jsonb_build_object('required', 0, 'backordered', 0, 'short', 0)),
    'technician', v_tech,
    'permit', v_permit,
    'weather_alerts', v_alerts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_job_context_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_job_context_facts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.build_job_context_facts(uuid) TO service_role;
