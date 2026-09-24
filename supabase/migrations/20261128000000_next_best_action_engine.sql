/*
  # Proactive Customer Care / Next Best Action Engine

  Ranks the day's most important revenue/operational actions — an estimate
  at risk, a customer showing churn signals, a day with open technician
  capacity, or an invoice at risk of going uncollected — using signals that
  ALREADY exist in this schema (revenue_recovery_events, get_capacity_status)
  plus one new deterministic churn heuristic. The AI layer only ranks and
  writes copy over these ground-truth candidates; it never invents one.

  Purely additive.

  1. next_best_actions                    daily ranked action feed (history).
  2. get_next_best_action_churn_candidates() same cadence-based risk heuristic
                                            already used in CustomerIntelligencePage,
                                            moved server-side so it can feed the engine.
  3. next_best_action_usage / consume_next_best_action_quota()
                                            atomic per-account hourly quota,
                                            service-role only — same pattern as
                                            consume_field_estimate_quota().

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Daily ranked action feed --------------------------------------------
CREATE TABLE IF NOT EXISTS next_best_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- the ACCOUNT OWNER id (get_account_owner_id())
  action_date date NOT NULL DEFAULT current_date,
  category text NOT NULL CHECK (category IN ('estimate_risk', 'invoice_risk', 'churn_risk', 'capacity_gap')),
  title text NOT NULL,
  reasoning text NOT NULL,
  recommended_action text NOT NULL,
  priority_score integer NOT NULL DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
  amount_label text,
  entity_type text,
  entity_id uuid,
  entity_label text,
  cta_href text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_next_best_actions_user_date
  ON next_best_actions(user_id, action_date DESC, priority_score DESC);

ALTER TABLE next_best_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_next_best_actions" ON next_best_actions;
CREATE POLICY "select_own_next_best_actions" ON next_best_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_next_best_actions" ON next_best_actions;
CREATE POLICY "update_own_next_best_actions" ON next_best_actions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- Intentionally no INSERT/DELETE policy for authenticated: only the
-- next-best-actions Edge Function (service role) writes rows, so a client
-- can never fabricate a fake "estimate at risk" or forge a priority score.

-- 2) Server-side churn-cadence heuristic ----------------------------------
-- Mirrors the transparent heuristic already used client-side in
-- CustomerIntelligencePage.tsx (own historical job cadence vs. days since
-- last job) — moved here so the engine can rank real at-risk customers.
CREATE OR REPLACE FUNCTION public.get_next_best_action_churn_candidates(p_limit integer DEFAULT 8)
RETURNS TABLE (
  customer_id uuid,
  customer_name text,
  tier text,
  days_since_last_job integer,
  ltv_dollars numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  RETURN QUERY
  WITH job_gaps AS (
    SELECT
      j.customer_id,
      j.created_at,
      LAG(j.created_at) OVER (PARTITION BY j.customer_id ORDER BY j.created_at) AS prev_created_at
    FROM jobs j
    WHERE j.user_id = v_owner AND j.customer_id IS NOT NULL
  ),
  cycles AS (
    SELECT customer_id, AVG(EXTRACT(EPOCH FROM (created_at - prev_created_at)) / 86400) AS avg_cycle_days
    FROM job_gaps
    WHERE prev_created_at IS NOT NULL
    GROUP BY customer_id
  ),
  agg AS (
    SELECT
      j.customer_id,
      COUNT(*) AS job_count,
      MAX(j.created_at) AS last_job_at,
      SUM(COALESCE(j.invoice_amount, 0)) AS ltv
    FROM jobs j
    WHERE j.user_id = v_owner AND j.customer_id IS NOT NULL
    GROUP BY j.customer_id
  ),
  scored AS (
    SELECT
      c.id AS customer_id,
      c.name AS customer_name,
      c.lifecycle_stage,
      a.job_count,
      a.ltv,
      GREATEST(0, (CURRENT_DATE - a.last_job_at::date))::integer AS days_since_last_job,
      cy.avg_cycle_days
    FROM customers c
    JOIN agg a ON a.customer_id = c.id
    LEFT JOIN cycles cy ON cy.customer_id = c.id
    WHERE c.user_id = v_owner
  ),
  tiered AS (
    SELECT
      s.*,
      CASE
        WHEN s.lifecycle_stage = 'inactive' THEN 'churned'
        WHEN s.job_count = 1 OR s.avg_cycle_days IS NULL THEN
          CASE
            WHEN s.days_since_last_job <= 30 THEN 'new'
            WHEN s.days_since_last_job <= 90 THEN 'healthy'
            WHEN s.days_since_last_job <= 180 THEN 'watch'
            ELSE 'at_risk'
          END
        ELSE
          CASE
            WHEN s.days_since_last_job::numeric / GREATEST(s.avg_cycle_days, 14) <= 1 THEN 'healthy'
            WHEN s.days_since_last_job::numeric / GREATEST(s.avg_cycle_days, 14) <= 1.75 THEN 'watch'
            ELSE 'at_risk'
          END
      END AS tier
    FROM scored s
  )
  SELECT t.customer_id, t.customer_name, t.tier, t.days_since_last_job, ROUND(t.ltv, 2) AS ltv_dollars
  FROM tiered t
  WHERE t.tier IN ('at_risk', 'watch')
  ORDER BY t.ltv DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 20));
END;
$$;

-- 3) Atomic quota (service-role only) ---------------------------------------
CREATE TABLE IF NOT EXISTS next_best_action_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE next_best_action_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only this migration's RPC (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_next_best_action_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO next_best_action_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_next_best_action_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_next_best_action_quota(uuid, integer, integer) TO service_role;
