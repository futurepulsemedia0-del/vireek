/*
  # Causal Disruption Chain Engine

  ## Why
  Answers "what operational disruption is actually driving my Conversion /
  Cancellation / Revenue changes?" — not a guess, but Pearson correlation
  (Postgres' built-in corr()) computed on this account's own weekly history,
  both same-week and 1-week-lagged (to surface leading indicators, e.g.
  "dispatch delay this week predicts cancellations NEXT week").

  ## Tables
  - causal_chain_analyses — one cached result row per account.
*/

CREATE TABLE IF NOT EXISTS causal_chain_analyses (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  result jsonb,
  computed_at timestamptz
);

ALTER TABLE causal_chain_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_causal_chain_analyses" ON causal_chain_analyses;
CREATE POLICY "select_own_causal_chain_analyses" ON causal_chain_analyses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — only the RPC below writes here.

-- =============================================================
-- THE ENGINE
-- =============================================================
CREATE OR REPLACE FUNCTION public.compute_causal_disruption_chains(p_weeks integer DEFAULT 26)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
  v_first_week date;
  v_last_week date;
  v_weeks_analyzed integer;
  v_weeks_with_dispatch integer;
  v_confidence text;
  v_result jsonb;
BEGIN
  p_weeks := GREATEST(COALESCE(p_weeks, 26), 6);
  v_last_week := (date_trunc('week', now()) - interval '1 week')::date;
  v_first_week := (date_trunc('week', now() - (p_weeks || ' weeks')::interval))::date;

  DROP TABLE IF EXISTS _ccd_weeks;
  CREATE TEMP TABLE _ccd_weeks ON COMMIT DROP AS
  SELECT gs::date AS week_start,
         NULL::numeric AS dispatch_delay, NULL::numeric AS missed_call_rate, NULL::numeric AS reschedule_rate,
         NULL::numeric AS conversion_rate, NULL::numeric AS cancellation_rate, NULL::numeric AS revenue
  FROM generate_series(v_first_week, v_last_week, interval '1 week') AS gs;

  UPDATE _ccd_weeks w SET dispatch_delay = a.v FROM (
    SELECT date_trunc('week', jta.assigned_at)::date wk, avg(EXTRACT(epoch FROM (jta.assigned_at - j.created_at)) / 3600) v
    FROM job_technician_assignments jta JOIN jobs j ON j.id = jta.job_id
    WHERE jta.user_id = v_user_id AND jta.assigned_at >= v_first_week AND jta.assigned_at < v_last_week + interval '1 week'
    GROUP BY 1) a WHERE w.week_start = a.wk;

  UPDATE _ccd_weeks w SET missed_call_rate = a.v FROM (
    SELECT date_trunc('week', call_datetime)::date wk, (count(*) FILTER (WHERE status = 'missed'))::numeric / NULLIF(count(*), 0) v
    FROM calls WHERE user_id = v_user_id AND call_datetime >= v_first_week AND call_datetime < v_last_week + interval '1 week'
    GROUP BY 1) a WHERE w.week_start = a.wk;

  UPDATE _ccd_weeks w SET reschedule_rate = a.v FROM (
    SELECT sc.wk, sc.n::numeric / NULLIF(jc.n, 0) v FROM (
      SELECT date_trunc('week', changed_at)::date wk, count(*) n FROM job_schedule_changes
      WHERE user_id = v_user_id AND changed_at >= v_first_week AND changed_at < v_last_week + interval '1 week' GROUP BY 1) sc
    JOIN (
      SELECT date_trunc('week', created_at)::date wk, count(*) n FROM jobs
      WHERE user_id = v_user_id AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week' GROUP BY 1) jc
    ON sc.wk = jc.wk) a WHERE w.week_start = a.wk;

  UPDATE _ccd_weeks w SET conversion_rate = a.v FROM (
    SELECT date_trunc('week', created_at)::date wk, (count(*) FILTER (WHERE stage = 'won'))::numeric / NULLIF(count(*), 0) v
    FROM leads WHERE user_id = v_user_id AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
    GROUP BY 1) a WHERE w.week_start = a.wk;

  UPDATE _ccd_weeks w SET cancellation_rate = a.v FROM (
    SELECT date_trunc('week', created_at)::date wk, (count(*) FILTER (WHERE job_status = 'cancelled'))::numeric / NULLIF(count(*), 0) v
    FROM jobs WHERE user_id = v_user_id AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
    GROUP BY 1) a WHERE w.week_start = a.wk;

  UPDATE _ccd_weeks w SET revenue = a.v FROM (
    SELECT date_trunc('week', created_at)::date wk, sum(invoice_amount) v
    FROM jobs WHERE user_id = v_user_id AND job_status = 'completed' AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
    GROUP BY 1) a WHERE w.week_start = a.wk;

  SELECT count(*), count(*) FILTER (WHERE dispatch_delay IS NOT NULL)
  INTO v_weeks_analyzed, v_weeks_with_dispatch FROM _ccd_weeks;

  v_confidence := CASE
    WHEN v_weeks_analyzed >= 16 AND v_weeks_with_dispatch >= 8 THEN 'high'
    WHEN v_weeks_analyzed >= 8 THEN 'medium'
    ELSE 'low'
  END;

  WITH base AS (
    SELECT *,
      LEAD(conversion_rate) OVER (ORDER BY week_start) AS conversion_rate_lead,
      LEAD(cancellation_rate) OVER (ORDER BY week_start) AS cancellation_rate_lead,
      LEAD(revenue) OVER (ORDER BY week_start) AS revenue_lead
    FROM _ccd_weeks
  ),
  edges AS (
    SELECT t.from_metric, t.to_metric, t.same_week_corr, t.next_week_corr FROM (VALUES
      ('dispatch_delay', 'conversion_rate', (SELECT corr(dispatch_delay, conversion_rate) FROM base), (SELECT corr(dispatch_delay, conversion_rate_lead) FROM base)),
      ('dispatch_delay', 'cancellation_rate', (SELECT corr(dispatch_delay, cancellation_rate) FROM base), (SELECT corr(dispatch_delay, cancellation_rate_lead) FROM base)),
      ('dispatch_delay', 'revenue', (SELECT corr(dispatch_delay, revenue) FROM base), (SELECT corr(dispatch_delay, revenue_lead) FROM base)),
      ('missed_call_rate', 'conversion_rate', (SELECT corr(missed_call_rate, conversion_rate) FROM base), (SELECT corr(missed_call_rate, conversion_rate_lead) FROM base)),
      ('missed_call_rate', 'cancellation_rate', (SELECT corr(missed_call_rate, cancellation_rate) FROM base), (SELECT corr(missed_call_rate, cancellation_rate_lead) FROM base)),
      ('missed_call_rate', 'revenue', (SELECT corr(missed_call_rate, revenue) FROM base), (SELECT corr(missed_call_rate, revenue_lead) FROM base)),
      ('reschedule_rate', 'conversion_rate', (SELECT corr(reschedule_rate, conversion_rate) FROM base), (SELECT corr(reschedule_rate, conversion_rate_lead) FROM base)),
      ('reschedule_rate', 'cancellation_rate', (SELECT corr(reschedule_rate, cancellation_rate) FROM base), (SELECT corr(reschedule_rate, cancellation_rate_lead) FROM base)),
      ('reschedule_rate', 'revenue', (SELECT corr(reschedule_rate, revenue) FROM base), (SELECT corr(reschedule_rate, revenue_lead) FROM base)),
      ('cancellation_rate', 'revenue', (SELECT corr(cancellation_rate, revenue) FROM base), (SELECT corr(cancellation_rate, revenue_lead) FROM base)),
      ('conversion_rate', 'revenue', (SELECT corr(conversion_rate, revenue) FROM base), (SELECT corr(conversion_rate, revenue_lead) FROM base))
    ) AS t(from_metric, to_metric, same_week_corr, next_week_corr)
  ),
  best_op_edges AS (
    SELECT DISTINCT ON (to_metric) from_metric, to_metric, same_week_corr, next_week_corr,
      GREATEST(COALESCE(abs(same_week_corr), 0), COALESCE(abs(next_week_corr), 0)) AS strength,
      (COALESCE(abs(next_week_corr), 0) >= COALESCE(abs(same_week_corr), 0)) AS leading
    FROM edges
    WHERE from_metric IN ('dispatch_delay', 'missed_call_rate', 'reschedule_rate')
    ORDER BY to_metric, GREATEST(COALESCE(abs(same_week_corr), 0), COALESCE(abs(next_week_corr), 0)) DESC
  ),
  top_driver AS (
    SELECT * FROM best_op_edges ORDER BY strength DESC LIMIT 1
  ),
  biz_edges AS (
    SELECT from_metric, to_metric, same_week_corr, next_week_corr
    FROM edges WHERE from_metric IN ('cancellation_rate', 'conversion_rate') AND to_metric = 'revenue'
  )
  SELECT jsonb_build_object(
    'weeks_analyzed', v_weeks_analyzed,
    'weeks_with_dispatch_data', v_weeks_with_dispatch,
    'confidence', v_confidence,
    'edges', (SELECT jsonb_agg(jsonb_build_object(
        'from_metric', from_metric, 'to_metric', to_metric,
        'same_week_corr', round(same_week_corr, 3), 'next_week_corr', round(next_week_corr, 3)
      )) FROM edges),
    'top_driver', (SELECT to_jsonb(top_driver) FROM top_driver),
    'business_chain', (SELECT jsonb_agg(jsonb_build_object(
        'from_metric', from_metric, 'to_metric', to_metric,
        'same_week_corr', round(same_week_corr, 3), 'next_week_corr', round(next_week_corr, 3)
      )) FROM biz_edges),
    'weekly', (SELECT jsonb_agg(jsonb_build_object(
        'week_start', week_start, 'dispatch_delay', round(dispatch_delay, 2), 'missed_call_rate', round(missed_call_rate, 3),
        'reschedule_rate', round(reschedule_rate, 3), 'conversion_rate', round(conversion_rate, 3),
        'cancellation_rate', round(cancellation_rate, 3), 'revenue', round(revenue, 2)
      ) ORDER BY week_start) FROM base)
  ) INTO v_result;

  INSERT INTO causal_chain_analyses (user_id, result, computed_at)
  VALUES (v_user_id, v_result, now())
  ON CONFLICT (user_id) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_causal_disruption_chains(integer) TO authenticated;
