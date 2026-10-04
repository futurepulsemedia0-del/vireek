/*
  # Vireek Adaptive Customer Diagnostic

  A diagnostic that is not a fixed form and not a chatbot: after every customer answer the server recomputes a
  probability distribution over the possible diagnoses and asks whichever question removes the most uncertainty
  per unit of customer effort (expected information gain / effort). Nothing is hard-wired as a tree.

  ## How it rewrites itself
  - Each confirmed job outcome (diag_confirm_outcome) updates, per account, the observed answer counts for the
    confirmed diagnosis. Likelihoods = expert seed blended with those counts, so the next customer is asked
    different/better questions.
  - Realized value of each question is MEASURED (change in probability of the true diagnosis), never invented:
    diag_question_stats + diag_learning_summary expose it, including the diagnosis-accuracy trend.
  - "None of these" outcomes are kept as unmapped for human review instead of being forced into a label.

  ## Security
  - Catalog + seed tables: read-only to signed-in users (written by migrations only).
  - Sessions / learned counts / stats: RLS by account owner. Customer-side writes happen ONLY in the
    adaptive-diagnostic edge function (service role, token-gated by jobs.reschedule_token).
  - Learning is isolated per account. No cross-tenant data is read or written.

  Requires: jobs (with reschedule_token), public.get_account_owner_id(). Safe to run on the current schema.
*/

-- =============================================================
-- 1. CATALOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.diag_domains (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{3,40}$'),
  label text NOT NULL,
  trade text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.diag_hypotheses (
  domain_code text NOT NULL REFERENCES public.diag_domains(code) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  label text NOT NULL,
  prior numeric NOT NULL CHECK (prior > 0 AND prior < 1),
  safety text NOT NULL DEFAULT 'none' CHECK (safety IN ('none', 'caution', 'hazard')),
  parts_hint text,
  PRIMARY KEY (domain_code, code)
);

CREATE TABLE IF NOT EXISTS public.diag_questions (
  domain_code text NOT NULL REFERENCES public.diag_domains(code) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 5 AND 200),
  help text CHECK (help IS NULL OR char_length(help) <= 300),
  effort smallint NOT NULL DEFAULT 1 CHECK (effort BETWEEN 1 AND 3),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  PRIMARY KEY (domain_code, code)
);

CREATE TABLE IF NOT EXISTS public.diag_likelihood_seed (
  domain_code text NOT NULL,
  hypothesis_code text NOT NULL,
  question_code text NOT NULL,
  probs jsonb NOT NULL CHECK (jsonb_typeof(probs) = 'array'),
  PRIMARY KEY (domain_code, hypothesis_code, question_code),
  FOREIGN KEY (domain_code, hypothesis_code) REFERENCES public.diag_hypotheses(domain_code, code) ON DELETE CASCADE,
  FOREIGN KEY (domain_code, question_code) REFERENCES public.diag_questions(domain_code, code) ON DELETE CASCADE
);

-- =============================================================
-- 2. PER-ACCOUNT LEARNING STATE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.diag_obs (
  user_id uuid NOT NULL,
  domain_code text NOT NULL,
  hypothesis_code text NOT NULL,
  question_code text NOT NULL,
  counts integer[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, domain_code, hypothesis_code, question_code)
);

CREATE TABLE IF NOT EXISTS public.diag_prior_obs (
  user_id uuid NOT NULL,
  domain_code text NOT NULL,
  hypothesis_code text NOT NULL,
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (user_id, domain_code, hypothesis_code)
);

CREATE TABLE IF NOT EXISTS public.diag_question_stats (
  user_id uuid NOT NULL,
  domain_code text NOT NULL,
  question_code text NOT NULL,
  asked_n integer NOT NULL DEFAULT 0 CHECK (asked_n >= 0),
  gain_sum numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, domain_code, question_code)
);

