/*
  Vireek COGS and gross-margin views (internal, staff-only)

  What already existed (NOT duplicated): provider_cost_rates, cost_ledger (append-only, one source of measured /
  estimated cost), call_cost_components, staff_cost_per_call, staff_unit_costs, staff_margin_extras,
  src/lib/planMargins.ts (list-price margin from RATES at 100% use) and the /staff/margins dashboard.

  What this adds (the gap): realised cost per call-minute and per AI action, by plan and by tenant, and realised
  gross margin by plan. Everything is derived from cost_ledger (so voice and AI cost are never double counted)
  and from the existing plan config.

  Views (security_invoker, no client grants; read only through the staff_cogs_* RPCs or service_role)
    cogs_tenant_plan_v        one row per owner account: effective tier, billed flag, catalog price / minutes
    cogs_call_cost_v          one row per call: minutes, ledger cost
    cogs_ledger_non_call_v    ledger rows without a call_id: bucket ai_action | other_variable
    cogs_tenant_month_v       tenant x month: costed calls / minutes, voice cost per call-minute, AI actions,
                              AI cost per action, other variable cost, total cost, coverage
    cogs_ai_action_month_v    month x plan x task_type: AI actions and cost per action
    cogs_plan_month_v         month x plan: tenants, list-price subscription revenue, cost, gross margin

  Prices: cogs_plan_catalog() is a SQL MIRROR of supabase/functions/_shared/billing/pricingCatalog.ts
  (CATALOG_PLANS). A Vitest drift test (cogsViews.test.ts) fails CI if they differ. No price is invented.

  Assumptions (also in docs/finance/cogs-assumptions.md): revenue = list subscription price of the tenant's CURRENT
  effective tier for tenants with a subscription or a tier override (no history, no discounts, no annual
  normalisation, no overage revenue, grandfathered legacy prices not modelled); COGS = variable usage cost in
  cost_ledger only (no fixed phone-number / platform cost, no support or payment-processing cost); minutes are
  calls.duration_seconds / 60 (not billed-rounded); cost per minute divides by COSTED calls only and reports coverage.

  Access: authenticated users have NO grant on the views; the RPCs re-check is_vireek_staff. Idempotent.
  NOT EXECUTED in authoring (no Postgres available): run on a staging copy first.
*/

-- rollback: DROP FUNCTION staff_cogs_by_plan(date), staff_cogs_tenants(date, integer), staff_cogs_ai_actions(date);
-- then drop the views in reverse dependency order (cogs_plan_month_v, cogs_ai_action_month_v, cogs_tenant_month_v,
-- cogs_ledger_non_call_v, cogs_call_cost_v, cogs_tenant_plan_v) and cogs_plan_catalog(). No tables or data are touched.

-- 1) Plan catalog mirror (integer USD cents) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cogs_plan_catalog()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT '{"starter":{"monthlyCents":9900,"minutesIncluded":200,"overageCentsPerMin":25,"quoted":false},"professional":{"monthlyCents":24900,"minutesIncluded":600,"overageCentsPerMin":25,"quoted":false},"business":{"monthlyCents":54900,"minutesIncluded":1500,"overageCentsPerMin":25,"quoted":false},"enterprise":{"monthlyCents":179900,"minutesIncluded":6000,"overageCentsPerMin":20,"quoted":true}}'::jsonb $$;

REVOKE ALL ON FUNCTION public.cogs_plan_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cogs_plan_catalog() TO authenticated, service_role;

-- 2) Tenant dimension -----------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cogs_tenant_plan_v WITH (security_invoker = true) AS
SELECT p.id AS account_id,
       t.tier AS plan_tier,
       (t.tier <> 'free'
         AND (btrim(coalesce(p.stripe_subscription_id, '')) <> '' OR p.plan_tier_override IS NOT NULL)) AS is_billed,
       (public.cogs_plan_catalog() -> t.tier ->> 'monthlyCents')::integer AS list_price_cents,
       coalesce((public.cogs_plan_catalog() -> t.tier ->> 'quoted')::boolean, false) AS price_is_quoted,
       (public.cogs_plan_catalog() -> t.tier ->> 'minutesIncluded')::integer AS minutes_included,
       (public.cogs_plan_catalog() -> t.tier ->> 'overageCentsPerMin')::integer AS overage_cents_per_min
