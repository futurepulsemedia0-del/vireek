/*
  # Vireek SaaS metrics views: MRR, ARR, NRR, GRR, logo churn, CAC payback (internal, platform staff ONLY)

  Definitions, formulas and edge cases: docs/finance/metrics-definitions.md (this header is only a summary).

  What already existed (NOT duplicated, NOT replaced): subscription_facts (append-only MRR after every Stripe
  subscription event), growth_mrr_movements_v (new / expansion / contraction / churn / reactivation),
  growth_period_summary() (opening / closing / cohort for ONE arbitrary period), growth_marketing_spend (manual spend),
  founder_cac_inputs (manual gross margin), staff_growth_* RPCs. The older founder_* ledger is a second, slightly different
  MRR ledger; these views deliberately use the growth_* ledger only, so one number is defined one way.

  What this adds (the gap): MONTHLY time series as views, with ARR, 1-month AND 12-month NRR / GRR / logo churn, and a
  CAC payback view in which every missing input yields NULL plus a machine-readable reason, never a 0.

  Views (security_invoker, no client grants; read only through staff_metrics_saas or service_role)
    metrics_subscription_month_v   subscription x month-end state (MRR, status, unresolved-discount flag)
    metrics_account_month_v        account x currency x month-end MRR (sum of its subscriptions)
    metrics_mrr_monthly_v          month x currency: MRR, ARR (= MRR x 12), paying accounts
    metrics_retention_monthly_v    month x currency x window (1 | 12 months): NRR, GRR, logo churn (basis points)
    metrics_cac_payback_monthly_v  month x currency: spend, new logos, CAC, payback months
    metrics_data_health_v          one row: how complete the inputs are

  Rules shared by every view
    * MRR is exactly the MRR stored in subscription_facts (list price, forever-percent coupons applied, trialing = 0,
      past_due counts, canceled / unpaid / incomplete / paused = 0, yearly / 12). Refunds never change MRR.
    * Month-end snapshot = state after ALL ledger rows strictly before the first instant of the next UTC month.
    * No currency conversion; every row carries its currency (NULL currency is shown as 'unknown').
    * "Not available": the value is NULL and `availability` names the reason. A measured zero stays 0.
    * Windows that begin before the first ledger event are not available (the ledger cannot see accounts that were
      already paying before it started).

  Access: no grant to anon / authenticated; staff_metrics_saas checks is_vireek_staff and writes staff_audit_log. Idempotent.
  Requires: subscription_facts, growth_mrr_movements_v, growth_marketing_spend, founder_cac_inputs,
  _growth_assert_staff / _growth_assert_range.

  NOT EXECUTED IN PRODUCTION. Verified only against a stub-schema Postgres 16 (see the verification report).
  Performance is unmeasured at production scale: the month grid is subscriptions x months with one indexed lookup each
  (index idx_subscription_facts_sub_time). Run EXPLAIN ANALYZE on staging before wiring a dashboard [VERIFY].

  ROLLBACK (nothing but views and one function; no data is touched):
    DROP FUNCTION IF EXISTS public.staff_metrics_saas(date, date);
    DROP VIEW IF EXISTS public.metrics_data_health_v, public.metrics_cac_payback_monthly_v, public.metrics_retention_monthly_v,
      public.metrics_mrr_monthly_v, public.metrics_account_month_v, public.metrics_subscription_month_v;
*/

-- =====================================================================
-- 1) Subscription x month-end state
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_subscription_month_v WITH (security_invoker = true) AS
WITH first_ev AS (
  SELECT stripe_subscription_id, min(occurred_at) AS first_at
  FROM public.subscription_facts
  GROUP BY stripe_subscription_id
)
SELECT
  fe.stripe_subscription_id,
  f.user_id,
  coalesce(f.currency, 'unknown') AS currency,
  g.m::date AS month,
  f.mrr_cents,
  f.status,
  f.discount_unresolved
FROM first_ev fe
CROSS JOIN LATERAL generate_series(
  date_trunc('month', fe.first_at AT TIME ZONE 'UTC'),
  date_trunc('month', now() AT TIME ZONE 'UTC'),
  interval '1 month') AS g(m)
CROSS JOIN LATERAL (
  SELECT f2.*
  FROM public.subscription_facts f2
  WHERE f2.stripe_subscription_id = fe.stripe_subscription_id
    AND f2.occurred_at < ((g.m + interval '1 month') AT TIME ZONE 'UTC')
  ORDER BY f2.occurred_at DESC, f2.id DESC
  LIMIT 1
) f;

-- =====================================================================
-- 2) Account x currency x month-end MRR
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_account_month_v WITH (security_invoker = true) AS
SELECT s.user_id, s.currency, s.month, sum(s.mrr_cents)::bigint AS mrr_cents
FROM public.metrics_subscription_month_v s
GROUP BY s.user_id, s.currency, s.month;