-- =============================================================
-- 3. SESSIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.diag_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  domain_code text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'hazard', 'unsupported')),
  answers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers) = 'array' AND jsonb_array_length(answers) <= 40),
  trace jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trace) = 'array' AND jsonb_array_length(trace) <= 40),
  posterior jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_hypothesis text,
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  hazard boolean NOT NULL DEFAULT false,
  stop_reason text,
  customer_text text CHECK (customer_text IS NULL OR char_length(customer_text) <= 1500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  confirmed_hypothesis text,
  confirmed_at timestamptz,
  confirmed_by uuid,
  confirm_note text CHECK (confirm_note IS NULL OR char_length(confirm_note) <= 1000),
  top1_correct boolean,
  outcome_applied_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_diag_sessions_job ON public.diag_sessions (user_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_sessions_unconfirmed ON public.diag_sessions (user_id) WHERE outcome_applied_at IS NULL;

COMMENT ON TABLE public.diag_sessions IS
  'Vireek Adaptive Customer Diagnostic: one customer intake per job. Written only by the adaptive-diagnostic edge function; outcome applied only via diag_confirm_outcome.';

-- =============================================================
-- 4. RLS
-- =============================================================

ALTER TABLE public.diag_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_likelihood_seed ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_obs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_prior_obs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_question_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "diag_domains_read" ON public.diag_domains;
CREATE POLICY "diag_domains_read" ON public.diag_domains FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "diag_hypotheses_read" ON public.diag_hypotheses;
CREATE POLICY "diag_hypotheses_read" ON public.diag_hypotheses FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "diag_questions_read" ON public.diag_questions;
CREATE POLICY "diag_questions_read" ON public.diag_questions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "diag_likelihood_seed_read" ON public.diag_likelihood_seed;
CREATE POLICY "diag_likelihood_seed_read" ON public.diag_likelihood_seed FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "diag_obs_read" ON public.diag_obs;
CREATE POLICY "diag_obs_read" ON public.diag_obs FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "diag_prior_obs_read" ON public.diag_prior_obs;
CREATE POLICY "diag_prior_obs_read" ON public.diag_prior_obs FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "diag_question_stats_read" ON public.diag_question_stats;
CREATE POLICY "diag_question_stats_read" ON public.diag_question_stats FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "diag_sessions_read" ON public.diag_sessions;
CREATE POLICY "diag_sessions_read" ON public.diag_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = diag_sessions.job_id));

REVOKE ALL ON public.diag_domains, public.diag_hypotheses, public.diag_questions, public.diag_likelihood_seed,
  public.diag_obs, public.diag_prior_obs, public.diag_question_stats, public.diag_sessions FROM anon, authenticated;
GRANT SELECT ON public.diag_domains, public.diag_hypotheses, public.diag_questions, public.diag_likelihood_seed,
  public.diag_obs, public.diag_prior_obs, public.diag_question_stats, public.diag_sessions TO authenticated;

-- =============================================================
-- 5. SEED: HVAC «no cooling» (expert priors; replaced by evidence as jobs are confirmed)
-- =============================================================

INSERT INTO public.diag_domains (code, label, trade, keywords) VALUES
  ('hvac_no_cooling', 'AC not cooling', 'hvac',
   ARRAY['not cooling','no cooling','not cold','warm air','blowing warm','blowing hot','hot inside','ac not','a/c','air condition','central air','condenser','compressor','won''t cool','wont cool','cooling'])
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.diag_hypotheses (domain_code, code, label, prior, safety, parts_hint) VALUES
  ('hvac_no_cooling','cap_fail','Failed run/start capacitor',0.17,'none','Dual run capacitor, hard-start kit, contactor'),
  ('hvac_no_cooling','cond_fan','Condenser fan motor failure',0.08,'none','Condenser fan motor, fan blade, capacitor'),
  ('hvac_no_cooling','low_refrig','Low refrigerant / leak',0.14,'none','Gauges, leak detector, refrigerant, nitrogen and brazing kit'),
  ('hvac_no_cooling','frozen_coil','Frozen evaporator coil (restricted airflow)',0.11,'none','Coil cleaner, filter, thermometer, drain tools'),
  ('hvac_no_cooling','dirty_filter','Clogged filter / restricted airflow',0.09,'none','Replacement filters in common sizes'),
  ('hvac_no_cooling','blower','Indoor blower motor or module failure',0.07,'none','Blower motor / ECM module, capacitor'),
  ('hvac_no_cooling','contactor','Contactor or control-voltage fault',0.08,'none','Contactor, 24V transformer, low-voltage fuse'),
  ('hvac_no_cooling','comp_fail','Compressor failure / locked rotor',0.06,'caution','Hard-start kit, amp clamp, quote tools for replacement or system change-out'),
  ('hvac_no_cooling','tstat','Thermostat or settings issue',0.08,'none','Thermostat, batteries, 18/5 wire'),
  ('hvac_no_cooling','drain_trip','Clogged drain line / float switch tripped',0.06,'none','Wet/dry vac, drain treatment, float switch'),
  ('hvac_no_cooling','dirty_cond','Dirty condenser coil',0.06,'none','Coil cleaner, hose, fin comb')