FROM public.profiles p
CROSS JOIN LATERAL (SELECT public.plan_effective_tier(p.id) AS tier) t
WHERE p.role = 'owner' AND NOT coalesce(p.is_staff, false);

-- 3) Per-call cost (voice) ------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cogs_call_cost_v WITH (security_invoker = true) AS
SELECT c.user_id AS account_id,
       c.call_datetime,
       (date_trunc('month', c.call_datetime AT TIME ZONE 'UTC'))::date AS month,
       c.vapi_call_id,
       greatest(coalesce(c.duration_seconds, 0), 0) / 60.0 AS minutes,
       k.cost_micro,
       (k.cost_micro IS NOT NULL) AS has_cost,
       coalesce(k.estimated_micro, 0) AS estimated_micro
FROM public.calls c
LEFT JOIN LATERAL (
  SELECT sum(l.cost_micro)::bigint AS cost_micro,
         coalesce(sum(l.cost_micro) FILTER (WHERE l.basis = 'estimated'), 0)::bigint AS estimated_micro
  FROM public.cost_ledger l
  WHERE l.call_id = c.vapi_call_id
  HAVING count(*) > 0
) k ON true
WHERE c.vapi_call_id IS NOT NULL;

-- 4) Ledger rows that are not tied to a call -------------------------------------------------------------------------
-- ai_action      = metered LLM invocations (resource_type llm_tokens); one non-correction row = one action
-- other_variable = sms / maps / storage / other API usage with no call link
CREATE OR REPLACE VIEW public.cogs_ledger_non_call_v WITH (security_invoker = true) AS
SELECT l.account_id,
       l.occurred_at,
       (date_trunc('month', l.occurred_at AT TIME ZONE 'UTC'))::date AS month,
       CASE WHEN l.resource_type = 'llm_tokens' THEN 'ai_action' ELSE 'other_variable' END AS bucket,
       coalesce(nullif(btrim(l.task_type), ''), 'unattributed') AS task_type,
       l.cost_micro,
       (l.kind <> 'correction') AS is_action,
       l.basis
FROM public.cost_ledger l
WHERE l.call_id IS NULL
  AND l.account_id IS NOT NULL;

-- 5) Tenant x month ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cogs_tenant_month_v WITH (security_invoker = true) AS
WITH calls_m AS (
  SELECT account_id, month,
         count(*) AS calls_total,
         count(*) FILTER (WHERE has_cost) AS calls_costed,
         coalesce(sum(minutes), 0) AS minutes_total,
         coalesce(sum(minutes) FILTER (WHERE has_cost), 0) AS minutes_costed,
         coalesce(sum(cost_micro), 0)::bigint AS voice_cost_micro,
         coalesce(sum(estimated_micro), 0)::bigint AS voice_estimated_micro
  FROM public.cogs_call_cost_v
  GROUP BY account_id, month
),
nc AS (
  SELECT account_id, month,
         count(*) FILTER (WHERE bucket = 'ai_action' AND is_action) AS ai_actions,
         coalesce(sum(cost_micro) FILTER (WHERE bucket = 'ai_action'), 0)::bigint AS ai_cost_micro,
         coalesce(sum(cost_micro) FILTER (WHERE bucket = 'other_variable'), 0)::bigint AS other_cost_micro
  FROM public.cogs_ledger_non_call_v
  GROUP BY account_id, month
),
keys AS (
  SELECT account_id, month FROM calls_m
  UNION
  SELECT account_id, month FROM nc
)
SELECT k.account_id,
       k.month,
       tp.plan_tier,
       tp.is_billed,
       coalesce(c.calls_total, 0) AS calls_total,
       coalesce(c.calls_costed, 0) AS calls_costed,
       coalesce(c.minutes_total, 0) AS minutes_total,
       coalesce(c.minutes_costed, 0) AS minutes_costed,
       coalesce(c.voice_cost_micro, 0) AS voice_cost_micro,
       coalesce(c.voice_estimated_micro, 0) AS voice_estimated_micro,
       CASE WHEN coalesce(c.minutes_costed, 0) > 0
            THEN round(c.voice_cost_micro / c.minutes_costed, 2) END AS voice_cost_per_min_micro,
       coalesce(n.ai_actions, 0) AS ai_actions,
       coalesce(n.ai_cost_micro, 0) AS ai_cost_micro,
       CASE WHEN coalesce(n.ai_actions, 0) > 0
            THEN round(n.ai_cost_micro::numeric / n.ai_actions, 2) END AS ai_cost_per_action_micro,
       coalesce(n.other_cost_micro, 0) AS other_cost_micro,
       (coalesce(c.voice_cost_micro, 0) + coalesce(n.ai_cost_micro, 0) + coalesce(n.other_cost_micro, 0))::bigint AS total_cost_micro,
       CASE WHEN coalesce(c.calls_total, 0) > 0
            THEN round(100.0 * c.calls_costed / c.calls_total, 1) END AS call_cost_coverage_pct
