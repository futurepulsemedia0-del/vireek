/*
  # Moat metrics (platform staff ONLY, read-only, additive)

  Two families of PROXIES. Neither is a measurement of lock-in or of a network effect; both are counts and
  accuracy statistics computed from tables that already exist. Definitions, caveats and the reasons for every
  inclusion and exclusion live in docs/strategy/moat-metrics.md. No threshold, weight or target is invented here.

  A. Switching-cost proxies (per account)
       moat_accounts_v          eligible accounts: every profile that is not platform staff and not a synthetic probe tenant
       moat_integrations_v      distinct connected third-party providers per account
       moat_history_v           earliest record Vireek holds for the account, history length in days, record counts
       moat_automations_v       automations the account has switched on (installed templates, live workflows, enabled dispatch rules)
       moat_switching_cost_v    the three above side by side, one row per eligible account

  B. Data-network-effect proxies (per account, per predictor)
       moat_prediction_accuracy_v   Brier score, Brier skill and ECE of resolved predictions (prediction_log via the
                                    existing predictor_calibration_v, plus first-time-fix predictions paired with job outcomes)
       moat_cohort_contribution_v   what each account makes available to the cross-tenant learning cohort (opt-in flags and
                                    the count of learnable outcomes that qualify under build_outcome_aggregates)
       moat_network_effect_v        accuracy and contribution joined per account and predictor

  Read API
       staff_moat_metrics(int, boolean)   staff-only SECURITY DEFINER RPC -> jsonb of aggregates (no account ids, names or free text)

  Tenant boundary: the views read across ALL tenants, so every privilege on them is revoked from PUBLIC, anon and
  authenticated; they are reachable only through the RPC, which re-checks is_vireek_staff(auth.uid()). Same pattern as
  20290305000000_north_star_metric_tree.sql.

  Reuses (does not duplicate): predictor_calibration_v (Brier / ECE / skill for prediction_log) from
  20290102000000_outcome_learning_advanced.sql. The first-time-fix pairing mirrors eval_plane_pairs('first_time_fix')
  in 20270315000000_intelligence_evaluation_plane.sql (that function is per-owner and cannot be used set-wise); if
  that rule changes, change it here too.

  Requires (all created by earlier migrations): profiles(is_staff, is_synthetic_tenant, status, created_at),
  customers, jobs, calls, integrations, qbo_connections, acct_connections, payroll_connections, crm_connections,
  listing_connections, automation_installs, compiled_workflows, dispatch_rules, prediction_log,
  predictor_calibration_v, ftf_predictions, job_outcomes, outcome_learning_settings(capture_enabled, share_cross_tenant),
  outcome_benchmark_settings, agent_action_outcomes(attribution_rule, excluded_from_learning, attribution_conflict),
  outcome_cross_tenant_aggregates, is_vireek_staff(uuid).

  Performance: NOT MEASURED (no database was available when this was written). The history view aggregates customers,
  jobs and calls by user_id across all tenants. If the RPC is slow on production data, check that each of those tables
  has an index on (user_id) and consider materialising moat_history_v on a schedule.

  ROLLBACK (derived views only, no data is stored):
    DROP FUNCTION IF EXISTS public.staff_moat_metrics(integer, boolean);
    DROP VIEW IF EXISTS public.moat_network_effect_v;
    DROP VIEW IF EXISTS public.moat_cohort_contribution_v;
    DROP VIEW IF EXISTS public.moat_prediction_accuracy_v;
    DROP VIEW IF EXISTS public.moat_switching_cost_v;
    DROP VIEW IF EXISTS public.moat_automations_v;
    DROP VIEW IF EXISTS public.moat_history_v;
    DROP VIEW IF EXISTS public.moat_integrations_v;
    DROP VIEW IF EXISTS public.moat_accounts_v;
*/
-- rollback: drop the RPC, then the views in reverse dependency order (see the ROLLBACK block above); no data is stored, so nothing is lost.

-- =============================================================
-- Eligible accounts
-- =============================================================
CREATE OR REPLACE VIEW public.moat_accounts_v AS
SELECT
  p.id         AS user_id,
  p.created_at AS account_created_at,
  p.status     AS profile_status
FROM public.profiles p
WHERE NOT COALESCE(p.is_staff, false)
  AND NOT COALESCE(p.is_synthetic_tenant, false);