ON CONFLICT (domain_code, code) DO NOTHING;

INSERT INTO public.diag_questions (domain_code, code, text, help, effort, options) VALUES
  ('hvac_no_cooling','outdoor_state','What is the outdoor unit (the box outside) doing right now?','Stand near it for a few seconds and listen.',1,'[{"id": "fan_running", "label": "The fan on top is spinning"}, {"id": "humming", "label": "Humming or buzzing, but the fan is not spinning"}, {"id": "silent", "label": "Completely silent and still"}, {"id": "cycling", "label": "Clicking on and off"}]'::jsonb),
  ('hvac_no_cooling','airflow','How much air is coming out of the vents inside?',NULL,1,'[{"id": "strong", "label": "Strong airflow"}, {"id": "weak", "label": "Weak airflow"}, {"id": "none", "label": "No air at all"}]'::jsonb),
  ('hvac_no_cooling','air_temp','How does the air from the vents feel?',NULL,1,'[{"id": "cool", "label": "Cool, but not cold enough"}, {"id": "room", "label": "About room temperature"}, {"id": "warm", "label": "Warm"}]'::jsonb),
  ('hvac_no_cooling','ice','Do you see ice or frost on the pipes or the indoor unit?','Look at the copper pipes and the indoor unit (furnace or air handler).',2,'[{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}]'::jsonb),
  ('hvac_no_cooling','filter_age','When was the air filter last changed?',NULL,1,'[{"id": "new", "label": "Less than 3 months ago"}, {"id": "mid", "label": "3 to 12 months ago"}, {"id": "old", "label": "More than a year ago, or never"}]'::jsonb),
  ('hvac_no_cooling','water','Is there water around the indoor unit or the drain pan?',NULL,1,'[{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}]'::jsonb),
  ('hvac_no_cooling','breaker','Is any breaker tripped in your electrical panel?','Look for a breaker sitting in the middle or OFF position. Do not reset it if you smell burning.',2,'[{"id": "tripped", "label": "Yes, one is tripped"}, {"id": "fine", "label": "No, all look normal"}]'::jsonb),
  ('hvac_no_cooling','tstat_display','What does your thermostat show?',NULL,1,'[{"id": "blank", "label": "The screen is blank or frozen"}, {"id": "ok", "label": "It is on and set to Cool below room temperature"}]'::jsonb),
  ('hvac_no_cooling','onset','How did the problem start?',NULL,1,'[{"id": "sudden", "label": "Suddenly, it was working fine before"}, {"id": "gradual", "label": "Gradually, it has been getting worse"}]'::jsonb),
  ('hvac_no_cooling','age','About how old is the system?',NULL,1,'[{"id": "under5", "label": "Under 5 years"}, {"id": "mid", "label": "5 to 10 years"}, {"id": "old10", "label": "10 to 15 years"}, {"id": "over15", "label": "Over 15 years"}]'::jsonb),
  ('hvac_no_cooling','noise','Are you hearing any unusual noise?',NULL,1,'[{"id": "none", "label": "No unusual noise"}, {"id": "buzz", "label": "Buzzing or humming"}, {"id": "grind", "label": "Grinding or squealing"}, {"id": "hiss", "label": "Hissing or bubbling"}]'::jsonb),
  ('hvac_no_cooling','outdoor_dirty','Is the outdoor unit covered in dirt, leaves, or cottonwood?',NULL,2,'[{"id": "yes", "label": "Yes, it looks dirty or blocked"}, {"id": "no", "label": "No, it looks clean"}]'::jsonb),
  ('hvac_no_cooling','short_cycle','Does it start, then shut off again after a few minutes?',NULL,1,'[{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}]'::jsonb)
ON CONFLICT (domain_code, code) DO NOTHING;

