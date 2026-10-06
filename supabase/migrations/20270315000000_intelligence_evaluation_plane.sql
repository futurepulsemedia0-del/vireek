/*
  Vireek Intelligence Evaluation Plane

  One evaluation layer for every probabilistic model Vireek runs:
  prediction -> actual outcome -> error -> calibration -> segment performance
  -> drift -> cost / latency / safety -> version comparison -> promote / rollback.

  Models covered today (all read from tables that already exist, nothing is
  copied or duplicated):
    first_time_fix     ftf_predictions            vs job_outcomes
    quote_truth        quote_truth_analyses       vs quotes (accepted / declined)
    outcome_assurance  job_assurance_snapshots    vs job_outcomes

  Adds only: eval_plane_policies, eval_plane_decisions (append-only) and
  4 RPCs. Purely additive. Managers only (owner / admin / billing).
  Leakage guard: a prediction counts only if it was made BEFORE its outcome.
  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 1) Policies (one row per account + model; defaults live in the client) ------
CREATE TABLE IF NOT EXISTS eval_plane_policies (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_key text NOT NULL CHECK (model_key IN ('first_time_fix', 'quote_truth', 'outcome_assurance')),
  min_sample integer NOT NULL DEFAULT 30 CHECK (min_sample BETWEEN 5 AND 10000),
  ece_warn numeric(4, 3) NOT NULL DEFAULT 0.080 CHECK (ece_warn BETWEEN 0 AND 1),
  ece_fail numeric(4, 3) NOT NULL DEFAULT 0.150 CHECK (ece_fail BETWEEN 0 AND 1),
  skill_warn numeric(4, 3) NOT NULL DEFAULT 0.050 CHECK (skill_warn BETWEEN -1 AND 1),
  skill_fail numeric(4, 3) NOT NULL DEFAULT 0.000 CHECK (skill_fail BETWEEN -1 AND 1),
  drift_warn numeric(4, 3) NOT NULL DEFAULT 0.030 CHECK (drift_warn BETWEEN 0 AND 1),
  drift_fail numeric(4, 3) NOT NULL DEFAULT 0.080 CHECK (drift_fail BETWEEN 0 AND 1),
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, model_key),
  CONSTRAINT eval_plane_ece_order CHECK (ece_warn < ece_fail),
  CONSTRAINT eval_plane_skill_order CHECK (skill_fail < skill_warn),
  CONSTRAINT eval_plane_drift_order CHECK (drift_warn < drift_fail)
);

-- 2) Decision log (append-only evidence trail for promote / rollback) ---------
CREATE TABLE IF NOT EXISTS eval_plane_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_key text NOT NULL CHECK (model_key IN ('first_time_fix', 'quote_truth', 'outcome_assurance')),
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 60),
  decision text NOT NULL CHECK (decision IN ('promote', 'rollback', 'hold', 'acknowledge')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_plane_decisions_owner
  ON eval_plane_decisions (user_id, model_key, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_eval_plane_decision_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'eval_plane_decisions is append-only';
END;
$$;

-- BEFORE UPDATE only: a DELETE trigger would block account-deletion cascades.
DROP TRIGGER IF EXISTS trg_eval_plane_decisions_immutable ON eval_plane_decisions;
CREATE TRIGGER trg_eval_plane_decisions_immutable
  BEFORE UPDATE ON eval_plane_decisions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_eval_plane_decision_update();

ALTER TABLE eval_plane_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_plane_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "eval_plane_policies_read" ON eval_plane_policies;
CREATE POLICY "eval_plane_policies_read" ON eval_plane_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ftf_is_manager());

DROP POLICY IF EXISTS "eval_plane_decisions_read" ON eval_plane_decisions;
CREATE POLICY "eval_plane_decisions_read" ON eval_plane_decisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ftf_is_manager());

-- Writes: RPC only (no INSERT / UPDATE / DELETE policies on purpose).

-- 3) Internal: labeled (prediction, outcome) pairs ----------------------------
CREATE OR REPLACE FUNCTION public.eval_plane_pairs(
  p_owner uuid, p_model text, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (
  version text, p double precision, y smallint, occurred_at timestamptz,
  trade text, customer_type text, state text, job_type text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF p_model = 'first_time_fix' THEN
    RETURN QUERY
    SELECT 'v' || fp.model_version::text,
           (fp.probability / 100.0)::double precision,
           (CASE WHEN o.resolution = 'fixed_first_visit' AND NOT o.caused_callback THEN 1 ELSE 0 END)::smallint,
           o.recorded_at,
           coalesce(nullif(btrim(o.playbook_slug), ''), 'unknown'),
           coalesce(j.customer_type, 'unknown'),
           coalesce(nullif(upper(btrim(cs.state)), ''), 'unknown'),
           coalesce(nullif(btrim(o.job_type_key), ''), 'unknown')
    FROM ftf_predictions fp
    JOIN job_outcomes o ON o.job_id = fp.job_id AND o.technician_id = fp.technician_id
    JOIN jobs j ON j.id = fp.job_id
    LEFT JOIN customer_sites cs ON cs.id = j.site_id
    WHERE fp.account_owner_id = p_owner
      AND o.user_id = p_owner
      AND NOT o.is_rework
      AND fp.updated_at <= o.recorded_at
      AND o.recorded_at >= p_from AND o.recorded_at < p_to;

  ELSIF p_model = 'outcome_assurance' THEN
    RETURN QUERY
    SELECT 'v1'::text,
           (s.probability / 100.0)::double precision,
           (CASE WHEN o.resolution = 'fixed_first_visit' AND NOT o.caused_callback THEN 1 ELSE 0 END)::smallint,
           o.recorded_at,
           coalesce(nullif(btrim(o.playbook_slug), ''), 'unknown'),
           coalesce(j.customer_type, 'unknown'),
           coalesce(nullif(upper(btrim(cs.state)), ''), 'unknown'),
           coalesce(nullif(btrim(o.job_type_key), ''), 'unknown')
    FROM job_outcomes o
    JOIN LATERAL (
      SELECT a.probability
      FROM job_assurance_snapshots a
      WHERE a.job_id = o.job_id AND a.user_id = p_owner AND a.created_at <= o.recorded_at
      ORDER BY a.created_at DESC
      LIMIT 1
    ) s ON true
    JOIN jobs j ON j.id = o.job_id
    LEFT JOIN customer_sites cs ON cs.id = j.site_id
    WHERE o.user_id = p_owner
      AND NOT o.is_rework
      AND o.recorded_at >= p_from AND o.recorded_at < p_to;

  ELSIF p_model = 'quote_truth' THEN
    -- Event = "customer declined". Quotes carry no trade / site, so segments are 'unknown'.
    RETURN QUERY
    SELECT a.engine_version,
           a.rejection_probability::double precision,
           (CASE WHEN q.status = 'declined' THEN 1 ELSE 0 END)::smallint,
           q.responded_at,
           'unknown'::text, 'unknown'::text, 'unknown'::text, 'unknown'::text
    FROM quotes q
    JOIN LATERAL (
      SELECT t.engine_version, t.rejection_probability
      FROM quote_truth_analyses t
      WHERE t.quote_id = q.id AND t.user_id = p_owner AND t.created_at <= q.responded_at
      ORDER BY t.created_at DESC
      LIMIT 1
    ) a ON true
    WHERE q.user_id = p_owner
      AND q.status IN ('accepted', 'declined')
      AND q.responded_at IS NOT NULL
      AND q.responded_at >= p_from AND q.responded_at < p_to;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.eval_plane_pairs(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- 4) Public: calibration bins per (dimension, segment, version) ---------------
-- Returns 10 probability bins; every metric (Brier, ECE, bias, skill, drift)
-- is derived from these sums client-side, so one cheap query serves the page.
CREATE OR REPLACE FUNCTION public.eval_plane_bins(p_model text, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  dim text, seg text, version text, bin smallint,
  n bigint, sum_p double precision, sum_y double precision, sum_sq double precision
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ftf_is_manager() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_model NOT IN ('first_time_fix', 'quote_truth', 'outcome_assurance') THEN
    RAISE EXCEPTION 'Unknown model';
  END IF;
  IF p_to <= p_from OR p_to - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'Invalid window';
  END IF;

  RETURN QUERY
  WITH b AS (
    SELECT pr.version, pr.p, pr.y, pr.trade, pr.customer_type, pr.state, pr.job_type,
           least(9, floor(pr.p * 10))::smallint AS bin
    FROM public.eval_plane_pairs(v_owner, p_model, p_from, p_to) pr
  ),
  u AS (
    SELECT 'overall'::text AS dim, 'all'::text AS seg, version, bin, p, y FROM b
    UNION ALL SELECT 'trade', trade, version, bin, p, y FROM b
    UNION ALL SELECT 'customer_type', customer_type, version, bin, p, y FROM b
    UNION ALL SELECT 'state', state, version, bin, p, y FROM b
    UNION ALL SELECT 'job_type', job_type, version, bin, p, y FROM b
  )
  SELECT u.dim, u.seg, u.version, u.bin,
         count(*)::bigint,
         sum(u.p)::double precision,
         sum(u.y)::double precision,
         sum(power(u.p - u.y, 2))::double precision
  FROM u
  GROUP BY u.dim, u.seg, u.version, u.bin;
END;
$$;

-- 5) Public: AI cost / latency / reliability / safety -------------------------
CREATE OR REPLACE FUNCTION public.eval_plane_ai_ops(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tasks jsonb;
  v_eval jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ftf_is_manager() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_to <= p_from OR p_to - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'Invalid window';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.total_cost_usd DESC), '[]'::jsonb) INTO v_tasks
  FROM (
    SELECT l.task,
           count(*) AS calls,
           round(avg(CASE WHEN l.ok THEN 1 ELSE 0 END)::numeric, 4) AS ok_rate,
           round(avg(CASE WHEN l.was_fallback THEN 1 ELSE 0 END)::numeric, 4) AS fallback_rate,
           round(sum(l.cost_usd)::numeric, 4) AS total_cost_usd,
           round(avg(l.cost_usd)::numeric, 6) AS avg_cost_usd,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms))::numeric) AS p50_ms,
           round((percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms))::numeric) AS p95_ms
    FROM ai_usage_logs l
    WHERE l.account_id = v_owner AND l.created_at >= p_from AND l.created_at < p_to
    GROUP BY l.task
  ) t;

  SELECT jsonb_build_object(
           'runs', count(*),
           'cases', coalesce(sum(r.case_count), 0),
           'passes', coalesce(sum(r.pass_count), 0),
           'fails', coalesce(sum(r.fail_count), 0),
           'hallucinations', coalesce(sum(r.hallucination_count), 0)
         ) INTO v_eval
  FROM ai_eval_runs r
  WHERE r.account_id = v_owner AND r.status = 'completed'
    AND r.started_at >= p_from AND r.started_at < p_to;

  RETURN jsonb_build_object('tasks', v_tasks, 'eval', v_eval);
END;
$$;

-- 6) Public: save policy (managers only) --------------------------------------
CREATE OR REPLACE FUNCTION public.save_eval_plane_policy(
  p_model_key text, p_min_sample integer,
  p_ece_warn numeric, p_ece_fail numeric,
  p_skill_warn numeric, p_skill_fail numeric,
  p_drift_warn numeric, p_drift_fail numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ftf_is_manager() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  INSERT INTO eval_plane_policies AS e
    (user_id, model_key, min_sample, ece_warn, ece_fail, skill_warn, skill_fail, drift_warn, drift_fail, updated_by, updated_at)
  VALUES
    (v_owner, p_model_key, p_min_sample, p_ece_warn, p_ece_fail, p_skill_warn, p_skill_fail, p_drift_warn, p_drift_fail, auth.uid(), now())
  ON CONFLICT (user_id, model_key) DO UPDATE SET
    min_sample = EXCLUDED.min_sample, ece_warn = EXCLUDED.ece_warn, ece_fail = EXCLUDED.ece_fail,
    skill_warn = EXCLUDED.skill_warn, skill_fail = EXCLUDED.skill_fail,
    drift_warn = EXCLUDED.drift_warn, drift_fail = EXCLUDED.drift_fail,
    updated_by = auth.uid(), updated_at = now();
END;
$$;

-- 7) Public: record a promote / rollback / hold / acknowledge decision --------
CREATE OR REPLACE FUNCTION public.record_eval_plane_decision(
  p_model_key text, p_version text, p_decision text, p_reason text, p_metrics jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ftf_is_manager() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_decision NOT IN ('promote', 'rollback', 'hold', 'acknowledge') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;
  IF pg_column_size(coalesce(p_metrics, '{}'::jsonb)) > 20000 THEN
    RAISE EXCEPTION 'Metrics payload too large';
  END IF;

  INSERT INTO eval_plane_decisions (user_id, model_key, version, decision, reason, metrics)
  VALUES (v_owner, p_model_key, left(p_version, 60), p_decision, btrim(p_reason), coalesce(p_metrics, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.eval_plane_bins(text, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eval_plane_ai_ops(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_eval_plane_policy(text, integer, numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_eval_plane_decision(text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eval_plane_bins(text, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eval_plane_ai_ops(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_eval_plane_policy(text, integer, numeric, numeric, numeric, numeric, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_eval_plane_decision(text, text, text, text, jsonb) TO authenticated;