-- =============================================================
-- A1. Integrations per account
--     A provider counts once even when it appears in two tables (for example xero in integrations and acct_connections).
--     Only states that mean "connected" count; error / expired / disconnected do not. Outbound webhooks are not a vendor
--     integration and are excluded. Lower bound: tables not listed here (calendar sync, chat, messaging, banking,
--     telematics, property management) are NOT counted yet.
-- =============================================================
CREATE OR REPLACE VIEW public.moat_integrations_v AS
WITH connected AS (
  SELECT user_id, integration_type AS provider
    FROM public.integrations
   WHERE status = 'connected' AND integration_type <> 'webhook'
  UNION ALL SELECT user_id, 'quickbooks' FROM public.qbo_connections     WHERE status = 'connected'
  UNION ALL SELECT user_id, provider     FROM public.acct_connections    WHERE status = 'connected'
  UNION ALL SELECT user_id, provider     FROM public.payroll_connections WHERE status = 'connected'
  UNION ALL SELECT user_id, provider     FROM public.crm_connections     WHERE status = 'connected'
  UNION ALL SELECT user_id, platform     FROM public.listing_connections WHERE status = 'active'
)
SELECT user_id, count(DISTINCT provider)::integer AS integrations_n
FROM connected
GROUP BY user_id;

-- =============================================================
-- A2. Data history held per account
--     first_record_at is the earliest of customers.created_at, jobs.created_at, calls.call_datetime. It measures how far
--     back the data Vireek holds goes, not how long the customer has used Vireek: imported or back-dated rows can make it
--     older than the account itself (see data_quality.history_older_than_account_n in the RPC).
-- =============================================================
CREATE OR REPLACE VIEW public.moat_history_v AS
WITH cu AS (SELECT user_id, count(*) AS n, min(created_at)    AS first_at FROM public.customers GROUP BY user_id),
     jo AS (SELECT user_id, count(*) AS n, min(created_at)    AS first_at FROM public.jobs      GROUP BY user_id),
     ca AS (SELECT user_id, count(*) AS n, min(call_datetime) AS first_at FROM public.calls     GROUP BY user_id),
     u  AS (SELECT user_id FROM cu UNION SELECT user_id FROM jo UNION SELECT user_id FROM ca)
SELECT
  u.user_id,
  LEAST(cu.first_at, jo.first_at, ca.first_at) AS first_record_at,
  GREATEST(0, floor(extract(epoch FROM (now() - LEAST(cu.first_at, jo.first_at, ca.first_at))) / 86400))::integer AS history_days,
  COALESCE(cu.n, 0)::bigint AS customers_n,
  COALESCE(jo.n, 0)::bigint AS jobs_n,
  COALESCE(ca.n, 0)::bigint AS calls_n
FROM u
LEFT JOIN cu USING (user_id)
LEFT JOIN jo USING (user_id)
LEFT JOIN ca USING (user_id);

-- =============================================================
-- A3. Automations the account has switched on
--     Counts things the customer (or their setup) turned on, not things that merely exist as configuration.
--     Each component is shown separately; automations_n is their plain sum. No weighting.
-- =============================================================
CREATE OR REPLACE VIEW public.moat_automations_v AS
WITH x AS (
  SELECT user_id, 'install'::text       AS kind FROM public.automation_installs WHERE status = 'active'
  UNION ALL SELECT user_id, 'workflow'      FROM public.compiled_workflows  WHERE status = 'live'
  UNION ALL SELECT user_id, 'dispatch_rule' FROM public.dispatch_rules      WHERE enabled
)
SELECT
  user_id,
  (count(*) FILTER (WHERE kind = 'install'))::integer       AS installs_active_n,
  (count(*) FILTER (WHERE kind = 'workflow'))::integer      AS workflows_live_n,
  (count(*) FILTER (WHERE kind = 'dispatch_rule'))::integer AS dispatch_rules_enabled_n,
  count(*)::integer                                         AS automations_n
FROM x
GROUP BY user_id;

-- =============================================================
-- A. Switching-cost proxies side by side (zero, not NULL, where an account has none)
-- =============================================================
CREATE OR REPLACE VIEW public.moat_switching_cost_v AS
SELECT
  a.user_id,
  a.profile_status,
  a.account_created_at,
  GREATEST(0, floor(extract(epoch FROM (now() - a.account_created_at)) / 86400))::integer AS tenure_days,
  COALESCE(i.integrations_n, 0)             AS integrations_n,
  h.first_record_at,
  h.history_days,
  COALESCE(h.customers_n, 0)                AS customers_n,
  COALESCE(h.jobs_n, 0)                     AS jobs_n,
  COALESCE(h.calls_n, 0)                    AS calls_n,
  COALESCE(au.installs_active_n, 0)         AS installs_active_n,
  COALESCE(au.workflows_live_n, 0)          AS workflows_live_n,
  COALESCE(au.dispatch_rules_enabled_n, 0)  AS dispatch_rules_enabled_n,
  COALESCE(au.automations_n, 0)             AS automations_n