FROM keys k
JOIN public.cogs_tenant_plan_v tp ON tp.account_id = k.account_id
LEFT JOIN calls_m c ON c.account_id = k.account_id AND c.month = k.month
LEFT JOIN nc n ON n.account_id = k.account_id AND n.month = k.month;

-- 6) AI actions by plan and task ----------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cogs_ai_action_month_v WITH (security_invoker = true) AS
SELECT a.month,
       tp.plan_tier,
       a.task_type,
       count(*) FILTER (WHERE a.is_action) AS ai_actions,
       count(DISTINCT a.account_id) AS tenants,
       coalesce(sum(a.cost_micro), 0)::bigint AS cost_micro,
       CASE WHEN count(*) FILTER (WHERE a.is_action) > 0
            THEN round(sum(a.cost_micro)::numeric / count(*) FILTER (WHERE a.is_action), 2) END AS cost_per_action_micro,
       coalesce(sum(a.cost_micro) FILTER (WHERE a.basis = 'estimated'), 0)::bigint AS estimated_cost_micro
FROM public.cogs_ledger_non_call_v a
JOIN public.cogs_tenant_plan_v tp ON tp.account_id = a.account_id
WHERE a.bucket = 'ai_action'
GROUP BY a.month, tp.plan_tier, a.task_type;

-- 7) Gross margin by plan -------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cogs_plan_month_v WITH (security_invoker = true) AS
WITH months AS (
  SELECT DISTINCT month FROM public.cogs_tenant_month_v
),
tiers AS (
  SELECT plan_tier,
         count(*) AS tenants_total,
         count(*) FILTER (WHERE is_billed) AS tenants_billed,
         max(list_price_cents) AS list_price_cents,
         bool_or(price_is_quoted) AS price_is_quoted,
         max(minutes_included) AS minutes_included
  FROM public.cogs_tenant_plan_v
  GROUP BY plan_tier
),
usage AS (
  SELECT month, plan_tier,
         count(*) AS active_tenants,
         sum(minutes_total) AS minutes_total,
         sum(minutes_costed) AS minutes_costed,
         sum(calls_total) AS calls_total,
         sum(calls_costed) AS calls_costed,
         sum(voice_cost_micro)::bigint AS voice_cost_micro,
         sum(ai_actions)::bigint AS ai_actions,
         sum(ai_cost_micro)::bigint AS ai_cost_micro,
         sum(other_cost_micro)::bigint AS other_cost_micro,
         sum(total_cost_micro)::bigint AS total_cost_micro
  FROM public.cogs_tenant_month_v
  GROUP BY month, plan_tier
)
SELECT m.month,
       t.plan_tier,
       t.tenants_total,
       t.tenants_billed,
       coalesce(u.active_tenants, 0) AS active_tenants,
       t.list_price_cents,
       t.price_is_quoted,
       coalesce(u.minutes_total, 0) AS minutes_total,
       coalesce(u.minutes_costed, 0) AS minutes_costed,
       coalesce(u.calls_total, 0) AS calls_total,
       coalesce(u.calls_costed, 0) AS calls_costed,
       coalesce(u.voice_cost_micro, 0) AS voice_cost_micro,
       coalesce(u.ai_actions, 0) AS ai_actions,
       coalesce(u.ai_cost_micro, 0) AS ai_cost_micro,
       coalesce(u.other_cost_micro, 0) AS other_cost_micro,
       coalesce(u.total_cost_micro, 0) AS total_cost_micro,
       CASE WHEN coalesce(u.minutes_costed, 0) > 0
            THEN round(u.voice_cost_micro / u.minutes_costed, 2) END AS voice_cost_per_min_micro,
       CASE WHEN coalesce(u.ai_actions, 0) > 0
            THEN round(u.ai_cost_micro::numeric / u.ai_actions, 2) END AS ai_cost_per_action_micro,
       -- NULL (never 0) when the plan has no fixed list price (free, or enterprise "from" price)
       CASE WHEN t.list_price_cents IS NULL OR t.price_is_quoted THEN NULL
            ELSE t.tenants_billed * t.list_price_cents END AS subscription_revenue_cents,
       CASE WHEN t.list_price_cents IS NULL OR t.price_is_quoted THEN NULL
            ELSE round(t.tenants_billed * t.list_price_cents - coalesce(u.total_cost_micro, 0) / 10000.0, 2) END AS gross_margin_cents,
       CASE WHEN t.list_price_cents IS NULL OR t.price_is_quoted OR t.tenants_billed * t.list_price_cents = 0 THEN NULL
            ELSE round(100.0 * (t.tenants_billed * t.list_price_cents - coalesce(u.total_cost_micro, 0) / 10000.0)
                       / (t.tenants_billed * t.list_price_cents), 1) END AS gross_margin_pct,
       CASE WHEN coalesce(u.calls_total, 0) > 0
            THEN round(100.0 * u.calls_costed / u.calls_total, 1) END AS call_cost_coverage_pct
