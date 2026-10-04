/*
  # Vireek Failure Genome

  A failure "DNA" per equipment unit (MODEL + AGE + CLIMATE + USAGE + SYMPTOMS +
  HISTORY + PARTS + FAILURE + REPAIR + OUTCOME) and a privacy-preserving
  population layer that discovers EMERGING failure patterns across equipment
  populations. Separate from diagnosis-copilot (that analyses one unit; this
  watches populations).

  Layers
  1. equipment_failure_events  tenant-owned failure/repair events (normalised on write)
  2. failure_genomes           one DNA row per unit, kept fresh by triggers
  3. failure_patterns          cross-tenant aggregates, rebuilt nightly. NO client
                               access: only via SECURITY DEFINER RPCs below.
  4. failure_genome_partners   approved OEM / distributor / insurer accounts
                               (aggregate feed only, every access is logged)

  Privacy: pattern published only if >= 5 distinct businesses contribute, no single
  business supplies > 60% of events, unknown-model units are excluded, and a business
  can opt out (failure_genome_contribute). This is k-anonymity + a dominance rule,
  NOT formal differential privacy.

  Detection (emerging): >=5 businesses, >=20 units, >=6 recent events, lift >= 1.5,
  Poisson z >= 3, and the component's share of that model's events also grew >= 1.2x
  (guards against "more businesses started logging" false alarms). All thresholds
  live in refresh_failure_patterns() and are tunable in one place.

  Purely additive. Existing tables only get new nullable columns / extra triggers
  that can never block the original write (errors are swallowed with a WARNING).

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 0) Prerequisite columns ---------------------------------------------------
ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS climate_zone text,
  ADD COLUMN IF NOT EXISTS usage_profile text;

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS failure_genome_contribute boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_climate_zone text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_climate_zone_check') THEN
    ALTER TABLE equipment ADD CONSTRAINT equipment_climate_zone_check
      CHECK (climate_zone IS NULL OR climate_zone IN ('hot_humid','hot_dry','temperate','cold','marine','mixed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_usage_profile_check') THEN
    ALTER TABLE equipment ADD CONSTRAINT equipment_usage_profile_check
      CHECK (usage_profile IS NULL OR usage_profile IN ('light','normal','heavy','continuous'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_default_climate_zone_check') THEN
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_default_climate_zone_check
      CHECK (default_climate_zone IS NULL OR default_climate_zone IN ('hot_humid','hot_dry','temperate','cold','marine','mixed'));
  END IF;
END $$;

-- 1) Normalisation helpers ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.fg_slug(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(trim(both '_' from left(regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', '_', 'g'), 60)), '');
$$;

CREATE OR REPLACE FUNCTION public.fg_slugs(p_items text[], p_max integer DEFAULT 12)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(q.s), '{}'::text[])
  FROM (
    SELECT DISTINCT public.fg_slug(i) AS s
    FROM unnest(COALESCE(p_items, '{}'::text[])) AS i
    WHERE public.fg_slug(i) IS NOT NULL
    ORDER BY 1
    LIMIT p_max
  ) q;
$$;

CREATE OR REPLACE FUNCTION public.fg_age_band(p_months integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_months IS NULL THEN 'unknown'
    WHEN p_months < 36 THEN '0-2y'
    WHEN p_months < 72 THEN '3-5y'
    WHEN p_months < 108 THEN '6-8y'
    WHEN p_months < 156 THEN '9-12y'
    ELSE '13y+'
  END;
$$;

-- 2) Failure events (tenant-owned) --------------------------------------------
CREATE TABLE IF NOT EXISTS equipment_failure_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  age_months integer,
  symptoms text[] NOT NULL DEFAULT '{}',
  failure_component text NOT NULL,
  failure_mode text,
  repair_action text,
  parts_replaced text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'unknown'
    CHECK (outcome IN ('fixed','recurred','callback','replaced_unit','deferred','unknown')),
  repair_cost numeric CHECK (repair_cost IS NULL OR repair_cost >= 0),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','diagnosis','callback_rca','import')),
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fg_events_equipment ON equipment_failure_events(equipment_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_fg_events_user ON equipment_failure_events(user_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_fg_events_window ON equipment_failure_events(occurred_on);

ALTER TABLE equipment_failure_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_failure_events" ON equipment_failure_events;
CREATE POLICY "select_own_failure_events" ON equipment_failure_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_failure_events" ON equipment_failure_events;
CREATE POLICY "insert_own_failure_events" ON equipment_failure_events FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_failure_events" ON equipment_failure_events;
CREATE POLICY "update_own_failure_events" ON equipment_failure_events FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_failure_events" ON equipment_failure_events;
CREATE POLICY "delete_own_failure_events" ON equipment_failure_events FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- 3) Genome table --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS failure_genomes (
  equipment_id uuid PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  model_key text NOT NULL,
  make_key text NOT NULL,
  type_key text NOT NULL,
  age_band text NOT NULL,
  climate_band text NOT NULL,
  usage_band text NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  recurrence_count integer NOT NULL DEFAULT 0,
  last_failure_on date,
  dna jsonb NOT NULL,
  dna_hash text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fg_genomes_user ON failure_genomes(user_id);
CREATE INDEX IF NOT EXISTS idx_fg_genomes_model ON failure_genomes(model_key);

ALTER TABLE failure_genomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_failure_genomes" ON failure_genomes;
CREATE POLICY "select_own_failure_genomes" ON failure_genomes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client write path: only fg_build_genome() (definer / service role) writes here.

-- 4) Genome builder (internal) --------------------------------------------------
CREATE OR REPLACE FUNCTION public.fg_build_genome(p_equipment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e equipment%ROWTYPE;
  v_default_climate text;
  v_ref date;
  v_age_months integer;
  v_months_since_service integer;
  v_overdue boolean;
  v_failures integer;
  v_recur integer;
  v_first_on date;
  v_last_on date;
  v_last_comp text;
  v_last_action text;
  v_last_outcome text;
  v_symptoms text[];
  v_parts text[];
  v_components jsonb;
  v_actions jsonb;
  v_outcomes jsonb;
  v_mtbf numeric;
  v_make_key text;
  v_type_key text;
  v_model_key text;
  v_age_band text;
  v_climate text;
  v_usage text;
  v_dna jsonb;
  v_hash text;
BEGIN
  SELECT * INTO e FROM equipment WHERE id = p_equipment_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT bp.default_climate_zone INTO v_default_climate
  FROM business_profile bp WHERE bp.user_id = e.user_id LIMIT 1;

  SELECT count(*)::integer, min(ev.occurred_on), max(ev.occurred_on)
    INTO v_failures, v_first_on, v_last_on
  FROM equipment_failure_events ev WHERE ev.equipment_id = e.id;

  SELECT ev.failure_component, ev.repair_action, ev.outcome
    INTO v_last_comp, v_last_action, v_last_outcome
  FROM equipment_failure_events ev WHERE ev.equipment_id = e.id
  ORDER BY ev.occurred_on DESC, ev.created_at DESC LIMIT 1;

  SELECT count(*)::integer INTO v_recur FROM (
    SELECT ev.outcome AS outcome,
           ev.occurred_on - lag(ev.occurred_on) OVER (
             PARTITION BY ev.failure_component ORDER BY ev.occurred_on, ev.created_at) AS gap
    FROM equipment_failure_events ev WHERE ev.equipment_id = e.id
  ) x
  WHERE x.outcome IN ('recurred','callback') OR (x.gap IS NOT NULL AND x.gap <= 180);

  SELECT COALESCE(array_agg(t.s ORDER BY t.n DESC, t.s), '{}'::text[]) INTO v_symptoms FROM (
    SELECT s, count(*) AS n FROM equipment_failure_events ev, unnest(ev.symptoms) AS s
    WHERE ev.equipment_id = e.id GROUP BY s ORDER BY n DESC, s LIMIT 8) t;

  SELECT COALESCE(array_agg(t.s ORDER BY t.n DESC, t.s), '{}'::text[]) INTO v_parts FROM (
    SELECT s, count(*) AS n FROM equipment_failure_events ev, unnest(ev.parts_replaced) AS s
    WHERE ev.equipment_id = e.id GROUP BY s ORDER BY n DESC, s LIMIT 12) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('component', t.c, 'count', t.n) ORDER BY t.n DESC, t.c), '[]'::jsonb)
    INTO v_components FROM (
    SELECT ev.failure_component AS c, count(*) AS n FROM equipment_failure_events ev
    WHERE ev.equipment_id = e.id GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('action', t.a, 'count', t.n) ORDER BY t.n DESC, t.a), '[]'::jsonb)
    INTO v_actions FROM (
    SELECT ev.repair_action AS a, count(*) AS n FROM equipment_failure_events ev
    WHERE ev.equipment_id = e.id AND ev.repair_action IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8) t;

  SELECT jsonb_build_object(
    'fixed', count(*) FILTER (WHERE ev.outcome = 'fixed'),
    'recurred', count(*) FILTER (WHERE ev.outcome = 'recurred'),
    'callback', count(*) FILTER (WHERE ev.outcome = 'callback'),
    'replaced_unit', count(*) FILTER (WHERE ev.outcome = 'replaced_unit'),
    'deferred', count(*) FILTER (WHERE ev.outcome = 'deferred'),
    'unknown', count(*) FILTER (WHERE ev.outcome = 'unknown'))
    INTO v_outcomes FROM equipment_failure_events ev WHERE ev.equipment_id = e.id;

  v_mtbf := CASE WHEN v_failures > 1
    THEN round(((v_last_on - v_first_on)::numeric / 30.4375) / (v_failures - 1), 1) END;

  v_make_key := COALESCE(public.fg_slug(e.make), 'unknown');
  v_type_key := COALESCE(public.fg_slug(e.equipment_type), 'unknown');
  v_model_key := v_make_key || '/' || COALESCE(public.fg_slug(e.model), 'unknown') || '/' || v_type_key;

  -- Retired units keep the age they had at their last failure, so they stay in the right cohort.
  v_ref := CASE WHEN e.status = 'active' THEN CURRENT_DATE ELSE COALESCE(v_last_on, CURRENT_DATE) END;
  v_age_months := CASE WHEN e.install_date IS NULL THEN NULL
    ELSE GREATEST(0, (EXTRACT(year FROM age(v_ref, e.install_date)) * 12
                    + EXTRACT(month FROM age(v_ref, e.install_date)))::integer) END;

  v_months_since_service := CASE WHEN e.last_service_date IS NULL THEN NULL
    ELSE GREATEST(0, (EXTRACT(year FROM age(CURRENT_DATE, e.last_service_date)) * 12
                    + EXTRACT(month FROM age(CURRENT_DATE, e.last_service_date)))::integer) END;
  v_overdue := COALESCE(v_months_since_service > e.service_interval_months, false);

  v_age_band := public.fg_age_band(v_age_months);
  v_climate := COALESCE(e.climate_zone, v_default_climate, 'unknown');
  v_usage := COALESCE(e.usage_profile, 'unknown');

  v_dna := jsonb_build_object(
    'model', jsonb_build_object('key', v_model_key, 'make', e.make, 'model', e.model, 'type', e.equipment_type),
    'age', jsonb_build_object('months', v_age_months, 'band', v_age_band),
    'climate', jsonb_build_object('band', v_climate),
    'usage', jsonb_build_object('band', v_usage),
    'symptoms', to_jsonb(v_symptoms),
    'history', jsonb_build_object('failures', v_failures, 'recurrences', v_recur, 'first_on', v_first_on,
                                  'last_on', v_last_on, 'mean_months_between', v_mtbf, 'service_overdue', v_overdue),
    'parts', to_jsonb(v_parts),
    'failure', jsonb_build_object('components', v_components, 'last', v_last_comp),
    'repair', jsonb_build_object('actions', v_actions, 'last', v_last_action),
    'outcome', v_outcomes || jsonb_build_object('last', v_last_outcome)
  );

  v_hash := md5(concat_ws('|', v_model_key, v_age_band, v_climate, v_usage,
    array_to_string(ARRAY(SELECT unnest(v_symptoms) ORDER BY 1), ','),
    array_to_string(ARRAY(SELECT unnest(v_parts) ORDER BY 1), ','),
    (SELECT string_agg(DISTINCT ev.failure_component, ',' ORDER BY ev.failure_component)
       FROM equipment_failure_events ev WHERE ev.equipment_id = e.id),
    COALESCE(v_last_outcome, '')));

  INSERT INTO failure_genomes AS g (
    equipment_id, user_id, status, model_key, make_key, type_key, age_band, climate_band, usage_band,
    failure_count, recurrence_count, last_failure_on, dna, dna_hash, computed_at)
  VALUES (
    e.id, e.user_id, e.status, v_model_key, v_make_key, v_type_key, v_age_band, v_climate, v_usage,
    v_failures, v_recur, v_last_on, v_dna, v_hash, now())
  ON CONFLICT (equipment_id) DO UPDATE SET
    user_id = EXCLUDED.user_id, status = EXCLUDED.status, model_key = EXCLUDED.model_key,
    make_key = EXCLUDED.make_key, type_key = EXCLUDED.type_key, age_band = EXCLUDED.age_band,
    climate_band = EXCLUDED.climate_band, usage_band = EXCLUDED.usage_band,
    failure_count = EXCLUDED.failure_count, recurrence_count = EXCLUDED.recurrence_count,
    last_failure_on = EXCLUDED.last_failure_on, dna = EXCLUDED.dna, dna_hash = EXCLUDED.dna_hash,
    computed_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.fg_build_genome(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fg_build_genome(uuid) TO service_role;

-- 5) Triggers --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fg_event_before()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_install date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.equipment_id IS DISTINCT FROM OLD.equipment_id THEN
    RAISE EXCEPTION 'equipment_id cannot be changed on a failure event';
  END IF;

  SELECT e.user_id, e.install_date INTO v_owner, v_install FROM equipment e WHERE e.id = NEW.equipment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipment not found'; END IF;
  NEW.user_id := v_owner; -- always derived from the unit, never trusted from the client

  IF NEW.job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'Job does not belong to this account';
  END IF;
  IF NEW.occurred_on > CURRENT_DATE + 1 THEN
    RAISE EXCEPTION 'Failure date cannot be in the future';
  END IF;

  NEW.failure_component := public.fg_slug(NEW.failure_component);
  IF NEW.failure_component IS NULL THEN RAISE EXCEPTION 'A failed component is required'; END IF;
  NEW.failure_mode := public.fg_slug(NEW.failure_mode);
  NEW.repair_action := public.fg_slug(NEW.repair_action);
  NEW.symptoms := public.fg_slugs(NEW.symptoms);
  NEW.parts_replaced := public.fg_slugs(NEW.parts_replaced);
  NEW.age_months := CASE WHEN v_install IS NULL THEN NULL
    ELSE GREATEST(0, (EXTRACT(year FROM age(NEW.occurred_on, v_install)) * 12
                    + EXTRACT(month FROM age(NEW.occurred_on, v_install)))::integer) END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fg_event_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.fg_build_genome(CASE WHEN TG_OP = 'DELETE' THEN OLD.equipment_id ELSE NEW.equipment_id END);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'failure_genome rebuild failed (nightly job will retry): %', SQLERRM;
  END;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.fg_equipment_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.fg_build_genome(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Never let genome bookkeeping block a core equipment write.
    RAISE WARNING 'failure_genome rebuild failed (nightly job will retry): %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fg_event_before ON equipment_failure_events;
CREATE TRIGGER trg_fg_event_before BEFORE INSERT OR UPDATE ON equipment_failure_events
  FOR EACH ROW EXECUTE FUNCTION public.fg_event_before();

DROP TRIGGER IF EXISTS trg_fg_event_after ON equipment_failure_events;
CREATE TRIGGER trg_fg_event_after AFTER INSERT OR UPDATE OR DELETE ON equipment_failure_events
  FOR EACH ROW EXECUTE FUNCTION public.fg_event_after();

DROP TRIGGER IF EXISTS trg_fg_equipment_sync ON equipment;
CREATE TRIGGER trg_fg_equipment_sync
  AFTER INSERT OR UPDATE OF equipment_type, make, model, install_date, status, last_service_date,
                            service_interval_months, climate_zone, usage_profile
  ON equipment FOR EACH ROW EXECUTE FUNCTION public.fg_equipment_after();

-- 6) Population patterns (cross-tenant, aggregate only) ------------------------------
CREATE TABLE IF NOT EXISTS failure_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key text NOT NULL,
  make_key text NOT NULL,
  type_key text NOT NULL,
  failure_component text NOT NULL,
  age_band text NOT NULL DEFAULT 'any',
  climate_band text NOT NULL DEFAULT 'any',
  units_exposed integer NOT NULL,
  contributor_count integer NOT NULL,
  recent_events integer NOT NULL,
  baseline_events integer NOT NULL,
  recent_rate numeric NOT NULL,   -- events per 100 units in the recent window
  baseline_rate numeric NOT NULL, -- expected events per 100 units for a window of the same length
  lift numeric,
  z_score numeric,
  status text NOT NULL CHECK (status IN ('emerging','elevated','stable','declining')),
  recurrence_rate numeric,
  replacement_rate numeric,
  fix_rate numeric,
  avg_repair_cost numeric,
  top_symptoms jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_repairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_days integer NOT NULL,
  first_detected_at timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, failure_component, age_band, climate_band)
);

CREATE INDEX IF NOT EXISTS idx_fg_patterns_status ON failure_patterns(status, lift DESC);
CREATE INDEX IF NOT EXISTS idx_fg_patterns_make ON failure_patterns(make_key);

ALTER TABLE failure_patterns ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: authenticated users reach this only through the RPCs below.

CREATE OR REPLACE FUNCTION public.refresh_failure_patterns(p_recent_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k CONSTANT integer := 5;            -- min distinct businesses per published pattern
  v_min_units CONSTANT integer := 20;   -- min exposed units per cohort
  v_max_share CONSTANT numeric := 0.60; -- no single business may supply more than this share of events
  v_recent integer := GREATEST(30, LEAST(COALESCE(p_recent_days, 90), 180));
  v_today date := CURRENT_DATE;
  v_r_start date;
  v_b_start date;
  v_started timestamptz := now();
  v_rows integer := 0;
  r_pat record;
  r_ten record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('vireek_failure_patterns_refresh')) THEN
    RETURN 0; -- another run is in progress
  END IF;

  v_r_start := v_today - v_recent;          -- recent window  = (v_r_start, today]
  v_b_start := v_today - v_recent * 4;      -- baseline window = (v_b_start, v_r_start]  (3x as long)

  DROP TABLE IF EXISTS tmp_fg_prev, tmp_fg_units, tmp_fg_ev, tmp_fg_tags;
  CREATE TEMP TABLE tmp_fg_prev (id uuid PRIMARY KEY, status text) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_units (
    equipment_id uuid, user_id uuid, model_key text, age_f text, clim_f text) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_ev (
    user_id uuid, model_key text, age_f text, clim_f text, failure_component text,
    symptoms text[], parts text[], repair_action text, outcome text, repair_cost numeric,
    is_recent boolean) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_tags (
    model_key text, age_f text, clim_f text, failure_component text, kind text, tag text, n integer) ON COMMIT DROP;

  INSERT INTO tmp_fg_prev SELECT id, status FROM failure_patterns;

  -- Exposure: every contributing unit, exploded into its 4 cohort facets
  -- (any/any, age/any, any/climate, age/climate).
  INSERT INTO tmp_fg_units (equipment_id, user_id, model_key, age_f, clim_f)
  SELECT g.equipment_id, g.user_id, g.model_key, f.age_f, f.clim_f
  FROM failure_genomes g
  CROSS JOIN LATERAL (VALUES
    ('any', 'any'), (g.age_band, 'any'), ('any', g.climate_band), (g.age_band, g.climate_band)
  ) AS f(age_f, clim_f)
  WHERE split_part(g.model_key, '/', 1) <> 'unknown'
    AND split_part(g.model_key, '/', 2) <> 'unknown'
    AND f.age_f <> 'unknown' AND f.clim_f <> 'unknown'
    AND NOT EXISTS (SELECT 1 FROM business_profile bp
                    WHERE bp.user_id = g.user_id AND bp.failure_genome_contribute = false);

  INSERT INTO tmp_fg_ev (user_id, model_key, age_f, clim_f, failure_component, symptoms, parts,
                         repair_action, outcome, repair_cost, is_recent)
  SELECT ev.user_id, g.model_key, f.age_f, f.clim_f, ev.failure_component, ev.symptoms,
         ev.parts_replaced, ev.repair_action, ev.outcome, ev.repair_cost, (ev.occurred_on > v_r_start)
  FROM equipment_failure_events ev
  JOIN failure_genomes g ON g.equipment_id = ev.equipment_id
  CROSS JOIN LATERAL (VALUES
    ('any', 'any'), (g.age_band, 'any'), ('any', g.climate_band), (g.age_band, g.climate_band)
  ) AS f(age_f, clim_f)
  WHERE ev.occurred_on > v_b_start AND ev.occurred_on <= v_today
    AND split_part(g.model_key, '/', 1) <> 'unknown'
    AND split_part(g.model_key, '/', 2) <> 'unknown'
    AND f.age_f <> 'unknown' AND f.clim_f <> 'unknown'
    AND NOT EXISTS (SELECT 1 FROM business_profile bp
                    WHERE bp.user_id = g.user_id AND bp.failure_genome_contribute = false);

  INSERT INTO failure_patterns (
    model_key, make_key, type_key, failure_component, age_band, climate_band,
    units_exposed, contributor_count, recent_events, baseline_events, recent_rate, baseline_rate,
    lift, z_score, status, recurrence_rate, replacement_rate, fix_rate, avg_repair_cost,
    window_days, first_detected_at, status_changed_at, computed_at)
  WITH pt AS (
    SELECT model_key, age_f, clim_f, failure_component, user_id,
           count(*) FILTER (WHERE is_recent) AS rec,
           count(*) FILTER (WHERE NOT is_recent) AS base,
           count(*) FILTER (WHERE outcome IN ('recurred', 'callback')) AS recur,
           count(*) FILTER (WHERE outcome = 'replaced_unit') AS repl,
           count(*) FILTER (WHERE outcome = 'fixed') AS fixd,
           sum(repair_cost) AS cost_sum,
           count(repair_cost) AS cost_n
    FROM tmp_fg_ev
    GROUP BY model_key, age_f, clim_f, failure_component, user_id
  ), ag AS (
    SELECT model_key, age_f, clim_f, failure_component,
           sum(rec)::integer AS rec, sum(base)::integer AS base, count(*)::integer AS tenants,
           max(rec + base)::numeric / NULLIF(sum(rec + base), 0) AS top_share,
           sum(recur)::numeric AS recur, sum(repl)::numeric AS repl, sum(fixd)::numeric AS fixd,
           sum(cost_sum) AS cost_sum, sum(cost_n) AS cost_n
    FROM pt GROUP BY model_key, age_f, clim_f, failure_component
  ), tot AS (
    SELECT model_key, age_f, clim_f,
           count(*) FILTER (WHERE is_recent)::numeric AS rec_tot,
           count(*) FILTER (WHERE NOT is_recent)::numeric AS base_tot
    FROM tmp_fg_ev GROUP BY model_key, age_f, clim_f
  ), un AS (
    SELECT model_key, age_f, clim_f, count(*)::integer AS units
    FROM tmp_fg_units GROUP BY model_key, age_f, clim_f
  ), calc AS (
    SELECT ag.*, un.units, tot.rec_tot, tot.base_tot, ag.base / 3.0 AS expected
    FROM ag
    JOIN un USING (model_key, age_f, clim_f)
    JOIN tot USING (model_key, age_f, clim_f)
    WHERE ag.tenants >= v_k
      AND ag.top_share <= v_max_share
      AND un.units >= v_min_units
      AND (ag.rec + ag.base) >= 8
  ), scored AS (
    SELECT c.*,
           LEAST(99, round(c.rec / GREATEST(c.expected, 0.5), 2)) AS lift,
           round((c.rec - c.expected) / sqrt(c.expected + 1), 2) AS z,
           CASE WHEN c.base > 0 AND c.base_tot > 0 AND c.rec_tot > 0
                THEN (c.rec / c.rec_tot) / (c.base / c.base_tot) END AS share_lift
    FROM calc c
  ), classified AS (
    SELECT s.*,
           CASE
             WHEN s.rec >= 6 AND s.lift >= 1.5 AND s.z >= 3 AND COALESCE(s.share_lift, 2) >= 1.2 THEN 'emerging'
             WHEN s.rec >= 4 AND s.lift >= 1.25 AND s.z >= 2 THEN 'elevated'
             WHEN s.lift <= 0.67 AND s.z <= -2 THEN 'declining'
             ELSE 'stable'
           END AS status
    FROM scored s
  )
  SELECT s.model_key, split_part(s.model_key, '/', 1), split_part(s.model_key, '/', 3),
         s.failure_component, s.age_f, s.clim_f,
         s.units, s.tenants, s.rec, s.base,
         round(s.rec * 100.0 / s.units, 2), round(s.expected * 100.0 / s.units, 2),
         s.lift, s.z, s.status,
         round(s.recur / NULLIF(s.rec + s.base, 0), 3),
         round(s.repl / NULLIF(s.rec + s.base, 0), 3),
         round(s.fixd / NULLIF(s.rec + s.base, 0), 3),
         round(s.cost_sum / NULLIF(s.cost_n, 0), 2),
         v_recent,
         CASE WHEN s.status = 'emerging' THEN v_started END,
         v_started, v_started
  FROM classified s
  ON CONFLICT (model_key, failure_component, age_band, climate_band) DO UPDATE SET
    make_key = EXCLUDED.make_key, type_key = EXCLUDED.type_key,
    units_exposed = EXCLUDED.units_exposed, contributor_count = EXCLUDED.contributor_count,
    recent_events = EXCLUDED.recent_events, baseline_events = EXCLUDED.baseline_events,
    recent_rate = EXCLUDED.recent_rate, baseline_rate = EXCLUDED.baseline_rate,
    lift = EXCLUDED.lift, z_score = EXCLUDED.z_score,
    recurrence_rate = EXCLUDED.recurrence_rate, replacement_rate = EXCLUDED.replacement_rate,
    fix_rate = EXCLUDED.fix_rate, avg_repair_cost = EXCLUDED.avg_repair_cost,
    window_days = EXCLUDED.window_days,
    status_changed_at = CASE WHEN failure_patterns.status IS DISTINCT FROM EXCLUDED.status
                             THEN v_started ELSE failure_patterns.status_changed_at END,
    first_detected_at = COALESCE(failure_patterns.first_detected_at, EXCLUDED.first_detected_at),
    status = EXCLUDED.status,
    computed_at = v_started;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Evidence tags: published only when >= k distinct businesses reported the tag.
  INSERT INTO tmp_fg_tags (model_key, age_f, clim_f, failure_component, kind, tag, n)
  SELECT x.model_key, x.age_f, x.clim_f, x.failure_component, x.kind, x.tag, count(*)::integer
  FROM (
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'symptom' AS kind, unnest(symptoms) AS tag FROM tmp_fg_ev
    UNION ALL
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'part', unnest(parts) FROM tmp_fg_ev
    UNION ALL
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'repair', repair_action FROM tmp_fg_ev
    WHERE repair_action IS NOT NULL
  ) x
  GROUP BY x.model_key, x.age_f, x.clim_f, x.failure_component, x.kind, x.tag
  HAVING count(DISTINCT x.user_id) >= v_k;

  UPDATE failure_patterns fp SET
    top_symptoms = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'symptom'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb),
    top_parts = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'part'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb),
    top_repairs = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'repair'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb)
  WHERE fp.computed_at = v_started;

  -- Anything not re-published this run no longer clears the privacy gates (or the tenant opted out).
  DELETE FROM failure_patterns WHERE computed_at < v_started;

  -- Alert every exposed business exactly once, when a pattern NEWLY becomes emerging.
  FOR r_pat IN
    SELECT fp.id, fp.model_key, fp.failure_component, fp.age_band, fp.climate_band, fp.lift, fp.recent_events
    FROM failure_patterns fp
    LEFT JOIN tmp_fg_prev pv ON pv.id = fp.id
    WHERE fp.status = 'emerging' AND (pv.id IS NULL OR pv.status <> 'emerging')
  LOOP
    FOR r_ten IN
      SELECT u.user_id, count(DISTINCT u.equipment_id)::integer AS units
      FROM tmp_fg_units u
      WHERE u.model_key = r_pat.model_key AND u.age_f = r_pat.age_band AND u.clim_f = r_pat.climate_band
      GROUP BY u.user_id
    LOOP
      BEGIN
        PERFORM public.append_activity_event(
          'failure_pattern', r_pat.id, 'failure_genome.pattern_emerging',
          jsonb_build_object('model_key', r_pat.model_key, 'failure_component', r_pat.failure_component,
                             'age_band', r_pat.age_band, 'climate_band', r_pat.climate_band,
                             'lift', r_pat.lift, 'recent_events', r_pat.recent_events,
                             'your_units', r_ten.units),
          'system', NULL, NULL, '{}'::jsonb, r_ten.user_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'failure_genome notify failed: %', SQLERRM;
      END;
    END LOOP;
  END LOOP;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_failure_patterns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_failure_patterns(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.run_failure_genome_nightly()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  -- Re-age every genome (age bands move with time) and pick up climate-default changes.
  FOR r IN SELECT id FROM equipment LOOP
    BEGIN
      PERFORM public.fg_build_genome(r.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fg_build_genome(%) failed: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN public.refresh_failure_patterns(90);
END;
$$;

REVOKE ALL ON FUNCTION public.run_failure_genome_nightly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_failure_genome_nightly() TO service_role;

-- 7) Contractor RPC: patterns that touch MY units ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_failure_pattern_exposure(
  p_status text[] DEFAULT ARRAY['emerging', 'elevated']
)
RETURNS TABLE (pattern jsonb, my_units integer, my_equipment_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RETURN; END IF;
  -- Reciprocity: only businesses that contribute get the population view.
  IF EXISTS (SELECT 1 FROM business_profile bp
             WHERE bp.user_id = v_owner AND bp.failure_genome_contribute = false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT to_jsonb(fp), m.units, m.ids
  FROM failure_patterns fp
  JOIN LATERAL (
    SELECT count(*)::integer AS units, array_agg(g.equipment_id) AS ids
    FROM failure_genomes g
    WHERE g.user_id = v_owner AND g.status = 'active' AND g.model_key = fp.model_key
      AND (fp.age_band = 'any' OR g.age_band = fp.age_band)
      AND (fp.climate_band = 'any' OR g.climate_band = fp.climate_band)
  ) m ON m.units > 0
  WHERE fp.status = ANY(p_status)
  ORDER BY CASE fp.status WHEN 'emerging' THEN 0 WHEN 'elevated' THEN 1 WHEN 'stable' THEN 2 ELSE 3 END,
           fp.lift DESC NULLS LAST, m.units DESC
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.get_failure_pattern_exposure(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_failure_pattern_exposure(text[]) TO authenticated;

-- 8) Partner data product (OEM / distributor / insurer) ------------------------------------
CREATE TABLE IF NOT EXISTS failure_genome_partners (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('oem', 'distributor', 'insurer')),
  organization text NOT NULL,
  allowed_makes text[] NOT NULL DEFAULT '{}',  -- slugs, e.g. {carrier,trane}; oem + distributor
  allowed_types text[] NOT NULL DEFAULT '{}',  -- slugs, e.g. {hvac,water_heater}; insurer
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE failure_genome_partners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "partners_read_own_row" ON failure_genome_partners;
CREATE POLICY "partners_read_own_row" ON failure_genome_partners FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- No client writes: onboard/approve partners with SQL or the service role.

CREATE TABLE IF NOT EXISTS failure_genome_feed_access (
  id bigserial PRIMARY KEY,
  partner_id uuid NOT NULL,
  audience text NOT NULL,
  status_filter text[],
  accessed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE failure_genome_feed_access ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: audit trail readable by service role only.

CREATE OR REPLACE FUNCTION public.get_failure_pattern_feed(
  p_status text[] DEFAULT ARRAY['emerging', 'elevated'],
  p_limit integer DEFAULT 200
)
RETURNS SETOF failure_patterns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner failure_genome_partners%ROWTYPE;
BEGIN
  SELECT * INTO v_partner FROM failure_genome_partners fgp
  WHERE fgp.user_id = auth.uid() AND fgp.status = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not an approved Failure Genome partner' USING ERRCODE = '42501';
  END IF;

  INSERT INTO failure_genome_feed_access (partner_id, audience, status_filter)
  VALUES (v_partner.user_id, v_partner.audience, p_status);

  RETURN QUERY
  SELECT fp.* FROM failure_patterns fp
  WHERE fp.status = ANY(p_status)
    AND CASE WHEN v_partner.audience = 'insurer'
             THEN fp.type_key = ANY(v_partner.allowed_types)
             ELSE fp.make_key = ANY(v_partner.allowed_makes) END
  ORDER BY CASE fp.status WHEN 'emerging' THEN 0 WHEN 'elevated' THEN 1 WHEN 'stable' THEN 2 ELSE 3 END,
           fp.lift DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.get_failure_pattern_feed(text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_failure_pattern_feed(text[], integer) TO authenticated;

-- 9) Backfill: every existing unit gets a genome ------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM equipment LOOP
    BEGIN
      PERFORM public.fg_build_genome(r.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'genome backfill skipped for %: %', r.id, SQLERRM;
    END;
  END LOOP;
END $$;

-- 10) Nightly schedule (no-op, not an error, when pg_cron is unavailable) -------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-failure-genome-nightly');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-failure-genome-nightly', '40 3 * * *', 'select public.run_failure_genome_nightly()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
