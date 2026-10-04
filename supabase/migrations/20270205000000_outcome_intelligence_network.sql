/*
  # Vireek Outcome Intelligence Network (OIN)

  Every completed job becomes a structured, outcome-linked case:

    Problem -> Symptoms -> Diagnosis -> Technician -> Part -> Action
            -> Cost -> Outcome -> Callback -> Customer result

  Across the network, anonymized and privacy-preserving, Vireek learns which
  intervention actually resolves a problem for a given equipment make/model,
  symptom, climate and failure mode — with a calibrated probability.
  Every new contributing customer makes the answer better for everyone.

  ## Privacy model (all enforced in the database, not in the UI)
  1. OPT-IN: a tenant contributes only after its owner/admin switches it on
     (oin_settings.contribute). Withdrawal is honoured at the next refresh:
     the published statistics are rebuilt from contributing tenants only.
  2. CONTROLLED VOCABULARY: the network only ever sees taxonomy keys
     (oin_taxonomy), normalized equipment make/model/type, and a coarse
     climate band. No free text, names, addresses, ids, coordinates or dates.
  3. K-ANONYMITY + DOMINANCE: a published cell needs >= 5 distinct tenants,
     >= 10 matured cases, and no single tenant above 50% of the cell.
  4. STABLE CALIBRATED NOISE: rates get Laplace-style noise scaled 1/n, seeded
     by (cell, month) so re-running the refresh cannot be averaged away.
     This is DP-INSPIRED, not a formally certified epsilon-DP guarantee.
  5. GIVE-TO-GET: only contributing tenants can read network intelligence.
  6. MATURITY: an outcome counts only 30 days after the job, so callbacks and
     disputes are visible. Success = fixed AND no callback AND no dispute.

  Requires: jobs, equipment, job_equipment, job_outcomes
  (20261126000000_trade_playbooks_outcome_learning.sql), business_profile,
  team_members, profiles, get_account_owner_id(). Additive: nothing existing
  is altered.
*/

-- =============================================================
-- 0. PURE HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.oin_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(left(regexp_replace(lower(COALESCE(p, '')), '[^a-z0-9]+', '', 'g'), 40), ''), 'unknown');
$$;

