-- rollback: DROP FUNCTION IF EXISTS public.staff_fx_exposure(integer); DROP VIEW IF EXISTS public.fx_exposure_summary_v, public.fx_cost_by_currency_month_v, public.fx_collected_by_currency_month_v, public.fx_revenue_run_rate_v;
/*
  Currency exposure (20290307000000): Vireek's OWN revenue and cost by currency, and a per-currency exposure summary.
  Purely additive: four views and one staff RPC. No table is created or altered; no existing object is touched.
  NOT EXECUTED by the author (no Postgres in the authoring sandbox): run on a staging copy first, then
  `supabase test db` (supabase/tests/database/fx_exposure_views.test.sql).

  This is company-level (staff) reporting, not tenant reporting. Tenant invoices (jobs.invoice_currency) are the
  tenants' money and are not read here.

  Sources (nothing is invented, nothing is converted):
    revenue run-rate   subscription_facts (latest fact per Stripe subscription), same source as the MRR bridge
    revenue collected  billing_events payloads of Stripe invoice.paid / invoice.payment_succeeded, de-duplicated per invoice
    cost               cost_ledger (append-only; stored in micro-USD, so every cost row is USD BY CONSTRUCTION)
    reconciliation     provider_invoices (USD) is shown as a separate source and is NEVER added to cost_ledger,
                       because it invoices the same usage the ledger already records (adding both would double count)

  Rules:
    * Currencies are never converted, added together or averaged across currencies. No FX rate exists in this migration.
    * A currency with no recorded cost source shows cost as NULL ("not recorded"), never 0. Today the only recorded
      cost currency is USD; costs Vireek pays in other currencies (payroll, hosting, contractors) are not in the
      database [VERIFY]. A NULL cost means "unknown", not "no cost".
    * Amounts are Stripe minor units (cents for USD/EUR). Zero-decimal and three-decimal currencies keep their own
      minor unit; consumers must use the ISO 4217 exponent when formatting [VERIFY Stripe special cases].
    * collected_minor is Stripe's invoice amount_paid and INCLUDES tax. tax_minor is filled only when the payload carries
      a `tax` field (newer Stripe API versions may not) [VERIFY].
    * Access: no client grants on the views; read through staff_fx_exposure() (staff only) or service_role.
*/

-- 1) Recurring revenue run-rate by currency (latest fact per subscription) ---------------------------------------------------
CREATE OR REPLACE VIEW public.fx_revenue_run_rate_v WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (f.stripe_subscription_id)
    f.stripe_subscription_id, f.user_id, f.status, f.mrr_cents, f.currency, f.discount_unresolved
  FROM public.subscription_facts f
  ORDER BY f.stripe_subscription_id, f.occurred_at DESC, f.id DESC
)
SELECT
  coalesce(upper(nullif(btrim(l.currency), '')), 'UNSPECIFIED') AS currency,
  coalesce(sum(l.mrr_cents) FILTER (WHERE l.status IN ('active', 'past_due')), 0)::bigint AS mrr_minor,
  (count(*) FILTER (WHERE l.status IN ('active', 'past_due')))::integer AS subscriptions,
  (count(DISTINCT l.user_id) FILTER (WHERE l.status IN ('active', 'past_due')))::integer AS accounts,
  coalesce(sum(l.mrr_cents) FILTER (WHERE l.status = 'past_due'), 0)::bigint AS past_due_mrr_minor,
  (count(*) FILTER (WHERE l.status IN ('active', 'past_due') AND l.discount_unresolved))::integer AS discount_unresolved_subscriptions
FROM latest l
GROUP BY 1;