FROM public.moat_accounts_v a
LEFT JOIN public.moat_integrations_v i  ON i.user_id  = a.user_id
LEFT JOIN public.moat_history_v      h  ON h.user_id  = a.user_id
LEFT JOIN public.moat_automations_v  au ON au.user_id = a.user_id;

-- =============================================================
-- B1. Prediction accuracy per account, predictor and model version
--     Brier = mean squared error of the predicted probability. Brier skill = 1 - Brier / (base_rate * (1 - base_rate)),
--     i.e. against always predicting the account's own base rate; NULL when the base rate is 0 or 1 (same rule as
--     predictor_calibration_v). ECE is only available for prediction_log predictors.
--     Source 1: prediction_log (first prediction wins, outcome set later) through predictor_calibration_v.
--     Source 2: first-time-fix predictions paired with the job's recorded outcome (same pairing rule as eval_plane_pairs).
-- =============================================================
CREATE OR REPLACE VIEW public.moat_prediction_accuracy_v AS
SELECT
  c.user_id,
  ('prediction_log:' || c.predictor)::text AS predictor_key,
  c.model_version::text                    AS model_version,
  c.n::integer                             AS n,
  c.brier::numeric                         AS brier,
  c.brier_skill::numeric                   AS brier_skill,
  c.ece::numeric                           AS ece
FROM public.predictor_calibration_v c
UNION ALL
SELECT
  f.user_id,
  'first_time_fix'::text AS predictor_key,
  f.model_version,
  count(*)::integer AS n,
  avg(power(f.p - f.y, 2)) AS brier,
  CASE WHEN avg(f.y) IN (0, 1) THEN NULL
       ELSE 1 - avg(power(f.p - f.y, 2)) / (avg(f.y) * (1 - avg(f.y))) END AS brier_skill,
  NULL::numeric AS ece
FROM (
  SELECT fp.account_owner_id AS user_id,
         'v' || fp.model_version::text AS model_version,
         (fp.probability / 100.0)::numeric AS p,
         (CASE WHEN o.resolution = 'fixed_first_visit' AND NOT o.caused_callback THEN 1 ELSE 0 END)::numeric AS y
    FROM public.ftf_predictions fp
    JOIN public.job_outcomes o
      ON o.job_id = fp.job_id AND o.technician_id = fp.technician_id AND o.user_id = fp.account_owner_id
   WHERE NOT o.is_rework
     AND fp.updated_at <= o.recorded_at
) f
GROUP BY f.user_id, f.model_version;

-- =============================================================
-- B2. What each account makes available to the cross-tenant learning cohort
--     contributed_outcomes_n applies the same per-tenant filter as build_outcome_aggregates (opted in, learnable, not
--     excluded, not unknown, no attribution conflict). It is ELIGIBLE contribution: aggregates are only published for
--     signals that meet the cohort floors, and the rows that were actually used are stored under salted references that
--     are deliberately not joined back to accounts here.
-- =============================================================
CREATE OR REPLACE VIEW public.moat_cohort_contribution_v AS
WITH learnable AS (
  SELECT user_id, count(*)::integer AS n
    FROM public.agent_action_outcomes
   WHERE attribution_rule IS NOT NULL
     AND NOT excluded_from_learning
     AND outcome <> 'unknown'
     AND NOT attribution_conflict
   GROUP BY user_id
)
SELECT
  a.user_id,
  a.profile_status,
  COALESCE(s.capture_enabled, false)    AS capture_enabled,
  COALESCE(s.share_cross_tenant, false) AS share_cross_tenant,
  COALESCE(b.participating, true)       AS benchmark_participating,
  COALESCE(l.n, 0)                      AS learnable_outcomes_n,
  CASE WHEN COALESCE(s.capture_enabled, false) AND COALESCE(s.share_cross_tenant, false)
       THEN COALESCE(l.n, 0) ELSE 0 END AS contributed_outcomes_n