-- =====================================================================
-- 3) MRR and ARR per month
--    ARR = MRR x 12 (a run-rate, not contracted or invoiced annual revenue).
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_mrr_monthly_v WITH (security_invoker = true) AS
SELECT
  a.month,
  a.currency,
  sum(a.mrr_cents)::bigint AS mrr_cents,
  (sum(a.mrr_cents) * 12)::bigint AS arr_cents,
  count(*) FILTER (WHERE a.mrr_cents > 0) AS paying_accounts,
  (SELECT count(*) FROM public.metrics_subscription_month_v s
    WHERE s.month = a.month AND s.currency = a.currency AND s.mrr_cents > 0 AND s.discount_unresolved) AS subscriptions_with_unresolved_discount,
  (a.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS is_partial
FROM public.metrics_account_month_v a
GROUP BY a.month, a.currency;

-- =====================================================================
-- 4) Retention: NRR, GRR, logo churn over a 1-month and a 12-month window ending at the end of `month`.
--    Cohort = accounts with MRR > 0 at the START of the window (= end of month - window). New logos are not in it.
--      NRR        = sum(closing MRR of cohort) / sum(opening MRR of cohort)                (expansion counts, can exceed 100%)
--      GRR        = sum(min(closing, opening)) / sum(opening)                              (never above 100%)
--      logo churn = cohort accounts whose MRR is 0 at the window end / cohort accounts
--    Basis points (10000 = 100%). One window, never annualised.
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_retention_monthly_v WITH (security_invoker = true) AS
WITH hist AS (SELECT min(occurred_at) AS history_start FROM public.subscription_facts),
grid AS (
  SELECT DISTINCT a.month, a.currency, w.window_months
  FROM public.metrics_account_month_v a
  CROSS JOIN (VALUES (1), (12)) AS w(window_months)
),
agg AS (
  SELECT
    g.month, g.currency, g.window_months,
    count(o.user_id) AS cohort_accounts,
    coalesce(sum(o.mrr_cents), 0)::bigint AS opening_mrr_cents,
    coalesce(sum(coalesce(c.mrr_cents, 0)), 0)::bigint AS closing_mrr_cents,
    coalesce(sum(least(o.mrr_cents, coalesce(c.mrr_cents, 0))), 0)::bigint AS retained_floor_cents,
    count(o.user_id) FILTER (WHERE coalesce(c.mrr_cents, 0) = 0) AS churned_accounts
  FROM grid g
  LEFT JOIN public.metrics_account_month_v o
    ON o.currency = g.currency
   AND o.month = (g.month - make_interval(months => g.window_months))::date
   AND o.mrr_cents > 0
  LEFT JOIN public.metrics_account_month_v c
    ON c.user_id = o.user_id AND c.currency = o.currency AND c.month = g.month
  GROUP BY g.month, g.currency, g.window_months
)
SELECT
  x.month, x.currency, x.window_months,
  x.cohort_accounts, x.opening_mrr_cents, x.closing_mrr_cents, x.retained_floor_cents, x.churned_accounts,
  CASE WHEN x.availability = 'ok' THEN round(x.closing_mrr_cents::numeric * 10000 / x.opening_mrr_cents)::integer END AS nrr_bp,
  CASE WHEN x.availability = 'ok' THEN round(x.retained_floor_cents::numeric * 10000 / x.opening_mrr_cents)::integer END AS grr_bp,
  CASE WHEN x.availability = 'ok' THEN round(x.churned_accounts::numeric * 10000 / x.cohort_accounts)::integer END AS logo_churn_bp,
  x.availability,
  (x.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS is_partial
FROM (
  SELECT a.*,
    CASE
      WHEN h.history_start IS NULL
        OR ((a.month - make_interval(months => a.window_months - 1))::timestamp AT TIME ZONE 'UTC') < h.history_start
        THEN 'not_available_history_too_short'
      WHEN a.cohort_accounts = 0 OR a.opening_mrr_cents <= 0 THEN 'not_available_no_cohort'
      ELSE 'ok'
    END AS availability
  FROM agg a CROSS JOIN hist h
) x;

-- =====================================================================
-- 5) CAC payback
--      CAC            = spend entered for the month and currency / new logos of that month
--      payback months = spend x 10000 / (new-logo MRR x gross margin bp)
--                     = CAC / (average new-logo MRR x gross margin)
--    new logo   = the account's first month with MRR > 0 (growth_mrr_movements_v movement 'new'; a trial counts when it converts)
--    spend      = growth_marketing_spend (manual; sum over channels)
--    gross margin = founder_cac_inputs.gross_margin_bp (manual); 0 or missing is NOT a margin, it is "not available"
--    A missing spend row is not a zero spend. An entered zero is a measured zero.
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_cac_payback_monthly_v WITH (security_invoker = true) AS
WITH new_logos AS (
  SELECT date_trunc('month', v.occurred_at AT TIME ZONE 'UTC')::date AS month,
         coalesce(v.currency, 'unknown') AS currency,
         count(*) AS new_logos,
         sum(v.delta_cents)::bigint AS new_logo_mrr_cents
  FROM public.growth_mrr_movements_v v
  WHERE v.movement = 'new'
  GROUP BY 1, 2
),
spend AS (
  SELECT s.month, s.currency, sum(s.amount_cents)::bigint AS spend_cents
  FROM public.growth_marketing_spend s
  GROUP BY s.month, s.currency
),
gm AS (
  SELECT to_date(i.month || '-01', 'YYYY-MM-DD') AS month, i.gross_margin_bp
  FROM public.founder_cac_inputs i
),
keys AS (
  SELECT month, currency FROM new_logos
  UNION
  SELECT month, currency FROM spend
),
j AS (
  SELECT k.month, k.currency,
         sp.spend_cents, coalesce(n.new_logos, 0) AS new_logos, coalesce(n.new_logo_mrr_cents, 0) AS new_logo_mrr_cents,
         g.gross_margin_bp
  FROM keys k
  LEFT JOIN spend sp ON sp.month = k.month AND sp.currency = k.currency
  LEFT JOIN new_logos n ON n.month = k.month AND n.currency = k.currency
  LEFT JOIN gm g ON g.month = k.month
)
SELECT
  j.month, j.currency, j.spend_cents, j.new_logos, j.new_logo_mrr_cents, j.gross_margin_bp,
  -- CAC itself needs only spend and new logos (it does not depend on gross margin).
  CASE WHEN j.spend_cents IS NOT NULL AND j.new_logos > 0 THEN round(j.spend_cents::numeric / j.new_logos)::bigint END AS cac_cents,
  CASE WHEN x.availability = 'ok' THEN round(j.spend_cents::numeric * 10000 / (j.new_logo_mrr_cents::numeric * j.gross_margin_bp), 2) END AS payback_months,
  x.availability,
  (j.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS is_partial
FROM j
CROSS JOIN LATERAL (SELECT CASE
    WHEN j.spend_cents IS NULL THEN 'not_available_no_spend'
    WHEN j.new_logos = 0 THEN 'not_available_no_new_logos'
    WHEN j.new_logo_mrr_cents <= 0 THEN 'not_available_no_new_mrr'
    WHEN j.gross_margin_bp IS NULL OR j.gross_margin_bp <= 0 THEN 'not_available_no_gross_margin'
    ELSE 'ok' END AS availability) x;

-- =====================================================================
-- 6) Data health (one row). Inputs that do not exist are reported as such, never zero-filled.
-- =====================================================================
CREATE OR REPLACE VIEW public.metrics_data_health_v WITH (security_invoker = true) AS
SELECT
  (SELECT min(occurred_at) FROM public.subscription_facts) AS history_start,
  (SELECT max(occurred_at) FROM public.subscription_facts) AS latest_event_at,
  (SELECT count(*) FROM public.subscription_facts) AS subscription_fact_rows,
  (SELECT count(*) FROM public.subscription_facts WHERE event_type = 'customer.subscription.created') AS created_events,
  (SELECT count(*) FROM public.subscription_facts WHERE currency IS NULL) AS rows_without_currency,
  (SELECT count(*) FROM public.growth_marketing_spend) AS spend_rows,
  (SELECT count(*) FROM public.founder_cac_inputs WHERE gross_margin_bp > 0) AS gross_margin_months,
  (SELECT count(*) FROM public.metrics_subscription_month_v
     WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND mrr_cents > 0 AND discount_unresolved) AS current_subscriptions_with_unresolved_discount;

