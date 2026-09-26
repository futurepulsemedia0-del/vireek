/*
  # Counterfactual Reality Engine

  ## Why
  The existing Counterfactual Library answers "what if a different micro-
  decision had been made on THIS job/quote?". This adds the macro layer:
  the user logs a real business decision (a pricing change, a marketing
  shift, a hire...) with a date, and the engine compares the ACTUAL path
  of a chosen weekly metric after that date to a COUNTERFACTUAL path —
  what this account's own pre-decision trend (fit via linear regression
  on its own weekly history) would have predicted had nothing changed.
  Every number comes from this account's own jobs/leads history — never
  a generic industry benchmark.

  ## Tables
  - business_reality_decisions — user-logged decisions + cached last result.
*/

CREATE TABLE IF NOT EXISTS business_reality_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('pricing', 'marketing', 'staffing', 'service_area', 'process', 'other')),
  decision_date date NOT NULL,
  metric text NOT NULL DEFAULT 'revenue'
    CHECK (metric IN ('revenue', 'leads', 'bookings', 'jobs_completed', 'avg_ticket')),
  description text,
  last_result jsonb,
  last_computed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brd_user ON business_reality_decisions(user_id, decision_date DESC);

ALTER TABLE business_reality_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_reality_decisions" ON business_reality_decisions;
CREATE POLICY "select_own_reality_decisions" ON business_reality_decisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_reality_decisions" ON business_reality_decisions;
CREATE POLICY "insert_own_reality_decisions" ON business_reality_decisions FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_reality_decisions" ON business_reality_decisions;
CREATE POLICY "update_own_reality_decisions" ON business_reality_decisions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_reality_decisions" ON business_reality_decisions;
CREATE POLICY "delete_own_reality_decisions" ON business_reality_decisions FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- THE ENGINE: actual weekly path vs. counterfactual (pre-decision
-- trend, extrapolated via Postgres' built-in linear regression)
-- =============================================================
CREATE OR REPLACE FUNCTION public.compute_counterfactual_reality_path(
  p_decision_id uuid,
  p_pre_weeks integer DEFAULT 8,
  p_post_weeks integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_decision record;
  v_first_week date;
  v_decision_week date;
  v_last_week date;
  v_slope numeric;
  v_intercept numeric;
  v_r2 numeric;
  v_pre_n integer;
  v_cum_actual numeric;
  v_cum_cf numeric;
  v_weekly jsonb;
  v_confidence text;
  v_result jsonb;
BEGIN
  SELECT * INTO v_decision FROM business_reality_decisions
  WHERE id = p_decision_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Decision not found or not authorized'; END IF;

  p_pre_weeks := GREATEST(COALESCE(p_pre_weeks, 8), 2);
  p_post_weeks := GREATEST(COALESCE(p_post_weeks, 8), 1);

  v_first_week := (date_trunc('week', v_decision.decision_date::timestamptz - (p_pre_weeks || ' weeks')::interval))::date;
  v_decision_week := (date_trunc('week', v_decision.decision_date::timestamptz))::date;
  v_last_week := LEAST(
    (date_trunc('week', v_decision.decision_date::timestamptz + (p_post_weeks || ' weeks')::interval))::date,
    (date_trunc('week', now()))::date
  );
  IF v_last_week < v_decision_week THEN v_last_week := v_decision_week; END IF;

  DROP TABLE IF EXISTS _cfre_weeks;
  CREATE TEMP TABLE _cfre_weeks ON COMMIT DROP AS
  SELECT gs::date AS week_start, 0::numeric AS actual,
         (row_number() OVER (ORDER BY gs) - 1)::int AS idx
  FROM generate_series(v_first_week, v_last_week, interval '1 week') AS gs;

  IF v_decision.metric = 'revenue' THEN
    UPDATE _cfre_weeks w SET actual = COALESCE(a.v, 0) FROM (
      SELECT date_trunc('week', created_at)::date wk, sum(invoice_amount) v FROM jobs
      WHERE user_id = v_decision.user_id AND job_status = 'completed'
        AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
      GROUP BY 1) a WHERE w.week_start = a.wk;
  ELSIF v_decision.metric = 'leads' THEN
    UPDATE _cfre_weeks w SET actual = COALESCE(a.v, 0) FROM (
      SELECT date_trunc('week', created_at)::date wk, count(*) v FROM leads
      WHERE user_id = v_decision.user_id
        AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
      GROUP BY 1) a WHERE w.week_start = a.wk;
  ELSIF v_decision.metric = 'bookings' THEN
    UPDATE _cfre_weeks w SET actual = COALESCE(a.v, 0) FROM (
      SELECT date_trunc('week', created_at)::date wk, count(*) v FROM jobs
      WHERE user_id = v_decision.user_id AND job_status <> 'cancelled'
        AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
      GROUP BY 1) a WHERE w.week_start = a.wk;
  ELSIF v_decision.metric = 'jobs_completed' THEN
    UPDATE _cfre_weeks w SET actual = COALESCE(a.v, 0) FROM (
      SELECT date_trunc('week', created_at)::date wk, count(*) v FROM jobs
      WHERE user_id = v_decision.user_id AND job_status = 'completed'
        AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
      GROUP BY 1) a WHERE w.week_start = a.wk;
  ELSIF v_decision.metric = 'avg_ticket' THEN
    UPDATE _cfre_weeks w SET actual = COALESCE(a.v, 0) FROM (
      SELECT date_trunc('week', created_at)::date wk, avg(invoice_amount) v FROM jobs
      WHERE user_id = v_decision.user_id AND job_status = 'completed' AND invoice_amount IS NOT NULL
        AND created_at >= v_first_week AND created_at < v_last_week + interval '1 week'
      GROUP BY 1) a WHERE w.week_start = a.wk;
  END IF;

  SELECT regr_slope(actual, idx), regr_intercept(actual, idx), regr_r2(actual, idx), count(*)
  INTO v_slope, v_intercept, v_r2, v_pre_n
  FROM _cfre_weeks WHERE week_start < v_decision_week;

  IF v_slope IS NULL THEN
    SELECT COALESCE(avg(actual), 0) INTO v_intercept FROM _cfre_weeks WHERE week_start < v_decision_week;
    v_slope := 0; v_r2 := 0;
  END IF;

  SELECT
    COALESCE(sum(actual) FILTER (WHERE week_start >= v_decision_week), 0),
    COALESCE(sum(GREATEST(v_slope * idx + v_intercept, 0)) FILTER (WHERE week_start >= v_decision_week), 0)
  INTO v_cum_actual, v_cum_cf
  FROM _cfre_weeks;

  v_confidence := CASE
    WHEN v_pre_n >= 8 AND COALESCE(v_r2, 0) >= 0.4 THEN 'high'
    WHEN v_pre_n >= 4 THEN 'medium'
    ELSE 'low'
  END;

  SELECT jsonb_agg(jsonb_build_object(
    'week_start', week_start,
    'actual', round(actual, 2),
    'counterfactual', round(GREATEST(v_slope * idx + v_intercept, 0), 2)
  ) ORDER BY week_start) INTO v_weekly FROM _cfre_weeks;

  v_result := jsonb_build_object(
    'metric', v_decision.metric,
    'decision_week', v_decision_week,
    'pre_weeks_used', v_pre_n,
    'post_weeks_used', (SELECT count(*) FROM _cfre_weeks WHERE week_start >= v_decision_week),
    'slope', round(v_slope, 4),
    'r_squared', round(COALESCE(v_r2, 0), 4),
    'cumulative_actual', round(v_cum_actual, 2),
    'cumulative_counterfactual', round(v_cum_cf, 2),
    'cumulative_impact', round(v_cum_actual - v_cum_cf, 2),
    'confidence', v_confidence,
    'weekly', v_weekly
  );

  UPDATE business_reality_decisions SET last_result = v_result, last_computed_at = now() WHERE id = p_decision_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_counterfactual_reality_path(uuid, integer, integer) TO authenticated;