FROM public.moat_accounts_v a
LEFT JOIN public.outcome_learning_settings  s ON s.user_id = a.user_id
LEFT JOIN public.outcome_benchmark_settings b ON b.account_owner_id = a.user_id
LEFT JOIN learnable                         l ON l.user_id = a.user_id;

-- =============================================================
-- B. Accuracy and contribution per account and predictor
-- =============================================================
CREATE OR REPLACE VIEW public.moat_network_effect_v AS
SELECT
  acc.user_id,
  acc.predictor_key,
  acc.model_version,
  acc.n,
  acc.brier,
  acc.brier_skill,
  acc.ece,
  c.profile_status,
  c.capture_enabled,
  c.share_cross_tenant,
  c.benchmark_participating,
  c.learnable_outcomes_n,
  c.contributed_outcomes_n
FROM public.moat_prediction_accuracy_v acc
JOIN public.moat_cohort_contribution_v c ON c.user_id = acc.user_id;

COMMENT ON VIEW public.moat_accounts_v           IS 'Moat metrics: eligible accounts (not staff, not synthetic). See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_integrations_v       IS 'Moat metrics A1: distinct connected providers per account; lower bound. See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_history_v            IS 'Moat metrics A2: earliest record held and history length in days; not the same as tenure. See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_automations_v        IS 'Moat metrics A3: automations switched on (installs, live workflows, enabled dispatch rules). See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_switching_cost_v     IS 'Moat metrics A: switching-cost proxies per eligible account. Proxy, not a measure of lock-in. See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_prediction_accuracy_v IS 'Moat metrics B1: Brier, Brier skill and ECE per account, predictor and model version. See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_cohort_contribution_v IS 'Moat metrics B2: eligible contribution to the cross-tenant learning cohort. See docs/strategy/moat-metrics.md.';
COMMENT ON VIEW public.moat_network_effect_v     IS 'Moat metrics B: accuracy next to contribution. Association only, never causal. See docs/strategy/moat-metrics.md.';

-- Cross-tenant views: not readable by clients. Only the staff RPC below reads them.
REVOKE ALL ON public.moat_accounts_v            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_integrations_v        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_history_v             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_automations_v         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_switching_cost_v      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_prediction_accuracy_v FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_cohort_contribution_v FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.moat_network_effect_v      FROM PUBLIC, anon, authenticated;

