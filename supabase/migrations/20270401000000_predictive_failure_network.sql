/*
  # VIREEK Predictive Failure Network (PFN)

  Closed-loop failure intelligence:

    Equipment + age + service history + parts + weather + usage + repair outcomes + similar units
      -> failure probability (per unit, per failure mode)
      -> hand-off into the EXISTING Home Health Agent loop
         (governed customer outreach -> quote -> job -> dispatch -> repair -> verify)
      -> parts staged on the job
      -> real outcome (job_outcomes) scores the forecast
      -> calibration + per-failure-mode correction feed the next forecast

  ## Design rules
  - Prediction math lives in supabase/functions/_shared/predictive-failure/engine.ts (pure, unit-tested).
    SQL here only stores forecasts, scores them against real outcomes, and keeps the learning counters.
  - Forecasts are IMMUTABLE snapshots. They are scored on their own horizon, so accuracy numbers are honest.
  - Prevention paradox: a forecast followed by a completed intervention is labelled 'intervened'
    and excluded from calibration (we cannot know whether it would have failed).
  - Customer messaging is NOT sent from here. The hand-off creates a home_health_actions row, so outreach
    still passes Agent Governance, A2P/DNC compliance and the price book exactly as before.
  - Cross-module reads (job_outcomes, job_equipment, equipment) happen only inside plpgsql functions, so a
    column drift in another module can never make this migration fail to apply.

  Depends on: equipment, customers, jobs, job_equipment, job_outcomes, public.get_account_owner_id().
  Optional (graceful if missing): failure_atlas_cells, weather_surge_events, home_health_actions,
  lifecycle_passport_signals(), inventory_* tables.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 1) Failure-mode knowledge base (global, read-only for clients)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pfn_failure_modes (
  key text PRIMARY KEY,
  label text NOT NULL,
  families text[] NOT NULL,
  shape numeric(4, 2) NOT NULL CHECK (shape BETWEEN 0.5 AND 6),
  scale_months numeric(7, 1) CHECK (scale_months IS NULL OR scale_months > 0),
  aliases text[] NOT NULL DEFAULT '{}',
  part_keywords text[] NOT NULL DEFAULT '{}',
  maintenance_sensitive boolean NOT NULL DEFAULT false,
  runtime_driven boolean NOT NULL DEFAULT false,
  seasonal text NOT NULL DEFAULT 'none' CHECK (seasonal IN ('none', 'cooling', 'heating')),
  safety_critical boolean NOT NULL DEFAULT false,
  typical_cost_cents integer NOT NULL DEFAULT 0 CHECK (typical_cost_cents >= 0),
  intervention jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.pfn_failure_modes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_modes_read" ON public.pfn_failure_modes;
CREATE POLICY "pfn_modes_read" ON public.pfn_failure_modes FOR SELECT TO authenticated USING (active);

-- =============================================================
-- 2) Per-account settings and per-unit usage profile
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pfn_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  horizon_days integer NOT NULL DEFAULT 90 CHECK (horizon_days BETWEEN 30 AND 365),
  alert_threshold numeric(3, 2) NOT NULL DEFAULT 0.35 CHECK (alert_threshold BETWEEN 0.05 AND 0.95),
  auto_handoff boolean NOT NULL DEFAULT false,
  auto_stage_parts boolean NOT NULL DEFAULT true,
  last_scan_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pfn_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_settings_select" ON public.pfn_settings;
CREATE POLICY "pfn_settings_select" ON public.pfn_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pfn_settings_insert" ON public.pfn_settings;
CREATE POLICY "pfn_settings_insert" ON public.pfn_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pfn_settings_update" ON public.pfn_settings;
CREATE POLICY "pfn_settings_update" ON public.pfn_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS public.pfn_equipment_profiles (
  equipment_id uuid PRIMARY KEY REFERENCES public.equipment(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  duty_class text NOT NULL DEFAULT 'normal' CHECK (duty_class IN ('light', 'normal', 'heavy')),
  environment text NOT NULL DEFAULT 'normal' CHECK (environment IN ('normal', 'coastal', 'dusty', 'corrosive', 'humid')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pfn_profiles_user ON public.pfn_equipment_profiles(user_id);

ALTER TABLE public.pfn_equipment_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_profiles_select" ON public.pfn_equipment_profiles;
CREATE POLICY "pfn_profiles_select" ON public.pfn_equipment_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pfn_profiles_insert" ON public.pfn_equipment_profiles;
CREATE POLICY "pfn_profiles_insert" ON public.pfn_equipment_profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = equipment_id AND e.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pfn_profiles_update" ON public.pfn_equipment_profiles;
CREATE POLICY "pfn_profiles_update" ON public.pfn_equipment_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = equipment_id AND e.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pfn_profiles_delete" ON public.pfn_equipment_profiles;
CREATE POLICY "pfn_profiles_delete" ON public.pfn_equipment_profiles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3) Forecasts (immutable numbers; loop + outcome columns are updated by server code only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pfn_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  equipment_label text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days BETWEEN 30 AND 365),
  horizon_end timestamptz NOT NULL,
  probability numeric(5, 4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  raw_probability numeric(5, 4) NOT NULL CHECK (raw_probability BETWEEN 0 AND 1),
  ci_low numeric(5, 4),
  ci_high numeric(5, 4),
  band text NOT NULL CHECK (band IN ('critical', 'high', 'elevated', 'low')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'moderate', 'low')),
  calibrated boolean NOT NULL DEFAULT false,
  top_mode text,
  top_mode_label text,
  modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended jsonb,
  data_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_explanation text,
  exposure_cents bigint NOT NULL DEFAULT 0 CHECK (exposure_cents >= 0),
  engine_version text NOT NULL,
  -- loop state
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handed_off', 'resolved', 'dismissed', 'superseded')),
  hh_action_id uuid,                 -- soft reference to home_health_actions.id
  hh_quote_id uuid,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  loop_stage text,                   -- mirror of the Home Health action stage
  loop_blocked_reason text,
  parts_status text NOT NULL DEFAULT 'none' CHECK (parts_status IN ('none', 'not_needed', 'staged', 'backordered', 'partial', 'failed')),
  parts_detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  handed_off_at timestamptz,
  intervened_at timestamptz,
  -- outcome (scored against real job_outcomes)
  outcome text CHECK (outcome IN ('failed_in_window', 'no_failure', 'intervened', 'censored')),
  outcome_mode text,
  outcome_job_id uuid,
  outcome_at timestamptz,
  resolved_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now()
);

-- one live forecast per unit (resolved/dismissed ones keep their history)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pfn_live_forecast
  ON public.pfn_forecasts(equipment_id) WHERE status IN ('open', 'handed_off');
CREATE INDEX IF NOT EXISTS idx_pfn_forecasts_user_status ON public.pfn_forecasts(user_id, status, probability DESC);
CREATE INDEX IF NOT EXISTS idx_pfn_forecasts_equipment ON public.pfn_forecasts(equipment_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_pfn_forecasts_unscored ON public.pfn_forecasts(horizon_end) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_pfn_forecasts_hh_action ON public.pfn_forecasts(hh_action_id) WHERE hh_action_id IS NOT NULL;

ALTER TABLE public.pfn_forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_forecasts_select" ON public.pfn_forecasts;
CREATE POLICY "pfn_forecasts_select" ON public.pfn_forecasts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- no client INSERT/UPDATE/DELETE: probabilities and outcomes cannot be forged from the browser.

-- =============================================================
-- 4) Learning counters (server-written, owner-readable)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pfn_mode_stats (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text NOT NULL,
  expected numeric(12, 4) NOT NULL DEFAULT 0,
  observed integer NOT NULL DEFAULT 0,
  n integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode)
);

CREATE TABLE IF NOT EXISTS public.pfn_calibration_bins (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bin smallint NOT NULL CHECK (bin BETWEEN 0 AND 9),
  n integer NOT NULL DEFAULT 0,
  positives integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bin)
);

ALTER TABLE public.pfn_mode_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_mode_stats_select" ON public.pfn_mode_stats;
CREATE POLICY "pfn_mode_stats_select" ON public.pfn_mode_stats FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

ALTER TABLE public.pfn_calibration_bins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pfn_bins_select" ON public.pfn_calibration_bins;
CREATE POLICY "pfn_bins_select" ON public.pfn_calibration_bins FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 5) Seed: failure modes (expert priors - calibrated by YOUR outcomes and the network)
--    shape = Weibull beta (>1 = wear-out), scale_months = characteristic life (63rd percentile)
-- =============================================================
INSERT INTO public.pfn_failure_modes
  (key, label, families, shape, scale_months, aliases, part_keywords, maintenance_sensitive, runtime_driven, seasonal, safety_critical, typical_cost_cents, intervention)
VALUES
  ('capacitor_failure', 'Capacitor failure', '{hvac_cooling}', 2.0, 96, '{bad_capacitor,failed_capacitor,run_capacitor,capacitor}', '{capacitor}', true, false, 'cooling', false, 25000,
   '{"key":"replace_run_capacitor","label":"Test and replace the run capacitor","kind":"preventive_repair","parts":["Run capacitor"],"estMinutes":45}'),
  ('contactor_failure', 'Contactor failure', '{hvac_cooling}', 2.0, 108, '{bad_contactor,pitted_contactor,contactor}', '{contactor}', true, false, 'cooling', false, 28000,
   '{"key":"replace_contactor","label":"Inspect and replace the contactor","kind":"preventive_repair","parts":["Contactor"],"estMinutes":45}'),
  ('condenser_fan_motor_failure', 'Condenser fan motor failure', '{hvac_cooling}', 2.5, 132, '{condenser_fan_motor,fan_motor_failure,bad_fan_motor}', '{condenser fan,fan motor}', false, true, 'cooling', false, 55000,
   '{"key":"test_condenser_fan","label":"Test condenser fan motor and bearings","kind":"inspection","parts":[],"estMinutes":40}'),
  ('compressor_failure', 'Compressor failure', '{hvac_cooling}', 3.0, 180, '{bad_compressor,compressor_seized,compressor}', '{compressor}', true, true, 'cooling', false, 250000,
   '{"key":"compressor_health_check","label":"Compressor health check (amp draw, insulation resistance)","kind":"inspection","parts":[],"estMinutes":60}'),
  ('refrigerant_leak', 'Refrigerant leak', '{hvac_cooling}', 1.5, 144, '{low_refrigerant,refrigerant_leak,freon_leak}', '{refrigerant,freon}', false, false, 'none', false, 90000,
   '{"key":"refrigerant_leak_check","label":"Refrigerant leak check and pressure test","kind":"inspection","parts":[],"estMinutes":60}'),
  ('evaporator_coil_leak', 'Evaporator coil leak', '{hvac_cooling}', 2.5, 168, '{evaporator_coil,evap_coil_leak,coil_leak}', '{evaporator,evap coil}', false, false, 'none', false, 220000,
   '{"key":"coil_inspection","label":"Coil inspection and leak test","kind":"inspection","parts":[],"estMinutes":60}'),
  ('blower_motor_failure', 'Blower motor failure', '{hvac_cooling,hvac_heating}', 2.5, 144, '{bad_blower_motor,blower_motor,blower}', '{blower motor,blower}', true, true, 'none', false, 60000,
   '{"key":"test_blower_motor","label":"Test blower motor amperage and bearings","kind":"inspection","parts":[],"estMinutes":40}'),
  ('control_board_failure', 'Control board failure', '{hvac_cooling,hvac_heating}', 1.8, 120, '{bad_control_board,control_board,circuit_board}', '{control board,circuit board}', false, false, 'none', false, 45000,
   '{"key":"inspect_control_board","label":"Inspect control board for corrosion and burnt traces","kind":"inspection","parts":[],"estMinutes":30}'),
  ('igniter_failure', 'Igniter failure', '{hvac_heating}', 2.5, 72, '{bad_igniter,cracked_igniter,igniter,ignitor}', '{igniter,ignitor}', true, false, 'heating', false, 30000,
   '{"key":"replace_igniter","label":"Test igniter resistance and replace if weak","kind":"preventive_repair","parts":["Hot surface igniter"],"estMinutes":45}'),
  ('flame_sensor_fouling', 'Flame sensor fouling', '{hvac_heating}', 1.5, 60, '{dirty_flame_sensor,flame_sensor}', '{flame sensor}', true, false, 'heating', false, 18000,
   '{"key":"clean_flame_sensor","label":"Clean flame sensor and test microamps","kind":"maintenance","parts":[],"estMinutes":30}'),
  ('inducer_motor_failure', 'Inducer motor failure', '{hvac_heating}', 2.5, 144, '{bad_inducer,inducer_motor,draft_inducer}', '{inducer}', false, true, 'heating', false, 70000,
   '{"key":"test_inducer","label":"Test inducer motor and venting","kind":"inspection","parts":[],"estMinutes":45}'),
  ('heat_exchanger_crack', 'Heat exchanger crack', '{hvac_heating}', 3.5, 216, '{cracked_heat_exchanger,heat_exchanger}', '{heat exchanger}', false, false, 'heating', true, 300000,
   '{"key":"combustion_safety_check","label":"Combustion safety and heat-exchanger inspection","kind":"inspection","parts":[],"estMinutes":60}'),
  ('gas_valve_failure', 'Gas valve failure', '{hvac_heating}', 2.0, 180, '{bad_gas_valve,gas_valve}', '{gas valve}', false, false, 'heating', true, 45000,
   '{"key":"gas_valve_check","label":"Gas valve operation and leak test","kind":"inspection","parts":[],"estMinutes":40}'),
  ('pressure_switch_failure', 'Pressure switch failure', '{hvac_heating}', 1.8, 144, '{bad_pressure_switch,pressure_switch}', '{pressure switch}', false, false, 'heating', false, 25000,
   '{"key":"test_pressure_switch","label":"Test pressure switch and tubing","kind":"inspection","parts":[],"estMinutes":30}'),
  ('anode_rod_depleted', 'Anode rod depleted', '{water_heater}', 2.5, 60, '{anode_rod,depleted_anode}', '{anode}', true, false, 'none', false, 18000,
   '{"key":"replace_anode","label":"Inspect and replace the anode rod","kind":"preventive_repair","parts":["Anode rod"],"estMinutes":60}'),
  ('tank_leak', 'Tank leak', '{water_heater}', 3.5, 144, '{water_heater_leak,tank_leak,leaking_tank}', '{}', true, false, 'none', false, 120000,
   '{"key":"tank_corrosion_check","label":"Tank corrosion inspection and replacement planning","kind":"inspection","parts":[],"estMinutes":45}'),
  ('heating_element_failure', 'Heating element failure', '{water_heater}', 2.0, 96, '{bad_element,heating_element,element}', '{heating element,element}', false, true, 'none', false, 22000,
   '{"key":"test_heating_elements","label":"Test heating elements","kind":"inspection","parts":[],"estMinutes":30}'),
  ('water_heater_thermostat_failure', 'Thermostat failure', '{water_heater}', 2.0, 120, '{bad_thermostat,thermostat}', '{thermostat}', false, false, 'none', false, 20000,
   '{"key":"test_wh_thermostat","label":"Test thermostat and high-limit","kind":"inspection","parts":[],"estMinutes":30}'),
  ('tpr_valve_failure', 'T&P relief valve failure', '{water_heater}', 2.0, 144, '{tpr_valve,t_p_valve,pressure_relief_valve}', '{t&p,tpr,relief valve,pressure relief}', false, false, 'none', true, 15000,
   '{"key":"replace_tpr","label":"Test the temperature-pressure relief valve","kind":"preventive_repair","parts":["T&P relief valve"],"estMinutes":30}'),
  ('gas_burner_thermocouple_failure', 'Thermocouple / burner failure', '{water_heater}', 2.0, 96, '{thermocouple,bad_thermocouple,pilot}', '{thermocouple,thermopile}', true, false, 'none', false, 22000,
   '{"key":"clean_burner","label":"Clean burner assembly and test thermocouple","kind":"maintenance","parts":[],"estMinutes":40}'),
  ('sump_pump_failure', 'Sump pump failure', '{plumbing}', 2.5, 96, '{bad_sump_pump,sump_pump}', '{sump pump}', true, true, 'none', false, 90000,
   '{"key":"test_sump_pump","label":"Test sump pump, float switch and check valve","kind":"inspection","parts":[],"estMinutes":40}'),
  ('pressure_regulator_failure', 'Pressure regulator failure', '{plumbing}', 2.5, 156, '{prv,bad_prv,pressure_regulator}', '{pressure reducing,prv,regulator}', false, false, 'none', false, 55000,
   '{"key":"check_water_pressure","label":"Check static water pressure and regulator","kind":"inspection","parts":[],"estMinutes":30}'),
  ('supply_line_failure', 'Supply line failure', '{plumbing}', 2.0, 120, '{burst_supply_line,supply_line}', '{supply line,braided}', false, false, 'none', false, 35000,
   '{"key":"replace_supply_lines","label":"Inspect supply lines and replace aged flex connectors","kind":"preventive_repair","parts":["Braided supply line"],"estMinutes":30}'),
  ('generator_battery_failure', 'Generator battery failure', '{electrical}', 2.0, 48, '{generator_battery,bad_battery}', '{battery}', true, false, 'none', false, 30000,
   '{"key":"load_test_battery","label":"Load-test the generator battery","kind":"preventive_repair","parts":["Generator battery"],"estMinutes":30}'),
  ('end_of_life_wearout', 'End-of-life wear-out', '{hvac_cooling,hvac_heating,water_heater,plumbing,electrical,appliance,generic}', 4.0, NULL, '{end_of_life,worn_out,old_age}', '{}', false, false, 'none', false, 350000,
   '{"key":"plan_replacement","label":"Plan a replacement before the next breakdown","kind":"replacement_planning","parts":[],"estMinutes":240}')
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label, families = EXCLUDED.families, shape = EXCLUDED.shape, scale_months = EXCLUDED.scale_months,
  aliases = EXCLUDED.aliases, part_keywords = EXCLUDED.part_keywords, maintenance_sensitive = EXCLUDED.maintenance_sensitive,
  runtime_driven = EXCLUDED.runtime_driven, seasonal = EXCLUDED.seasonal, safety_critical = EXCLUDED.safety_critical,
  typical_cost_cents = EXCLUDED.typical_cost_cents, intervention = EXCLUDED.intervention;

-- =============================================================
-- 6) Evidence reader (service role only): per-unit corrective history from real job outcomes
-- =============================================================
CREATE OR REPLACE FUNCTION public.pfn_unit_history(p_owner uuid, p_equipment_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(t.equipment_id::text, t.events), '{}'::jsonb)
  INTO v
  FROM (
    SELECT x.equipment_id, jsonb_agg(x.ev ORDER BY x.occurred_at DESC) AS events
    FROM (
      SELECT je.equipment_id,
             jo.recorded_at AS occurred_at,
             jsonb_build_object(
               'at', jo.recorded_at,
               'type', jo.job_type_key,
               'root_cause', jo.root_cause_key,
               'parts', to_jsonb(coalesce(jo.parts_used, '{}'::text[])),
               'callback', coalesce(jo.caused_callback, false),
               'revenue_cents', jo.revenue_cents,
               'single', ((SELECT count(*) FROM job_equipment j2 WHERE j2.job_id = jo.job_id) = 1)
             ) AS ev,
             row_number() OVER (PARTITION BY je.equipment_id ORDER BY jo.recorded_at DESC) AS rn
      FROM job_equipment je
      JOIN equipment e ON e.id = je.equipment_id AND e.user_id = p_owner
      JOIN job_outcomes jo ON jo.job_id = je.job_id
      WHERE je.equipment_id = ANY (p_equipment_ids)
        AND jo.recorded_at >= now() - interval '48 months'
    ) x
    WHERE x.rn <= 60
    GROUP BY x.equipment_id
  ) t;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.pfn_unit_history(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pfn_unit_history(uuid, uuid[]) TO service_role;

-- =============================================================
-- 7) Scoring + learning: resolve forecasts against REAL outcomes
-- =============================================================
CREATE OR REPLACE FUNCTION public.pfn_resolve_forecasts(p_owner uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f record;
  m record;
  v_fail_job uuid;
  v_fail_at timestamptz;
  v_fail_key text;
  v_eq_status text;
  v_outcome text;
  v_recognized text;
  v_bin integer;
  v_resolved integer := 0;
BEGIN
  FOR f IN
    SELECT *
    FROM pfn_forecasts
    WHERE outcome IS NULL AND (p_owner IS NULL OR user_id = p_owner)
    ORDER BY issued_at
    LIMIT 5000
    FOR UPDATE SKIP LOCKED
  LOOP
    v_fail_job := NULL; v_fail_at := NULL; v_fail_key := NULL; v_recognized := NULL; v_outcome := NULL;

    -- first corrective (non-maintenance) outcome on a single-unit job inside the forecast window
    SELECT jo.job_id, jo.recorded_at,
           lower(btrim(regexp_replace(coalesce(jo.root_cause_key, ''), '[^a-zA-Z0-9]+', '_', 'g'), '_'))
    INTO v_fail_job, v_fail_at, v_fail_key
    FROM job_outcomes jo
    JOIN job_equipment je ON je.job_id = jo.job_id AND je.equipment_id = f.equipment_id
    WHERE jo.recorded_at > f.issued_at
      AND jo.recorded_at <= f.horizon_end
      AND coalesce(jo.job_type_key, '') !~* '(maint|tune.?up|inspect|clean|check.?up|seasonal|annual|filter|preventi|install|membership)'
      AND (SELECT count(*) FROM job_equipment j2 WHERE j2.job_id = jo.job_id) = 1
      -- our own proactive visit is the intervention, never the failure
      AND jo.job_id IS DISTINCT FROM f.job_id
      AND NOT EXISTS (SELECT 1 FROM jobs pj WHERE pj.id = jo.job_id AND pj.tags @> ARRAY['home-health']::text[])
    ORDER BY jo.recorded_at
    LIMIT 1;

    IF v_fail_at IS NOT NULL THEN
      IF f.intervened_at IS NOT NULL AND f.intervened_at <= v_fail_at THEN
        v_outcome := 'intervened';           -- we acted first; the unit still failed afterwards (outcome_mode records it)
      ELSE
        v_outcome := 'failed_in_window';
      END IF;
    ELSIF f.horizon_end <= now() THEN
      v_outcome := CASE WHEN f.intervened_at IS NOT NULL THEN 'intervened' ELSE 'no_failure' END;
    ELSE
      SELECT status INTO v_eq_status FROM equipment WHERE id = f.equipment_id;
      IF v_eq_status IS NOT NULL AND v_eq_status <> 'active' THEN
        v_outcome := 'censored';             -- unit removed/replaced before the window ended
      ELSE
        CONTINUE;                            -- still inside the window
      END IF;
    END IF;

    IF v_fail_at IS NOT NULL AND v_fail_key <> '' THEN
      SELECT key INTO v_recognized
      FROM pfn_failure_modes
      WHERE key = v_fail_key OR v_fail_key = ANY (aliases)
      LIMIT 1;
      IF v_recognized IS NULL AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(f.modes) e WHERE e->>'mode' = v_fail_key
      ) THEN
        v_recognized := v_fail_key;
      END IF;
    END IF;

    -- learning: only clean, uncontaminated outcomes train the model
    IF v_outcome IN ('failed_in_window', 'no_failure') THEN
      v_bin := least(9, greatest(0, floor(f.raw_probability * 10)::integer));
      INSERT INTO pfn_calibration_bins (user_id, bin, n, positives)
      VALUES (f.user_id, v_bin, 1, CASE WHEN v_outcome = 'failed_in_window' THEN 1 ELSE 0 END)
      ON CONFLICT (user_id, bin) DO UPDATE
        SET n = pfn_calibration_bins.n + 1,
            positives = pfn_calibration_bins.positives + EXCLUDED.positives,
            updated_at = now();

      -- per-mode Observed/Expected: skipped when the failure's cause is not recognisable (no mis-attribution)
      IF v_outcome = 'no_failure' OR v_recognized IS NOT NULL THEN
        FOR m IN
          SELECT e->>'mode' AS mode,
                 coalesce((e->>'baseProbability')::numeric, (e->>'rawProbability')::numeric, (e->>'probability')::numeric, 0) AS p
          FROM jsonb_array_elements(f.modes) e
          WHERE e->>'mode' IS NOT NULL
        LOOP
          INSERT INTO pfn_mode_stats (user_id, mode, expected, observed, n)
          VALUES (f.user_id, m.mode, m.p,
                  CASE WHEN v_outcome = 'failed_in_window' AND m.mode = v_recognized THEN 1 ELSE 0 END, 1)
          ON CONFLICT (user_id, mode) DO UPDATE
            SET expected = pfn_mode_stats.expected + EXCLUDED.expected,
                observed = pfn_mode_stats.observed + EXCLUDED.observed,
                n = pfn_mode_stats.n + 1,
                updated_at = now();
        END LOOP;

        -- the model did not even list the mode that happened: that is an observation too
        IF v_outcome = 'failed_in_window' AND v_recognized IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(f.modes) e WHERE e->>'mode' = v_recognized
        ) THEN
          INSERT INTO pfn_mode_stats (user_id, mode, expected, observed, n)
          VALUES (f.user_id, v_recognized, 0, 1, 1)
          ON CONFLICT (user_id, mode) DO UPDATE
            SET observed = pfn_mode_stats.observed + 1, n = pfn_mode_stats.n + 1, updated_at = now();
        END IF;
      END IF;
    END IF;

    UPDATE pfn_forecasts
    SET outcome = v_outcome,
        outcome_mode = coalesce(v_recognized, nullif(v_fail_key, '')),
        outcome_job_id = v_fail_job,
        outcome_at = coalesce(v_fail_at, f.horizon_end),
        resolved_at = now(),
        last_checked_at = now(),
        status = 'resolved'
    WHERE id = f.id;

    v_resolved := v_resolved + 1;
  END LOOP;

  RETURN v_resolved;
END;
$$;

REVOKE ALL ON FUNCTION public.pfn_resolve_forecasts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pfn_resolve_forecasts(uuid) TO service_role;

-- =============================================================
-- 8) Client-callable wrappers (always scoped to the caller's account)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pfn_sweep_my_forecasts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RETURN 0; END IF;
  RETURN public.pfn_resolve_forecasts(v_owner);
END;
$$;

CREATE OR REPLACE FUNCTION public.pfn_dismiss_forecast(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RETURN false; END IF;
  UPDATE pfn_forecasts
  SET status = 'dismissed'
  WHERE id = p_id AND user_id = v_owner AND status = 'open' AND outcome IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.pfn_my_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_units integer;
  v_open jsonb;
  v_loop jsonb;
  v_acc jsonb;
  v_bins jsonb;
  v_modes jsonb;
BEGIN
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_units FROM equipment WHERE user_id = v_owner AND status = 'active';

  SELECT jsonb_build_object(
    'total', count(*),
    'critical', count(*) FILTER (WHERE band = 'critical'),
    'high', count(*) FILTER (WHERE band = 'high'),
    'elevated', count(*) FILTER (WHERE band = 'elevated'),
    'exposure_cents', coalesce(sum(exposure_cents), 0)
  ) INTO v_open
  FROM pfn_forecasts WHERE user_id = v_owner AND status IN ('open', 'handed_off');

  SELECT jsonb_build_object(
    'issued', count(*),
    'handed_off', count(*) FILTER (WHERE handed_off_at IS NOT NULL),
    'contacted', count(*) FILTER (WHERE loop_stage IN ('awaiting_customer', 'scheduled', 'dispatched', 'repaired', 'verified')),
    'scheduled', count(*) FILTER (WHERE loop_stage IN ('scheduled', 'dispatched', 'repaired', 'verified')),
    'dispatched', count(*) FILTER (WHERE loop_stage IN ('dispatched', 'repaired', 'verified')),
    'completed', count(*) FILTER (WHERE loop_stage IN ('repaired', 'verified')),
    'declined', count(*) FILTER (WHERE loop_stage IN ('declined', 'expired', 'dismissed')),
    'parts_staged', count(*) FILTER (WHERE parts_status = 'staged'),
    'scored', count(*) FILTER (WHERE outcome IS NOT NULL)
  ) INTO v_loop
  FROM pfn_forecasts WHERE user_id = v_owner;

  WITH scored AS (
    SELECT probability::numeric AS p, (outcome = 'failed_in_window')::integer AS y
    FROM pfn_forecasts
    WHERE user_id = v_owner AND outcome IN ('failed_in_window', 'no_failure')
  ), agg AS (
    SELECT count(*) AS n, coalesce(sum(y), 0) AS failures,
           avg(power(p - y, 2)) AS brier, avg(y::numeric) AS base_rate
    FROM scored
  )
  SELECT jsonb_build_object(
    'scored', a.n,
    'failures', a.failures,
    'brier', round(a.brier, 4),
    'base_rate', round(a.base_rate, 4),
    'skill', CASE WHEN a.n > 0 AND a.base_rate > 0 AND a.base_rate < 1
                  THEN round(1 - a.brier / (a.base_rate * (1 - a.base_rate)), 4) END,
    'calibrated', a.n >= 30,
    'intervened', (SELECT count(*) FROM pfn_forecasts WHERE user_id = v_owner AND outcome = 'intervened'),
    'intervened_then_failed', (SELECT count(*) FROM pfn_forecasts WHERE user_id = v_owner AND outcome = 'intervened' AND outcome_mode IS NOT NULL),
    'censored', (SELECT count(*) FROM pfn_forecasts WHERE user_id = v_owner AND outcome = 'censored')
  ) INTO v_acc
  FROM agg a;

  SELECT coalesce(jsonb_agg(jsonb_build_object('bin', bin, 'n', n, 'positives', positives) ORDER BY bin), '[]'::jsonb)
  INTO v_bins FROM pfn_calibration_bins WHERE user_id = v_owner;

  SELECT coalesce(jsonb_agg(jsonb_build_object('mode', mode, 'expected', round(expected, 2), 'observed', observed, 'n', n) ORDER BY n DESC), '[]'::jsonb)
  INTO v_modes FROM (SELECT * FROM pfn_mode_stats WHERE user_id = v_owner ORDER BY n DESC LIMIT 20) s;

  RETURN jsonb_build_object(
    'monitored_units', v_units, 'open', v_open, 'loop', v_loop, 'accuracy', v_acc, 'bins', v_bins, 'modes', v_modes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pfn_sweep_my_forecasts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pfn_dismiss_forecast(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pfn_my_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pfn_sweep_my_forecasts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pfn_dismiss_forecast(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pfn_my_stats() TO authenticated;

-- =============================================================
-- 9) Nightly scoring (no-op, not an error, if pg_cron is absent)
-- =============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-pfn-resolve');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-pfn-resolve', '50 3 * * *', 'select public.pfn_resolve_forecasts()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