INSERT INTO public.diag_likelihood_seed (domain_code, hypothesis_code, question_code, probs) VALUES
  ('hvac_no_cooling','cap_fail','outdoor_state','[0.1, 0.62, 0.18, 0.1]'::jsonb),
  ('hvac_no_cooling','cap_fail','air_temp','[0.1, 0.45, 0.45]'::jsonb),
  ('hvac_no_cooling','cap_fail','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','cap_fail','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','cap_fail','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','cap_fail','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','cap_fail','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','cap_fail','onset','[0.7, 0.3]'::jsonb),
  ('hvac_no_cooling','cap_fail','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','cap_fail','noise','[0.2, 0.6, 0.15, 0.05]'::jsonb),
  ('hvac_no_cooling','cap_fail','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','cap_fail','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','cond_fan','outdoor_state','[0.15, 0.55, 0.1, 0.2]'::jsonb),
  ('hvac_no_cooling','cond_fan','air_temp','[0.25, 0.4, 0.35]'::jsonb),
  ('hvac_no_cooling','cond_fan','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','cond_fan','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','cond_fan','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','cond_fan','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','cond_fan','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','cond_fan','onset','[0.5, 0.5]'::jsonb),
  ('hvac_no_cooling','cond_fan','age','[0.08, 0.22, 0.3, 0.4]'::jsonb),
  ('hvac_no_cooling','cond_fan','noise','[0.3, 0.3, 0.35, 0.05]'::jsonb),
  ('hvac_no_cooling','cond_fan','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','cond_fan','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','low_refrig','outdoor_state','[0.85, 0.02, 0.01, 0.12]'::jsonb),
  ('hvac_no_cooling','low_refrig','airflow','[0.8, 0.17, 0.03]'::jsonb),
  ('hvac_no_cooling','low_refrig','air_temp','[0.55, 0.35, 0.1]'::jsonb),
  ('hvac_no_cooling','low_refrig','ice','[0.45, 0.55]'::jsonb),
  ('hvac_no_cooling','low_refrig','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','low_refrig','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','low_refrig','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','low_refrig','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','low_refrig','onset','[0.15, 0.85]'::jsonb),
  ('hvac_no_cooling','low_refrig','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','low_refrig','noise','[0.6, 0.05, 0.05, 0.3]'::jsonb),
  ('hvac_no_cooling','low_refrig','outdoor_dirty','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','low_refrig','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','frozen_coil','outdoor_state','[0.75, 0.02, 0.03, 0.2]'::jsonb),
  ('hvac_no_cooling','frozen_coil','airflow','[0.15, 0.55, 0.3]'::jsonb),
  ('hvac_no_cooling','frozen_coil','air_temp','[0.3, 0.45, 0.25]'::jsonb),
  ('hvac_no_cooling','frozen_coil','ice','[0.97, 0.03]'::jsonb),
  ('hvac_no_cooling','frozen_coil','filter_age','[0.15, 0.3, 0.55]'::jsonb),
  ('hvac_no_cooling','frozen_coil','water','[0.4, 0.6]'::jsonb),
  ('hvac_no_cooling','frozen_coil','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','frozen_coil','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','frozen_coil','onset','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','frozen_coil','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','frozen_coil','noise','[0.55, 0.2, 0.15, 0.1]'::jsonb),
  ('hvac_no_cooling','frozen_coil','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','frozen_coil','short_cycle','[0.3, 0.7]'::jsonb),
  ('hvac_no_cooling','dirty_filter','outdoor_state','[0.9, 0.01, 0.01, 0.08]'::jsonb),
  ('hvac_no_cooling','dirty_filter','airflow','[0.15, 0.75, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_filter','air_temp','[0.55, 0.35, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_filter','ice','[0.3, 0.7]'::jsonb),
  ('hvac_no_cooling','dirty_filter','filter_age','[0.05, 0.25, 0.7]'::jsonb),
  ('hvac_no_cooling','dirty_filter','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','dirty_filter','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','dirty_filter','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','dirty_filter','onset','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','dirty_filter','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','dirty_filter','noise','[0.55, 0.2, 0.15, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_filter','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','dirty_filter','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','blower','outdoor_state','[0.85, 0.05, 0.05, 0.05]'::jsonb),
  ('hvac_no_cooling','blower','airflow','[0.02, 0.18, 0.8]'::jsonb),
  ('hvac_no_cooling','blower','air_temp','[0.1, 0.45, 0.45]'::jsonb),
  ('hvac_no_cooling','blower','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','blower','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','blower','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','blower','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','blower','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','blower','onset','[0.5, 0.5]'::jsonb),
  ('hvac_no_cooling','blower','age','[0.08, 0.22, 0.3, 0.4]'::jsonb),
  ('hvac_no_cooling','blower','noise','[0.3, 0.2, 0.4, 0.1]'::jsonb),
  ('hvac_no_cooling','blower','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','blower','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','contactor','outdoor_state','[0.05, 0.2, 0.65, 0.1]'::jsonb),
  ('hvac_no_cooling','contactor','airflow','[0.85, 0.12, 0.03]'::jsonb),
  ('hvac_no_cooling','contactor','air_temp','[0.05, 0.45, 0.5]'::jsonb),
  ('hvac_no_cooling','contactor','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','contactor','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','contactor','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','contactor','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','contactor','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','contactor','onset','[0.65, 0.35]'::jsonb),
  ('hvac_no_cooling','contactor','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','contactor','noise','[0.45, 0.3, 0.05, 0.2]'::jsonb),
  ('hvac_no_cooling','contactor','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','contactor','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','comp_fail','outdoor_state','[0.25, 0.35, 0.15, 0.25]'::jsonb),
  ('hvac_no_cooling','comp_fail','air_temp','[0.05, 0.4, 0.55]'::jsonb),
  ('hvac_no_cooling','comp_fail','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','comp_fail','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','comp_fail','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','comp_fail','breaker','[0.3, 0.7]'::jsonb),
  ('hvac_no_cooling','comp_fail','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','comp_fail','onset','[0.55, 0.45]'::jsonb),
  ('hvac_no_cooling','comp_fail','age','[0.05, 0.15, 0.3, 0.5]'::jsonb),
  ('hvac_no_cooling','comp_fail','noise','[0.2, 0.35, 0.35, 0.1]'::jsonb),
  ('hvac_no_cooling','comp_fail','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','comp_fail','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','tstat','outdoor_state','[0.1, 0.01, 0.8, 0.09]'::jsonb),
  ('hvac_no_cooling','tstat','airflow','[0.4, 0.1, 0.5]'::jsonb),
  ('hvac_no_cooling','tstat','air_temp','[0.05, 0.45, 0.5]'::jsonb),
  ('hvac_no_cooling','tstat','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','tstat','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','tstat','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','tstat','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','tstat','tstat_display','[0.8, 0.2]'::jsonb),
  ('hvac_no_cooling','tstat','onset','[0.7, 0.3]'::jsonb),
  ('hvac_no_cooling','tstat','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','tstat','noise','[0.55, 0.2, 0.15, 0.1]'::jsonb),
  ('hvac_no_cooling','tstat','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','tstat','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','drain_trip','outdoor_state','[0.1, 0.01, 0.8, 0.09]'::jsonb),
  ('hvac_no_cooling','drain_trip','airflow','[0.3, 0.1, 0.6]'::jsonb),
  ('hvac_no_cooling','drain_trip','air_temp','[0.05, 0.45, 0.5]'::jsonb),
  ('hvac_no_cooling','drain_trip','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','drain_trip','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','drain_trip','water','[0.85, 0.15]'::jsonb),
  ('hvac_no_cooling','drain_trip','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','drain_trip','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','drain_trip','onset','[0.5, 0.5]'::jsonb),
  ('hvac_no_cooling','drain_trip','age','[0.1, 0.25, 0.3, 0.35]'::jsonb),
  ('hvac_no_cooling','drain_trip','noise','[0.55, 0.2, 0.15, 0.1]'::jsonb),
  ('hvac_no_cooling','drain_trip','outdoor_dirty','[0.25, 0.75]'::jsonb),
  ('hvac_no_cooling','drain_trip','short_cycle','[0.2, 0.8]'::jsonb),
  ('hvac_no_cooling','dirty_cond','outdoor_state','[0.85, 0.02, 0.03, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_cond','air_temp','[0.55, 0.35, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_cond','ice','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','dirty_cond','filter_age','[0.3, 0.35, 0.35]'::jsonb),
  ('hvac_no_cooling','dirty_cond','water','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','dirty_cond','breaker','[0.08, 0.92]'::jsonb),
  ('hvac_no_cooling','dirty_cond','tstat_display','[0.05, 0.95]'::jsonb),
  ('hvac_no_cooling','dirty_cond','onset','[0.1, 0.9]'::jsonb),
  ('hvac_no_cooling','dirty_cond','age','[0.12, 0.28, 0.3, 0.3]'::jsonb),
  ('hvac_no_cooling','dirty_cond','noise','[0.7, 0.1, 0.1, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_cond','outdoor_dirty','[0.9, 0.1]'::jsonb),
  ('hvac_no_cooling','dirty_cond','short_cycle','[0.4, 0.6]'::jsonb)
