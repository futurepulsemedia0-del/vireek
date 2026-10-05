/*
  # VIREEK OEM Intelligence Graph

  Connects the pieces of the OEM world into ONE traversable chain per physical unit:

    Serial # -> OEM -> Model -> Known Issue -> Service Bulletin -> Required Part -> Warranty -> Claim

  and, as the network grows, answers:
    "This model fails more often in Vireek data than the benchmark for its equipment type."

  Builds ON TOP of (and never modifies) the existing layers:
    - oem_manufacturers / oem_equipment_models / oem_parts / oem_recalls /
      oem_service_bulletins / oem_failure_patterns / equipment_oem_link   (20261215000000)
    - failure_atlas_consent, atlas_* helpers, failure_atlas_cells         (20270301000000)
    - equipment, job_equipment, job_outcomes, warranty_claims

  ## New reference layer (shared, read-only for clients, written via import_oem_graph / SQL)
  - oem_known_issues      issue -> optional bulletin / recall, repair, labor time, manufacture-date range
  - oem_issue_parts       issue -> required part(s) from oem_parts
  - oem_warranty_terms    per model / equipment type / manufacturer, per component
  - oem_documents         manuals, wiring diagrams, spec sheets (https links only)
  - oem_serial_rules      per-manufacturer serial -> manufacture date decoding (regex, admin-curated)

  ## Network benchmark (the data asset)
  - oem_model_reliability  per equipment type + make + model family: failure rate vs the rest of the network
  - oem_graph_stats        one-row headline stats
  - refresh_oem_model_reliability()  nightly rebuild, service_role / pg_cron only

  Privacy = the SAME model as the Failure Atlas: opt-in (failure_atlas_consent), k >= 5 businesses,
  >= 20 units, dominance caps, bucketed counts, deterministic jitter, no tenant/customer/job ids.
  Failure definition is identical to refresh_failure_atlas(): a unit "failed" if it has >= 1 job_outcome
  with a structured root cause on a job that touched exactly ONE unit, inside the window.
  KEEP THE TWO DEFINITIONS IN SYNC if you ever change one.

  ## Client API (SECURITY INVOKER, RLS applies, account-owner scoped)
  - get_oem_graph_for_equipment(equipment_id)   full chain for one unit
  - get_oem_graph_fleet()                        compact rows for every active unit

  Honest by design: nothing is invented. No serial rules and no issues are seeded; the chain shows
  exactly which links have data and which are still empty.
*/

-- =============================================================
-- 1. REFERENCE LAYER
-- =============================================================

CREATE TABLE IF NOT EXISTS public.oem_known_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES public.oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.oem_equipment_models(id) ON DELETE CASCADE,   -- NULL = every model of that equipment_type
  equipment_type text,
  issue_key text NOT NULL CHECK (issue_key ~ '^[a-z0-9_]{1,48}$'),             -- use the same keys as job_outcomes.root_cause_key to link network observations
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 200),
  symptom text CHECK (symptom IS NULL OR char_length(symptom) <= 1000),
  root_cause text CHECK (root_cause IS NULL OR char_length(root_cause) <= 1000),
  recommended_repair text CHECK (recommended_repair IS NULL OR char_length(recommended_repair) <= 2000),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  labor_minutes_min integer CHECK (labor_minutes_min IS NULL OR labor_minutes_min BETWEEN 0 AND 4800),
  labor_minutes_max integer CHECK (labor_minutes_max IS NULL OR labor_minutes_max BETWEEN 0 AND 4800),
  manufactured_from date,
  manufactured_to date,
  bulletin_id uuid REFERENCES public.oem_service_bulletins(id) ON DELETE SET NULL,
  recall_id uuid REFERENCES public.oem_recalls(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('oem_bulletin', 'manufacturer', 'vireek_network', 'manual')),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oem_known_issues_scope CHECK (model_id IS NOT NULL OR equipment_type IS NOT NULL),
  CONSTRAINT oem_known_issues_labor_order CHECK (labor_minutes_min IS NULL OR labor_minutes_max IS NULL OR labor_minutes_max >= labor_minutes_min),
  CONSTRAINT oem_known_issues_mfg_order CHECK (manufactured_from IS NULL OR manufactured_to IS NULL OR manufactured_to >= manufactured_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oem_known_issues_scope
  ON public.oem_known_issues (
    manufacturer_id,
    (coalesce(model_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(lower(equipment_type), '')),
    issue_key
  );
CREATE INDEX IF NOT EXISTS idx_oem_known_issues_model ON public.oem_known_issues (model_id);
CREATE INDEX IF NOT EXISTS idx_oem_known_issues_mfr_type ON public.oem_known_issues (manufacturer_id, lower(equipment_type)) WHERE model_id IS NULL;

DROP TRIGGER IF EXISTS trg_oem_known_issues_updated_at ON public.oem_known_issues;
CREATE TRIGGER trg_oem_known_issues_updated_at
  BEFORE UPDATE ON public.oem_known_issues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.oem_issue_parts (
  issue_id uuid NOT NULL REFERENCES public.oem_known_issues(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES public.oem_parts(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  is_required boolean NOT NULL DEFAULT true,
  PRIMARY KEY (issue_id, part_id)
);

CREATE TABLE IF NOT EXISTS public.oem_warranty_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES public.oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.oem_equipment_models(id) ON DELETE CASCADE,
  equipment_type text,
  component text NOT NULL CHECK (component IN ('parts', 'labor', 'compressor', 'heat_exchanger', 'other')),
  months integer NOT NULL CHECK (months BETWEEN 0 AND 600),                      -- coverage with NO action by the owner
  registered_months integer CHECK (registered_months IS NULL OR registered_months BETWEEN 1 AND 600),  -- longer coverage ONLY if registered
  registration_window_days integer CHECK (registration_window_days IS NULL OR registration_window_days BETWEEN 1 AND 3650),
  transferable boolean,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oem_warranty_registered_longer CHECK (registered_months IS NULL OR registered_months > months)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oem_warranty_terms_scope
  ON public.oem_warranty_terms (
    manufacturer_id,
    (coalesce(model_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(lower(equipment_type), '')),
    component
  );

CREATE TABLE IF NOT EXISTS public.oem_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES public.oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.oem_equipment_models(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('manual', 'install_guide', 'wiring_diagram', 'spec_sheet', 'service_bulletin', 'parts_list', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 200),
  url text NOT NULL CHECK (url ~* '^https://'),
  language text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, url)
);
CREATE INDEX IF NOT EXISTS idx_oem_documents_model ON public.oem_documents (model_id);

CREATE TABLE IF NOT EXISTS public.oem_serial_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES public.oem_manufacturers(id) ON DELETE CASCADE,
  equipment_type text,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 80),
  pattern text NOT NULL CHECK (char_length(pattern) BETWEEN 3 AND 300),         -- POSIX regex over the UPPERCASE alphanumeric serial
  year_group integer NOT NULL CHECK (year_group BETWEEN 1 AND 9),
  year_format text NOT NULL CHECK (year_format IN ('yy', 'yyyy', 'y')),
  decade_base integer CHECK (decade_base IS NULL OR (decade_base BETWEEN 1980 AND 2090 AND decade_base % 10 = 0)),
  period_group integer CHECK (period_group IS NULL OR period_group BETWEEN 1 AND 9),
  period_kind text NOT NULL DEFAULT 'none' CHECK (period_kind IN ('none', 'week', 'month')),
  verified boolean NOT NULL DEFAULT false,
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, label),
  CONSTRAINT oem_serial_rules_y_needs_decade CHECK (year_format <> 'y' OR decade_base IS NOT NULL),
  CONSTRAINT oem_serial_rules_period CHECK (period_kind = 'none' OR period_group IS NOT NULL)
);

-- Published network benchmark (shared, aggregate only).
CREATE TABLE IF NOT EXISTS public.oem_model_reliability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_type text NOT NULL,
  make_key text NOT NULL,
  model_family text NOT NULL,                           -- '*' = brand-wide fallback
  units_observed integer NOT NULL,                      -- bucketed
  units_failed integer NOT NULL,                        -- bucketed
  contributor_count integer NOT NULL,
  failure_rate_pct numeric(5,2) NOT NULL,               -- jittered, see header
  benchmark_rate_pct numeric(5,2) NOT NULL,             -- rest of the network, same equipment type
  lift numeric(6,2),
  signal text NOT NULL CHECK (signal IN ('above_benchmark', 'in_line', 'below_benchmark')),
  median_age_months integer,
  top_failure_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_months integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (equipment_type, make_key, model_family)
);