-- =============================================================
-- Staff-only read API (aggregates only)
--   p_min_n:       accounts with fewer resolved predictions than this are counted but left out of the accuracy statistics.
--                  Default 30 is the repository's existing minimum cell size (MIN_CELL_N in src/lib/stats/inference.ts and
--                  the p_min_n default in build_outcome_aggregates).
--   p_active_only: restrict to profiles whose status is 'active' (the column default).
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_moat_metrics(p_min_n integer DEFAULT 30, p_active_only boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sw jsonb;
  v_ne jsonb;
  v_cg jsonb;
  v_dq jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_min_n IS NULL OR p_min_n < 1 OR p_min_n > 100000 THEN
    RAISE EXCEPTION 'p_min_n must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;
  p_active_only := COALESCE(p_active_only, true);

  -- A. Switching-cost proxies: how many accounts have each, and the spread (continuous percentiles).
  SELECT jsonb_build_object(
           'accounts_n',         count(*),
           'with_integration_n', count(*) FILTER (WHERE integrations_n > 0),
           'with_automation_n',  count(*) FILTER (WHERE automations_n > 0),
           'with_history_n',     count(*) FILTER (WHERE first_record_at IS NOT NULL),
           'integrations_n', jsonb_build_object(
             'p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY integrations_n),
             'p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY integrations_n),
             'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY integrations_n),
             'max', max(integrations_n)),
           'automations_n', jsonb_build_object(
             'p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY automations_n),
             'p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY automations_n),
             'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY automations_n),
             'max', max(automations_n)),
           'history_days', jsonb_build_object(
             'p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY history_days),
             'p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY history_days),
             'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY history_days),
             'max', max(history_days)),
           'components_total', jsonb_build_object(
             'installs_active_n',        COALESCE(sum(installs_active_n), 0),
             'workflows_live_n',         COALESCE(sum(workflows_live_n), 0),
             'dispatch_rules_enabled_n', COALESCE(sum(dispatch_rules_enabled_n), 0))
         )
    INTO v_sw
    FROM public.moat_switching_cost_v s
   WHERE NOT p_active_only OR s.profile_status = 'active';

  -- B. Network-effect proxies per predictor and model version. Association only: correlation of eligible contribution with
  --    Brier skill across accounts, and the median skill of contributing vs other accounts.
  SELECT COALESCE(jsonb_agg(q.x ORDER BY q.x ->> 'predictor_key', q.x ->> 'model_version'), '[]'::jsonb)
    INTO v_ne
    FROM (
      SELECT jsonb_build_object(
               'predictor_key',                 e.predictor_key,
               'model_version',                 e.model_version,
               'accounts_total_n',              count(*),
               'accounts_below_min_n',          count(*) FILTER (WHERE NOT e.ok),
               'accounts_used_n',               count(*) FILTER (WHERE e.ok),
               'resolved_n_used',               COALESCE(sum(e.n) FILTER (WHERE e.ok), 0),
               'contributing_accounts_used_n',  count(*) FILTER (WHERE e.ok AND e.contributes),
               'other_accounts_used_n',         count(*) FILTER (WHERE e.ok AND NOT e.contributes),
               'brier_skill_median_contributing',
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY e.brier_skill::double precision) FILTER (WHERE e.ok AND e.contributes),
               'brier_skill_median_other',
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY e.brier_skill::double precision) FILTER (WHERE e.ok AND NOT e.contributes),
               'corr_contribution_vs_brier_skill',
                  corr(e.contributed_outcomes_n::double precision, e.brier_skill::double precision) FILTER (WHERE e.ok)
             ) AS x
        FROM (
          SELECT n.*,
                 (n.n >= p_min_n AND n.brier_skill IS NOT NULL)                     AS ok,
                 (n.share_cross_tenant AND n.contributed_outcomes_n > 0)            AS contributes
            FROM public.moat_network_effect_v n
           WHERE NOT p_active_only OR n.profile_status = 'active'
        ) e
       GROUP BY e.predictor_key, e.model_version
    ) q;

  -- Cohort growth as published (anonymous aggregates only): how the shared cohort has grown over time.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'computed_on',      g.computed_on,
           'signals_n',        g.signals_n,
           'tenant_count_min', g.tenant_count_min,
           'tenant_count_max', g.tenant_count_max,
           'sample_n_total',   g.sample_n_total
         ) ORDER BY g.computed_on DESC), '[]'::jsonb)
    INTO v_cg
    FROM (
      SELECT computed_on,
             count(*)::integer          AS signals_n,
             min(tenant_count)::integer AS tenant_count_min,
             max(tenant_count)::integer AS tenant_count_max,
             sum(sample_n)::bigint      AS sample_n_total
        FROM public.outcome_cross_tenant_aggregates
       GROUP BY computed_on
       ORDER BY computed_on DESC
       LIMIT 90
    ) g;

  -- What the numbers can and cannot support.
  SELECT jsonb_build_object(
           'prediction_log_rows',                 (SELECT count(*) FROM public.prediction_log),
           'prediction_log_resolved_rows',        (SELECT count(*) FROM public.prediction_log WHERE outcome IS NOT NULL),
           'accounts_with_resolved_predictions_n',(SELECT count(DISTINCT user_id) FROM public.moat_prediction_accuracy_v),
           'first_time_fix_pairs_n',              (SELECT COALESCE(sum(n), 0) FROM public.moat_prediction_accuracy_v WHERE predictor_key = 'first_time_fix'),
           'accounts_opted_in_n',                 (SELECT count(*) FROM public.moat_cohort_contribution_v WHERE capture_enabled AND share_cross_tenant),
           'accounts_with_contribution_n',        (SELECT count(*) FROM public.moat_cohort_contribution_v WHERE contributed_outcomes_n > 0),
           'published_aggregates_rows',           (SELECT count(*) FROM public.outcome_cross_tenant_aggregates),
           'history_older_than_account_n',        (SELECT count(*) FROM public.moat_switching_cost_v
                                                    WHERE first_record_at IS NOT NULL AND first_record_at < account_created_at)
         )
    INTO v_dq;

  RETURN jsonb_build_object(
    'generated_at',       now(),
    'definition_version', 1,
    'min_n',              p_min_n,
    'active_only',        p_active_only,
    'switching_cost',     v_sw,
    'network_effect',     v_ne,
    'cohort_growth',      v_cg,
    'data_quality',       v_dq
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_moat_metrics(integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_moat_metrics(integer, boolean) TO authenticated;