CREATE OR REPLACE FUNCTION public.oin_trade_slug(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(COALESCE(p, '')) ~ 'hvac|heat|cool|air.?cond|refrig' THEN 'hvac'
    WHEN lower(COALESCE(p, '')) ~ 'plumb|drain|water.?heater' THEN 'plumbing'
    WHEN lower(COALESCE(p, '')) ~ 'electr' THEN 'electrical'
    ELSE 'other'
  END;
$$;

-- Latitude band is a deliberately coarse climate proxy (never stores coordinates).
CREATE OR REPLACE FUNCTION public.oin_climate_band(p_lat double precision)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_lat IS NULL OR p_lat NOT BETWEEN -90 AND 90 THEN 'unknown'
    WHEN abs(p_lat) < 23.5 THEN 'tropical'
    WHEN abs(p_lat) < 35 THEN 'subtropical'
    WHEN abs(p_lat) < 48 THEN 'temperate'
    WHEN abs(p_lat) < 60 THEN 'cold'
    ELSE 'subarctic'
  END;
$$;

-- Deterministic Laplace noise: same (seed, scale) always yields the same value.
CREATE OR REPLACE FUNCTION public.oin_stable_laplace(p_seed text, p_scale numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN u = 0 THEN 0::numeric ELSE -p_scale * sign(u) * ln(1 - 2 * abs(u)) END
  FROM (SELECT (hashtextextended(p_seed, 0) % 1000000)::numeric / 2000000.0 AS u) t;
$$;

CREATE OR REPLACE FUNCTION public.oin_wilson(p numeric, n numeric, p_upper boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 THEN NULL ELSE
    least(1, greatest(0,
      (p + c.z2 / (2 * n) + CASE WHEN p_upper THEN 1 ELSE -1 END * 1.96 * sqrt(greatest(0, (p * (1 - p) + c.z2 / (4 * n)) / n)))
      / (1 + c.z2 / n)))
  END
  FROM (SELECT 3.8416::numeric AS z2) c;
$$;

-- =============================================================
-- 1. TAXONOMY (controlled vocabulary — the ONLY thing the network sees)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.oin_taxonomy (
  kind text NOT NULL CHECK (kind IN ('symptom', 'failure_mode', 'action', 'part')),
  trade text NOT NULL CHECK (trade IN ('hvac', 'plumbing', 'electrical')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,48}$'),
  label text NOT NULL,
  PRIMARY KEY (kind, trade, key)
);

ALTER TABLE public.oin_taxonomy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_oin_taxonomy" ON public.oin_taxonomy;
CREATE POLICY "read_oin_taxonomy" ON public.oin_taxonomy FOR SELECT TO authenticated USING (true);
-- No client writes: maintained by migrations / service role only.

INSERT INTO public.oin_taxonomy (kind, trade, key, label)
SELECT v.kind, v.trade, k, initcap(replace(k, '_', ' '))
FROM (VALUES
  ('symptom', 'hvac', ARRAY['no_cooling','weak_cooling','no_heat','short_cycling','frozen_coil','noisy_operation','water_leak','high_energy_bill','thermostat_blank','intermittent_shutdown','bad_odor','uneven_temperatures']),
  ('failure_mode', 'hvac', ARRAY['low_refrigerant','failed_capacitor','failed_contactor','failed_compressor','dirty_coil','failed_blower_motor','failed_igniter','dirty_flame_sensor','clogged_condensate','failed_control_board','thermostat_fault','airflow_restriction','failed_txv']),
  ('action', 'hvac', ARRAY['leak_repair_and_recharge','replace_capacitor','replace_contactor','replace_compressor','clean_coil','replace_blower_motor','replace_igniter','clean_flame_sensor','clear_condensate_line','replace_control_board','replace_thermostat','replace_filter_restore_airflow','replace_txv','full_unit_replacement']),
  ('part', 'hvac', ARRAY['capacitor','contactor','compressor','refrigerant','blower_motor','igniter','flame_sensor','control_board','thermostat','filter','txv','condensate_pump']),
  ('symptom', 'plumbing', ARRAY['leaking_pipe','clogged_drain','no_hot_water','low_water_pressure','running_toilet','water_heater_leak','slab_leak_suspected','sewer_backup','noisy_pipes','dripping_faucet']),
  ('failure_mode', 'plumbing', ARRAY['failed_supply_line','root_intrusion','grease_blockage','failed_heating_element','failed_water_heater_thermostat','sediment_buildup','worn_flapper','failed_fill_valve','corroded_pipe','failed_pressure_regulator','cracked_fixture']),
  ('action', 'plumbing', ARRAY['replace_supply_line','hydro_jet_line','snake_drain','replace_heating_element','flush_water_heater','replace_flapper','replace_fill_valve','repipe_section','replace_pressure_regulator','replace_water_heater','camera_inspection_and_repair','replace_cartridge']),
  ('part', 'plumbing', ARRAY['supply_line','flapper','fill_valve','heating_element','anode_rod','pressure_regulator','cartridge','pipe_section','water_heater','p_trap']),
  ('symptom', 'electrical', ARRAY['breaker_tripping','dead_outlet','flickering_lights','burning_smell','panel_buzzing','gfci_wont_reset','partial_power_loss','ev_charger_fault','hot_outlet','voltage_fluctuation']),
  ('failure_mode', 'electrical', ARRAY['overloaded_circuit','loose_connection','failed_breaker','failed_gfci','damaged_wiring','bad_neutral','failed_switch','panel_corrosion','failed_surge_protector','ground_fault']),
  ('action', 'electrical', ARRAY['tighten_connections','replace_breaker','replace_gfci','rewire_circuit','add_dedicated_circuit','replace_switch','repair_neutral','replace_panel','install_surge_protection','replace_outlet']),
  ('part', 'electrical', ARRAY['breaker','gfci','outlet','switch','wire','panel','surge_protector','connector'])
) AS v(kind, trade, keys), unnest(v.keys) AS k
ON CONFLICT (kind, trade, key) DO NOTHING;

-- =============================================================
-- 2. CONSENT (opt-in, per tenant)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.oin_settings (
  user_id uuid PRIMARY KEY,
  contribute boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 1,
  consented_at timestamptz,
  consented_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.oin_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_oin_settings" ON public.oin_settings;
CREATE POLICY "select_own_oin_settings" ON public.oin_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client insert/update/delete: changed only through oin_set_contribution().

CREATE OR REPLACE FUNCTION public.oin_can_manage()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.role = 'admin' AND tm.invite_status = 'active'
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.oin_is_contributing(p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((SELECT s.contribute FROM oin_settings s WHERE s.user_id = p_owner), false);
$$;

CREATE OR REPLACE FUNCTION public.oin_can_read()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.oin_is_contributing(public.get_account_owner_id());
$$;

CREATE OR REPLACE FUNCTION public.oin_set_contribution(p_enabled boolean)
RETURNS public.oin_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.oin_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.oin_can_manage() THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: only an owner or admin can change data-sharing' USING ERRCODE = '42501';
  END IF;

  INSERT INTO oin_settings (user_id, contribute, consented_at, consented_by, updated_at)
  VALUES (v_owner, COALESCE(p_enabled, false), CASE WHEN p_enabled THEN now() END, CASE WHEN p_enabled THEN auth.uid() END, now())
  ON CONFLICT (user_id) DO UPDATE SET
    contribute = EXCLUDED.contribute,
    consented_at = CASE WHEN EXCLUDED.contribute AND NOT oin_settings.contribute THEN now() ELSE oin_settings.consented_at END,
    consented_by = CASE WHEN EXCLUDED.contribute AND NOT oin_settings.contribute THEN auth.uid() ELSE oin_settings.consented_by END,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- 3. CASE RECORDS (private, per tenant) — the full outcome chain
-- =============================================================

CREATE TABLE IF NOT EXISTS public.oin_case_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  trade text NOT NULL CHECK (trade IN ('hvac', 'plumbing', 'electrical')),
  equipment_type text NOT NULL DEFAULT 'unknown',
  equipment_make text NOT NULL DEFAULT 'unknown',
  equipment_model text NOT NULL DEFAULT 'unknown',
  equipment_age_band text NOT NULL DEFAULT 'unknown' CHECK (equipment_age_band IN ('unknown', 'lt5', '5_10', '10_15', 'gte15')),
  climate_band text NOT NULL DEFAULT 'unknown' CHECK (climate_band IN ('unknown', 'tropical', 'subtropical', 'temperate', 'cold', 'subarctic')),
  symptom_keys text[] NOT NULL CHECK (cardinality(symptom_keys) BETWEEN 1 AND 8),
  failure_mode text NOT NULL,
  action_key text NOT NULL,
  part_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(part_keys) <= 8),
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  resolution text,
  first_visit_fix boolean,
  caused_callback boolean,
  customer_disputed boolean,
  customer_rating smallint CHECK (customer_rating IS NULL OR customer_rating BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matured')),
  success boolean,
  matured_at timestamptz,
  predicted_success numeric(5,4) CHECK (predicted_success IS NULL OR predicted_success BETWEEN 0 AND 1),
  predicted_action_key text,
  captured_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR (success IS NOT NULL AND matured_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_oin_cases_user ON public.oin_case_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oin_cases_open ON public.oin_case_records (user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_oin_cases_matured ON public.oin_case_records (status, trade) WHERE status = 'matured';

ALTER TABLE public.oin_case_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_oin_cases" ON public.oin_case_records;
CREATE POLICY "select_own_oin_cases" ON public.oin_case_records FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_oin_cases" ON public.oin_case_records;
CREATE POLICY "delete_own_oin_cases" ON public.oin_case_records FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client insert/update: server-derived fields come from oin_record_case().

CREATE OR REPLACE FUNCTION public.oin_record_case(
  p_job_id uuid,
  p_symptoms text[],
  p_failure_mode text,
  p_action text,
  p_parts text[] DEFAULT '{}',
  p_equipment_id uuid DEFAULT NULL,
  p_predicted_success numeric DEFAULT NULL,
  p_predicted_action text DEFAULT NULL
)
RETURNS public.oin_case_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job record;
  v_eq record;
  v_out record;
  v_trade text;
  v_status text;
  v_symptoms text[];
  v_parts text[];
  v_age text;
  v_cost integer;
  v_row public.oin_case_records;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;

  SELECT j.id, j.job_status, j.latitude, j.completed_at, j.duration_minutes, j.invoice_amount, j.assigned_technician_id
    INTO v_job FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIN_JOB_NOT_FOUND: job not found' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.job_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'OIN_JOB_NOT_COMPLETED: only completed jobs can be captured' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status FROM oin_case_records WHERE job_id = p_job_id;
  IF v_status = 'matured' THEN
    RAISE EXCEPTION 'OIN_CASE_LOCKED: this case already matured and is sealed' USING ERRCODE = 'P0001';
  END IF;

  SELECT public.oin_trade_slug(bp.primary_industry) INTO v_trade FROM business_profile bp WHERE bp.user_id = v_owner;
  IF COALESCE(v_trade, 'other') = 'other' THEN
    RAISE EXCEPTION 'OIN_TRADE_UNSUPPORTED: set your primary industry to HVAC, Plumbing or Electrical in the business profile' USING ERRCODE = 'P0001';
  END IF;

  v_symptoms := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_symptoms, '{}')) x WHERE x IS NOT NULL ORDER BY x);
  v_parts := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_parts, '{}')) x WHERE x IS NOT NULL ORDER BY x);

  IF cardinality(v_symptoms) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'OIN_INVALID_INPUT: choose between 1 and 8 symptoms' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_parts) > 8 THEN
    RAISE EXCEPTION 'OIN_INVALID_INPUT: at most 8 parts' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM oin_taxonomy WHERE kind = 'symptom' AND trade = v_trade AND key = ANY (v_symptoms)) <> cardinality(v_symptoms)
     OR (SELECT count(*) FROM oin_taxonomy WHERE kind = 'part' AND trade = v_trade AND key = ANY (v_parts)) <> cardinality(v_parts)
     OR NOT EXISTS (SELECT 1 FROM oin_taxonomy WHERE kind = 'failure_mode' AND trade = v_trade AND key = p_failure_mode)
     OR NOT EXISTS (SELECT 1 FROM oin_taxonomy WHERE kind = 'action' AND trade = v_trade AND key = p_action) THEN
    RAISE EXCEPTION 'OIN_INVALID_TAXONOMY: unknown symptom, diagnosis, action or part for this trade' USING ERRCODE = 'P0001';
  END IF;

  SELECT e.equipment_type, e.make, e.model, e.install_date INTO v_eq
  FROM equipment e
  WHERE e.user_id = v_owner
    AND e.id = COALESCE(p_equipment_id, (SELECT je.equipment_id FROM job_equipment je WHERE je.job_id = p_job_id ORDER BY je.created_at LIMIT 1));

  v_age := CASE
    WHEN v_eq.install_date IS NULL THEN 'unknown'
    WHEN age(COALESCE(v_job.completed_at, now())::date, v_eq.install_date) < interval '5 years' THEN 'lt5'
    WHEN age(COALESCE(v_job.completed_at, now())::date, v_eq.install_date) < interval '10 years' THEN '5_10'
    WHEN age(COALESCE(v_job.completed_at, now())::date, v_eq.install_date) < interval '15 years' THEN '10_15'
    ELSE 'gte15'
  END;

  SELECT jo.resolution, jo.caused_callback, jo.customer_rating, jo.revenue_cents, jo.duration_minutes
    INTO v_out FROM job_outcomes jo WHERE jo.job_id = p_job_id;

  v_cost := COALESCE(v_out.revenue_cents, CASE WHEN v_job.invoice_amount IS NOT NULL THEN round(v_job.invoice_amount * 100)::integer END);

  INSERT INTO oin_case_records AS c (
    user_id, job_id, trade, equipment_type, equipment_make, equipment_model, equipment_age_band, climate_band,
    symptom_keys, failure_mode, action_key, part_keys, technician_id, cost_cents, duration_minutes,
    resolution, first_visit_fix, caused_callback, customer_rating,
    predicted_success, predicted_action_key, captured_by
  ) VALUES (
    v_owner, p_job_id, v_trade, public.oin_norm(v_eq.equipment_type), public.oin_norm(v_eq.make), public.oin_norm(v_eq.model),
    v_age, public.oin_climate_band(v_job.latitude),
    v_symptoms, p_failure_mode, p_action, v_parts, v_job.assigned_technician_id, v_cost,
    COALESCE(v_out.duration_minutes, v_job.duration_minutes),
    v_out.resolution, (v_out.resolution = 'fixed_first_visit'), v_out.caused_callback, v_out.customer_rating,
    p_predicted_success, p_predicted_action, auth.uid()
  )
  ON CONFLICT (job_id) DO UPDATE SET
    trade = EXCLUDED.trade, equipment_type = EXCLUDED.equipment_type, equipment_make = EXCLUDED.equipment_make,
    equipment_model = EXCLUDED.equipment_model, equipment_age_band = EXCLUDED.equipment_age_band,
    climate_band = EXCLUDED.climate_band, symptom_keys = EXCLUDED.symptom_keys, failure_mode = EXCLUDED.failure_mode,
    action_key = EXCLUDED.action_key, part_keys = EXCLUDED.part_keys, technician_id = EXCLUDED.technician_id,
    cost_cents = EXCLUDED.cost_cents, duration_minutes = EXCLUDED.duration_minutes, resolution = EXCLUDED.resolution,
    first_visit_fix = EXCLUDED.first_visit_fix, caused_callback = EXCLUDED.caused_callback,
    customer_rating = EXCLUDED.customer_rating, predicted_success = EXCLUDED.predicted_success,
    predicted_action_key = EXCLUDED.predicted_action_key, captured_by = EXCLUDED.captured_by
  WHERE c.status = 'open'
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- 4. MATURITY — outcome is final 30 days after the job
-- =============================================================