CREATE TABLE IF NOT EXISTS public.oem_graph_stats (
  id integer PRIMARY KEY CHECK (id = 1),
  contributing_businesses integer NOT NULL DEFAULT 0,
  units_observed integer NOT NULL DEFAULT 0,
  models_published integer NOT NULL DEFAULT 0,
  window_months integer NOT NULL DEFAULT 36,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 2. RLS / PRIVILEGES (read-only for clients; writes = service role / SQL editor only)
-- =============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oem_known_issues', 'oem_issue_parts', 'oem_warranty_terms', 'oem_documents',
                           'oem_serial_rules', 'oem_model_reliability', 'oem_graph_stats'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "read_%s" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "read_%s" ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END;
$$;

-- =============================================================
-- 3. PURE-ish HELPERS
-- =============================================================

-- Serial -> manufacture date. Returns NULL unless a curated rule matches. Never guesses.
CREATE OR REPLACE FUNCTION public.oem_decode_serial(p_manufacturer uuid, p_equipment_type text, p_serial text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r record;
  m text[];
  v_ser text := upper(regexp_replace(coalesce(p_serial, ''), '[^0-9A-Za-z]', '', 'g'));
  v_year integer;
  v_period integer;
  v_yy integer;
  v_date date;
  v_prec text;
BEGIN
  IF p_manufacturer IS NULL OR length(v_ser) < 4 THEN RETURN NULL; END IF;

  FOR r IN
    SELECT * FROM public.oem_serial_rules
    WHERE manufacturer_id = p_manufacturer
      AND (equipment_type IS NULL OR lower(equipment_type) = lower(btrim(coalesce(p_equipment_type, ''))))
    ORDER BY (equipment_type IS NULL), verified DESC, label
  LOOP
    BEGIN
      m := regexp_match(v_ser, r.pattern);
      IF m IS NULL THEN CONTINUE; END IF;

      IF r.year_format = 'yyyy' THEN
        v_year := m[r.year_group]::integer;
      ELSIF r.year_format = 'yy' THEN
        v_yy := m[r.year_group]::integer;
        v_year := CASE WHEN v_yy >= 80 THEN 1900 + v_yy ELSE 2000 + v_yy END;
      ELSE
        v_year := r.decade_base + m[r.year_group]::integer;
      END IF;

      IF v_year IS NULL OR v_year < 1980 OR v_year > extract(year FROM now())::integer + 1 THEN CONTINUE; END IF;

      IF r.period_kind = 'week' THEN
        v_period := m[r.period_group]::integer;
        IF v_period IS NULL OR v_period < 1 OR v_period > 53 THEN CONTINUE; END IF;
        v_date := make_date(v_year, 1, 1) + ((v_period - 1) * 7);
        v_prec := 'week';
      ELSIF r.period_kind = 'month' THEN
        v_period := m[r.period_group]::integer;
        IF v_period IS NULL OR v_period < 1 OR v_period > 12 THEN CONTINUE; END IF;
        v_date := make_date(v_year, v_period, 1);
        v_prec := 'month';
      ELSE
        v_date := make_date(v_year, 1, 1);
        v_prec := 'year';
      END IF;

      RETURN jsonb_build_object('date', v_date, 'precision', v_prec, 'rule', r.label, 'verified', r.verified);
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;   -- invalid regex / bad cast in one curated rule must never break the read
    END;
  END LOOP;

  RETURN NULL;
END;
$$;

-- 'applies' | 'possible' | 'outside' for an issue's manufacture-date range vs a decoded serial.
CREATE OR REPLACE FUNCTION public.oem_issue_applicability(p_from date, p_to date, p_decoded jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_start date;
  v_end date;
  v_prec text;
BEGIN
  IF p_from IS NULL AND p_to IS NULL THEN RETURN 'applies'; END IF;
  IF p_decoded IS NULL OR p_decoded->>'date' IS NULL THEN RETURN 'possible'; END IF;

  v_start := (p_decoded->>'date')::date;
  v_prec := p_decoded->>'precision';
  v_end := CASE v_prec
    WHEN 'year' THEN (v_start + interval '1 year' - interval '1 day')::date
    WHEN 'month' THEN (v_start + interval '1 month' - interval '1 day')::date
    ELSE v_start + 6
  END;

  IF (p_from IS NULL OR v_start >= p_from) AND (p_to IS NULL OR v_end <= p_to) THEN RETURN 'applies'; END IF;
  IF (p_from IS NOT NULL AND v_end < p_from) OR (p_to IS NOT NULL AND v_start > p_to) THEN RETURN 'outside'; END IF;
  RETURN 'possible';
END;
$$;

-- Equipment row -> OEM manufacturer/model. Order: existing enrichment link, exact model, unique family, manufacturer only.
CREATE OR REPLACE FUNCTION public.oem_match_equipment(p_equipment_id uuid, p_make text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_make text := public.atlas_norm(p_make);
  v_model text := public.atlas_norm(p_model);
  v_mfr uuid;
  v_mid uuid;
  v_n integer;
  v_link record;
BEGIN
  IF p_equipment_id IS NOT NULL AND to_regclass('public.equipment_oem_link') IS NOT NULL THEN
    SELECT l.model_id, l.match_confidence INTO v_link
    FROM public.equipment_oem_link l
    WHERE l.equipment_id = p_equipment_id AND l.enrichment_status = 'matched' AND l.model_id IS NOT NULL;
    IF FOUND THEN
      SELECT manufacturer_id INTO v_mfr FROM public.oem_equipment_models WHERE id = v_link.model_id;
      IF v_mfr IS NOT NULL THEN
        RETURN jsonb_build_object('method', 'linked', 'confidence', coalesce(v_link.match_confidence, 1),
                                  'manufacturer_id', v_mfr, 'model_id', v_link.model_id);
      END IF;
    END IF;
  END IF;

  IF v_make IS NULL THEN RETURN jsonb_build_object('method', 'none', 'confidence', 0); END IF;

  SELECT m.id INTO v_mfr
  FROM public.oem_manufacturers m
  WHERE length(public.atlas_norm(m.name)) >= 3
    AND (public.atlas_norm(m.slug) = v_make OR public.atlas_norm(m.name) = v_make
         OR v_make LIKE public.atlas_norm(m.name) || '%')
  ORDER BY (public.atlas_norm(m.name) = v_make) DESC, length(m.name) DESC
  LIMIT 1;

  IF v_mfr IS NULL THEN RETURN jsonb_build_object('method', 'none', 'confidence', 0); END IF;

  IF v_model IS NOT NULL THEN
    SELECT id INTO v_mid FROM public.oem_equipment_models
    WHERE manufacturer_id = v_mfr AND public.atlas_norm(model_number) = v_model
    ORDER BY created_at LIMIT 1;
    IF v_mid IS NOT NULL THEN
      RETURN jsonb_build_object('method', 'exact', 'confidence', 1, 'manufacturer_id', v_mfr, 'model_id', v_mid);
    END IF;

    SELECT count(*), min(id::text)::uuid INTO v_n, v_mid FROM public.oem_equipment_models
    WHERE manufacturer_id = v_mfr AND public.atlas_model_family(model_number) = public.atlas_model_family(p_model);
    IF v_n = 1 THEN
      RETURN jsonb_build_object('method', 'family', 'confidence', 0.6, 'manufacturer_id', v_mfr, 'model_id', v_mid);
    END IF;
  END IF;

  RETURN jsonb_build_object('method', 'manufacturer', 'confidence', 0.4, 'manufacturer_id', v_mfr);
END;
$$;

-- Published benchmark for a unit: model-family cell, else brand-wide cell, else NULL.
CREATE OR REPLACE FUNCTION public.oem_reliability_for(p_type text, p_make text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r public.oem_model_reliability;
  v_type text := lower(btrim(coalesce(p_type, '')));
  v_make text := public.atlas_norm(p_make);
  v_fam text := public.atlas_model_family(p_model);
BEGIN
  IF v_make IS NULL OR v_type = '' THEN RETURN NULL; END IF;

  SELECT * INTO r FROM public.oem_model_reliability
  WHERE equipment_type = v_type AND make_key = v_make AND model_family = v_fam;
  IF NOT FOUND THEN
    SELECT * INTO r FROM public.oem_model_reliability
    WHERE equipment_type = v_type AND make_key = v_make AND model_family = '*';
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'scope', CASE WHEN r.model_family = '*' THEN 'brand' ELSE 'family' END,
    'model_family', r.model_family,
    'units_observed', r.units_observed,
    'units_failed', r.units_failed,
    'contributor_count', r.contributor_count,
    'failure_rate_pct', r.failure_rate_pct,
    'benchmark_rate_pct', r.benchmark_rate_pct,
    'lift', r.lift,
    'signal', r.signal,
    'median_age_months', r.median_age_months,
    'top_failure_modes', r.top_failure_modes,
    'window_months', r.window_months,
    'computed_at', r.computed_at
  );
END;
$$;

-- =============================================================
-- 4. NETWORK BENCHMARK REFRESH (service_role / pg_cron)
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_oem_model_reliability(p_window_months integer DEFAULT 36)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k_tenants      CONSTANT integer := 5;
  k_units        CONSTANT integer := 20;
  k_rest_units   CONSTANT integer := 50;
  k_rest_tenants CONSTANT integer := 5;
  k_age          CONSTANT integer := 10;
  max_fail_share CONSTANT numeric := 0.40;
  max_unit_share CONSTANT numeric := 0.50;
  jitter_amp     CONSTANT numeric := 0.35;
  z              CONSTANT numeric := 1.96;
  v_window integer := GREATEST(6, LEAST(COALESCE(p_window_months, 36), 120));
  v_week text := to_char(now(), 'IYYY-IW');
  v_rows integer := 0;
BEGIN
  IF to_regclass('public.failure_atlas_consent') IS NULL THEN
    RAISE EXCEPTION 'OEM_GRAPH_REQUIRES_ATLAS: apply 20270301000000_global_failure_atlas.sql first' USING ERRCODE = 'P0001';
  END IF;

  DROP TABLE IF EXISTS tmp_oemr_units, tmp_oemr_scope, tmp_oemr_cells;

  CREATE TEMP TABLE tmp_oemr_units (
    equipment_id uuid PRIMARY KEY, user_id uuid, equipment_type text, make_key text,
    model_family text, install_date date, failed boolean NOT NULL DEFAULT false, first_failure_age numeric
  ) ON COMMIT DROP;

  INSERT INTO tmp_oemr_units (equipment_id, user_id, equipment_type, make_key, model_family, install_date)
  SELECT e.id, e.user_id, lower(btrim(e.equipment_type)), public.atlas_norm(e.make),
         public.atlas_model_family(e.model), e.install_date
  FROM equipment e
  JOIN failure_atlas_consent c ON c.user_id = e.user_id AND c.contribute
  WHERE public.atlas_norm(e.make) IS NOT NULL
    AND btrim(coalesce(e.equipment_type, '')) <> '';

  CREATE INDEX ON tmp_oemr_units (equipment_type);

  -- Same failure definition as refresh_failure_atlas(): structured root cause, job touched exactly ONE unit.
  WITH ev AS (
    SELECT je.equipment_id, jo.recorded_at
    FROM job_outcomes jo
    JOIN (
      SELECT job_id, min(equipment_id::text)::uuid AS equipment_id
      FROM job_equipment GROUP BY job_id HAVING count(*) = 1
    ) je ON je.job_id = jo.job_id
    JOIN tmp_oemr_units u ON u.equipment_id = je.equipment_id AND u.user_id = jo.user_id
    WHERE jo.root_cause_key IS NOT NULL
      AND btrim(jo.root_cause_key) <> ''
      AND lower(btrim(jo.root_cause_key)) NOT IN ('other', 'unknown', 'none', 'not_diagnosed')
      AND jo.recorded_at >= now() - make_interval(months => v_window)
  ), first_ev AS (
    SELECT equipment_id, min(recorded_at) AS first_at FROM ev GROUP BY equipment_id
  )
  UPDATE tmp_oemr_units u
  SET failed = true,
      first_failure_age = CASE
        WHEN u.install_date IS NOT NULL AND f.first_at::date >= u.install_date
        THEN (f.first_at::date - u.install_date) / 30.4375 END
  FROM first_ev f
  WHERE f.equipment_id = u.equipment_id;

  -- Every unit counts at its model-family level AND brand-wide.
  CREATE TEMP TABLE tmp_oemr_scope (
    equipment_id uuid, user_id uuid, equipment_type text, make_key text,
    scope_family text, failed boolean, first_failure_age numeric
  ) ON COMMIT DROP;

  INSERT INTO tmp_oemr_scope
  SELECT equipment_id, user_id, equipment_type, make_key, model_family, failed, first_failure_age
  FROM tmp_oemr_units WHERE model_family IS NOT NULL
  UNION ALL
  SELECT equipment_id, user_id, equipment_type, make_key, '*', failed, first_failure_age
  FROM tmp_oemr_units;

  CREATE INDEX ON tmp_oemr_scope (equipment_type, make_key, scope_family);

  -- Candidate cells that clear k-anonymity + dominance caps.
  CREATE TEMP TABLE tmp_oemr_cells (
    equipment_type text, make_key text, scope_family text,
    units integer, failed_units integer, tenants integer, median_age numeric, age_n integer
  ) ON COMMIT DROP;

  INSERT INTO tmp_oemr_cells
  WITH per_tenant AS (
    SELECT equipment_type, make_key, scope_family, user_id,
           count(*) AS units, count(*) FILTER (WHERE failed) AS failed_units
    FROM tmp_oemr_scope
    GROUP BY equipment_type, make_key, scope_family, user_id
  ), agg AS (
    SELECT equipment_type, make_key, scope_family,
           sum(units)::integer AS units, sum(failed_units)::integer AS failed_units, count(*)::integer AS tenants
    FROM per_tenant
    GROUP BY equipment_type, make_key, scope_family
    HAVING count(*) >= k_tenants
       AND sum(units) >= k_units
       AND max(units)::numeric / sum(units) <= max_unit_share
       AND (sum(failed_units) = 0 OR max(failed_units)::numeric / sum(failed_units) <= max_fail_share)
  )
  SELECT a.equipment_type, a.make_key, a.scope_family, a.units, a.failed_units, a.tenants,
         ages.median_age, ages.age_n
  FROM agg a
  LEFT JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.first_failure_age) AS median_age,
           count(s.first_failure_age)::integer AS age_n
    FROM tmp_oemr_scope s
    WHERE s.equipment_type = a.equipment_type AND s.make_key = a.make_key
      AND s.scope_family = a.scope_family AND s.failed AND s.first_failure_age IS NOT NULL
  ) ages ON true;

  -- Full rebuild: withdrawn consent leaves the benchmark at the next run.
  DELETE FROM oem_model_reliability;

  INSERT INTO oem_model_reliability
    (equipment_type, make_key, model_family, units_observed, units_failed, contributor_count,
     failure_rate_pct, benchmark_rate_pct, lift, signal, median_age_months, window_months)
  WITH base AS (
    SELECT c.*, r.units AS rest_units, r.failed AS rest_failed
    FROM tmp_oemr_cells c
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS units, (count(*) FILTER (WHERE u.failed))::integer AS failed,
             count(DISTINCT u.user_id)::integer AS tenants
      FROM tmp_oemr_units u
      WHERE u.equipment_type = c.equipment_type
        AND NOT (u.make_key = c.make_key
                 AND (c.scope_family = '*' OR u.model_family IS NOT DISTINCT FROM c.scope_family))
    ) r
    WHERE r.units >= k_rest_units AND r.tenants >= k_rest_tenants
  ), rates AS (
    SELECT b.*,
           b.failed_units::numeric / b.units AS p,
           b.rest_failed::numeric / b.rest_units AS bench
    FROM base b
  ), calc AS (
    SELECT r.*,
           (r.p + z * z / (2 * r.units) - z * sqrt(r.p * (1 - r.p) / r.units + z * z / (4 * r.units * r.units)))
             / (1 + z * z / r.units) AS w_low,
           (r.p + z * z / (2 * r.units) + z * sqrt(r.p * (1 - r.p) / r.units + z * z / (4 * r.units * r.units)))
             / (1 + z * z / r.units) AS w_high
    FROM rates r
  ), pub AS (
    SELECT c.*,
           round(least(100::numeric, greatest(0::numeric,
             100 * c.p + jitter_amp * 100 * sqrt(c.p * (1 - c.p) / c.units)
                       * public.atlas_jitter(c.equipment_type || ':' || c.make_key || ':' || c.scope_family || ':' || v_week))), 1) AS rate_pub,
           round(100 * c.bench, 1) AS bench_pub,
           CASE
             WHEN c.bench <= 0 THEN 'in_line'
             WHEN c.w_low > c.bench AND c.p / c.bench >= 1.25 THEN 'above_benchmark'
             WHEN c.w_high < c.bench AND c.p / c.bench <= 0.80 THEN 'below_benchmark'
             ELSE 'in_line'
           END AS sig
    FROM calc c
  )
  SELECT p.equipment_type, p.make_key, p.scope_family,
         public.atlas_bucket(p.units), public.atlas_bucket(p.failed_units), p.tenants,
         p.rate_pub, p.bench_pub,
         CASE WHEN p.bench_pub > 0 THEN least(99.99, round(p.rate_pub / p.bench_pub, 2)) END,
         p.sig,
         CASE WHEN p.age_n >= k_age THEN round(p.median_age)::integer END,
         v_window
  FROM pub p;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Attach the top failure modes from the already-published Atlas cells (no new exposure).
  IF to_regclass('public.failure_atlas_cells') IS NOT NULL THEN
    UPDATE oem_model_reliability r
    SET top_failure_modes = coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'failure_mode', t.failure_mode, 'failure_rate_pct', t.failure_rate_pct,
               'median_age_months', t.median_age_months, 'top_parts', t.top_parts)
             ORDER BY t.failure_rate_pct DESC, t.failure_mode)
      FROM (
        SELECT a.failure_mode, a.failure_rate_pct, a.median_age_months, a.top_parts
        FROM failure_atlas_cells a
        WHERE a.equipment_type = r.equipment_type AND a.make_key = r.make_key AND a.model_family = r.model_family
        ORDER BY a.failure_rate_pct DESC, a.failure_mode
        LIMIT 3
      ) t
    ), '[]'::jsonb);
  END IF;

  INSERT INTO oem_graph_stats (id, contributing_businesses, units_observed, models_published, window_months, computed_at)
  VALUES (
    1,
    (SELECT count(*) FROM failure_atlas_consent WHERE contribute),
    public.atlas_bucket((SELECT count(*) FROM tmp_oemr_units)),
    (SELECT count(*) FROM oem_model_reliability WHERE model_family <> '*'),
    v_window, now())
  ON CONFLICT (id) DO UPDATE
    SET contributing_businesses = EXCLUDED.contributing_businesses, units_observed = EXCLUDED.units_observed,
        models_published = EXCLUDED.models_published, window_months = EXCLUDED.window_months,
        computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END;