REVOKE ALL ON public.metrics_subscription_month_v, public.metrics_account_month_v, public.metrics_mrr_monthly_v,
  public.metrics_retention_monthly_v, public.metrics_cac_payback_monthly_v, public.metrics_data_health_v FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 7) Staff RPC (is_vireek_staff checked inside, access written to staff_audit_log)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_metrics_saas(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_mrr jsonb; v_ret jsonb; v_cac jsonb; v_health jsonb;
BEGIN
  PERFORM public._growth_assert_staff('metrics_saas');
  PERFORM public._growth_assert_range(p_from, p_to);

  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.month, m.currency), '[]'::jsonb) INTO v_mrr
  FROM public.metrics_mrr_monthly_v m WHERE m.month >= date_trunc('month', p_from)::date AND m.month <= p_to;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.month, r.currency, r.window_months), '[]'::jsonb) INTO v_ret
  FROM public.metrics_retention_monthly_v r WHERE r.month >= date_trunc('month', p_from)::date AND r.month <= p_to;

  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.month, c.currency), '[]'::jsonb) INTO v_cac
  FROM public.metrics_cac_payback_monthly_v c WHERE c.month >= date_trunc('month', p_from)::date AND c.month <= p_to;

  SELECT to_jsonb(h) INTO v_health FROM public.metrics_data_health_v h;

  RETURN jsonb_build_object(
    'generated_at', now(), 'from', p_from, 'to', p_to,
    'basis', 'growth_* subscription ledger; UTC month-end snapshots; per currency, minor units, no conversion; NULL + availability = not available',
    'mrr', v_mrr, 'retention', v_ret, 'cac_payback', v_cac, 'data_health', v_health
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_metrics_saas(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_metrics_saas(date, date) TO authenticated;
