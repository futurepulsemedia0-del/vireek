/*
  # Outcome Learning — Calibration, Experiments, Safe Policy Learning,
    Cross-Tenant Boundaries, Dataset, Observability (Parts 2–4)

  Depends on 20290101000000_outcome_learning_foundation.sql. No destructive change.
  Every behaviour-changing step is behind a per-account flag in
  outcome_learning_settings (all default OFF/0):
    capture_enabled (foundation) · holdout is per-experiment ·
    auto_apply_low_risk · share_cross_tenant

  Sections
   A. settings flags + wilson_lower_bound()
   B. prediction calibration (prediction_log, predictor_status, views, drift)
   C. randomized-holdout experiments (+ legacy causal numbers labelled unadjusted)
   D. bounded, reversible learning (learning_policy_changes, auto-apply, rollback)
   E. alerts (coverage drop, predictor demotion/drift, rollback)
   F. cross-tenant aggregates: >=5 tenants AND dominance <=50% AND n>=30,
      hashed contribution audit, no free text (enforced by CHECK constraints)
   G. versioned dataset view outcome_dataset_v1 (service role only)
   H. flywheel_promotions accepts source_type 'measured_outcome'

  Rollback (manual): drop the objects created here (tables/views/functions listed
  above); nothing in existing tables is altered except new nullable/default columns
  on outcome_learning_settings and a widened CHECK on flywheel_promotions.
*/

-- =============================================================
-- A. flags + helper
-- =============================================================
ALTER TABLE outcome_learning_settings
  ADD COLUMN IF NOT EXISTS auto_apply_low_risk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_cross_tenant boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.set_outcome_learning_flags(p_auto_apply boolean DEFAULT NULL, p_share boolean DEFAULT NULL)