$$;

-- =============================================================
-- 5. CLIENT RPCs (SECURITY INVOKER: RLS applies; owner scope enforced again explicitly)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_oem_graph_for_equipment(p_equipment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  e record;
  v_type text;
  v_match jsonb;
  v_mfr uuid;
  v_model uuid;
  v_decoded jsonb;
  v_rel jsonb;
  v_mfr_json jsonb;
  v_model_json jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_excluded integer := 0;
  v_recalls jsonb := '[]'::jsonb;
  v_bulletins jsonb := '[]'::jsonb;
  v_patterns jsonb := '[]'::jsonb;
  v_terms jsonb := '[]'::jsonb;
  v_docs jsonb := '[]'::jsonb;
  v_claims jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'OEM_GRAPH_UNAUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  SELECT eq.id, eq.equipment_type, eq.make, eq.model, eq.serial_number, eq.install_date,
         eq.warranty_expires_at, eq.status, eq.customer_id, c.name AS customer_name
  INTO e
  FROM equipment eq
  LEFT JOIN customers c ON c.id = eq.customer_id
  WHERE eq.id = p_equipment_id AND eq.user_id = v_owner;

  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  v_type := lower(btrim(coalesce(e.equipment_type, '')));
  v_match := public.oem_match_equipment(e.id, e.make, e.model);
  v_mfr := nullif(v_match->>'manufacturer_id', '')::uuid;
  v_model := nullif(v_match->>'model_id', '')::uuid;
  v_rel := public.oem_reliability_for(e.equipment_type, e.make, e.model);

  IF v_mfr IS NOT NULL THEN
    v_decoded := public.oem_decode_serial(v_mfr, e.equipment_type, e.serial_number);

    SELECT jsonb_build_object('id', m.id, 'slug', m.slug, 'name', m.name, 'support_url', m.support_url)
    INTO v_mfr_json FROM oem_manufacturers m WHERE m.id = v_mfr;

    IF v_model IS NOT NULL THEN
      SELECT jsonb_build_object('id', m.id, 'model_number', m.model_number, 'equipment_type', m.equipment_type,
                                'category', m.category, 'avg_lifespan_years', m.avg_lifespan_years,
                                'manual_url', m.manual_url, 'specs', m.specs, 'source', m.source)
      INTO v_model_json FROM oem_equipment_models m WHERE m.id = v_model;
    END IF;

    SELECT coalesce(jsonb_agg(x.j ORDER BY x.sev_rank, x.title), '[]'::jsonb) INTO v_issues
    FROM (
      SELECT i.title,
             CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END AS sev_rank,
             jsonb_build_object(
               'id', i.id, 'issue_key', i.issue_key, 'title', i.title, 'symptom', i.symptom,
               'root_cause', i.root_cause, 'recommended_repair', i.recommended_repair, 'severity', i.severity,
               'labor_minutes_min', i.labor_minutes_min, 'labor_minutes_max', i.labor_minutes_max,
               'manufactured_from', i.manufactured_from, 'manufactured_to', i.manufactured_to,
               'applicability', public.oem_issue_applicability(i.manufactured_from, i.manufactured_to, v_decoded),
               'scope', CASE WHEN i.model_id IS NULL THEN 'manufacturer' ELSE 'model' END,
               'source', i.source, 'source_url', i.source_url,
               'bulletin', (SELECT jsonb_build_object('id', b.id, 'bulletin_number', b.bulletin_number, 'title', b.title,
                                                      'issued_date', b.issued_date, 'source_url', b.source_url)
                            FROM oem_service_bulletins b WHERE b.id = i.bulletin_id),
               'recall', (SELECT jsonb_build_object('id', r.id, 'recall_number', r.recall_number, 'title', r.title,
                                                    'severity', r.severity, 'issued_date', r.issued_date,
                                                    'remedy', r.remedy, 'source_url', r.source_url)
                          FROM oem_recalls r WHERE r.id = i.recall_id),
               'parts', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('id', p.id, 'part_number', p.part_number, 'part_name', p.part_name,
                                                     'category', p.category, 'avg_price', p.avg_price,
                                                     'quantity', ip.quantity, 'is_required', ip.is_required)
                                  ORDER BY ip.is_required DESC, p.part_name)
                 FROM oem_issue_parts ip JOIN oem_parts p ON p.id = ip.part_id
                 WHERE ip.issue_id = i.id), '[]'::jsonb),
               'observed', (SELECT m FROM jsonb_array_elements(coalesce(v_rel->'top_failure_modes', '[]'::jsonb)) m
                            WHERE m->>'failure_mode' = i.issue_key LIMIT 1)
             ) AS j
      FROM oem_known_issues i
      WHERE i.manufacturer_id = v_mfr
        AND ((v_model IS NOT NULL AND i.model_id = v_model)
             OR (i.model_id IS NULL AND lower(coalesce(i.equipment_type, '')) = v_type))
        AND public.oem_issue_applicability(i.manufactured_from, i.manufactured_to, v_decoded) <> 'outside'
    ) x;

    SELECT count(*)::integer INTO v_excluded
    FROM oem_known_issues i
    WHERE i.manufacturer_id = v_mfr
      AND ((v_model IS NOT NULL AND i.model_id = v_model)
           OR (i.model_id IS NULL AND lower(coalesce(i.equipment_type, '')) = v_type))
      AND public.oem_issue_applicability(i.manufactured_from, i.manufactured_to, v_decoded) = 'outside';

    IF v_model IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id, 'recall_number', r.recall_number, 'title', r.title, 'description', r.description,
               'severity', r.severity, 'issued_date', r.issued_date, 'remedy', r.remedy, 'source_url', r.source_url)
             ORDER BY r.issued_date DESC NULLS LAST), '[]'::jsonb)
      INTO v_recalls FROM oem_recalls r WHERE r.model_id = v_model;

      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', b.id, 'bulletin_number', b.bulletin_number, 'title', b.title, 'description', b.description,
               'issued_date', b.issued_date, 'source_url', b.source_url)
             ORDER BY b.issued_date DESC NULLS LAST), '[]'::jsonb)
      INTO v_bulletins FROM oem_service_bulletins b WHERE b.model_id = v_model;

      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'failure_mode', f.failure_mode, 'typical_age_months', f.typical_age_months,
               'sample_size', f.sample_size, 'frequency_score', f.frequency_score, 'common_fix', f.common_fix)
             ORDER BY f.frequency_score DESC), '[]'::jsonb)
      INTO v_patterns
      FROM (SELECT * FROM oem_failure_patterns WHERE model_id = v_model ORDER BY frequency_score DESC LIMIT 5) f;
    END IF;

    SELECT coalesce(jsonb_agg(t.j ORDER BY t.component), '[]'::jsonb) INTO v_terms
    FROM (
      SELECT DISTINCT ON (w.component) w.component,
             jsonb_build_object(
               'component', w.component, 'months', w.months, 'registered_months', w.registered_months,
               'registration_window_days', w.registration_window_days, 'transferable', w.transferable,
               'notes', w.notes, 'source_url', w.source_url,
               'scope', CASE WHEN w.model_id IS NOT NULL THEN 'model' WHEN w.equipment_type IS NOT NULL THEN 'type' ELSE 'manufacturer' END
             ) AS j
      FROM oem_warranty_terms w
      WHERE w.manufacturer_id = v_mfr
        AND (w.model_id = v_model
             OR (w.model_id IS NULL AND (w.equipment_type IS NULL OR lower(w.equipment_type) = v_type)))
      ORDER BY w.component, (w.model_id IS NULL), (w.equipment_type IS NULL)
    ) t;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', d.id, 'doc_type', d.doc_type, 'title', d.title, 'url', d.url, 'language', d.language,
             'scope', CASE WHEN d.model_id IS NULL THEN 'manufacturer' ELSE 'model' END)
           ORDER BY (d.model_id IS NULL), d.doc_type, d.title), '[]'::jsonb)
    INTO v_docs
    FROM oem_documents d
    WHERE d.manufacturer_id = v_mfr AND (d.model_id IS NULL OR d.model_id = v_model);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'status', w.status, 'claim_number', w.claim_number, 'part_description', w.part_description,
           'failure_date', w.failure_date, 'claim_deadline', w.claim_deadline, 'submitted_at', w.submitted_at,
           'claimed_amount_cents', w.claimed_amount_cents, 'approved_amount_cents', w.approved_amount_cents,
           'credit_received_cents', w.credit_received_cents)
         ORDER BY w.created_at DESC), '[]'::jsonb)
  INTO v_claims
  FROM (SELECT * FROM warranty_claims WHERE equipment_id = e.id AND user_id = v_owner ORDER BY created_at DESC LIMIT 20) w;

  RETURN jsonb_build_object(
    'found', true,
    'equipment', jsonb_build_object(
      'id', e.id, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
      'serial_number', e.serial_number, 'install_date', e.install_date,
      'warranty_expires_at', e.warranty_expires_at, 'status', e.status,
      'customer_id', e.customer_id, 'customer_name', e.customer_name),
    'match', jsonb_build_object(
      'method', v_match->>'method', 'confidence', coalesce((v_match->>'confidence')::numeric, 0),
      'manufacturer', v_mfr_json, 'model', v_model_json),
    'serial', jsonb_build_object('decoded', v_decoded, 'excluded_issues', v_excluded),
    'issues', v_issues, 'recalls', v_recalls, 'bulletins', v_bulletins, 'patterns', v_patterns,
    'warranty_terms', v_terms, 'documents', v_docs, 'reliability', v_rel, 'claims', v_claims,
    'coverage', jsonb_build_object(
      'model_matched', v_model IS NOT NULL,
      'issues', jsonb_array_length(v_issues),
      'warranty_terms', jsonb_array_length(v_terms),
      'documents', jsonb_array_length(v_docs),
      'reliability', v_rel IS NOT NULL,
      'serial_rule', v_decoded IS NOT NULL,
      'has_serial', btrim(coalesce(e.serial_number, '')) <> '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_oem_graph_fleet()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'OEM_GRAPH_UNAUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(z.j ORDER BY z.created_at DESC)
    FROM (
      SELECT eq.created_at,
             jsonb_build_object(
               'equipment_id', eq.id, 'equipment_type', eq.equipment_type, 'make', eq.make, 'model', eq.model,
               'serial_number', eq.serial_number, 'customer_id', eq.customer_id, 'customer_name', c.name,
               'install_date', eq.install_date, 'warranty_expires_at', eq.warranty_expires_at,
               'match_method', m.j->>'method',
               'match_confidence', coalesce((m.j->>'confidence')::numeric, 0),
               'recall_count', CASE WHEN k.model_id IS NULL THEN 0 ELSE
                 (SELECT count(*) FROM oem_recalls r WHERE r.model_id = k.model_id) END,
               'bulletin_count', CASE WHEN k.model_id IS NULL THEN 0 ELSE
                 (SELECT count(*) FROM oem_service_bulletins b WHERE b.model_id = k.model_id) END,
               'issue_count', CASE WHEN k.mfr_id IS NULL THEN 0 ELSE
                 (SELECT count(*) FROM oem_known_issues i
                  WHERE i.manufacturer_id = k.mfr_id
                    AND ((k.model_id IS NOT NULL AND i.model_id = k.model_id)
                         OR (i.model_id IS NULL AND lower(coalesce(i.equipment_type, '')) = lower(btrim(coalesce(eq.equipment_type, '')))))) END,
               'reliability', rel.j - 'top_failure_modes'
             ) AS j
      FROM equipment eq
      LEFT JOIN customers c ON c.id = eq.customer_id
      CROSS JOIN LATERAL (SELECT public.oem_match_equipment(eq.id, eq.make, eq.model) AS j) m
      CROSS JOIN LATERAL (SELECT nullif(m.j->>'manufacturer_id', '')::uuid AS mfr_id,
                                 nullif(m.j->>'model_id', '')::uuid AS model_id) k
      CROSS JOIN LATERAL (SELECT public.oem_reliability_for(eq.equipment_type, eq.make, eq.model) AS j) rel
      WHERE eq.user_id = v_owner AND eq.status = 'active'
      ORDER BY eq.created_at DESC
      LIMIT 1000
    ) z
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 6. IMPORTER (service_role): idempotent, all-or-nothing, validated
-- =============================================================

CREATE OR REPLACE FUNCTION public.oem_import_ids(p_manufacturer text, p_model text, OUT o_mfr uuid, OUT o_model uuid)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  SELECT id INTO o_mfr FROM public.oem_manufacturers WHERE slug = lower(btrim(coalesce(p_manufacturer, '')));
  IF o_mfr IS NULL THEN
    RAISE EXCEPTION 'OEM_IMPORT_INVALID: unknown manufacturer "%"', p_manufacturer USING ERRCODE = 'P0001';
  END IF;
  IF nullif(btrim(coalesce(p_model, '')), '') IS NOT NULL THEN
    SELECT id INTO o_model FROM public.oem_equipment_models
    WHERE manufacturer_id = o_mfr AND public.atlas_norm(model_number) = public.atlas_norm(p_model);
    IF o_model IS NULL THEN
      RAISE EXCEPTION 'OEM_IMPORT_INVALID: unknown model "%" for manufacturer "%" (import it under "models" first)', p_model, p_manufacturer
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_oem_graph(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  x jsonb;
  y jsonb;
  ids record;
  v_mfr uuid;
  v_model uuid;
  v_issue uuid;
  v_part uuid;
  v_bul uuid;
  v_rec uuid;
  v_id uuid;
  v_type text;
  n_models integer := 0; n_parts integer := 0; n_bulletins integer := 0; n_recalls integer := 0;
  n_issues integer := 0; n_issue_parts integer := 0; n_terms integer := 0; n_docs integer := 0;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'OEM_IMPORT_INVALID: payload must be a JSON object' USING ERRCODE = 'P0001';
  END IF;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'models', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', NULL);
    INSERT INTO oem_equipment_models (manufacturer_id, model_number, equipment_type, category, specs, avg_lifespan_years, manual_url, source)
    VALUES (ids.o_mfr, btrim(x->>'model_number'), lower(btrim(x->>'equipment_type')), nullif(x->>'category', ''),
            coalesce(x->'specs', '{}'::jsonb), nullif(x->>'avg_lifespan_years', '')::integer,
            nullif(x->>'manual_url', ''), coalesce(nullif(x->>'source', ''), 'internal'))
    ON CONFLICT (manufacturer_id, model_number) DO UPDATE
      SET equipment_type = EXCLUDED.equipment_type,
          category = coalesce(EXCLUDED.category, oem_equipment_models.category),
          specs = oem_equipment_models.specs || EXCLUDED.specs,
          avg_lifespan_years = coalesce(EXCLUDED.avg_lifespan_years, oem_equipment_models.avg_lifespan_years),
          manual_url = coalesce(EXCLUDED.manual_url, oem_equipment_models.manual_url),
          source = CASE WHEN x ? 'source' THEN EXCLUDED.source ELSE oem_equipment_models.source END;
    n_models := n_models + 1;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'parts', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    SELECT id INTO v_part FROM oem_parts
    WHERE manufacturer_id = ids.o_mfr AND part_number = btrim(x->>'part_number') AND model_id IS NOT DISTINCT FROM ids.o_model
    LIMIT 1;
    IF v_part IS NULL THEN
      INSERT INTO oem_parts (manufacturer_id, model_id, part_number, part_name, category, avg_price)
      VALUES (ids.o_mfr, ids.o_model, btrim(x->>'part_number'), btrim(x->>'part_name'), nullif(x->>'category', ''),
              nullif(x->>'avg_price', '')::numeric);
    ELSE
      UPDATE oem_parts
      SET part_name = btrim(x->>'part_name'), category = coalesce(nullif(x->>'category', ''), category),
          avg_price = coalesce(nullif(x->>'avg_price', '')::numeric, avg_price)
      WHERE id = v_part;
    END IF;
    n_parts := n_parts + 1;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'bulletins', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    INSERT INTO oem_service_bulletins (manufacturer_id, model_id, bulletin_number, title, description, issued_date, source_url)
    VALUES (ids.o_mfr, ids.o_model, btrim(x->>'bulletin_number'), btrim(x->>'title'), nullif(x->>'description', ''),
            nullif(x->>'issued_date', '')::date, nullif(x->>'source_url', ''))
    ON CONFLICT (manufacturer_id, bulletin_number) DO UPDATE
      SET model_id = coalesce(EXCLUDED.model_id, oem_service_bulletins.model_id), title = EXCLUDED.title,
          description = coalesce(EXCLUDED.description, oem_service_bulletins.description),
          issued_date = coalesce(EXCLUDED.issued_date, oem_service_bulletins.issued_date),
          source_url = coalesce(EXCLUDED.source_url, oem_service_bulletins.source_url);
    n_bulletins := n_bulletins + 1;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'recalls', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    INSERT INTO oem_recalls (manufacturer_id, model_id, recall_number, title, description, severity, issued_date, remedy, source_url)
    VALUES (ids.o_mfr, ids.o_model, btrim(x->>'recall_number'), btrim(x->>'title'), nullif(x->>'description', ''),
            coalesce(nullif(x->>'severity', ''), 'medium'), nullif(x->>'issued_date', '')::date,
            nullif(x->>'remedy', ''), nullif(x->>'source_url', ''))
    ON CONFLICT (manufacturer_id, recall_number) DO UPDATE
      SET model_id = coalesce(EXCLUDED.model_id, oem_recalls.model_id), title = EXCLUDED.title,
          description = coalesce(EXCLUDED.description, oem_recalls.description), severity = EXCLUDED.severity,
          issued_date = coalesce(EXCLUDED.issued_date, oem_recalls.issued_date),
          remedy = coalesce(EXCLUDED.remedy, oem_recalls.remedy),
          source_url = coalesce(EXCLUDED.source_url, oem_recalls.source_url);
    n_recalls := n_recalls + 1;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'issues', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    v_mfr := ids.o_mfr; v_model := ids.o_model;
    v_type := nullif(lower(btrim(coalesce(x->>'equipment_type', ''))), '');
    v_bul := NULL; v_rec := NULL;

    IF nullif(x->>'bulletin_number', '') IS NOT NULL THEN
      SELECT id INTO v_bul FROM oem_service_bulletins WHERE manufacturer_id = v_mfr AND bulletin_number = x->>'bulletin_number';
      IF v_bul IS NULL THEN
        RAISE EXCEPTION 'OEM_IMPORT_INVALID: unknown bulletin "%" (import it under "bulletins" first)', x->>'bulletin_number' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF nullif(x->>'recall_number', '') IS NOT NULL THEN
      SELECT id INTO v_rec FROM oem_recalls WHERE manufacturer_id = v_mfr AND recall_number = x->>'recall_number';
      IF v_rec IS NULL THEN
        RAISE EXCEPTION 'OEM_IMPORT_INVALID: unknown recall "%" (import it under "recalls" first)', x->>'recall_number' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    SELECT id INTO v_issue FROM oem_known_issues
    WHERE manufacturer_id = v_mfr AND model_id IS NOT DISTINCT FROM v_model
      AND coalesce(lower(equipment_type), '') = coalesce(v_type, '') AND issue_key = x->>'issue_key';

    IF v_issue IS NULL THEN
      INSERT INTO oem_known_issues
        (manufacturer_id, model_id, equipment_type, issue_key, title, symptom, root_cause, recommended_repair, severity,
         labor_minutes_min, labor_minutes_max, manufactured_from, manufactured_to, bulletin_id, recall_id, source, source_url)
      VALUES (v_mfr, v_model, v_type, x->>'issue_key', btrim(x->>'title'), nullif(x->>'symptom', ''), nullif(x->>'root_cause', ''),
              nullif(x->>'recommended_repair', ''), coalesce(nullif(x->>'severity', ''), 'medium'),
              nullif(x->>'labor_minutes_min', '')::integer, nullif(x->>'labor_minutes_max', '')::integer,
              nullif(x->>'manufactured_from', '')::date, nullif(x->>'manufactured_to', '')::date,
              v_bul, v_rec, coalesce(nullif(x->>'source', ''), 'manual'), nullif(x->>'source_url', ''))
      RETURNING id INTO v_issue;
    ELSE
      UPDATE oem_known_issues
      SET title = btrim(x->>'title'), symptom = nullif(x->>'symptom', ''), root_cause = nullif(x->>'root_cause', ''),
          recommended_repair = nullif(x->>'recommended_repair', ''), severity = coalesce(nullif(x->>'severity', ''), severity),
          labor_minutes_min = nullif(x->>'labor_minutes_min', '')::integer, labor_minutes_max = nullif(x->>'labor_minutes_max', '')::integer,
          manufactured_from = nullif(x->>'manufactured_from', '')::date, manufactured_to = nullif(x->>'manufactured_to', '')::date,
          bulletin_id = coalesce(v_bul, bulletin_id), recall_id = coalesce(v_rec, recall_id),
          source = coalesce(nullif(x->>'source', ''), source), source_url = coalesce(nullif(x->>'source_url', ''), source_url)
      WHERE id = v_issue;
    END IF;
    n_issues := n_issues + 1;

    FOR y IN SELECT value FROM jsonb_array_elements(coalesce(x->'parts', '[]'::jsonb)) LOOP
      v_part := NULL;
      SELECT id INTO v_part FROM oem_parts
      WHERE manufacturer_id = v_mfr AND part_number = btrim(y->>'part_number')
        AND (model_id = v_model OR model_id IS NULL)
      ORDER BY (model_id IS NULL) LIMIT 1;
      IF v_part IS NULL THEN
        IF nullif(btrim(coalesce(y->>'part_name', '')), '') IS NULL THEN
          RAISE EXCEPTION 'OEM_IMPORT_INVALID: unknown part "%" (add part_name to create it, or import it under "parts")', y->>'part_number' USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO oem_parts (manufacturer_id, model_id, part_number, part_name, category, avg_price)
        VALUES (v_mfr, v_model, btrim(y->>'part_number'), btrim(y->>'part_name'), nullif(y->>'category', ''), nullif(y->>'avg_price', '')::numeric)
        RETURNING id INTO v_part;
      END IF;
      INSERT INTO oem_issue_parts (issue_id, part_id, quantity, is_required)
      VALUES (v_issue, v_part, coalesce(nullif(y->>'quantity', '')::integer, 1), coalesce(nullif(y->>'is_required', '')::boolean, true))
      ON CONFLICT (issue_id, part_id) DO UPDATE SET quantity = EXCLUDED.quantity, is_required = EXCLUDED.is_required;
      n_issue_parts := n_issue_parts + 1;
    END LOOP;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'warranty_terms', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    v_type := nullif(lower(btrim(coalesce(x->>'equipment_type', ''))), '');
    SELECT id INTO v_id FROM oem_warranty_terms
    WHERE manufacturer_id = ids.o_mfr AND model_id IS NOT DISTINCT FROM ids.o_model
      AND coalesce(lower(equipment_type), '') = coalesce(v_type, '') AND component = x->>'component';
    IF v_id IS NULL THEN
      INSERT INTO oem_warranty_terms (manufacturer_id, model_id, equipment_type, component, months, registered_months,
                                      registration_window_days, transferable, notes, source_url)
      VALUES (ids.o_mfr, ids.o_model, v_type, x->>'component', (x->>'months')::integer, nullif(x->>'registered_months', '')::integer,
              nullif(x->>'registration_window_days', '')::integer, nullif(x->>'transferable', '')::boolean,
              nullif(x->>'notes', ''), nullif(x->>'source_url', ''));
    ELSE
      UPDATE oem_warranty_terms
      SET months = (x->>'months')::integer, registered_months = nullif(x->>'registered_months', '')::integer,
          registration_window_days = nullif(x->>'registration_window_days', '')::integer,
          transferable = nullif(x->>'transferable', '')::boolean, notes = nullif(x->>'notes', ''),
          source_url = coalesce(nullif(x->>'source_url', ''), source_url)
      WHERE id = v_id;
    END IF;
    n_terms := n_terms + 1;
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'documents', '[]'::jsonb)) LOOP
    SELECT * INTO ids FROM public.oem_import_ids(x->>'manufacturer', x->>'model_number');
    INSERT INTO oem_documents (manufacturer_id, model_id, doc_type, title, url, language)
    VALUES (ids.o_mfr, ids.o_model, x->>'doc_type', btrim(x->>'title'), btrim(x->>'url'), coalesce(nullif(x->>'language', ''), 'en'))
    ON CONFLICT (manufacturer_id, url) DO UPDATE
      SET model_id = coalesce(EXCLUDED.model_id, oem_documents.model_id), doc_type = EXCLUDED.doc_type,
          title = EXCLUDED.title, language = EXCLUDED.language;
    n_docs := n_docs + 1;
  END LOOP;

  RETURN jsonb_build_object('models', n_models, 'parts', n_parts, 'bulletins', n_bulletins, 'recalls', n_recalls,
                            'issues', n_issues, 'issue_parts', n_issue_parts, 'warranty_terms', n_terms, 'documents', n_docs);
END;
$$;

-- =============================================================
-- 7. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.oem_decode_serial(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.oem_issue_applicability(date, date, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.oem_match_equipment(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.oem_reliability_for(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_oem_graph_for_equipment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_oem_graph_fleet() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.oem_decode_serial(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.oem_issue_applicability(date, date, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.oem_match_equipment(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.oem_reliability_for(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_oem_graph_for_equipment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_oem_graph_fleet() TO authenticated;

REVOKE ALL ON FUNCTION public.refresh_oem_model_reliability(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_oem_model_reliability(integer) TO service_role;
REVOKE ALL ON FUNCTION public.oem_import_ids(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_oem_graph(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oem_import_ids(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_oem_graph(jsonb) TO service_role;

-- =============================================================
-- 8. Nightly refresh (skipped silently if pg_cron is absent) + first build
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-oem-reliability-refresh');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-oem-reliability-refresh', '10 4 * * *', 'select public.refresh_oem_model_reliability(36)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END;
$$;

DO $$
BEGIN
  PERFORM public.refresh_oem_model_reliability(36);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'initial OEM reliability build skipped: %', SQLERRM;
END;
$$;