FROM months m
CROSS JOIN tiers t
LEFT JOIN usage u ON u.month = m.month AND u.plan_tier = t.plan_tier;

-- 8) Access: views are internal ---------------------------------------------------------------------------------------------
REVOKE ALL ON public.cogs_tenant_plan_v, public.cogs_call_cost_v, public.cogs_ledger_non_call_v,
  public.cogs_tenant_month_v, public.cogs_ai_action_month_v, public.cogs_plan_month_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cogs_tenant_plan_v, public.cogs_call_cost_v, public.cogs_ledger_non_call_v,
  public.cogs_tenant_month_v, public.cogs_ai_action_month_v, public.cogs_plan_month_v TO service_role;

-- 9) Staff RPCs (same guard pattern as staff_unit_economics) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cogs_assert_staff_month(p_month date)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'month is required' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', p_month)::date;
  IF v_month < date '2020-01-01' OR v_month > (date_trunc('month', now() AT TIME ZONE 'UTC')::date + interval '1 month')::date THEN
    RAISE EXCEPTION 'month out of range' USING ERRCODE = '22023';
  END IF;
  RETURN v_month;
END;
$$;
REVOKE ALL ON FUNCTION public.cogs_assert_staff_month(date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_cogs_by_plan(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month date := public.cogs_assert_staff_month(p_month);
BEGIN
  RETURN jsonb_build_object(
    'month', v_month,
    'plans', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.plan_tier)
      FROM (SELECT * FROM public.cogs_plan_month_v WHERE month = v_month) x
    ), '[]'::jsonb),
    'revenue_basis', 'list_price_subscription_only',
    'cost_basis', 'cost_ledger_variable_usage_only'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_cogs_tenants(p_month date, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month date := public.cogs_assert_staff_month(p_month);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
BEGIN
  RETURN jsonb_build_object(
    'month', v_month,
    'tenants', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.total_cost_micro DESC, x.account_id)
      FROM (
        SELECT * FROM public.cogs_tenant_month_v
        WHERE month = v_month
        ORDER BY total_cost_micro DESC, account_id
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'truncated', (SELECT count(*) FROM public.cogs_tenant_month_v WHERE month = v_month) > v_limit
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_cogs_ai_actions(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month date := public.cogs_assert_staff_month(p_month);
BEGIN
  RETURN jsonb_build_object(
    'month', v_month,
    'actions', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.cost_micro DESC, x.plan_tier, x.task_type)
      FROM (
        SELECT * FROM public.cogs_ai_action_month_v
        WHERE month = v_month
        ORDER BY cost_micro DESC, plan_tier, task_type
        LIMIT 200
      ) x
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_cogs_by_plan(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_cogs_tenants(date, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_cogs_ai_actions(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cogs_by_plan(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_cogs_tenants(date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_cogs_ai_actions(date) TO authenticated;
