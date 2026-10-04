/*
  # Vireek Field Intelligence Engine

  Turns every completed job into a labeled learning observation:

    Customer -> Property -> Equipment -> Symptoms -> Diagnosis -> Technician
      -> Skill -> Tools -> Part -> Action -> Cost -> Duration -> Outcome
      -> Callback -> Warranty -> Long-term outcome

  This is NOT an LLM. It is the data + labeling + evaluation layer that every
  Vireek model (diagnosis copilot, first-time-fix, outcome assurance, dispatch)
  is measured and improved against. All labeling is deterministic, explainable
  and auditable; humans can overrule it and their decision always wins.

  ## Tables (per account, RLS = get_account_owner_id(), clients SELECT only)
  - fie_observations   one chain snapshot per completed job + current outcome label
  - fie_actions        action-level rows (diagnosis / part / repair) with their own
                       success / failure / unknown label  -> technician-action,
                       part-outcome and diagnosis-outcome data
  - fie_outcome_events append-only temporal ledger (d7 / d30 / d90 / d365)
  - fie_signals        multimodal links (text, photo, sensor readings)
  - fie_adjudications  human adjudication audit trail
  - fie_eval_sets / fie_eval_cases  frozen, immutable evaluation datasets
  - fie_learning_runs  continuous-learning ledger (calibration, drift, label quality)
  - fie_settings       per-account switch for contributing to the network layer

  ## Network layer (shared, service-role written, k-anonymous)
  - fie_global_patterns  success rate per make/model x diagnosis/part, only when
                         >= 5 observations from >= 3 distinct accounts. Never
                         contains customer, address, free text or account ids.

  ## Depends on
  jobs, customers, customer_sites, equipment, job_equipment, team_members (skills),
  technician_tools, job_parts_required, inventory_parts, job_cost_entries,
  job_outcomes, diagnosis_sessions, callback_root_cause_analyses, warranty_claims,
  ftf_predictions, job_assurance_snapshots.
*/

-- =============================================================
-- 1. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_wilson_lower(s numeric, n numeric, z numeric DEFAULT 1.96)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 THEN NULL ELSE
    round(((s / n) + z * z / (2 * n) - z * sqrt(((s / n) * (1 - s / n) + z * z / (4 * n)) / n)) / (1 + z * z / n), 4)
  END
$$;

CREATE OR REPLACE FUNCTION public.fie_wilson_upper(s numeric, n numeric, z numeric DEFAULT 1.96)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 THEN NULL ELSE
    round(((s / n) + z * z / (2 * n) + z * sqrt(((s / n) * (1 - s / n) + z * z / (4 * n)) / n)) / (1 + z * z / n), 4)
  END
$$;

