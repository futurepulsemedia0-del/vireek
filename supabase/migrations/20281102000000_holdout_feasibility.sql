/*
  # Verified Incrementality — Phase 0: holdout feasibility inputs (read-only)

  ## Why
  Before adding any randomized holdout we must know whether any action type has enough volume
  to ever detect a lift. These functions only AGGREGATE existing data; no tables are created,
  no behavior changes, nothing is written.

  ## Population (verified in the repo)
  - ai_action_events  — next_best_action 'done' + workflow_run 'completed' (captured by triggers).
  - outbound_sms      — what followup-agent-dispatcher really sends (quote_followup,
                        review_request_call, appointment_reminder). These dispatchers do NOT
                        write to ai_action_events, so ai_action_events alone undercounts.

  ## Outcome
  Binary "customer booked another job within 90 days of the action", only for actions at least
  90 days old (mature) and linked to a job -> customer. Same outcome as causal ROI retention.

  ## Functions
  - holdout_feasibility_core(p_lookback_days, p_owner)  service_role only; one row per
                                                     (account, source, action_type); p_owner NULL = all
                                                     accounts (operator), set = one tenant (pushed down).
  - get_holdout_feasibility_inputs(p_lookback_days)  tenant-scoped wrapper for the owner.
*/

CREATE OR REPLACE FUNCTION public.holdout_feasibility_core(p_lookback_days integer DEFAULT 365, p_owner uuid DEFAULT NULL)
RETURNS TABLE (
  user_id uuid,
  population_source text,
  action_type text,
  n_actions integer,
  active_months numeric,
  n_mature_resolved integer,
  n_mature_repeat integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    -- Clamp so a bad argument cannot trigger an unbounded scan.
    SELECT
      LEAST(GREATEST(COALESCE(p_lookback_days, 365), 30), 1095) AS days,
      now() - make_interval(days => LEAST(GREATEST(COALESCE(p_lookback_days, 365), 30), 1095)) AS since,
      now() - interval '90 days' AS mature_before
  ),
  acts AS (
    SELECT e.user_id, 'ai_action_events'::text AS population_source, e.action_type,
           e.occurred_at AS at,
           public.resolve_ai_action_event_job(e.entity_type, e.entity_id, e.user_id, e.occurred_at) AS job_id
    FROM ai_action_events e, params p
    WHERE e.occurred_at >= p.since
      AND (p_owner IS NULL OR e.user_id = p_owner)
    UNION ALL
    SELECT s.user_id, 'outbound_sms'::text, s.campaign_type,
           COALESCE(s.sent_at, s.created_at), s.job_id
    FROM outbound_sms s, params p
    WHERE s.status IN ('sent', 'delivered')
      AND COALESCE(s.sent_at, s.created_at) >= p.since
      AND (p_owner IS NULL OR s.user_id = p_owner)
  ),
  scored AS (
    SELECT a.user_id, a.population_source, a.action_type, a.at,
      CASE
        WHEN a.at <= (SELECT mature_before FROM params) AND j.customer_id IS NOT NULL THEN
          EXISTS (
            SELECT 1 FROM jobs j2
            WHERE j2.user_id = a.user_id
              AND j2.customer_id = j.customer_id
              AND j2.created_at > a.at
              AND j2.created_at <= a.at + interval '90 days'
          )
      END AS repeat_90d -- NULL = not mature yet, or no linked customer (unmeasurable)
    FROM acts a
    LEFT JOIN jobs j ON j.id = a.job_id AND j.user_id = a.user_id
  )
  SELECT
    s.user_id,
    s.population_source,
    s.action_type,
    count(*)::integer,
    -- Months since the first action in the window, so a quiet tail is not hidden.
    round(LEAST(
      (SELECT days FROM params) / 30.4375,
      GREATEST(1, extract(epoch FROM (now() - min(s.at))) / 86400.0 / 30.4375)
    )::numeric, 2),
    (count(*) FILTER (WHERE s.repeat_90d IS NOT NULL))::integer,
    (count(*) FILTER (WHERE s.repeat_90d IS TRUE))::integer
  FROM scored s
  GROUP BY s.user_id, s.population_source, s.action_type;
$$;

-- Cross-tenant: operator only. Never reachable from the browser.
REVOKE ALL ON FUNCTION public.holdout_feasibility_core(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.holdout_feasibility_core(integer, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.holdout_feasibility_core(integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_holdout_feasibility_inputs(p_lookback_days integer DEFAULT 365)
RETURNS TABLE (
  population_source text,
  action_type text,
  n_actions integer,
  active_months numeric,
  n_mature_resolved integer,
  n_mature_repeat integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.population_source, c.action_type, c.n_actions, c.active_months,
         c.n_mature_resolved, c.n_mature_repeat
  FROM public.holdout_feasibility_core(p_lookback_days, public.get_account_owner_id()) c
  -- If the caller has no resolvable account, p_owner would be NULL and core would return ALL
  -- tenants. This guard makes that case return nothing instead.
  WHERE public.get_account_owner_id() IS NOT NULL
  ORDER BY c.action_type, c.population_source;
$$;

REVOKE ALL ON FUNCTION public.get_holdout_feasibility_inputs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_holdout_feasibility_inputs(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_holdout_feasibility_inputs(integer) TO authenticated;
