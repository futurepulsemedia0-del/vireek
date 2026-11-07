/*
  # Economics part 2: per-booking / per-paid-job / per-workflow unit costs, marketplace economics,
  # Outcome-Learning read contract, tenant ROI inputs, alerts table, service-role "core" functions.

  Verified links used (from repo migrations): jobs.call_id -> calls.id (uuid); calls.vapi_call_id (text) -> cost_ledger.call_id;
  jobs.invoice_status = 'paid'; workflow_runs.status = 'completed'; agent_action_outcomes.log_id -> agent_action_log.id;
  marketplace_agent_ledger.run_id -> marketplace_agent_runs.id.
  Requires 20281110000000. NOT EXECUTED in authoring (no Postgres available): run on staging first.
  Rollback: DROP the functions and economics_alerts created here; ALTER TABLE cost_ledger DROP COLUMN marketplace_run_id.
*/

ALTER TABLE public.cost_ledger ADD COLUMN IF NOT EXISTS marketplace_run_id uuid;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_marketplace_run ON public.cost_ledger (marketplace_run_id) WHERE marketplace_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_job ON public.cost_ledger (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_workflow ON public.cost_ledger (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_action_log ON public.cost_ledger (agent_action_log_id) WHERE agent_action_log_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Core functions: no auth.uid() (service role runs the sweep). NOT callable by clients.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economics_reconciliation_core(p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.provider), '[]'::jsonb) FROM (
    WITH l AS (
      SELECT lower(provider) AS provider, sum(cost_micro)::bigint AS ledger_micro, count(*)::bigint AS events
      FROM cost_ledger
      WHERE occurred_at >= p_month::timestamptz AND occurred_at < (p_month + interval '1 month')::timestamptz
      GROUP BY lower(provider)
    ), i AS (
      SELECT lower(provider) AS provider, round(sum(invoiced_usd) * 1000000)::bigint AS invoiced_micro
      FROM provider_invoices WHERE period_month = p_month GROUP BY lower(provider)
    )
    SELECT coalesce(l.provider, i.provider) AS provider, l.ledger_micro, l.events, i.invoiced_micro,
           CASE WHEN l.ledger_micro IS NOT NULL AND i.invoiced_micro IS NOT NULL THEN l.ledger_micro - i.invoiced_micro END AS variance_micro,
           CASE WHEN l.ledger_micro IS NOT NULL AND i.invoiced_micro > 0
                THEN round(((l.ledger_micro - i.invoiced_micro)::numeric / i.invoiced_micro) * 100, 2) END AS variance_pct,
           CASE WHEN i.invoiced_micro IS NULL THEN 'no_invoice'
                WHEN l.ledger_micro IS NULL THEN 'no_ledger'
                WHEN l.ledger_micro = i.invoiced_micro THEN 'match'
                WHEN i.invoiced_micro > 0 AND abs((l.ledger_micro - i.invoiced_micro)::numeric / i.invoiced_micro) <= 0.05 THEN 'within_tolerance'
                ELSE 'over_threshold' END AS status
    FROM l FULL JOIN i ON i.provider = l.provider
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.economics_coverage_core(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.resource_type), '[]'::jsonb) FROM (
    SELECT resource_type,
           count(*)::bigint AS events,
           (count(*) FILTER (WHERE call_id IS NOT NULL OR job_id IS NOT NULL OR workflow_run_id IS NOT NULL
                                OR agent_action_log_id IS NOT NULL OR marketplace_run_id IS NOT NULL))::bigint AS with_correlation,
           (count(*) FILTER (WHERE account_id IS NOT NULL))::bigint AS with_tenant,
           sum(cost_micro)::bigint AS cost_micro
    FROM cost_ledger
    WHERE occurred_at >= p_start AND occurred_at < p_end AND kind <> 'correction'
    GROUP BY resource_type
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.economics_daily_cost_per_call(p_days integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.day), '[]'::jsonb) FROM (
    SELECT (c.call_datetime AT TIME ZONE 'UTC')::date AS day,
           count(*)::bigint AS calls_with_cost,
           round(sum(k.micro)::numeric / count(*)) AS micro_per_call
    FROM calls c
    JOIN (SELECT call_id, sum(cost_micro) AS micro FROM cost_ledger WHERE call_id IS NOT NULL
            AND occurred_at >= now() - make_interval(days => least(greatest(p_days, 1), 60) + 1) GROUP BY call_id) k
      ON k.call_id = c.vapi_call_id
    WHERE c.call_datetime >= now() - make_interval(days => least(greatest(p_days, 1), 60))
    GROUP BY 1
  ) x;
$$;

REVOKE ALL ON FUNCTION public.economics_reconciliation_core(date), public.economics_coverage_core(timestamptz, timestamptz),
  public.economics_daily_cost_per_call(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economics_reconciliation_core(date), public.economics_coverage_core(timestamptz, timestamptz),
  public.economics_daily_cost_per_call(integer) TO service_role;

-- Staff wrappers (replace the part-1 bodies; same signatures and permissions).
CREATE OR REPLACE FUNCTION public.staff_cost_reconciliation(p_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN RAISE EXCEPTION 'p_month must be the first day of a month' USING ERRCODE = '22023'; END IF;
  RETURN public.economics_reconciliation_core(p_month);
END; $$;

CREATE OR REPLACE FUNCTION public.staff_ledger_coverage(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN public.economics_coverage_core(p_start, p_end);
END; $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Unit costs per handled call / booking / paid job / workflow, always with sample sizes.
--  booking_direct  = ledger cost linked to the booked calls (+ cost linked to the jobs created from them)
--  booking_loaded  = cost of ALL handled calls with cost / number of booked calls (what a booking really costs us)
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_unit_costs(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;

  WITH w AS (
    SELECT c.id, c.vapi_call_id FROM calls c
    WHERE c.call_datetime >= p_start AND c.call_datetime < p_end AND c.vapi_call_id IS NOT NULL
  ),
  call_cost AS (
    SELECT l.call_id, sum(l.cost_micro)::bigint AS micro FROM cost_ledger l
    WHERE l.call_id IN (SELECT vapi_call_id FROM w) GROUP BY l.call_id
  ),
  jb AS (
    SELECT j.id AS job_id, w.id AS call_uuid, w.vapi_call_id, j.invoice_status = 'paid' AS paid
    FROM w JOIN jobs j ON j.call_id = w.id
  ),
  job_cost AS (
    SELECT l.job_id, sum(l.cost_micro)::bigint AS micro FROM cost_ledger l
    WHERE l.job_id IN (SELECT job_id FROM jb) GROUP BY l.job_id
  ),
  booked_calls AS (SELECT DISTINCT call_uuid, vapi_call_id FROM jb),
  paid_calls AS (SELECT DISTINCT call_uuid, vapi_call_id FROM jb WHERE paid),
  wf AS (
    SELECT l.workflow_run_id, sum(l.cost_micro)::bigint AS micro, r.status
    FROM cost_ledger l LEFT JOIN workflow_runs r ON r.id = l.workflow_run_id
    WHERE l.workflow_run_id IS NOT NULL AND l.occurred_at >= p_start AND l.occurred_at < p_end
    GROUP BY l.workflow_run_id, r.status
  )
  SELECT jsonb_build_object(
    'calls_handled', (SELECT count(*) FROM w),
    'calls_with_cost', (SELECT count(*) FROM call_cost),
    'call_cost_micro', coalesce((SELECT sum(micro) FROM call_cost), 0),
    'micro_per_call', (SELECT CASE WHEN count(*) > 0 THEN round(sum(micro)::numeric / count(*)) END FROM call_cost),
    'booked_calls', (SELECT count(*) FROM booked_calls),
    'booked_calls_with_cost', (SELECT count(*) FROM booked_calls b JOIN call_cost c ON c.call_id = b.vapi_call_id),
    'booking_direct_micro', coalesce((SELECT sum(c.micro) FROM booked_calls b JOIN call_cost c ON c.call_id = b.vapi_call_id), 0)
                          + coalesce((SELECT sum(micro) FROM job_cost), 0),
    'micro_per_booking_direct', (SELECT CASE WHEN count(*) > 0 THEN round((coalesce(sum(c.micro),0) + (SELECT coalesce(sum(micro),0) FROM job_cost))::numeric / count(*)) END
                                  FROM booked_calls b JOIN call_cost c ON c.call_id = b.vapi_call_id),
    'micro_per_booking_loaded', (SELECT CASE WHEN (SELECT count(*) FROM booked_calls) > 0
                                        THEN round(coalesce((SELECT sum(micro) FROM call_cost), 0)::numeric / (SELECT count(*) FROM booked_calls)) END),
    'paid_jobs', (SELECT count(*) FROM jb WHERE paid),
    'paid_calls_with_cost', (SELECT count(*) FROM paid_calls p JOIN call_cost c ON c.call_id = p.vapi_call_id),
    'micro_per_paid_job_direct', (SELECT CASE WHEN count(*) > 0 THEN round((coalesce(sum(c.micro),0))::numeric / count(*)) END
                                   FROM paid_calls p JOIN call_cost c ON c.call_id = p.vapi_call_id),
    'workflow_runs_with_cost', (SELECT count(*) FROM wf),
    'workflow_runs_completed_with_cost', (SELECT count(*) FROM wf WHERE status = 'completed'),
    'micro_per_workflow_run', (SELECT CASE WHEN count(*) > 0 THEN round(sum(micro)::numeric / count(*)) END FROM wf),
    'micro_per_completed_workflow', (SELECT CASE WHEN count(*) > 0 THEN round(sum(micro)::numeric / count(*)) END FROM wf WHERE status = 'completed'),
    'notes', jsonb_build_array(
      'Window is by calls.call_datetime; costs without a call_id/job_id/workflow_run_id are excluded from every per-unit figure.',
      'micro_per_paid_job_direct counts call-linked cost only (job-linked cost is in booking_direct).',
      'Workflow cost exists only for ledger rows that carry workflow_run_id; none are written until producers pass it.')
  ) INTO v;
  RETURN v;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Marketplace economics: Vireek-borne measured cost per agent run vs the revenue-share ledger.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_marketplace_economics(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x ORDER BY x.agent_id) FROM (
      WITH runs AS (
        SELECT r.id, r.agent_id FROM marketplace_agent_runs r WHERE r.created_at >= p_start AND r.created_at < p_end
      ), cost AS (
        SELECT l.marketplace_run_id AS run_id, sum(l.cost_micro)::bigint AS micro FROM cost_ledger l
        WHERE l.marketplace_run_id IN (SELECT id FROM runs) GROUP BY l.marketplace_run_id
      ), rev AS (
        SELECT m.agent_id, sum(m.amount_cents)::bigint AS billed_cents, sum(m.platform_fee_cents)::bigint AS fee_cents,
               sum(m.publisher_payout_cents)::bigint AS payout_cents
        FROM marketplace_agent_ledger m WHERE m.created_at >= p_start AND m.created_at < p_end GROUP BY m.agent_id
      )
      SELECT runs.agent_id,
             count(*)::bigint AS runs,
             (count(cost.run_id))::bigint AS runs_with_cost,
             coalesce(sum(cost.micro), 0)::bigint AS cost_micro,
             max(rev.billed_cents) AS billed_cents, max(rev.fee_cents) AS platform_fee_cents, max(rev.payout_cents) AS publisher_payout_cents,
             CASE WHEN max(rev.fee_cents) IS NOT NULL THEN max(rev.fee_cents) - round(coalesce(sum(cost.micro), 0) / 10000.0)::bigint END AS vireek_margin_cents
      FROM runs LEFT JOIN cost ON cost.run_id = runs.id LEFT JOIN rev ON rev.agent_id = runs.agent_id
      GROUP BY runs.agent_id
    ) x
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Read-only contract for the Outcome Learning layer: cost per outcome by action type. Service role only.
-- p_user NULL = all tenants (aggregate). Learning logic lives elsewhere; this exposes data only.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economics_action_cost_outcome(p_start timestamptz, p_end timestamptz, p_user uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.action_slug), '[]'::jsonb) FROM (
    SELECT a.action_slug,
           count(*)::bigint AS actions,
           (count(k.micro))::bigint AS actions_with_cost,
           coalesce(sum(k.micro), 0)::bigint AS cost_micro,
           (count(*) FILTER (WHERE o.outcome IN ('success','partial') AND o.financial_outcome_cents IS NOT NULL))::bigint AS valued_outcomes,
           coalesce(sum(o.financial_outcome_cents) FILTER (WHERE o.outcome IN ('success','partial') AND o.confidence >= 0.6), 0)::bigint AS confident_value_cents
    FROM agent_action_log a
    LEFT JOIN agent_action_outcomes o ON o.log_id = a.id
    LEFT JOIN (SELECT agent_action_log_id, sum(cost_micro)::bigint AS micro FROM cost_ledger
               WHERE agent_action_log_id IS NOT NULL GROUP BY agent_action_log_id) k ON k.agent_action_log_id = a.id
    WHERE a.created_at >= p_start AND a.created_at < p_end AND (p_user IS NULL OR a.user_id = p_user)
    GROUP BY a.action_slug
  ) x;
$$;
REVOKE ALL ON FUNCTION public.economics_action_cost_outcome(timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economics_action_cost_outcome(timestamptz, timestamptz, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant ROI inputs: the caller's OWN attributed outcomes only (owner resolved server-side, never a parameter).
-- Math + "not enough data" live in supabase/functions/_shared/economics/roi.ts so every figure links to these ids.
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenant_roi_inputs(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object(
    'outcomes_total', (SELECT count(*) FROM agent_action_outcomes o WHERE o.user_id = v_owner AND o.recorded_at >= p_start AND o.recorded_at < p_end),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'action_slug', o.action_slug, 'action_at', l.created_at, 'outcome_at', o.recorded_at,
        'value_cents', o.financial_outcome_cents, 'confidence', o.confidence) ORDER BY o.recorded_at DESC)
      FROM (SELECT * FROM agent_action_outcomes o2
            WHERE o2.user_id = v_owner AND o2.outcome IN ('success','partial') AND o2.financial_outcome_cents IS NOT NULL
              AND o2.recorded_at >= p_start AND o2.recorded_at < p_end
            ORDER BY o2.recorded_at DESC LIMIT 500) o
      JOIN agent_action_log l ON l.id = o.log_id
    ), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.tenant_roi_inputs(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_roi_inputs(timestamptz, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.staff_unit_costs(timestamptz, timestamptz), public.staff_marketplace_economics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_unit_costs(timestamptz, timestamptz), public.staff_marketplace_economics(timestamptz, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Alerts (written by the economics-sweep edge function with the service role; deduped per day).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.economics_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('cost_per_call_spike','reconciliation_variance','missing_correlation','budget_breach')),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  dedupe_key text NOT NULL UNIQUE,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE public.economics_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS economics_alerts_staff_select ON public.economics_alerts;
CREATE POLICY economics_alerts_staff_select ON public.economics_alerts FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON public.economics_alerts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.economics_alerts FROM authenticated;

CREATE OR REPLACE FUNCTION public.staff_resolve_economics_alert(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  UPDATE public.economics_alerts SET resolved_at = now() WHERE id = p_id AND resolved_at IS NULL;
END; $$;
REVOKE ALL ON FUNCTION public.staff_resolve_economics_alert(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_resolve_economics_alert(uuid) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Inputs for the outcome-fee WHAT-IF simulator (staff-only). Analysis only: nothing here changes pricing or billing.
-- recovered_cents counts only positive outcomes with confidence >= 0.6 (same floor as the tenant ROI rule).
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_outcome_fee_inputs(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x) FROM (
      SELECT p.id AS account_id, p.plan,
             coalesce((SELECT sum(l.cost_micro) FROM cost_ledger l WHERE l.account_id = p.id AND l.occurred_at >= p_start AND l.occurred_at < p_end), 0)::bigint AS cost_micro,
             (SELECT count(*) FROM jobs j WHERE j.user_id = p.id AND j.call_id IS NOT NULL AND j.created_at >= p_start AND j.created_at < p_end)::bigint AS booked_jobs,
             coalesce((SELECT sum(o.financial_outcome_cents) FROM agent_action_outcomes o
                        WHERE o.user_id = p.id AND o.outcome IN ('success','partial') AND o.confidence >= 0.6
                          AND o.financial_outcome_cents > 0 AND o.recorded_at >= p_start AND o.recorded_at < p_end), 0)::bigint AS recovered_cents
      FROM profiles p WHERE p.role = 'owner' ORDER BY p.id LIMIT 2000
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_outcome_fee_inputs(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_outcome_fee_inputs(timestamptz, timestamptz) TO authenticated;