ON CONFLICT (domain_code, hypothesis_code, question_code) DO NOTHING;

-- Seed integrity: priors sum to 1, every probability vector matches its question and sums to 1.
DO $$
DECLARE v_bad integer;
BEGIN
  IF abs((SELECT sum(prior) FROM public.diag_hypotheses WHERE domain_code = 'hvac_no_cooling') - 1) > 0.001 THEN
    RAISE EXCEPTION 'DIAG_SEED_INVALID: priors must sum to 1';
  END IF;
  SELECT count(*) INTO v_bad
  FROM public.diag_likelihood_seed s
  JOIN public.diag_questions q ON q.domain_code = s.domain_code AND q.code = s.question_code
  WHERE jsonb_array_length(s.probs) <> jsonb_array_length(q.options)
     OR abs((SELECT sum(x::numeric) FROM jsonb_array_elements_text(s.probs) x) - 1) > 0.011;
  IF v_bad > 0 THEN RAISE EXCEPTION 'DIAG_SEED_INVALID: % likelihood rows are inconsistent', v_bad; END IF;
END $$;

-- =============================================================
-- 6. OUTCOME CONFIRMATION = THE LEARNING STEP
-- =============================================================

CREATE OR REPLACE FUNCTION public.diag_confirm_outcome(p_session uuid, p_hypothesis text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.get_account_owner_id();
  s public.diag_sessions%ROWTYPE;
  step jsonb;
  v_opts jsonb;
  v_idx integer;
  v_len integer;
  v_gain numeric;
  v_applied integer := 0;
  v_other boolean := (p_hypothesis = '__other__');
BEGIN
  IF auth.uid() IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'DIAG_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  IF p_hypothesis IS NULL OR char_length(p_hypothesis) NOT BETWEEN 2 AND 40 THEN
    RAISE EXCEPTION 'DIAG_INVALID: choose a diagnosis' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO s FROM public.diag_sessions WHERE id = p_session AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DIAG_NOT_FOUND: diagnostic session not found' USING ERRCODE = 'P0001'; END IF;
  IF s.outcome_applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'DIAG_ALREADY_CONFIRMED: this outcome was already recorded' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_other THEN
    IF s.domain_code IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.diag_hypotheses h WHERE h.domain_code = s.domain_code AND h.code = p_hypothesis
    ) THEN
      RAISE EXCEPTION 'DIAG_INVALID: unknown diagnosis for this session' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.diag_prior_obs (user_id, domain_code, hypothesis_code, n)
    VALUES (v_uid, s.domain_code, p_hypothesis, 1)
    ON CONFLICT (user_id, domain_code, hypothesis_code) DO UPDATE SET n = public.diag_prior_obs.n + 1;

    FOR step IN SELECT value FROM jsonb_array_elements(s.trace) LOOP
      CONTINUE WHEN step->>'a' = 'unsure';
      SELECT q.options INTO v_opts FROM public.diag_questions q WHERE q.domain_code = s.domain_code AND q.code = step->>'q';
      CONTINUE WHEN v_opts IS NULL;
      v_idx := NULL;
      SELECT (t.ord - 1)::integer INTO v_idx
      FROM jsonb_array_elements(v_opts) WITH ORDINALITY AS t(o, ord) WHERE t.o->>'id' = step->>'a';
      CONTINUE WHEN v_idx IS NULL;
      v_len := jsonb_array_length(v_opts);

      INSERT INTO public.diag_obs (user_id, domain_code, hypothesis_code, question_code, counts)
      VALUES (
        v_uid, s.domain_code, p_hypothesis, step->>'q',
        (SELECT array_agg(CASE WHEN i = v_idx THEN 1 ELSE 0 END ORDER BY i)::integer[] FROM generate_series(0, v_len - 1) AS i)
      )
      ON CONFLICT (user_id, domain_code, hypothesis_code, question_code) DO UPDATE
        SET counts[v_idx + 1] = coalesce(public.diag_obs.counts[v_idx + 1], 0) + 1, updated_at = now();

      v_gain := coalesce((step->'after'->>p_hypothesis)::numeric, 0) - coalesce((step->'before'->>p_hypothesis)::numeric, 0);
      INSERT INTO public.diag_question_stats (user_id, domain_code, question_code, asked_n, gain_sum)
      VALUES (v_uid, s.domain_code, step->>'q', 1, v_gain)
      ON CONFLICT (user_id, domain_code, question_code) DO UPDATE
        SET asked_n = public.diag_question_stats.asked_n + 1,
            gain_sum = public.diag_question_stats.gain_sum + v_gain,
            updated_at = now();
      v_applied := v_applied + 1;
    END LOOP;
  END IF;

  UPDATE public.diag_sessions SET
    confirmed_hypothesis = p_hypothesis,
    confirmed_at = now(),
    confirmed_by = auth.uid(),
    confirm_note = nullif(btrim(coalesce(p_note, '')), ''),
    top1_correct = CASE WHEN v_other THEN NULL ELSE (s.top_hypothesis IS NOT DISTINCT FROM p_hypothesis) END,
    outcome_applied_at = now(),
    updated_at = now()
  WHERE id = s.id;

  RETURN jsonb_build_object(
    'top1_correct', CASE WHEN v_other THEN NULL ELSE (s.top_hypothesis IS NOT DISTINCT FROM p_hypothesis) END,
    'steps_learned', v_applied,
    'unmapped', v_other
  );