RETURNS outcome_learning_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row outcome_learning_settings;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can change outcome learning settings.';
  END IF;
  INSERT INTO outcome_learning_settings (user_id, auto_apply_low_risk, share_cross_tenant)
  VALUES (auth.uid(), COALESCE(p_auto_apply, false), COALESCE(p_share, false))
  ON CONFLICT (user_id) DO UPDATE SET
    auto_apply_low_risk = COALESCE(p_auto_apply, outcome_learning_settings.auto_apply_low_risk),
    share_cross_tenant = COALESCE(p_share, outcome_learning_settings.share_cross_tenant),
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE ALL ON FUNCTION public.set_outcome_learning_flags(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_outcome_learning_flags(boolean, boolean) TO authenticated, service_role;

-- 95% Wilson lower bound of k/n (0 when n = 0).
CREATE OR REPLACE FUNCTION public.wilson_lower_bound(k numeric, n numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 OR k < 0 OR k > n THEN 0
    ELSE GREATEST(0, (
      (k / n + 1.959964 ^ 2 / (2 * n))
      - 1.959964 * sqrt((k / n) * (1 - k / n) / n + 1.959964 ^ 2 / (4 * n ^ 2))
    ) / (1 + 1.959964 ^ 2 / n)) END;
$$;

-- =============================================================
-- E. alerts (defined early: used by later functions)
-- =============================================================
CREATE TABLE IF NOT EXISTS outcome_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  alert_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('coverage_drop', 'predictor_demoted', 'predictor_drift', 'policy_rolled_back')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_alerts_open ON outcome_alerts(user_id, alert_key) WHERE resolved_at IS NULL;
ALTER TABLE outcome_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_outcome_alerts" ON outcome_alerts;
CREATE POLICY "select_own_outcome_alerts" ON outcome_alerts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.raise_outcome_alert(p_user uuid, p_key text, p_kind text, p_severity text, p_detail jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO outcome_alerts (user_id, alert_key, kind, severity, detail)
  VALUES (p_user, p_key, p_kind, p_severity, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (user_id, alert_key) WHERE resolved_at IS NULL DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public.raise_outcome_alert(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_outcome_alert(uuid, text, text, text, jsonb) TO service_role;

-- =============================================================
-- B. prediction calibration
-- =============================================================
CREATE TABLE IF NOT EXISTS prediction_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  predictor text NOT NULL CHECK (predictor ~ '^[a-z0-9_]{1,64}$'),
  model_version text NOT NULL DEFAULT 'v1' CHECK (model_version ~ '^[A-Za-z0-9_.-]{1,32}$'),
  subject_table text NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) <= 128),
  predicted_prob numeric NOT NULL CHECK (predicted_prob >= 0 AND predicted_prob <= 1),
  predicted_at timestamptz NOT NULL DEFAULT now(),
  outcome boolean,
  outcome_at timestamptz,
  UNIQUE (user_id, predictor, model_version, subject_table, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_prediction_log_user_predictor ON prediction_log(user_id, predictor, predicted_at DESC);
ALTER TABLE prediction_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_prediction_log" ON prediction_log;
CREATE POLICY "select_own_prediction_log" ON prediction_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- First prediction for a subject wins (idempotent replays never rewrite history).
CREATE OR REPLACE FUNCTION public.record_prediction(
  p_user_id uuid, p_predictor text, p_subject_table text, p_subject_id text,
  p_prob numeric, p_model_version text DEFAULT 'v1')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob)
  VALUES (p_user_id, p_predictor, COALESCE(p_model_version, 'v1'), p_subject_table, p_subject_id, p_prob)
  ON CONFLICT (user_id, predictor, model_version, subject_table, subject_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END; $$;
REVOKE ALL ON FUNCTION public.record_prediction(uuid, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_prediction(uuid, text, text, text, numeric, text) TO service_role;

-- An outcome observed at/before the prediction is ignored (never credit earlier outcomes).
CREATE OR REPLACE FUNCTION public.resolve_prediction(
  p_user_id uuid, p_predictor text, p_subject_table text, p_subject_id text,
  p_outcome boolean, p_observed_at timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE prediction_log SET outcome = p_outcome, outcome_at = p_observed_at
  WHERE user_id = p_user_id AND predictor = p_predictor
    AND subject_table = p_subject_table AND subject_id = p_subject_id
    AND outcome IS NULL AND p_observed_at > predicted_at AND p_observed_at <= now() + interval '5 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.resolve_prediction(uuid, text, text, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_prediction(uuid, text, text, text, boolean, timestamptz) TO service_role;

CREATE OR REPLACE VIEW public.predictor_reliability_bins_v WITH (security_invoker = true) AS
SELECT user_id, predictor, model_version,
       LEAST(9, floor(predicted_prob * 10))::integer AS bin,
       count(*)::integer AS n,
       avg(predicted_prob) AS mean_p,
       avg(outcome::integer::numeric) AS mean_y
FROM prediction_log WHERE outcome IS NOT NULL
GROUP BY user_id, predictor, model_version, LEAST(9, floor(predicted_prob * 10));

CREATE OR REPLACE VIEW public.predictor_calibration_v WITH (security_invoker = true) AS
WITH s AS (
  SELECT user_id, predictor, model_version,
         count(*)::integer AS n,
         avg((predicted_prob - outcome::integer) ^ 2) AS brier,
         avg(outcome::integer::numeric) AS base_rate
  FROM prediction_log WHERE outcome IS NOT NULL
  GROUP BY user_id, predictor, model_version
), e AS (
  SELECT user_id, predictor, model_version,
         sum(n * abs(mean_p - mean_y)) / NULLIF(sum(n), 0) AS ece
  FROM predictor_reliability_bins_v GROUP BY user_id, predictor, model_version
)
SELECT s.user_id, s.predictor, s.model_version, s.n, s.brier, e.ece,
       CASE WHEN s.base_rate IN (0, 1) THEN NULL ELSE 1 - s.brier / (s.base_rate * (1 - s.base_rate)) END AS brier_skill
FROM s JOIN e USING (user_id, predictor, model_version);

CREATE TABLE IF NOT EXISTS predictor_status (
  user_id uuid NOT NULL,
  predictor text NOT NULL,
  model_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('insufficient_data', 'ok', 'demote')),
  weight numeric NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  n integer NOT NULL DEFAULT 0,
  ece numeric, brier numeric, brier_skill numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, predictor, model_version)
);
ALTER TABLE predictor_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_predictor_status" ON predictor_status;
CREATE POLICY "select_own_predictor_status" ON predictor_status FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Same thresholds as calibration.ts: n >= 50; demote if ECE > 0.15 or skill < 0.
-- Drift: ECE(last 30d) - ECE(30–90d ago) > 0.10 with n >= 50 in both windows.
CREATE OR REPLACE FUNCTION public.refresh_predictor_status()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_status text; v_prev text; v_count integer := 0; d record;
BEGIN
  FOR r IN SELECT * FROM predictor_calibration_v LOOP
    v_status := CASE WHEN r.n < 50 THEN 'insufficient_data'
                     WHEN r.ece > 0.15 OR COALESCE(r.brier_skill, 0) < 0 THEN 'demote' ELSE 'ok' END;
    SELECT status INTO v_prev FROM predictor_status
      WHERE user_id = r.user_id AND predictor = r.predictor AND model_version = r.model_version;
    INSERT INTO predictor_status (user_id, predictor, model_version, status, weight, n, ece, brier, brier_skill, updated_at)
    VALUES (r.user_id, r.predictor, r.model_version, v_status, CASE WHEN v_status = 'demote' THEN 0 ELSE 1 END,
            r.n, r.ece, r.brier, r.brier_skill, now())
    ON CONFLICT (user_id, predictor, model_version) DO UPDATE SET
      status = EXCLUDED.status, weight = EXCLUDED.weight, n = EXCLUDED.n,
      ece = EXCLUDED.ece, brier = EXCLUDED.brier, brier_skill = EXCLUDED.brier_skill, updated_at = now();
    IF v_status = 'demote' AND v_prev IS DISTINCT FROM 'demote' THEN
      PERFORM public.raise_outcome_alert(r.user_id, 'demoted:' || r.predictor || ':' || r.model_version, 'predictor_demoted', 'warning',
        jsonb_build_object('predictor', r.predictor, 'n', r.n, 'ece', r.ece, 'brier_skill', r.brier_skill));
    END IF;
    v_count := v_count + 1;
  END LOOP;

  FOR d IN
    WITH w AS (
      SELECT user_id, predictor, model_version,
             CASE WHEN predicted_at >= now() - interval '30 days' THEN 'recent' ELSE 'prior' END AS win,
             LEAST(9, floor(predicted_prob * 10))::integer AS bin, predicted_prob, outcome::integer AS y
      FROM prediction_log
      WHERE outcome IS NOT NULL AND predicted_at >= now() - interval '90 days'
    ), b AS (
      SELECT user_id, predictor, model_version, win, bin, count(*) AS n, avg(predicted_prob) AS mp, avg(y::numeric) AS my
      FROM w GROUP BY 1, 2, 3, 4, 5
    ), e AS (
      SELECT user_id, predictor, model_version, win, sum(n) AS n, sum(n * abs(mp - my)) / sum(n) AS ece
      FROM b GROUP BY 1, 2, 3, 4
    )
    SELECT r1.user_id, r1.predictor, r1.model_version, r1.ece AS ece_recent, r0.ece AS ece_prior
    FROM e r1 JOIN e r0 USING (user_id, predictor, model_version)
    WHERE r1.win = 'recent' AND r0.win = 'prior' AND r1.n >= 50 AND r0.n >= 50 AND r1.ece - r0.ece > 0.10
  LOOP
    PERFORM public.raise_outcome_alert(d.user_id, 'drift:' || d.predictor || ':' || d.model_version, 'predictor_drift', 'warning',
      jsonb_build_object('predictor', d.predictor, 'ece_recent', d.ece_recent, 'ece_prior', d.ece_prior));
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.refresh_predictor_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_predictor_status() TO service_role;

-- Influence multiplier for decision code: 0 when the latest model version is demoted, else 1.
CREATE OR REPLACE FUNCTION public.get_predictor_weight(p_user_id uuid, p_predictor text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT weight FROM predictor_status
                   WHERE user_id = p_user_id AND predictor = p_predictor
                   ORDER BY updated_at DESC LIMIT 1), 1);
$$;
REVOKE ALL ON FUNCTION public.get_predictor_weight(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_predictor_weight(uuid, text) TO service_role;

-- =============================================================
-- C. randomized-holdout experiments
-- =============================================================
CREATE TABLE IF NOT EXISTS outcome_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  holdout_pct numeric NOT NULL CHECK (holdout_pct > 0 AND holdout_pct <= 20),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped')),
  contact_rule_ack boolean NOT NULL CHECK (contact_rule_ack),
  min_n_per_arm integer NOT NULL DEFAULT 30 CHECK (min_n_per_arm >= 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz
);
ALTER TABLE outcome_experiments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_outcome_experiments" ON outcome_experiments;
CREATE POLICY "select_own_outcome_experiments" ON outcome_experiments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS outcome_experiment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES outcome_experiments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 128),
  arm text NOT NULL CHECK (arm IN ('treatment', 'holdout')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  outcome boolean,
  outcome_at timestamptz,
  UNIQUE (experiment_id, subject_key)
);
ALTER TABLE outcome_experiment_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_outcome_experiment_assignments" ON outcome_experiment_assignments;
CREATE POLICY "select_own_outcome_experiment_assignments" ON outcome_experiment_assignments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Holdouts are only allowed for optional messaging/marketing actions, after the
-- owner acknowledges that mandatory/legal/emergency contact is never withheld.
CREATE OR REPLACE FUNCTION public.create_outcome_experiment(
  p_action_slug text, p_name text, p_holdout_pct numeric, p_contact_rule_ack boolean)
RETURNS outcome_experiments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cat text; v_row outcome_experiments;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can create experiments.';
  END IF;
  IF NOT COALESCE(p_contact_rule_ack, false) THEN
    RAISE EXCEPTION 'You must acknowledge that mandatory, legal and emergency contact is never withheld.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outcome_learning_settings WHERE user_id = auth.uid() AND capture_enabled) THEN
    RAISE EXCEPTION 'Enable outcome capture first.';
  END IF;
  SELECT category INTO v_cat FROM agent_action_catalog WHERE slug = p_action_slug;
  IF v_cat IS NULL OR v_cat NOT IN ('messaging', 'marketing') THEN
    RAISE EXCEPTION 'Holdout experiments are only allowed for messaging or marketing actions.';
  END IF;
  INSERT INTO outcome_experiments (user_id, action_slug, name, holdout_pct, contact_rule_ack)
  VALUES (auth.uid(), p_action_slug, p_name, p_holdout_pct, true) RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE ALL ON FUNCTION public.create_outcome_experiment(text, text, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_outcome_experiment(text, text, numeric, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stop_outcome_experiment(p_experiment_id uuid)
RETURNS outcome_experiments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row outcome_experiments;
BEGIN
  UPDATE outcome_experiments SET status = 'stopped', stopped_at = now()
  WHERE id = p_experiment_id AND user_id = auth.uid() AND status = 'running' RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Experiment not found, not yours, or already stopped.'; END IF;
  RETURN v_row;
END; $$;
REVOKE ALL ON FUNCTION public.stop_outcome_experiment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_outcome_experiment(uuid) TO authenticated, service_role;

-- Deterministic, idempotent assignment. Returns 'treatment' (safe default) whenever the
-- experiment is not running. The caller MUST skip the action only when 'holdout' is returned
-- and the contact is optional.
CREATE OR REPLACE FUNCTION public.assign_experiment_arm(p_experiment_id uuid, p_subject_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e outcome_experiments; v_arm text;
BEGIN
  SELECT * INTO e FROM outcome_experiments WHERE id = p_experiment_id;
  IF NOT FOUND OR e.status <> 'running' THEN RETURN 'treatment'; END IF;
  SELECT arm INTO v_arm FROM outcome_experiment_assignments WHERE experiment_id = e.id AND subject_key = p_subject_key;
  IF FOUND THEN RETURN v_arm; END IF;
  v_arm := CASE WHEN (abs(hashtext(e.id::text || ':' || p_subject_key)::bigint) % 10000) < (e.holdout_pct * 100)
                THEN 'holdout' ELSE 'treatment' END;
  INSERT INTO outcome_experiment_assignments (experiment_id, user_id, subject_key, arm)
  VALUES (e.id, e.user_id, p_subject_key, v_arm)
  ON CONFLICT (experiment_id, subject_key) DO NOTHING;
  SELECT arm INTO v_arm FROM outcome_experiment_assignments WHERE experiment_id = e.id AND subject_key = p_subject_key;
  RETURN v_arm;
END; $$;
REVOKE ALL ON FUNCTION public.assign_experiment_arm(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_experiment_arm(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_experiment_outcome(
  p_experiment_id uuid, p_subject_key text, p_success boolean, p_observed_at timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE outcome_experiment_assignments SET outcome = p_success, outcome_at = p_observed_at
  WHERE experiment_id = p_experiment_id AND subject_key = p_subject_key
    AND outcome IS NULL AND p_observed_at > assigned_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.resolve_experiment_outcome(uuid, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_experiment_outcome(uuid, text, boolean, timestamptz) TO service_role;

-- Counts per arm; intervals/suppression are computed by experiment.ts (diffProportions).
CREATE OR REPLACE VIEW public.outcome_experiment_arms_v WITH (security_invoker = true) AS
SELECT x.id AS experiment_id, x.user_id, x.action_slug, x.name, x.status, x.holdout_pct, x.min_n_per_arm, a.arm,
       count(*) FILTER (WHERE a.outcome IS NOT NULL)::integer AS n_resolved,
       count(*) FILTER (WHERE a.outcome)::integer AS k_success,
       count(*) FILTER (WHERE a.outcome IS NULL)::integer AS n_pending
FROM outcome_experiments x JOIN outcome_experiment_assignments a ON a.experiment_id = x.id
GROUP BY x.id, x.user_id, x.action_slug, x.name, x.status, x.holdout_pct, x.min_n_per_arm, a.arm;

-- Legacy before/after numbers: label them in the schema so every consumer sees it.
DO $$ BEGIN
  IF to_regclass('public.causal_outcome_tracking') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON TABLE public.causal_outcome_tracking IS
      'LEGACY, UNADJUSTED before/after revenue comparison (no control group, no seasonality or attribution handling). Do not present as causal. Use outcome_experiment_arms_v / experiment.ts for adjusted estimates.'$c$;
  END IF;
END $$;

-- =============================================================
-- D. bounded, reversible learning
-- =============================================================
CREATE TABLE IF NOT EXISTS learning_policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug),
  suggestion_id uuid REFERENCES agent_learning_suggestions(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('relax_approval', 'tighten_approval')),
  risk_class text NOT NULL CHECK (risk_class IN ('low')),
  applied_by text NOT NULL DEFAULT 'auto' CHECK (applied_by IN ('auto')),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  baseline_k integer NOT NULL,
  baseline_n integer NOT NULL,
  status text NOT NULL DEFAULT 'monitoring' CHECK (status IN ('monitoring', 'confirmed', 'rolled_back')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  monitor_until timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason text,
  UNIQUE (suggestion_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_policy_changes_open ON learning_policy_changes(status, monitor_until) WHERE status = 'monitoring';
ALTER TABLE learning_policy_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_learning_policy_changes" ON learning_policy_changes;
CREATE POLICY "select_own_learning_policy_changes" ON learning_policy_changes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Auto-apply is limited to LOW-RISK classes for accounts that opted in:
--  * tighten_approval (adds human oversight) with >= 30 final outcomes
--  * relax_approval only for messaging actions with NO cost, >= 50 learnable outcomes,
--    Wilson lower bound of success >= 0.85 and human override rate <= 10%
-- Everything else stays a human-reviewed suggestion. Always reversible (see rollback fn).
CREATE OR REPLACE FUNCTION public.auto_apply_learning_suggestions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; st agent_action_learning_stats; v_perm agent_permissions; v_new boolean; v_applied integer := 0; v_ok boolean;
BEGIN
  FOR r IN
    SELECT g.*, c.category, c.has_cost
    FROM agent_learning_suggestions g
    JOIN outcome_learning_settings s ON s.user_id = g.user_id AND s.capture_enabled AND s.auto_apply_low_risk
    JOIN agent_action_catalog c ON c.slug = g.action_slug
    WHERE g.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM learning_policy_changes lc WHERE lc.suggestion_id = g.id)
    ORDER BY g.created_at
    LIMIT 200
  LOOP
    SELECT * INTO st FROM agent_action_learning_stats WHERE user_id = r.user_id AND action_slug = r.action_slug;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF r.kind = 'tighten_approval' THEN
      v_ok := st.outcomes_recorded >= 30; v_new := true;
    ELSE
      v_ok := r.category = 'messaging' AND NOT r.has_cost AND st.outcomes_recorded >= 50
              AND public.wilson_lower_bound(st.success_count, st.outcomes_recorded) >= 0.85
              AND COALESCE(st.human_override_rate, 0) <= 0.1;
      v_new := false;
    END IF;
    IF NOT v_ok THEN CONTINUE; END IF;

    SELECT * INTO v_perm FROM agent_permissions WHERE user_id = r.user_id AND action_slug = r.action_slug;
    INSERT INTO learning_policy_changes (user_id, action_slug, suggestion_id, kind, risk_class, before_state, after_state,
                                         baseline_k, baseline_n, monitor_until)
    VALUES (r.user_id, r.action_slug, r.id, r.kind, 'low',
            jsonb_build_object('row_existed', v_perm.user_id IS NOT NULL, 'requires_approval', to_jsonb(v_perm.requires_approval)),
            jsonb_build_object('requires_approval', v_new),
            st.success_count, st.outcomes_recorded, now() + interval '14 days');

    INSERT INTO agent_permissions (user_id, action_slug, enabled, requires_approval, updated_by)
    VALUES (r.user_id, r.action_slug, true, v_new, NULL)
    ON CONFLICT (user_id, action_slug) DO UPDATE SET requires_approval = v_new, updated_at = now(), updated_by = NULL;

    UPDATE agent_learning_suggestions SET status = 'accepted', decided_at = now() WHERE id = r.id;
    v_applied := v_applied + 1;
  END LOOP;
  RETURN v_applied;
END; $$;
REVOKE ALL ON FUNCTION public.auto_apply_learning_suggestions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_apply_learning_suggestions() TO service_role;

CREATE OR REPLACE FUNCTION public.rollback_learning_change(p_change_id uuid, p_reason text)
RETURNS learning_policy_changes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c learning_policy_changes; v_prev boolean;
BEGIN
  SELECT * INTO c FROM learning_policy_changes WHERE id = p_change_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Change % not found.', p_change_id; END IF;
  IF c.status <> 'monitoring' THEN RETURN c; END IF; -- idempotent
  v_prev := CASE WHEN c.before_state ? 'requires_approval' AND jsonb_typeof(c.before_state -> 'requires_approval') = 'boolean'
                 THEN (c.before_state ->> 'requires_approval')::boolean ELSE NULL END;
  UPDATE agent_permissions SET requires_approval = v_prev, updated_at = now(), updated_by = NULL
  WHERE user_id = c.user_id AND action_slug = c.action_slug;
  UPDATE learning_policy_changes SET status = 'rolled_back', resolved_at = now(), resolution_reason = left(p_reason, 200)
  WHERE id = c.id RETURNING * INTO c;
  PERFORM public.raise_outcome_alert(c.user_id, 'rollback:' || c.id::text, 'policy_rolled_back', 'warning',
    jsonb_build_object('action_slug', c.action_slug, 'kind', c.kind, 'reason', c.resolution_reason));
  RETURN c;
END; $$;
REVOKE ALL ON FUNCTION public.rollback_learning_change(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_learning_change(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_learning_change(p_change_id uuid, p_reason text)
RETURNS learning_policy_changes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c learning_policy_changes;
BEGIN
  UPDATE learning_policy_changes SET status = 'confirmed', resolved_at = now(), resolution_reason = left(p_reason, 200)
  WHERE id = p_change_id AND status = 'monitoring' RETURNING * INTO c;
  IF NOT FOUND THEN SELECT * INTO c FROM learning_policy_changes WHERE id = p_change_id; END IF;
  RETURN c;
END; $$;
REVOKE ALL ON FUNCTION public.confirm_learning_change(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_learning_change(uuid, text) TO service_role;

-- Post-change evidence for the monitor: learnable outcomes recorded after the change was applied.
CREATE OR REPLACE FUNCTION public.learning_change_post_stats(p_change_id uuid)
RETURNS TABLE (post_k integer, post_n integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE o.outcome = 'success')::integer, count(*)::integer
  FROM learning_policy_changes c
  JOIN agent_action_outcomes o ON o.user_id = c.user_id AND o.action_slug = c.action_slug
  WHERE c.id = p_change_id AND o.recorded_at > c.applied_at
    AND o.outcome <> 'unknown' AND NOT o.excluded_from_learning;
$$;
REVOKE ALL ON FUNCTION public.learning_change_post_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.learning_change_post_stats(uuid) TO service_role;

-- Coverage alert: governed actions with a rule-backed target but no final outcome.
CREATE OR REPLACE FUNCTION public.check_outcome_coverage_alerts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT l.user_id, l.action_slug, count(*)::integer AS executed, count(o.id)::integer AS with_outcome
    FROM agent_action_log l
    JOIN outcome_learning_settings s ON s.user_id = l.user_id AND s.capture_enabled
    LEFT JOIN agent_action_outcomes o ON o.log_id = l.id
    WHERE l.status = 'executed' AND l.target_table IN ('workflow_runs', 'financing_offers', 'invoices')
      AND l.created_at < now() - interval '4 days' AND l.created_at > now() - interval '60 days'
    GROUP BY l.user_id, l.action_slug
    HAVING count(*) >= 20 AND count(o.id)::numeric / count(*) < 0.5
  LOOP
    PERFORM public.raise_outcome_alert(r.user_id, 'coverage:' || r.action_slug, 'coverage_drop', 'warning',
      jsonb_build_object('action_slug', r.action_slug, 'executed', r.executed, 'with_outcome', r.with_outcome));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.check_outcome_coverage_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_outcome_coverage_alerts() TO service_role;

CREATE OR REPLACE VIEW public.learning_changes_v WITH (security_invoker = true) AS
SELECT id, user_id, action_slug, kind, risk_class, status, before_state, after_state,
       baseline_k, baseline_n, applied_at, monitor_until, resolved_at, resolution_reason
FROM learning_policy_changes;

-- =============================================================
-- F. cross-tenant aggregates (k-anonymity + dominance), no PII
-- =============================================================
CREATE TABLE IF NOT EXISTS outcome_privacy_salt (
  id integer PRIMARY KEY CHECK (id = 1),
  salt text NOT NULL DEFAULT gen_random_uuid()::text
);
INSERT INTO outcome_privacy_salt (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE outcome_privacy_salt ENABLE ROW LEVEL SECURITY; -- no policies: service role only
REVOKE ALL ON outcome_privacy_salt FROM PUBLIC, anon, authenticated;

-- The floors are enforced by CHECK constraints so a bug in any writer cannot publish a unsafe row.
CREATE TABLE IF NOT EXISTS outcome_cross_tenant_aggregates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_key text NOT NULL CHECK (signal_key ~ '^[a-z0-9_]{1,64}\|[a-z0-9_]{1,64}$'),
  schema_version text NOT NULL DEFAULT 'agg.v1',
  computed_on date NOT NULL DEFAULT current_date,
  tenant_count integer NOT NULL CHECK (tenant_count >= 5),
  sample_n integer NOT NULL CHECK (sample_n >= 30),
  success_n integer NOT NULL CHECK (success_n >= 0 AND success_n <= sample_n),
  success_rate numeric NOT NULL,
  max_tenant_share numeric NOT NULL CHECK (max_tenant_share > 0 AND max_tenant_share <= 0.5),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_key, computed_on)
);
ALTER TABLE outcome_cross_tenant_aggregates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_outcome_cross_tenant_aggregates" ON outcome_cross_tenant_aggregates;
CREATE POLICY "read_outcome_cross_tenant_aggregates" ON outcome_cross_tenant_aggregates FOR SELECT TO authenticated
  USING (true); -- anonymous aggregates only: no tenant identifiers or free text exist in this table

CREATE TABLE IF NOT EXISTS outcome_aggregate_contributions (
  aggregate_id uuid NOT NULL REFERENCES outcome_cross_tenant_aggregates(id) ON DELETE CASCADE,
  tenant_ref text NOT NULL,        -- salted sha256, never the tenant id
  sample_n integer NOT NULL CHECK (sample_n > 0),
  PRIMARY KEY (aggregate_id, tenant_ref)
);
ALTER TABLE outcome_aggregate_contributions ENABLE ROW LEVEL SECURITY; -- no policies: audit is service-role only
REVOKE ALL ON outcome_aggregate_contributions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.build_outcome_aggregates(
  p_min_tenants integer DEFAULT 5, p_max_share numeric DEFAULT 0.5, p_min_n integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t integer := GREATEST(COALESCE(p_min_tenants, 5), 5);      -- floors can only be raised
  v_s numeric := LEAST(COALESCE(p_max_share, 0.5), 0.5);
  v_n integer := GREATEST(COALESCE(p_min_n, 30), 30);
  v_salt text; r record; v_id uuid; v_made integer := 0;
BEGIN
  SELECT salt INTO v_salt FROM outcome_privacy_salt WHERE id = 1;
  FOR r IN
    WITH per_tenant AS (
      SELECT o.action_slug || '|' || o.attribution_rule AS signal_key, o.user_id,
             count(*) AS n, count(*) FILTER (WHERE o.outcome = 'success') AS k
      FROM agent_action_outcomes o
      JOIN outcome_learning_settings s ON s.user_id = o.user_id AND s.capture_enabled AND s.share_cross_tenant
      WHERE o.attribution_rule IS NOT NULL AND NOT o.excluded_from_learning
        AND o.outcome <> 'unknown' AND NOT o.attribution_conflict
        AND o.action_slug ~ '^[a-z0-9_]{1,64}$' AND o.attribution_rule ~ '^[a-z0-9_]{1,64}$'
      GROUP BY 1, 2
    )
    SELECT signal_key, count(*)::integer AS tenants, sum(n)::integer AS n, sum(k)::integer AS k,
           (max(n)::numeric / sum(n)) AS max_share
    FROM per_tenant GROUP BY signal_key
    HAVING count(*) >= v_t AND sum(n) >= v_n AND max(n)::numeric / sum(n) <= v_s
  LOOP
    v_id := NULL;
    INSERT INTO outcome_cross_tenant_aggregates (signal_key, tenant_count, sample_n, success_n, success_rate, max_tenant_share)
    VALUES (r.signal_key, r.tenants, r.n, r.k, round(r.k::numeric / r.n, 4), round(r.max_share, 4))
    ON CONFLICT (signal_key, computed_on) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO outcome_aggregate_contributions (aggregate_id, tenant_ref, sample_n)
      SELECT v_id, encode(sha256(convert_to(v_salt || ':' || o.user_id::text, 'UTF8')), 'hex'), count(*)::integer
      FROM agent_action_outcomes o
      JOIN outcome_learning_settings s ON s.user_id = o.user_id AND s.capture_enabled AND s.share_cross_tenant
      WHERE o.action_slug || '|' || o.attribution_rule = r.signal_key AND NOT o.excluded_from_learning
        AND o.outcome <> 'unknown' AND NOT o.attribution_conflict
      GROUP BY o.user_id;
      v_made := v_made + 1;
    END IF;
  END LOOP;
  RETURN v_made;
END; $$;
REVOKE ALL ON FUNCTION public.build_outcome_aggregates(integer, numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_outcome_aggregates(integer, numeric, integer) TO service_role;

-- =============================================================
-- G. versioned dataset (opted-in tenants only; service role only)
-- =============================================================
CREATE OR REPLACE VIEW public.outcome_dataset_v1 AS
SELECT
  'outcome_dataset.v1'::text AS schema_version,
  encode(sha256(convert_to((SELECT salt FROM outcome_privacy_salt WHERE id = 1) || ':' || o.user_id::text, 'UTF8')), 'hex') AS tenant_ref,
  o.action_slug, o.attribution_rule, o.attribution_version, o.outcome,
  o.financial_outcome_cents, o.confidence, o.measurement_window_hours, o.dq_flags, o.observed_at,
  NOT o.excluded_from_learning AS learnable,
  o.attribution_conflict,
  o.recorded_by,
  true AS consent_cross_tenant
FROM agent_action_outcomes o
JOIN outcome_learning_settings s ON s.user_id = o.user_id AND s.capture_enabled AND s.share_cross_tenant
WHERE o.attribution_rule IS NOT NULL;

COMMENT ON VIEW public.outcome_dataset_v1 IS
  'outcome_dataset.v1 — one row per auto-attributed agent action outcome. Provenance: outcome-reconciler (attribution_rule/attribution_version). Quality: learnable=false rows are excluded from learning. Consent: only accounts with share_cross_tenant=true. Identity: tenant_ref is a salted sha256; no free text, evidence JSON or customer data is exposed. Service-role read only.';
REVOKE ALL ON public.outcome_dataset_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.outcome_dataset_v1 TO service_role;

-- =============================================================
-- H. flywheel: allow promotions sourced from measured outcomes
-- =============================================================
DO $$ BEGIN
  IF to_regclass('public.flywheel_promotions') IS NOT NULL THEN
    ALTER TABLE public.flywheel_promotions DROP CONSTRAINT IF EXISTS flywheel_promotions_source_type_check;
    ALTER TABLE public.flywheel_promotions ADD CONSTRAINT flywheel_promotions_source_type_check
      CHECK (source_type IN ('org_memory_entry', 'business_immune_detector', 'measured_outcome'));
  END IF;
END $$;
