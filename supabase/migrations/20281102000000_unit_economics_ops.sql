/*
  # Unit economics ops: limits, invoices, staff report RPC

  - plan_cost_limits  : per-plan soft/hard monthly cost limits + max call seconds. NO seed rows (no limits until staff sets them).
  - provider_invoices : monthly provider invoice totals entered by staff, used for reconciliation.
  - staff_unit_economics(p_start,p_end): staff-only jsonb (per-tenant usage + reported voice cost + AI cost, per-component totals).
  - tenant_month_provider_cost(p_month_start): service_role-only per-tenant provider-reported cost for the guardrail sweep.

  Requires 20281101000000_unit_economics_foundation.sql. All cost figures are provider_reported or list-price estimates.
  Rollback: DROP FUNCTION staff_unit_economics(timestamptz,timestamptz), tenant_month_provider_cost(timestamptz); DROP TABLE provider_invoices, plan_cost_limits;
*/

CREATE TABLE IF NOT EXISTS public.plan_cost_limits (
  plan             text PRIMARY KEY CHECK (length(btrim(plan)) > 0),
  soft_cost_usd    numeric(12,2) CHECK (soft_cost_usd IS NULL OR soft_cost_usd >= 0),
  hard_cost_usd    numeric(12,2) CHECK (hard_cost_usd IS NULL OR hard_cost_usd >= 0),
  max_call_seconds integer CHECK (max_call_seconds IS NULL OR max_call_seconds > 0),
  updated_by       uuid DEFAULT auth.uid(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (soft_cost_usd IS NULL OR hard_cost_usd IS NULL OR hard_cost_usd >= soft_cost_usd)
);

CREATE TABLE IF NOT EXISTS public.provider_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL CHECK (length(btrim(provider)) > 0),
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  invoiced_usd numeric(14,2) NOT NULL CHECK (invoiced_usd >= 0),
  invoice_ref  text,
  notes        text,
  entered_by   uuid DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, period_month)
);

ALTER TABLE public.plan_cost_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_cost_limits_staff_all ON public.plan_cost_limits;
CREATE POLICY plan_cost_limits_staff_all ON public.plan_cost_limits
  FOR ALL TO authenticated
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS provider_invoices_staff_all ON public.provider_invoices;
CREATE POLICY provider_invoices_staff_all ON public.provider_invoices
  FOR ALL TO authenticated
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.plan_cost_limits FROM anon;
REVOKE ALL ON public.provider_invoices FROM anon;

CREATE INDEX IF NOT EXISTS idx_call_cost_components_vapi_call ON public.call_cost_components (vapi_call_id);

CREATE OR REPLACE FUNCTION public.staff_unit_economics(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'window too large (max 400 days)' USING ERRCODE = '22023';
  END IF;

  WITH w_calls AS (
    SELECT c.user_id, c.vapi_call_id, coalesce(c.duration_seconds, 0) AS secs
    FROM calls c
    WHERE c.call_datetime >= p_start AND c.call_datetime < p_end
  ),
  voice AS (
    SELECT user_id, sum(secs)::bigint AS voice_seconds, count(*)::bigint AS voice_calls
    FROM w_calls GROUP BY user_id
  ),
  rep AS (
    SELECT w.user_id,
           sum(cc.amount_usd)::float8 AS reported_voice_cost_usd,
           count(DISTINCT cc.vapi_call_id)::bigint AS calls_with_cost
    FROM w_calls w
    JOIN call_cost_components cc ON cc.vapi_call_id = w.vapi_call_id AND cc.basis = 'provider_reported'
    GROUP BY w.user_id
  ),
  ai AS (
    SELECT account_id, sum(cost_usd)::float8 AS ai_cost_usd
    FROM ai_usage_logs
    WHERE created_at >= p_start AND created_at < p_end AND account_id IS NOT NULL
    GROUP BY account_id
  ),
  tenants AS (
    SELECT p.id AS account_id, p.email, p.company_name, p.plan,
           coalesce(v.voice_seconds, 0) AS voice_seconds,
           coalesce(v.voice_calls, 0) AS voice_calls,
           coalesce(r.reported_voice_cost_usd, 0) AS reported_voice_cost_usd,
           coalesce(r.calls_with_cost, 0) AS calls_with_cost,
           coalesce(a.ai_cost_usd, 0) AS ai_cost_usd
    FROM profiles p
    LEFT JOIN voice v ON v.user_id = p.id
    LEFT JOIN rep r ON r.user_id = p.id
    LEFT JOIN ai a ON a.account_id = p.id
    WHERE p.role = 'owner' AND NOT coalesce(p.is_staff, false)
  ),
  ranked AS (
    SELECT * FROM tenants
    ORDER BY (reported_voice_cost_usd + ai_cost_usd) DESC, voice_seconds DESC, account_id
    LIMIT 5000
  )
  SELECT jsonb_build_object(
    'tenants', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM ranked r), '[]'::jsonb),
    'components', coalesce((
      SELECT jsonb_agg(x ORDER BY x.cost_usd DESC) FROM (
        SELECT cc.component, sum(cc.amount_usd)::float8 AS cost_usd, count(DISTINCT cc.vapi_call_id)::bigint AS calls
        FROM w_calls w
        JOIN call_cost_components cc ON cc.vapi_call_id = w.vapi_call_id AND cc.basis = 'provider_reported'
        GROUP BY cc.component
      ) x
    ), '[]'::jsonb),
    'reported_voice_total_usd', coalesce((
      SELECT sum(cc.amount_usd)::float8
      FROM w_calls w
      JOIN call_cost_components cc ON cc.vapi_call_id = w.vapi_call_id AND cc.basis = 'provider_reported'
    ), 0),
    'calls_total', (SELECT count(*) FROM w_calls),
    'calls_with_cost', (SELECT count(DISTINCT cc.vapi_call_id)
                        FROM w_calls w JOIN call_cost_components cc ON cc.vapi_call_id = w.vapi_call_id AND cc.basis = 'provider_reported'),
    'invoices', coalesce((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.period_month DESC)
      FROM provider_invoices i
      WHERE i.period_month >= date_trunc('month', p_start)::date AND i.period_month < p_end::date
    ), '[]'::jsonb),
    'truncated', (SELECT count(*) FROM tenants) > 5000
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_unit_economics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_unit_economics(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.tenant_month_provider_cost(p_month_start timestamptz)
RETURNS TABLE (user_id uuid, cost_usd float8)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.user_id, sum(cc.amount_usd)::float8
  FROM calls c
  JOIN call_cost_components cc ON cc.vapi_call_id = c.vapi_call_id AND cc.basis = 'provider_reported'
  WHERE c.call_datetime >= p_month_start AND c.call_datetime < (p_month_start + interval '1 month')
  GROUP BY c.user_id;
$$;

REVOKE ALL ON FUNCTION public.tenant_month_provider_cost(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_month_provider_cost(timestamptz) TO service_role;