-- 2) Cash collected by month and currency (Stripe invoices, one row per invoice) ------------------------------------------------
CREATE OR REPLACE VIEW public.fx_collected_by_currency_month_v WITH (security_invoker = true) AS
WITH inv AS (
  SELECT DISTINCT ON (coalesce(e.payload #>> '{data,object,id}', e.stripe_event_id))
    upper(nullif(btrim(e.payload #>> '{data,object,currency}'), '')) AS currency,
    CASE WHEN e.payload #>> '{data,object,amount_paid}' ~ '^[0-9]{1,15}$'
         THEN (e.payload #>> '{data,object,amount_paid}')::bigint END AS amount_paid_minor,
    CASE WHEN e.payload #>> '{data,object,tax}' ~ '^[0-9]{1,15}$'
         THEN (e.payload #>> '{data,object,tax}')::bigint END AS tax_minor,
    CASE WHEN e.payload ->> 'created' ~ '^[0-9]{9,11}$'
         THEN to_timestamp((e.payload ->> 'created')::bigint) ELSE e.created_at END AS paid_at
  FROM public.billing_events e
  WHERE e.event_type IN ('invoice.paid', 'invoice.payment_succeeded')
  ORDER BY coalesce(e.payload #>> '{data,object,id}', e.stripe_event_id), e.created_at, e.id
)
SELECT
  date_trunc('month', i.paid_at AT TIME ZONE 'UTC')::date AS month,
  coalesce(i.currency, 'UNSPECIFIED') AS currency,
  count(*)::integer AS invoices,
  sum(i.amount_paid_minor)::bigint AS collected_minor,
  sum(i.tax_minor)::bigint AS tax_minor,
  (count(*) FILTER (WHERE i.amount_paid_minor IS NULL))::integer AS invoices_without_amount,
  (count(*) FILTER (WHERE i.tax_minor IS NULL))::integer AS invoices_without_tax_field
FROM inv i
GROUP BY 1, 2;

-- 3) Cost by month and currency ------------------------------------------------------------------------------------------------
-- cost_ledger.cost_micro is micro-USD (1e-6 USD); 10,000 micro-USD = 1 cent. Rows with `source = 'provider_invoices'`
-- are a reconciliation reference and must NOT be added to the `cost_ledger` rows.
CREATE OR REPLACE VIEW public.fx_cost_by_currency_month_v WITH (security_invoker = true) AS
SELECT
  date_trunc('month', l.occurred_at AT TIME ZONE 'UTC')::date AS month,
  'USD'::text AS currency,
  'cost_ledger'::text AS source,
  round(sum(l.cost_micro) / 10000.0)::bigint AS amount_minor,
  round(coalesce(sum(l.cost_micro) FILTER (WHERE l.basis = 'estimated'), 0) / 10000.0)::bigint AS estimated_minor,
  count(*)::integer AS entries
FROM public.cost_ledger l
GROUP BY 1
UNION ALL
SELECT
  p.period_month AS month,
  'USD'::text AS currency,
  'provider_invoices'::text AS source,
  round(sum(p.invoiced_usd) * 100)::bigint AS amount_minor,
  0::bigint AS estimated_minor,
  count(*)::integer AS entries
FROM public.provider_invoices p
GROUP BY 1;

-- 4) Exposure summary: one row per currency over the last three COMPLETED UTC calendar months -----------------------------------
-- Compares the recurring revenue run-rate with the average monthly RECORDED cost in the same currency. Currencies are never
-- combined. `exposure_state` says what the data can and cannot show; it is descriptive, not a recommendation.
CREATE OR REPLACE VIEW public.fx_exposure_summary_v WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date AS w_start,
         date_trunc('month', now() AT TIME ZONE 'UTC')::date AS w_end
),
rev AS (
  SELECT r.currency, r.mrr_minor, r.subscriptions, r.accounts, r.past_due_mrr_minor, r.discount_unresolved_subscriptions
  FROM public.fx_revenue_run_rate_v r
),
col AS (
  SELECT c.currency,
         sum(c.collected_minor)::bigint AS collected_minor,
         sum(c.invoices)::integer AS invoices,
         sum(c.invoices_without_amount)::integer AS invoices_without_amount
  FROM public.fx_collected_by_currency_month_v c CROSS JOIN bounds b
  WHERE c.month >= b.w_start AND c.month < b.w_end
  GROUP BY c.currency
),
cst AS (
  SELECT v.currency,
         sum(v.amount_minor)::bigint AS cost_minor,
         count(DISTINCT v.month)::integer AS months_with_cost
  FROM public.fx_cost_by_currency_month_v v CROSS JOIN bounds b
  WHERE v.source = 'cost_ledger' AND v.month >= b.w_start AND v.month < b.w_end
  GROUP BY v.currency
),
cur AS (
  SELECT currency FROM rev UNION SELECT currency FROM col UNION SELECT currency FROM cst
),
tot AS (
  SELECT coalesce(sum(subscriptions), 0)::numeric AS subs FROM rev
)
SELECT
  cur.currency,
  b.w_start AS window_start,
  b.w_end AS window_end,
  rev.mrr_minor,
  rev.subscriptions,
  rev.accounts,
  rev.past_due_mrr_minor,
  rev.discount_unresolved_subscriptions,
  CASE WHEN t.subs > 0 AND rev.subscriptions IS NOT NULL
       THEN round(100.0 * rev.subscriptions / t.subs, 1) END AS share_of_subscriptions_pct,
  col.collected_minor,
  col.invoices AS collected_invoices,
  col.invoices_without_amount,
  cst.months_with_cost,
  CASE WHEN cst.months_with_cost > 0 THEN round(cst.cost_minor::numeric / cst.months_with_cost)::bigint END AS avg_monthly_cost_minor,
  CASE
    WHEN cst.cost_minor IS NOT NULL AND (rev.mrr_minor IS NOT NULL OR col.collected_minor IS NOT NULL) THEN 'revenue_and_cost_recorded'
    WHEN cst.cost_minor IS NOT NULL THEN 'cost_only'
    ELSE 'revenue_only_no_recorded_cost'
  END AS exposure_state
FROM cur
CROSS JOIN bounds b
CROSS JOIN tot t
LEFT JOIN rev ON rev.currency = cur.currency
LEFT JOIN col ON col.currency = cur.currency
LEFT JOIN cst ON cst.currency = cur.currency;

-- 5) Access: views are internal ---------------------------------------------------------------------------------------------------
REVOKE ALL ON public.fx_revenue_run_rate_v, public.fx_collected_by_currency_month_v,
  public.fx_cost_by_currency_month_v, public.fx_exposure_summary_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fx_revenue_run_rate_v, public.fx_collected_by_currency_month_v,
  public.fx_cost_by_currency_month_v, public.fx_exposure_summary_v TO service_role;

-- 6) Staff RPC (same guard as staff_cogs_by_plan) --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_fx_exposure(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_months IS NULL OR p_months < 1 OR p_months > 36 THEN
    RAISE EXCEPTION 'p_months must be between 1 and 36' USING ERRCODE = '22023';
  END IF;
  v_from := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months))::date;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'exposure', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.currency) FROM public.fx_exposure_summary_v x), '[]'::jsonb),
    'revenue_run_rate', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.currency) FROM public.fx_revenue_run_rate_v r), '[]'::jsonb),
    'collected_by_month', coalesce((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.month DESC, c.currency)
      FROM public.fx_collected_by_currency_month_v c WHERE c.month >= v_from
    ), '[]'::jsonb),
    'cost_by_month', coalesce((
      SELECT jsonb_agg(to_jsonb(k) ORDER BY k.month DESC, k.source, k.currency)
      FROM public.fx_cost_by_currency_month_v k WHERE k.month >= v_from
    ), '[]'::jsonb),
    'conversion', 'none: currencies are never converted or added together',
    'cost_basis', 'cost_ledger_is_usd_only; costs paid in other currencies are not recorded in the database',
    'provider_invoices_note', 'reconciliation reference only; never add to cost_ledger rows',
    'collected_includes_tax', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_fx_exposure(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_fx_exposure(integer) TO authenticated;