-- Fixed, closed taxonomy. Order = priority: root-cause tags first so that
-- (fie_tag_symptoms(x))[1] is the most diagnostic tag.
CREATE OR REPLACE FUNCTION public.fie_tag_symptoms(p_text text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text IS NULL OR btrim(p_text) = '' THEN '{}'::text[] ELSE
    array_remove(ARRAY[
      CASE WHEN p_text ~* 'refrigerant|freon|low charge|r-?410|r-?22|coil leak|leak.*coil' THEN 'refrigerant_leak' END,
      CASE WHEN p_text ~* 'capacitor|contactor|relay|blower motor|fan motor|condenser fan|compressor|control board|circuit board|transformer' THEN 'component_failure' END,
      CASE WHEN p_text ~* 'clog|drain line|slow drain|backup|overflow|blocked drain' THEN 'clog_drain' END,
      CASE WHEN p_text ~* 'ignit|flame sensor|no flame|lockout|pilot' THEN 'ignition_failure' END,
      CASE WHEN p_text ~* 'breaker|tripp|gfci|short circuit|fuse' THEN 'breaker_trip' END,
      CASE WHEN p_text ~* 'thermostat|t-?stat|setpoint' THEN 'thermostat' END,
      CASE WHEN p_text ~* 'freez|iced|frost|ice on' THEN 'freezing_coil' END,
      CASE WHEN p_text ~* 'water leak|leaking|dripping|puddle|flood|burst pipe' THEN 'water_leak' END,
      CASE WHEN p_text ~* 'roof|shingle|flashing|ceiling stain' THEN 'roof_leak' END,
      CASE WHEN p_text ~* 'gas smell|smell gas|gas leak|carbon monoxide|co alarm' THEN 'gas_smell' END,
      CASE WHEN p_text ~* 'no hot water|water heater|lukewarm|cold shower' THEN 'no_hot_water' END,
      CASE WHEN p_text ~* 'low (water )?pressure|weak flow' THEN 'low_pressure' END,
      CASE WHEN p_text ~* 'short.?cycl|keeps (turning|shutting)|cycles on and off' THEN 'short_cycling' END,
      CASE WHEN p_text ~* 'no cool|not cool|warm air|blowing warm|no cold|not blowing cold|no ac' THEN 'no_cooling' END,
      CASE WHEN p_text ~* 'no heat|not heat|furnace (not|won|isn)|blowing cold air' THEN 'no_heat' END,
      CASE WHEN p_text ~* 'weak air|low airflow|poor airflow|no airflow|restricted' THEN 'weak_airflow' END,
      CASE WHEN p_text ~* 'no power|dead|won.?t turn on|not turning on|blank display' THEN 'no_power' END,
      CASE WHEN p_text ~* 'error code|fault code|flashing code' THEN 'error_code' END,
      CASE WHEN p_text ~* 'noise|noisy|loud|rattl|bang|squeal|grind|buzz' THEN 'noise' END,
      CASE WHEN p_text ~* 'odor|smell|burning|musty' THEN 'odor' END
    ], NULL)
  END
$$;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS fie_settings (
  user_id uuid PRIMARY KEY,
  contribute_to_network boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fie_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL DEFAULT 1,

  -- chain: who / where / what
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  site_id uuid,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  equipment_type text,
  equipment_make text,
  equipment_model text,
  equipment_age_months integer,
  service_type text,
  symptoms text,
  symptom_tags text[] NOT NULL DEFAULT '{}',
  diagnosis text,
  diagnosis_tag text,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_skills text[] NOT NULL DEFAULT '{}',
  tools_used text[] NOT NULL DEFAULT '{}',
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions text[] NOT NULL DEFAULT '{}',
  modalities text[] NOT NULL DEFAULT '{}',
  cost_cents integer,
  revenue_cents integer,
  duration_minutes integer,
  observed_at timestamptz NOT NULL,

  -- outcome label (deterministic; human adjudication always wins)
  outcome_label text NOT NULL DEFAULT 'pending'
    CHECK (outcome_label IN ('pending', 'success', 'partial', 'failure', 'ambiguous')),
  label_source text NOT NULL DEFAULT 'system' CHECK (label_source IN ('system', 'human')),
  label_confidence numeric(4, 3) NOT NULL DEFAULT 0.5 CHECK (label_confidence BETWEEN 0 AND 1),
  uncertainty text NOT NULL DEFAULT 'high' CHECK (uncertainty IN ('low', 'medium', 'high')),
  needs_adjudication boolean NOT NULL DEFAULT false,
  outcome_reasons text[] NOT NULL DEFAULT '{}',
  matured_horizon text NOT NULL DEFAULT 'none' CHECK (matured_horizon IN ('none', 'd7', 'd30', 'd90', 'd365')),
  labeled_at timestamptz,
  built_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fie_obs_user_observed ON fie_observations(user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fie_obs_queue ON fie_observations(user_id, label_confidence) WHERE needs_adjudication = true;
CREATE INDEX IF NOT EXISTS idx_fie_obs_unmatured ON fie_observations(user_id, labeled_at NULLS FIRST)
  WHERE label_source = 'system' AND matured_horizon <> 'd365';
CREATE INDEX IF NOT EXISTS idx_fie_obs_equipment ON fie_observations(equipment_id) WHERE equipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fie_obs_technician ON fie_observations(technician_id) WHERE technician_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fie_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  observation_id uuid NOT NULL REFERENCES fie_observations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_kind text NOT NULL CHECK (action_kind IN ('diagnosis', 'part', 'repair')),
  label text NOT NULL,
  part_number text,
  action_key text NOT NULL,
  outcome_label text NOT NULL DEFAULT 'unknown' CHECK (outcome_label IN ('success', 'failure', 'unknown')),
  label_source text NOT NULL DEFAULT 'system' CHECK (label_source IN ('system', 'human')),
  label_confidence numeric(4, 3) NOT NULL DEFAULT 0.3 CHECK (label_confidence BETWEEN 0 AND 1),
  labeled_at timestamptz,
  UNIQUE (observation_id, action_kind, action_key)
);

CREATE INDEX IF NOT EXISTS idx_fie_actions_user_kind ON fie_actions(user_id, action_kind, action_key);
CREATE INDEX IF NOT EXISTS idx_fie_actions_observation ON fie_actions(observation_id);

CREATE TABLE IF NOT EXISTS fie_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  observation_id uuid NOT NULL REFERENCES fie_observations(id) ON DELETE CASCADE,
  horizon text NOT NULL CHECK (horizon IN ('job_close', 'd7', 'd30', 'd90', 'd365')),
  signal text NOT NULL CHECK (signal IN ('callback', 'warranty_claim', 'repeat_repair', 'customer_dispute', 'low_rating', 'unresolved', 'followup')),
  ref_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (observation_id, signal, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_fie_events_observation ON fie_outcome_events(observation_id);

CREATE TABLE IF NOT EXISTS fie_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  observation_id uuid NOT NULL REFERENCES fie_observations(id) ON DELETE CASCADE,
  modality text NOT NULL CHECK (modality IN ('text', 'photo', 'voice', 'video', 'sensor', 'document')),
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (observation_id, modality, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_fie_signals_observation ON fie_signals(observation_id);

CREATE TABLE IF NOT EXISTS fie_adjudications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  observation_id uuid NOT NULL REFERENCES fie_observations(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  proposed_label text NOT NULL,
  final_label text,
  decision text NOT NULL CHECK (decision IN ('confirm', 'override', 'unresolvable')),
  failed_kinds text[] NOT NULL DEFAULT '{}',
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fie_adjudications_user ON fie_adjudications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fie_adjudications_observation ON fie_adjudications(observation_id);

CREATE TABLE IF NOT EXISTS fie_eval_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  version integer NOT NULL,
  case_count integer NOT NULL DEFAULT 0,
  human_labeled_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);

CREATE TABLE IF NOT EXISTS fie_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  set_id uuid NOT NULL REFERENCES fie_eval_sets(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES fie_observations(id) ON DELETE SET NULL,
  stratum text NOT NULL,
  gold_label text NOT NULL CHECK (gold_label IN ('success', 'failure')),
  gold_source text NOT NULL CHECK (gold_source IN ('human', 'high_confidence_system')),
  gold_confidence numeric(4, 3) NOT NULL,
  input_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_fie_eval_cases_set ON fie_eval_cases(set_id);

-- Frozen means frozen: a case can never be edited after the set is built.
CREATE OR REPLACE FUNCTION public.fie_block_eval_case_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.observation_id IS NOT DISTINCT FROM OLD.observation_id
     AND NEW.gold_label = OLD.gold_label AND NEW.input_snapshot = OLD.input_snapshot
     AND NEW.set_id = OLD.set_id THEN
    RETURN NEW; -- observation_id may only be nulled by ON DELETE SET NULL
  END IF;
  IF NEW.observation_id IS NULL AND OLD.observation_id IS NOT NULL
     AND NEW.gold_label = OLD.gold_label AND NEW.input_snapshot = OLD.input_snapshot THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Evaluation cases are immutable once their set is frozen.';
END;
$$;

DROP TRIGGER IF EXISTS trg_fie_eval_case_immutable ON fie_eval_cases;
CREATE TRIGGER trg_fie_eval_case_immutable
  BEFORE UPDATE ON fie_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.fie_block_eval_case_update();

CREATE TABLE IF NOT EXISTS fie_learning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  observation_count integer NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fie_runs_user ON fie_learning_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fie_global_patterns (
  dimension text NOT NULL CHECK (dimension IN ('diagnosis', 'part')),
  equipment_make text NOT NULL DEFAULT '',
  equipment_model text NOT NULL DEFAULT '',
  action_key text NOT NULL,
  n_observations integer NOT NULL,
  n_accounts integer NOT NULL,
  n_success integer NOT NULL,
  success_rate numeric(5, 4) NOT NULL,
  wilson_lower numeric(5, 4) NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension, equipment_make, equipment_model, action_key)
);

-- =============================================================
-- 3. RLS — clients read their own account; every write goes through a function
-- =============================================================

ALTER TABLE fie_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_adjudications ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_eval_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_learning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fie_global_patterns ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fie_settings', 'fie_observations', 'fie_actions', 'fie_outcome_events', 'fie_signals',
                           'fie_adjudications', 'fie_eval_sets', 'fie_eval_cases', 'fie_learning_runs']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "select_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "select_own_%1$s" ON %1$I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "read_fie_global_patterns" ON fie_global_patterns;
CREATE POLICY "read_fie_global_patterns" ON fie_global_patterns FOR SELECT TO authenticated USING (true);

-- Only the account owner may change the network-contribution switch.
DROP POLICY IF EXISTS "insert_own_fie_settings" ON fie_settings;
CREATE POLICY "insert_own_fie_settings" ON fie_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_fie_settings" ON fie_settings;
CREATE POLICY "update_own_fie_settings" ON fie_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- =============================================================
-- 4. OUTCOME VIEWS (security_invoker -> caller's RLS applies)
-- =============================================================

CREATE OR REPLACE VIEW fie_diagnosis_outcomes_v WITH (security_invoker = true) AS
SELECT a.user_id,
       a.action_key AS diagnosis_tag,
       count(*)::int AS n,
       count(*) FILTER (WHERE a.outcome_label = 'success')::int AS n_success,
       round(count(*) FILTER (WHERE a.outcome_label = 'success')::numeric / count(*), 4) AS success_rate,
       public.fie_wilson_lower(count(*) FILTER (WHERE a.outcome_label = 'success'), count(*)) AS wilson_lower,
       public.fie_wilson_upper(count(*) FILTER (WHERE a.outcome_label = 'success'), count(*)) AS wilson_upper
FROM fie_actions a
WHERE a.action_kind = 'diagnosis' AND a.outcome_label IN ('success', 'failure') AND a.label_confidence >= 0.7
GROUP BY a.user_id, a.action_key;

CREATE OR REPLACE VIEW fie_part_outcomes_v WITH (security_invoker = true) AS
SELECT a.user_id,
       a.action_key AS part_key,
       max(a.label) AS part_label,
       count(*)::int AS n,
       count(*) FILTER (WHERE a.outcome_label = 'success')::int AS n_success,
       round(count(*) FILTER (WHERE a.outcome_label = 'success')::numeric / count(*), 4) AS success_rate,
       public.fie_wilson_lower(count(*) FILTER (WHERE a.outcome_label = 'success'), count(*)) AS wilson_lower,
       public.fie_wilson_upper(count(*) FILTER (WHERE a.outcome_label = 'success'), count(*)) AS wilson_upper
FROM fie_actions a
WHERE a.action_kind = 'part' AND a.outcome_label IN ('success', 'failure') AND a.label_confidence >= 0.7
GROUP BY a.user_id, a.action_key;

CREATE OR REPLACE VIEW fie_technician_outcomes_v WITH (security_invoker = true) AS
SELECT o.user_id,
       o.technician_id,
       tm.member_name AS technician_name,
       count(*)::int AS n,
       count(*) FILTER (WHERE o.outcome_label = 'success')::int AS n_success,
       round(count(*) FILTER (WHERE o.outcome_label = 'success')::numeric / count(*), 4) AS success_rate,
       public.fie_wilson_lower(count(*) FILTER (WHERE o.outcome_label = 'success'), count(*)) AS wilson_lower,
       public.fie_wilson_upper(count(*) FILTER (WHERE o.outcome_label = 'success'), count(*)) AS wilson_upper,
       round(avg(o.duration_minutes))::int AS avg_duration_minutes
FROM fie_observations o
LEFT JOIN team_members tm ON tm.id = o.technician_id
WHERE o.technician_id IS NOT NULL AND o.outcome_label IN ('success', 'failure') AND o.label_confidence >= 0.7
GROUP BY o.user_id, o.technician_id, tm.member_name;

-- =============================================================
-- 5. INGEST — completed jobs -> observations + actions + signals
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_ingest_owner(p_owner uuid, p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[];
BEGIN
  WITH new_jobs AS (
    SELECT j.*
    FROM jobs j
    WHERE j.user_id = p_owner
      AND j.job_status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM fie_observations o WHERE o.job_id = j.id)
    ORDER BY coalesce(j.completed_at, j.created_at) DESC
    LIMIT greatest(1, least(p_limit, 2000))
  ),
  ins AS (
    INSERT INTO fie_observations (
      user_id, job_id, customer_id, site_id, equipment_id, equipment_type, equipment_make, equipment_model,
      equipment_age_months, service_type, symptoms, symptom_tags, diagnosis, diagnosis_tag, technician_id,
      technician_skills, tools_used, parts, actions, cost_cents, revenue_cents, duration_minutes, observed_at
    )
    SELECT
      p_owner, j.id, j.customer_id, j.site_id, eq.id, eq.equipment_type, nullif(btrim(eq.make), ''), nullif(btrim(eq.model), ''),
      CASE WHEN eq.install_date IS NULL THEN NULL
           ELSE (extract(year FROM age(coalesce(j.completed_at, j.created_at)::date, eq.install_date)) * 12
               + extract(month FROM age(coalesce(j.completed_at, j.created_at)::date, eq.install_date)))::int END,
      j.service_type,
      left(concat_ws(' | ', nullif(btrim(ds.symptoms), ''), nullif(btrim(j.notes), ''), nullif(btrim(j.service_type), '')), 2000),
      public.fie_tag_symptoms(concat_ws(' ', ds.symptoms, j.notes, j.service_type)),
      left(nullif(btrim(j.technician_diagnosis), ''), 1000),
      (public.fie_tag_symptoms(j.technician_diagnosis))[1],
      j.assigned_technician_id,
      coalesce(tm.skills, '{}'),
      coalesce((SELECT array_agg(DISTINCT lower(btrim(tt.tool_name))) FROM technician_tools tt WHERE tt.team_member_id = tm.id), '{}'),
      coalesce(
        (SELECT jsonb_agg(jsonb_build_object('part_number', ip.part_number, 'name', ip.name, 'qty', jpr.quantity_required) ORDER BY ip.name)
           FROM job_parts_required jpr JOIN inventory_parts ip ON ip.id = jpr.part_id
          WHERE jpr.job_id = j.id AND jpr.status = 'installed'),
        (SELECT jsonb_agg(jsonb_build_object('part_number', NULL::text, 'name', pu)) FROM unnest(jo.parts_used) pu),
        '[]'::jsonb),
      CASE WHEN coalesce(cardinality(jo.checklist_done), 0) > 0 THEN jo.checklist_done
           WHEN nullif(btrim(j.service_type), '') IS NOT NULL THEN ARRAY[btrim(j.service_type)]
           ELSE '{}'::text[] END,
      coalesce((SELECT round(sum(c.amount) * 100)::int FROM job_cost_entries c WHERE c.job_id = j.id), jo.cost_cents),
      coalesce(round(j.invoice_amount * 100)::int, jo.revenue_cents),
      coalesce(jo.duration_minutes, j.duration_minutes),
      coalesce(j.completed_at, j.scheduled_datetime, j.created_at)
    FROM new_jobs j
    LEFT JOIN LATERAL (
      SELECT e.* FROM job_equipment je JOIN equipment e ON e.id = je.equipment_id
      WHERE je.job_id = j.id ORDER BY je.created_at, e.id LIMIT 1
    ) eq ON true
    LEFT JOIN team_members tm ON tm.id = j.assigned_technician_id
    LEFT JOIN job_outcomes jo ON jo.job_id = j.id
    LEFT JOIN LATERAL (
      SELECT d.symptoms FROM diagnosis_sessions d WHERE d.job_id = j.id ORDER BY d.created_at DESC LIMIT 1
    ) ds ON true
    ON CONFLICT (job_id) DO NOTHING
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM ins;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- diagnosis action
  INSERT INTO fie_actions (user_id, observation_id, job_id, action_kind, label, action_key)
  SELECT o.user_id, o.id, o.job_id, 'diagnosis', o.diagnosis, coalesce(o.diagnosis_tag, 'untagged')
  FROM fie_observations o
  WHERE o.id = ANY (v_ids) AND o.diagnosis IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- part actions
  INSERT INTO fie_actions (user_id, observation_id, job_id, action_kind, label, part_number, action_key)
  SELECT o.user_id, o.id, o.job_id, 'part', left(coalesce(pt->>'name', pt->>'part_number'), 200), pt->>'part_number',
         lower(btrim(coalesce(nullif(pt->>'part_number', ''), pt->>'name')))
  FROM fie_observations o, jsonb_array_elements(o.parts) pt
  WHERE o.id = ANY (v_ids) AND coalesce(nullif(pt->>'part_number', ''), pt->>'name') IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- repair actions
  INSERT INTO fie_actions (user_id, observation_id, job_id, action_kind, label, action_key)
  SELECT o.user_id, o.id, o.job_id, 'repair', left(ac, 200), lower(btrim(left(ac, 200)))
  FROM fie_observations o, unnest(o.actions) ac
  WHERE o.id = ANY (v_ids) AND btrim(ac) <> ''
  ON CONFLICT DO NOTHING;

  -- multimodal signals (diagnosis copilot sessions: text, photos, meter readings)
  INSERT INTO fie_signals (user_id, observation_id, modality, source_table, source_id, features)
  SELECT o.user_id, o.id, m.modality, 'diagnosis_sessions', d.id,
         CASE m.modality
           WHEN 'photo' THEN jsonb_build_object('photo_count', cardinality(d.photo_paths))
           WHEN 'sensor' THEN jsonb_build_object('has_readings', true)
           ELSE jsonb_build_object(
             'severity', d.severity, 'ai_confidence', d.confidence,
             'top_cause_tag', (public.fie_tag_symptoms(d.ai_result -> 'probable_causes' -> 0 ->> 'cause'))[1])
         END
  FROM fie_observations o
  JOIN diagnosis_sessions d ON d.job_id = o.job_id
  CROSS JOIN LATERAL (
    SELECT 'text'::text AS modality
    UNION ALL SELECT 'photo' WHERE cardinality(d.photo_paths) > 0
    UNION ALL SELECT 'sensor' WHERE nullif(btrim(d.meter_readings), '') IS NOT NULL
  ) m
  WHERE o.id = ANY (v_ids)
  ON CONFLICT DO NOTHING;

  UPDATE fie_observations o
  SET modalities = coalesce((SELECT array_agg(DISTINCT s.modality ORDER BY s.modality) FROM fie_signals s WHERE s.observation_id = o.id), '{}')
  WHERE o.id = ANY (v_ids);

  RETURN cardinality(v_ids);
END;
$$;

-- =============================================================
-- 6. LABEL — temporal events -> outcome labels -> action labels
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_label_owner(p_owner uuid, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT o.id FROM fie_observations o
    WHERE o.user_id = p_owner AND o.label_source = 'system' AND o.matured_horizon <> 'd365'
    ORDER BY o.labeled_at NULLS FIRST
    LIMIT greatest(1, least(p_limit, 5000))
  ) s;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- 6.0 late-arriving facts: costs / invoices are often entered after completion
  UPDATE fie_observations o
  SET cost_cents = coalesce(o.cost_cents, (SELECT round(sum(c.amount) * 100)::int FROM job_cost_entries c WHERE c.job_id = o.job_id)),
      revenue_cents = coalesce(o.revenue_cents, (SELECT round(j.invoice_amount * 100)::int FROM jobs j WHERE j.id = o.job_id))
  WHERE o.id = ANY (v_ids) AND (o.cost_cents IS NULL OR o.revenue_cents IS NULL);

  -- 6a. append temporal events (idempotent)
  INSERT INTO fie_outcome_events (user_id, observation_id, horizon, signal, ref_id, occurred_at, evidence)
  SELECT p_owner, ev.obs_id, h.horizon, ev.signal, ev.ref_id, ev.occurred_at, ev.evidence
  FROM (
    -- callbacks / rework (with root cause when the callback engine analysed it)
    SELECT o.id AS obs_id, c.id AS ref_id, c.created_at AS occurred_at, 'callback'::text AS signal,
           jsonb_build_object('cause', r.root_cause_category, 'part_number', ip.part_number) AS evidence,
           c.created_at - o.observed_at AS gap
    FROM fie_observations o
    JOIN jobs c ON c.user_id = p_owner AND c.rework_of_job_id = o.job_id AND c.created_at > o.observed_at
    LEFT JOIN callback_root_cause_analyses r ON r.callback_job_id = c.id AND r.original_job_id = o.job_id
    LEFT JOIN inventory_parts ip ON ip.id = r.part_id
    WHERE o.id = ANY (v_ids)
    UNION ALL
    -- callbacks the root-cause engine linked even though the job was not flagged as rework
    SELECT o.id, c.id, c.created_at, 'callback',
           jsonb_build_object('cause', r.root_cause_category, 'part_number', ip.part_number), c.created_at - o.observed_at
    FROM fie_observations o
    JOIN callback_root_cause_analyses r ON r.original_job_id = o.job_id AND r.user_id = p_owner
    JOIN jobs c ON c.id = r.callback_job_id AND c.created_at > o.observed_at AND c.rework_of_job_id IS DISTINCT FROM o.job_id
    LEFT JOIN inventory_parts ip ON ip.id = r.part_id
    WHERE o.id = ANY (v_ids)
    UNION ALL
    -- a later warranty claim on the same equipment = long-term failure signal
    -- (claims filed FOR this job are manufacturer recoveries, not failures)
    SELECT o.id, w.id, w.created_at, 'warranty_claim', jsonb_build_object('status', w.status), w.created_at - o.observed_at
    FROM fie_observations o
    JOIN warranty_claims w ON w.user_id = p_owner AND w.equipment_id = o.equipment_id
                          AND w.created_at > o.observed_at AND w.job_id IS DISTINCT FROM o.job_id
    WHERE o.id = ANY (v_ids) AND o.equipment_id IS NOT NULL
    UNION ALL
    -- same service type again on the same equipment (repairs only, not maintenance)
    SELECT o.id, j2.id, j2.created_at, 'repeat_repair', '{}'::jsonb, j2.created_at - o.observed_at
    FROM fie_observations o
    JOIN job_equipment je ON je.equipment_id = o.equipment_id AND je.job_id <> o.job_id
    JOIN jobs j2 ON j2.id = je.job_id AND j2.user_id = p_owner AND j2.created_at > o.observed_at
                AND j2.is_rework = false AND j2.rework_of_job_id IS NULL
                AND j2.service_type IS NOT DISTINCT FROM o.service_type
    WHERE o.id = ANY (v_ids) AND o.equipment_id IS NOT NULL AND o.service_type IS NOT NULL
      AND o.service_type !~* '(maint|tune|inspect|install|estimate|quote|replace)'
      AND j2.created_at - o.observed_at <= interval '90 days'
  ) ev(obs_id, ref_id, occurred_at, signal, evidence, gap)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN ev.gap <= interval '7 days' THEN 'd7' WHEN ev.gap <= interval '30 days' THEN 'd30'
                WHEN ev.gap <= interval '90 days' THEN 'd90' WHEN ev.gap <= interval '365 days' THEN 'd365' END AS horizon
  ) h
  WHERE h.horizon IS NOT NULL
  ON CONFLICT (observation_id, signal, ref_id) DO NOTHING;

  -- job-close signals (dispute, rating, resolution)
  INSERT INTO fie_outcome_events (user_id, observation_id, horizon, signal, ref_id, occurred_at, evidence)
  SELECT p_owner, o.id, 'job_close', s.signal, o.job_id, o.observed_at, '{}'::jsonb
  FROM fie_observations o
  JOIN jobs j ON j.id = o.job_id
  LEFT JOIN job_outcomes jo ON jo.job_id = o.job_id
  CROSS JOIN LATERAL (
    SELECT 'customer_dispute'::text AS signal WHERE j.customer_disputed
    UNION ALL SELECT 'low_rating' WHERE jo.customer_rating IS NOT NULL AND jo.customer_rating <= 2
    UNION ALL SELECT 'unresolved' WHERE jo.resolution = 'unresolved'
    UNION ALL SELECT 'followup' WHERE jo.resolution IN ('fixed_followup', 'parts_pending')
  ) s
  WHERE o.id = ANY (v_ids)
  ON CONFLICT (observation_id, signal, ref_id) DO NOTHING;

  -- 6b. derive the outcome label from events + maturity
  WITH agg AS (
    SELECT o.id,
      CASE WHEN o.observed_at <= now() - interval '365 days' THEN 'd365'
           WHEN o.observed_at <= now() - interval '90 days' THEN 'd90'
           WHEN o.observed_at <= now() - interval '30 days' THEN 'd30'
           WHEN o.observed_at <= now() - interval '7 days' THEN 'd7' ELSE 'none' END AS matured,
      coalesce(bool_or(e.signal = 'callback' AND coalesce(e.evidence ->> 'cause', '') NOT IN ('pre_existing_unrelated', 'customer_misuse')), false) AS attrib_cb,
      coalesce(bool_or(e.signal = 'callback' AND e.evidence ->> 'cause' IN ('pre_existing_unrelated', 'customer_misuse')), false) AS other_cb,
      coalesce(bool_or(e.signal = 'callback' AND coalesce(e.evidence ->> 'cause', 'unknown') <> 'unknown'), false) AS cb_explained,
      coalesce(bool_or(e.signal = 'unresolved'), false) AS unresolved,
      count(DISTINCT e.signal) FILTER (WHERE e.signal IN ('warranty_claim', 'repeat_repair', 'customer_dispute', 'low_rating', 'followup')) AS soft_n,
      coalesce(jo.resolution = 'fixed_first_visit', false) AS fixed_first
    FROM fie_observations o
    LEFT JOIN fie_outcome_events e ON e.observation_id = o.id
    LEFT JOIN job_outcomes jo ON jo.job_id = o.job_id
    WHERE o.id = ANY (v_ids) AND o.label_source = 'system'
    GROUP BY o.id, o.observed_at, jo.resolution
  ),
  lab AS (
    SELECT a.*,
      CASE WHEN a.attrib_cb OR a.unresolved THEN 'failure'
           WHEN a.other_cb THEN 'ambiguous'
           WHEN a.soft_n > 0 THEN 'partial'
           WHEN a.matured IN ('d30', 'd90', 'd365') THEN 'success'
           ELSE 'pending' END AS label
    FROM agg a
  ),
  conf AS (
    SELECT l.*,
      CASE l.label
        WHEN 'failure' THEN CASE WHEN l.unresolved THEN 0.85 WHEN l.cb_explained THEN 0.92 ELSE 0.80 END
        WHEN 'ambiguous' THEN 0.50
        WHEN 'partial' THEN CASE WHEN l.soft_n >= 2 THEN 0.70 ELSE 0.60 END
        WHEN 'success' THEN least(0.99, (CASE l.matured WHEN 'd365' THEN 0.95 WHEN 'd90' THEN 0.88 ELSE 0.78 END)
                                        + (CASE WHEN l.fixed_first THEN 0.04 ELSE 0 END))
        ELSE 0.50 END AS c
    FROM lab l
  )
  UPDATE fie_observations o
  SET outcome_label = c.label,
      label_confidence = c.c,
      uncertainty = CASE WHEN c.c >= 0.85 THEN 'low' WHEN c.c >= 0.65 THEN 'medium' ELSE 'high' END,
      needs_adjudication = (c.label = 'ambiguous' OR (c.label IN ('failure', 'partial') AND c.c < 0.85)),
      matured_horizon = c.matured,
      outcome_reasons = array_remove(ARRAY[
        CASE WHEN c.attrib_cb THEN 'callback' END, CASE WHEN c.other_cb THEN 'callback_not_attributable' END,
        CASE WHEN c.unresolved THEN 'unresolved' END, CASE WHEN c.soft_n > 0 THEN 'soft_signals:' || c.soft_n END,
        CASE WHEN c.fixed_first THEN 'fixed_first_visit' END], NULL),
      labeled_at = now()
  FROM conf c
  WHERE o.id = c.id AND o.label_source = 'system';

  -- 6c. action-level labels (system labels only; human labels are never touched)
  WITH cause AS (
    SELECT DISTINCT ON (e.observation_id) e.observation_id,
           e.evidence ->> 'cause' AS cause, e.evidence ->> 'part_number' AS part_number
    FROM fie_outcome_events e
    WHERE e.observation_id = ANY (v_ids) AND e.signal = 'callback'
      AND coalesce(e.evidence ->> 'cause', '') NOT IN ('pre_existing_unrelated', 'customer_misuse')
    ORDER BY e.observation_id, (e.evidence ->> 'cause' IS NOT NULL AND e.evidence ->> 'cause' <> 'unknown') DESC, e.occurred_at
  ),
  derived AS (
    SELECT a.id,
      CASE
        WHEN o.outcome_label = 'success' THEN 'success'
        WHEN o.outcome_label = 'failure' AND c.cause IN ('misdiagnosis', 'missed_related_issue') AND a.action_kind = 'diagnosis' THEN 'failure'
        WHEN o.outcome_label = 'failure' AND c.cause IN ('defective_part', 'wrong_part_installed') AND a.action_kind = 'part'
             AND (c.part_number IS NULL OR lower(btrim(c.part_number)) = a.action_key) THEN 'failure'
        WHEN o.outcome_label = 'failure' AND c.cause IN ('incomplete_repair', 'installation_error') AND a.action_kind = 'repair' THEN 'failure'
        ELSE 'unknown' END AS lbl,
      CASE
        WHEN o.outcome_label = 'success' THEN o.label_confidence
        WHEN o.outcome_label = 'failure' AND c.cause IN ('misdiagnosis', 'missed_related_issue', 'defective_part', 'wrong_part_installed', 'incomplete_repair', 'installation_error') THEN 0.85
        ELSE 0.30 END AS conf
    FROM fie_actions a
    JOIN fie_observations o ON o.id = a.observation_id
    LEFT JOIN cause c ON c.observation_id = a.observation_id
    WHERE a.observation_id = ANY (v_ids) AND a.label_source = 'system' AND o.label_source = 'system'
  )
  UPDATE fie_actions a
  SET outcome_label = d.lbl, label_confidence = d.conf, labeled_at = now()
  FROM derived d
  WHERE a.id = d.id;

  RETURN cardinality(v_ids);
END;
$$;

-- =============================================================
-- 7. CALIBRATION / CONTINUOUS LEARNING
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_calibration_json(p_probs numeric[], p_outcomes boolean[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n integer := coalesce(array_length(p_probs, 1), 0);
  i integer; b integer; y numeric; p numeric;
  cnt integer[] := array_fill(0, ARRAY[10]);
  sp numeric[] := array_fill(0::numeric, ARRAY[10]);
  sy numeric[] := array_fill(0::numeric, ARRAY[10]);
  brier numeric := 0; ece numeric := 0; base numeric := 0;
  bins jsonb := '[]'::jsonb;
BEGIN
  IF n = 0 THEN
    RETURN jsonb_build_object('n', 0);
  END IF;
  FOR i IN 1..n LOOP
    p := greatest(0, least(1, p_probs[i]));
    y := CASE WHEN p_outcomes[i] THEN 1 ELSE 0 END;
    b := least(9, floor(p * 10)::int) + 1;
    cnt[b] := cnt[b] + 1; sp[b] := sp[b] + p; sy[b] := sy[b] + y;
    brier := brier + power(p - y, 2); base := base + y;
  END LOOP;
  FOR b IN 1..10 LOOP
    IF cnt[b] > 0 THEN
      ece := ece + abs(sp[b] / cnt[b] - sy[b] / cnt[b]) * cnt[b];
      bins := bins || jsonb_build_array(jsonb_build_object(
        'bin', b, 'n', cnt[b], 'avg_predicted', round(sp[b] / cnt[b], 3), 'observed_rate', round(sy[b] / cnt[b], 3)));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('n', n, 'brier', round(brier / n, 4), 'ece', round(ece / n, 4),
                            'base_rate', round(base / n, 3), 'bins', bins);
END;
$$;

CREATE OR REPLACE FUNCTION public.fie_run_calibration(p_owner uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev fie_learning_runs%ROWTYPE;
  v_ftf jsonb; v_assure jsonb; v_metrics jsonb; v_total integer;
BEGIN
  SELECT * INTO v_prev FROM fie_learning_runs WHERE user_id = p_owner ORDER BY created_at DESC LIMIT 1;
  IF NOT p_force AND v_prev.id IS NOT NULL AND v_prev.created_at > now() - interval '30 minutes' THEN
    RETURN v_prev.metrics;
  END IF;

  SELECT public.fie_calibration_json(array_agg(x.p), array_agg(x.y)) INTO v_ftf
  FROM (
    SELECT DISTINCT ON (fp.job_id) fp.probability / 100.0 AS p, (o.outcome_label = 'success') AS y
    FROM ftf_predictions fp
    JOIN fie_observations o ON o.job_id = fp.job_id AND o.user_id = p_owner
    WHERE fp.account_owner_id = p_owner AND o.outcome_label IN ('success', 'failure') AND o.label_confidence >= 0.7
    ORDER BY fp.job_id, fp.updated_at DESC
  ) x;

  SELECT public.fie_calibration_json(array_agg(x.p), array_agg(x.y)) INTO v_assure
  FROM (
    SELECT DISTINCT ON (s.job_id) s.probability / 100.0 AS p, (o.outcome_label = 'success') AS y
    FROM job_assurance_snapshots s
    JOIN fie_observations o ON o.job_id = s.job_id AND o.user_id = p_owner
    WHERE s.user_id = p_owner AND o.outcome_label IN ('success', 'failure') AND o.label_confidence >= 0.7
    ORDER BY s.job_id, s.created_at DESC
  ) x;

  SELECT count(*) INTO v_total FROM fie_observations WHERE user_id = p_owner;

  v_metrics := jsonb_build_object(
    'total_observations', v_total,
    'label_counts', coalesce((SELECT jsonb_object_agg(outcome_label, n) FROM (
        SELECT outcome_label, count(*) AS n FROM fie_observations WHERE user_id = p_owner GROUP BY outcome_label) l), '{}'::jsonb),
    'adjudication_backlog', (SELECT count(*) FROM fie_observations WHERE user_id = p_owner AND needs_adjudication),
    'human', (SELECT jsonb_build_object('n', count(*),
                'override_rate', CASE WHEN count(*) = 0 THEN NULL ELSE round(count(*) FILTER (WHERE decision = 'override')::numeric / count(*), 3) END)
              FROM fie_adjudications WHERE user_id = p_owner AND decision <> 'unresolvable'),
    'coverage', (SELECT jsonb_build_object(
                'with_equipment', count(*) FILTER (WHERE equipment_id IS NOT NULL),
                'with_diagnosis', count(*) FILTER (WHERE diagnosis IS NOT NULL),
                'with_parts', count(*) FILTER (WHERE jsonb_array_length(parts) > 0),
                'with_technician', count(*) FILTER (WHERE technician_id IS NOT NULL),
                'multimodal', count(*) FILTER (WHERE cardinality(modalities) > 1),
                'with_cost', count(*) FILTER (WHERE cost_cents IS NOT NULL))
              FROM fie_observations WHERE user_id = p_owner),
    'copilot_agreement', (SELECT jsonb_build_object('n', count(*),
                'rate', CASE WHEN count(*) = 0 THEN NULL ELSE round(count(*) FILTER (WHERE s.features ->> 'top_cause_tag' = o.diagnosis_tag)::numeric / count(*), 3) END)
              FROM fie_signals s JOIN fie_observations o ON o.id = s.observation_id
              WHERE s.user_id = p_owner AND s.source_table = 'diagnosis_sessions' AND s.modality = 'text'
                AND s.features ->> 'top_cause_tag' IS NOT NULL AND o.diagnosis_tag IS NOT NULL),
    'ftf', v_ftf,
    'assurance', v_assure,
    'ftf_brier_delta', CASE WHEN (v_ftf ->> 'brier') IS NOT NULL AND (v_prev.metrics -> 'ftf' ->> 'brier') IS NOT NULL
                            THEN round((v_ftf ->> 'brier')::numeric - (v_prev.metrics -> 'ftf' ->> 'brier')::numeric, 4) END
  );

  INSERT INTO fie_learning_runs (user_id, observation_count, metrics) VALUES (p_owner, v_total, v_metrics);
  DELETE FROM fie_learning_runs WHERE user_id = p_owner AND id NOT IN (
    SELECT id FROM fie_learning_runs WHERE user_id = p_owner ORDER BY created_at DESC LIMIT 60);
  RETURN v_metrics;
END;
$$;

-- =============================================================
-- 8. ORCHESTRATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_refresh_owner(p_owner uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ingested integer; v_labeled integer; v_metrics jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('fie:' || p_owner::text, 0)) THEN
    RETURN jsonb_build_object('busy', true);
  END IF;
  v_ingested := public.fie_ingest_owner(p_owner);
  v_labeled := public.fie_label_owner(p_owner);
  v_metrics := public.fie_run_calibration(p_owner, p_force OR v_ingested > 0);
  RETURN jsonb_build_object('ingested', v_ingested, 'labeled', v_labeled, 'metrics', v_metrics);
END;
$$;

CREATE OR REPLACE FUNCTION public.fie_refresh_my_account()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised.' USING ERRCODE = '42501';
  END IF;
  RETURN public.fie_refresh_owner(v_owner, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fie_run_all()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT j.user_id FROM jobs j
    WHERE j.job_status = 'completed' AND j.created_at > now() - interval '400 days'
  LOOP
    BEGIN
      PERFORM public.fie_refresh_owner(r.user_id, false);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fie_run_all: owner % failed: %', r.user_id, SQLERRM;
    END;
  END LOOP;
  PERFORM public.fie_refresh_global_patterns();
  RETURN n;
END;
$$;

-- =============================================================
-- 9. HUMAN ADJUDICATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_adjudicate(
  p_observation_id uuid, p_final_label text, p_failed_kinds text[] DEFAULT '{}', p_notes text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  o fie_observations%ROWTYPE;
  v_kinds text[] := coalesce(p_failed_kinds, '{}');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can adjudicate outcomes.' USING ERRCODE = '42501';
  END IF;
  IF p_final_label IS NOT NULL AND p_final_label NOT IN ('success', 'partial', 'failure') THEN
    RAISE EXCEPTION 'final label must be success, partial or failure (or NULL for unresolvable).';
  END IF;
  IF NOT v_kinds <@ ARRAY['diagnosis', 'part', 'repair'] THEN
    RAISE EXCEPTION 'failed kinds must be diagnosis, part or repair.';
  END IF;

  SELECT * INTO o FROM fie_observations WHERE id = p_observation_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observation not found.' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO fie_adjudications (user_id, observation_id, reviewer_id, proposed_label, final_label, decision, failed_kinds, notes)
  VALUES (v_owner, o.id, auth.uid(), o.outcome_label, p_final_label,
          CASE WHEN p_final_label IS NULL THEN 'unresolvable' WHEN p_final_label = o.outcome_label THEN 'confirm' ELSE 'override' END,
          v_kinds, nullif(btrim(p_notes), ''));

  IF p_final_label IS NULL THEN
    UPDATE fie_observations SET needs_adjudication = false, outcome_label = 'ambiguous', label_source = 'human',
           label_confidence = 0.5, uncertainty = 'high', labeled_at = now() WHERE id = o.id;
    UPDATE fie_actions SET outcome_label = 'unknown', label_source = 'human', label_confidence = 0.3, labeled_at = now()
    WHERE observation_id = o.id;
    RETURN;
  END IF;

  UPDATE fie_observations SET outcome_label = p_final_label, label_source = 'human', label_confidence = 1,
         uncertainty = 'low', needs_adjudication = false, labeled_at = now() WHERE id = o.id;

  UPDATE fie_actions a
  SET outcome_label = CASE
        WHEN p_final_label = 'success' THEN 'success'
        WHEN a.action_kind = ANY (v_kinds) THEN 'failure'
        WHEN cardinality(v_kinds) = 0 THEN 'unknown'
        ELSE 'success' END,
      label_source = 'human',
      label_confidence = CASE WHEN p_final_label <> 'success' AND cardinality(v_kinds) = 0 THEN 0.3 ELSE 1 END,
      labeled_at = now()
  WHERE a.observation_id = o.id;
END;
$$;

-- =============================================================
-- 10. EVALUATION DATASETS (frozen, stratified, human-first)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_create_eval_set(p_name text, p_max_cases integer DEFAULT 500)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_set uuid; v_version integer; v_strata integer; v_per integer; v_max integer := greatest(10, least(coalesce(p_max_cases, 500), 5000));
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can create evaluation sets.' USING ERRCODE = '42501';
  END IF;

  DROP TABLE IF EXISTS _fie_pool;
  CREATE TEMP TABLE _fie_pool ON COMMIT DROP AS
  SELECT o.id, coalesce(o.service_type, 'unspecified') || ':' || o.outcome_label AS stratum,
         o.outcome_label AS gold_label, o.label_source, o.label_confidence,
         jsonb_build_object(
           'equipment_type', o.equipment_type, 'equipment_make', o.equipment_make, 'equipment_model', o.equipment_model,
           'equipment_age_months', o.equipment_age_months, 'service_type', o.service_type, 'symptoms', o.symptoms,
           'symptom_tags', o.symptom_tags, 'diagnosis_tag', o.diagnosis_tag, 'technician_skills', o.technician_skills,
           'tools_used', o.tools_used, 'parts', o.parts, 'actions', o.actions, 'modalities', o.modalities,
           'duration_minutes', o.duration_minutes, 'observed_at', o.observed_at) AS snap,
         row_number() OVER (PARTITION BY coalesce(o.service_type, 'unspecified'), o.outcome_label
                            ORDER BY (o.label_source = 'human') DESC, md5(o.id::text)) AS rn
  FROM fie_observations o
  WHERE o.user_id = v_owner AND o.outcome_label IN ('success', 'failure')
    AND (o.label_source = 'human' OR (o.label_confidence >= 0.9 AND o.matured_horizon IN ('d90', 'd365')));

  SELECT count(DISTINCT stratum) INTO v_strata FROM _fie_pool;
  IF coalesce(v_strata, 0) = 0 THEN
    RAISE EXCEPTION 'No eligible observations yet: need human-adjudicated or high-confidence matured outcomes.';
  END IF;
  v_per := greatest(1, ceil(v_max::numeric / v_strata)::int);

  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM fie_eval_sets WHERE user_id = v_owner;
  INSERT INTO fie_eval_sets (user_id, name, version, created_by)
  VALUES (v_owner, left(btrim(p_name), 120), v_version, auth.uid()) RETURNING id INTO v_set;

  INSERT INTO fie_eval_cases (user_id, set_id, observation_id, stratum, gold_label, gold_source, gold_confidence, input_snapshot)
  SELECT v_owner, v_set, p.id, p.stratum, p.gold_label,
         CASE WHEN p.label_source = 'human' THEN 'human' ELSE 'high_confidence_system' END, p.label_confidence, p.snap
  FROM _fie_pool p WHERE p.rn <= v_per
  ORDER BY (p.label_source = 'human') DESC, md5(p.id::text)
  LIMIT v_max;

  UPDATE fie_eval_sets s SET
    case_count = (SELECT count(*) FROM fie_eval_cases c WHERE c.set_id = s.id),
    human_labeled_count = (SELECT count(*) FROM fie_eval_cases c WHERE c.set_id = s.id AND c.gold_source = 'human')
  WHERE s.id = v_set;
  RETURN v_set;
END;
$$;

-- =============================================================
-- 11. NETWORK LAYER (k-anonymous, service-role / cron only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fie_refresh_global_patterns()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM fie_global_patterns WHERE true;

  WITH g AS (
    SELECT a.action_kind AS dimension, lower(coalesce(o.equipment_make, '')) AS make, lower(coalesce(o.equipment_model, '')) AS model,
           a.action_key, o.user_id, (a.outcome_label = 'success') AS ok
    FROM fie_actions a
    JOIN fie_observations o ON o.id = a.observation_id
    LEFT JOIN fie_settings s ON s.user_id = o.user_id
    WHERE a.action_kind IN ('diagnosis', 'part') AND a.outcome_label IN ('success', 'failure') AND a.label_confidence >= 0.7
      AND a.action_key NOT IN ('', 'untagged') AND o.equipment_make IS NOT NULL
      AND coalesce(s.contribute_to_network, true)
  )
  INSERT INTO fie_global_patterns (dimension, equipment_make, equipment_model, action_key, n_observations, n_accounts, n_success, success_rate, wilson_lower)
  SELECT g.dimension, g.make, g.model, g.action_key, count(*), count(DISTINCT g.user_id), count(*) FILTER (WHERE g.ok),
         round(count(*) FILTER (WHERE g.ok)::numeric / count(*), 4),
         public.fie_wilson_lower(count(*) FILTER (WHERE g.ok), count(*))
  FROM g
  GROUP BY g.dimension, g.make, g.model, g.action_key
  HAVING count(DISTINCT g.user_id) >= 3 AND count(*) >= 5
  UNION ALL
  SELECT g.dimension, g.make, '', g.action_key, count(*), count(DISTINCT g.user_id), count(*) FILTER (WHERE g.ok),
         round(count(*) FILTER (WHERE g.ok)::numeric / count(*), 4),
         public.fie_wilson_lower(count(*) FILTER (WHERE g.ok), count(*))
  FROM g
  GROUP BY g.dimension, g.make, g.action_key
  HAVING count(DISTINCT g.user_id) >= 3 AND count(*) >= 5
  ON CONFLICT (dimension, equipment_make, equipment_model, action_key) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- =============================================================
-- 12. PRIVILEGES — internal functions are never callable by clients
-- =============================================================

REVOKE ALL ON FUNCTION public.fie_ingest_owner(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fie_label_owner(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fie_run_calibration(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fie_refresh_owner(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fie_run_all() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fie_refresh_global_patterns() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fie_refresh_my_account() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fie_adjudicate(uuid, text, text[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fie_create_eval_set(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fie_refresh_my_account() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fie_adjudicate(uuid, text, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fie_create_eval_set(text, integer) TO authenticated;

-- Nightly learning cycle (same guarded pg_cron idiom as the other engines).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-field-intelligence', '20 4 * * *', 'select public.fie_run_all()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule vireek-field-intelligence: %', SQLERRM;
END $$;