END;
$$;

REVOKE ALL ON FUNCTION public.diag_confirm_outcome(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.diag_confirm_outcome(uuid, text, text) TO authenticated;

-- =============================================================
-- 7. MEASURED LEARNING (no invented numbers)
-- =============================================================

CREATE OR REPLACE FUNCTION public.diag_learning_summary(p_domain text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH conf AS (
    SELECT s.id, s.top1_correct, jsonb_array_length(s.answers) AS n_answers,
           row_number() OVER (ORDER BY s.confirmed_at, s.id) AS rn
    FROM public.diag_sessions s
    WHERE s.outcome_applied_at IS NOT NULL AND s.top1_correct IS NOT NULL
      AND (p_domain IS NULL OR s.domain_code = p_domain)
  ),
  trend AS (
    SELECT ((rn - 1) / 10) AS bucket, count(*) AS n,
           round(avg(top1_correct::int)::numeric, 3) AS accuracy,
           round(avg(n_answers)::numeric, 1) AS avg_questions
    FROM conf GROUP BY 1
  )
  SELECT jsonb_build_object(
    'confirmed', (SELECT count(*) FROM conf),
    'accuracy', (SELECT round(avg(top1_correct::int)::numeric, 3) FROM conf),
    'trend', coalesce((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'n', n, 'accuracy', accuracy, 'avg_questions', avg_questions) ORDER BY bucket) FROM trend), '[]'::jsonb),
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'code', st.question_code, 'text', q.text, 'asked_n', st.asked_n,
        'avg_gain_pp', round(100 * st.gain_sum / nullif(st.asked_n, 0), 1)
      ) ORDER BY st.gain_sum / nullif(st.asked_n, 0) DESC NULLS LAST)
      FROM public.diag_question_stats st
      JOIN public.diag_questions q ON q.domain_code = st.domain_code AND q.code = st.question_code
      WHERE p_domain IS NULL OR st.domain_code = p_domain
    ), '[]'::jsonb),
    'awaiting_outcome', (SELECT count(*) FROM public.diag_sessions s WHERE s.outcome_applied_at IS NULL AND s.status IN ('open', 'completed') AND jsonb_array_length(s.answers) > 0 AND (p_domain IS NULL OR s.domain_code = p_domain)),
    'unmapped', (SELECT count(*) FROM public.diag_sessions s WHERE s.confirmed_hypothesis = '__other__' AND (p_domain IS NULL OR s.domain_code = p_domain))
  );
$$;

REVOKE ALL ON FUNCTION public.diag_learning_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.diag_learning_summary(text) TO authenticated;