CREATE OR REPLACE FUNCTION public.oin_mature_cases(p_owner uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE oin_case_records c SET
    status = 'matured',
    resolution = jo.resolution,
    first_visit_fix = (jo.resolution = 'fixed_first_visit'),
    caused_callback = jo.caused_callback,
    customer_rating = jo.customer_rating,
    customer_disputed = COALESCE(j.customer_disputed, false),
    cost_cents = COALESCE(jo.revenue_cents, c.cost_cents),
    duration_minutes = COALESCE(jo.duration_minutes, c.duration_minutes),
    success = (jo.resolution IN ('fixed_first_visit', 'fixed_followup') AND NOT jo.caused_callback AND NOT COALESCE(j.customer_disputed, false)),
    matured_at = now()
  FROM jobs j
  JOIN job_outcomes jo ON jo.job_id = j.id
  WHERE c.job_id = j.id
    AND c.status = 'open'
    AND (p_owner IS NULL OR c.user_id = p_owner)
    AND COALESCE(j.completed_at, jo.recorded_at) <= now() - interval '30 days';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.oin_mature_my_cases()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  RETURN public.oin_mature_cases(public.get_account_owner_id());
END;
$$;

-- =============================================================
-- 5. NETWORK STATISTICS (shared, k-anonymous, service-role write only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.oin_network_stats (
  cell_key text PRIMARY KEY,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 8),
  trade text NOT NULL,
  equipment_type text NOT NULL,
  equipment_make text NOT NULL DEFAULT 'all',
  equipment_model text NOT NULL DEFAULT 'all',
  climate_band text NOT NULL DEFAULT 'all',
  symptom_key text NOT NULL,
  failure_mode text NOT NULL DEFAULT 'any',
  action_key text NOT NULL,
  contributor_count integer NOT NULL CHECK (contributor_count >= 5),
  case_count integer NOT NULL CHECK (case_count >= 10),
  success_rate numeric(5,4) NOT NULL,
  wilson_low numeric(5,4) NOT NULL,
  wilson_high numeric(5,4) NOT NULL,
  first_visit_rate numeric(5,4),
  callback_rate numeric(5,4),
  median_cost_cents integer,
  median_duration_minutes integer,
  avg_rating numeric(3,2),
  top_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oin_stats_lookup
  ON public.oin_network_stats (trade, equipment_type, symptom_key, action_key, level);

ALTER TABLE public.oin_network_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contributors_read_oin_stats" ON public.oin_network_stats;
CREATE POLICY "contributors_read_oin_stats" ON public.oin_network_stats FOR SELECT TO authenticated
  USING (public.oin_can_read());

CREATE OR REPLACE FUNCTION public.oin_refresh_network_stats()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c_min_contributors CONSTANT integer := 5;
  c_min_cases CONSTANT integer := 10;
  c_max_share CONSTANT numeric := 0.5;
  c_noise_eps CONSTANT numeric := 1.0;
  v_month text := to_char(now(), 'YYYY-MM');
  v_cells integer;
BEGIN
  DROP TABLE IF EXISTS tmp_oin_cells;

  -- One row per (matured case x symptom x level). Levels coarsen the context:
  -- 1 diagnosis+model+climate+make ... 4 diagnosis only, 5-8 same without diagnosis.
  CREATE TEMP TABLE tmp_oin_cells ON COMMIT DROP AS
  SELECT x.*, concat_ws('|', x.level, x.trade, x.equipment_type, x.equipment_make, x.equipment_model,
                        x.climate_band, x.symptom_key, x.failure_mode, x.action_key) AS cell_key
  FROM (
    SELECT lv.level::smallint AS level, c.trade, c.equipment_type,
           CASE WHEN lv.use_make THEN c.equipment_make ELSE 'all' END AS equipment_make,
           CASE WHEN lv.use_model THEN c.equipment_model ELSE 'all' END AS equipment_model,
           CASE WHEN lv.use_climate THEN c.climate_band ELSE 'all' END AS climate_band,
           sym AS symptom_key,
           CASE WHEN lv.use_fm THEN c.failure_mode ELSE 'any' END AS failure_mode,
           c.action_key, c.user_id,
           c.success, COALESCE(c.first_visit_fix, false) AS first_visit, COALESCE(c.caused_callback, false) AS callback,
           c.cost_cents, c.duration_minutes, c.customer_rating, c.part_keys AS parts
    FROM oin_case_records c
    JOIN oin_settings s ON s.user_id = c.user_id AND s.contribute
    CROSS JOIN LATERAL unnest(c.symptom_keys) AS sym
    CROSS JOIN (VALUES
      (1, true,  true,  true,  true),
      (2, true,  false, true,  true),
      (3, true,  false, false, true),
      (4, true,  false, false, false),
      (5, false, true,  true,  true),
      (6, false, false, true,  true),
      (7, false, false, false, true),
      (8, false, false, false, false)
    ) AS lv(level, use_fm, use_model, use_climate, use_make)
    WHERE c.status = 'matured' AND c.success IS NOT NULL AND c.equipment_type <> 'unknown'
      AND NOT (lv.use_make AND c.equipment_make = 'unknown')
      AND NOT (lv.use_model AND c.equipment_model = 'unknown')
      AND NOT (lv.use_climate AND c.climate_band = 'unknown')
  ) x;

  CREATE INDEX ON tmp_oin_cells (cell_key);

  DELETE FROM oin_network_stats WHERE true;

  INSERT INTO oin_network_stats (
    cell_key, level, trade, equipment_type, equipment_make, equipment_model, climate_band, symptom_key, failure_mode, action_key,
    contributor_count, case_count, success_rate, wilson_low, wilson_high, first_visit_rate, callback_rate,
    median_cost_cents, median_duration_minutes, avg_rating, computed_at
  )
  WITH tenant_counts AS (
    SELECT cell_key, user_id, count(*) AS c FROM tmp_oin_cells GROUP BY cell_key, user_id
  ), eligible AS (
    SELECT cell_key, count(*)::integer AS contributors, sum(c)::integer AS cases
    FROM tenant_counts GROUP BY cell_key
    HAVING count(*) >= c_min_contributors AND sum(c) >= c_min_cases AND max(c)::numeric / sum(c) <= c_max_share
  ), agg AS (
    SELECT t.cell_key, t.level, t.trade, t.equipment_type, t.equipment_make, t.equipment_model, t.climate_band,
           t.symptom_key, t.failure_mode, t.action_key, e.contributors, e.cases,
           avg(t.success::integer)::numeric AS p, avg(t.first_visit::integer)::numeric AS fv, avg(t.callback::integer)::numeric AS cb,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY t.cost_cents) AS med_cost,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_minutes) AS med_dur,
           avg(t.customer_rating)::numeric AS rating
    FROM tmp_oin_cells t JOIN eligible e USING (cell_key)
    GROUP BY t.cell_key, t.level, t.trade, t.equipment_type, t.equipment_make, t.equipment_model, t.climate_band,
             t.symptom_key, t.failure_mode, t.action_key, e.contributors, e.cases
  ), noised AS (
    SELECT a.*,
      least(1, greatest(0, a.p  + public.oin_stable_laplace(a.cell_key || '|p|'  || v_month, 1.0 / (c_noise_eps * a.cases)))) AS p_n,
      least(1, greatest(0, a.fv + public.oin_stable_laplace(a.cell_key || '|fv|' || v_month, 1.0 / (c_noise_eps * a.cases)))) AS fv_n,
      least(1, greatest(0, a.cb + public.oin_stable_laplace(a.cell_key || '|cb|' || v_month, 1.0 / (c_noise_eps * a.cases)))) AS cb_n
    FROM agg a
  )
  SELECT n.cell_key, n.level, n.trade, n.equipment_type, n.equipment_make, n.equipment_model, n.climate_band,
         n.symptom_key, n.failure_mode, n.action_key, n.contributors, n.cases,
         round(n.p_n, 4), round(public.oin_wilson(n.p_n, n.cases, false), 4), round(public.oin_wilson(n.p_n, n.cases, true), 4),
         round(n.fv_n, 4), round(n.cb_n, 4),
         CASE WHEN n.med_cost IS NULL THEN NULL ELSE (round(n.med_cost / 500.0) * 500)::integer END,
         CASE WHEN n.med_dur IS NULL THEN NULL ELSE (round(n.med_dur / 5.0) * 5)::integer END,
         round(n.rating, 2), now()
  FROM noised n;

  GET DIAGNOSTICS v_cells = ROW_COUNT;

  -- Top parts per cell: a part is published only if >= k distinct tenants used it.
  UPDATE oin_network_stats s SET top_parts = sub.parts
  FROM (
    SELECT r.cell_key,
           jsonb_agg(jsonb_build_object('part', r.part_key, 'share', round(r.uses::numeric / st.case_count, 2)) ORDER BY r.rn) AS parts
    FROM (
      SELECT p.cell_key, p.part_key, p.uses,
             row_number() OVER (PARTITION BY p.cell_key ORDER BY p.uses DESC, p.part_key) AS rn
      FROM (
        SELECT t.cell_key, pt AS part_key, count(*) AS uses
        FROM tmp_oin_cells t
        JOIN oin_network_stats s2 ON s2.cell_key = t.cell_key
        CROSS JOIN LATERAL unnest(t.parts) AS pt
        GROUP BY t.cell_key, pt
        HAVING count(DISTINCT t.user_id) >= c_min_contributors
      ) p
    ) r
    JOIN oin_network_stats st ON st.cell_key = r.cell_key
    WHERE r.rn <= 3
    GROUP BY r.cell_key
  ) sub
  WHERE s.cell_key = sub.cell_key;

  RETURN jsonb_build_object(
    'cells', v_cells,
    'contributors', (SELECT count(*) FROM oin_settings WHERE contribute),
    'computed_at', now()
  );
END;
$$;

-- =============================================================
-- 6. READ API (give-to-get)
-- =============================================================

CREATE OR REPLACE FUNCTION public.oin_recommend(
  p_trade text,
  p_equipment_type text,
  p_make text,
  p_model text,
  p_climate_band text,
  p_symptoms text[],
  p_failure_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_type text := public.oin_norm(p_equipment_type);
  v_make text := public.oin_norm(p_make);
  v_model text := public.oin_norm(p_model);
  v_climate text := COALESCE(NULLIF(p_climate_band, ''), 'unknown');
  v_fm text := COALESCE(NULLIF(p_failure_mode, ''), 'any');
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.oin_can_read() THEN
    RAISE EXCEPTION 'OIN_CONTRIBUTE_REQUIRED: turn on data-sharing to read network intelligence' USING ERRCODE = '42501';
  END IF;
  IF p_trade NOT IN ('hvac', 'plumbing', 'electrical') OR COALESCE(cardinality(p_symptoms), 0) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'OIN_INVALID_INPUT: trade and 1-8 symptoms are required' USING ERRCODE = 'P0001';
  END IF;

  WITH cand AS (
    SELECT DISTINCT ON (s.symptom_key, s.action_key) s.*
    FROM oin_network_stats s
    WHERE s.trade = p_trade AND s.equipment_type = v_type AND s.symptom_key = ANY (p_symptoms)
      AND s.equipment_make IN ('all', v_make)
      AND s.equipment_model IN ('all', v_model)
      AND s.climate_band IN ('all', v_climate)
      AND s.failure_mode IN ('any', v_fm)
    ORDER BY s.symptom_key, s.action_key, s.level
  ), best AS (
    SELECT DISTINCT ON (c.action_key) c.*
    FROM cand c
    ORDER BY c.action_key, c.wilson_low DESC, c.level
  ), ranked AS (
    SELECT b.*, tx.label AS action_label
    FROM best b
    LEFT JOIN oin_taxonomy tx ON tx.kind = 'action' AND tx.trade = b.trade AND tx.key = b.action_key
    ORDER BY b.wilson_low DESC, b.case_count DESC
    LIMIT 6
  )
  SELECT jsonb_build_object(
    'matched_cells', (SELECT count(*) FROM cand),
    'recommendations', COALESCE(jsonb_agg(jsonb_build_object(
      'action_key', r.action_key, 'action_label', COALESCE(r.action_label, r.action_key),
      'symptom_key', r.symptom_key, 'level', r.level,
      'contributor_count', r.contributor_count, 'case_count', r.case_count,
      'success_rate', r.success_rate, 'wilson_low', r.wilson_low, 'wilson_high', r.wilson_high,
      'first_visit_rate', r.first_visit_rate, 'callback_rate', r.callback_rate,
      'median_cost_cents', r.median_cost_cents, 'median_duration_minutes', r.median_duration_minutes,
      'avg_rating', r.avg_rating, 'top_parts', r.top_parts
    ) ORDER BY r.wilson_low DESC, r.case_count DESC), '[]'::jsonb)
  ) INTO v_result
  FROM ranked r;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.oin_network_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'OIN_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'contributing', public.oin_is_contributing(v_owner),
    'contributors', (SELECT count(*) FROM oin_settings WHERE contribute),
    'network_cases', (SELECT count(*) FROM oin_case_records c JOIN oin_settings s ON s.user_id = c.user_id AND s.contribute WHERE c.status = 'matured'),
    'published_cells', (SELECT count(*) FROM oin_network_stats),
    'last_computed_at', (SELECT max(computed_at) FROM oin_network_stats),
    'my_open', (SELECT count(*) FROM oin_case_records WHERE user_id = v_owner AND status = 'open'),
    'my_matured', (SELECT count(*) FROM oin_case_records WHERE user_id = v_owner AND status = 'matured'),
    'min_contributors', 5,
    'min_cases', 10
  );
END;
$$;

-- =============================================================
-- 7. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.oin_refresh_network_stats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.oin_mature_cases(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oin_refresh_network_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.oin_mature_cases(uuid) TO service_role;

-- Defense in depth on top of RLS: clients can never write these tables directly.
REVOKE ALL ON public.oin_network_stats, public.oin_settings, public.oin_taxonomy, public.oin_case_records FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.oin_network_stats, public.oin_settings, public.oin_taxonomy FROM authenticated;
REVOKE INSERT, UPDATE ON public.oin_case_records FROM authenticated;

GRANT EXECUTE ON FUNCTION public.oin_can_manage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_can_read() TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_set_contribution(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_record_case(uuid, text[], text, text, text[], uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_mature_my_cases() TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_recommend(text, text, text, text, text, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.oin_network_overview() TO authenticated;

-- =============================================================
-- 8. NIGHTLY SCHEDULE (no-op, not an error, if pg_cron is unavailable)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-oin-nightly');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-oin-nightly', '15 4 * * *',
      'select public.oin_mature_cases(); select public.oin_refresh_network_stats();');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
