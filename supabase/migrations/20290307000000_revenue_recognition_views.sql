/*
  # Vireek revenue recognition views (internal, platform staff ONLY)

  Scope: Vireek's OWN revenue (what tenants pay Vireek). It is NOT the tenant-facing `invoices` table, which holds
  invoices that tenants send to THEIR customers and is irrelevant to Vireek's revenue.

  Source of truth: the full Stripe event payloads that stripe-webhook already stores in `billing_events`
  (invoice.paid / invoice.payment_succeeded, charge.refunded). No new ingestion, no change to stripe-webhook.

  What already existed (NOT duplicated): subscription_facts + growth_mrr_movements_v (MRR movements, which are
  a RUN-RATE measure, not recognised revenue), founder_* ledger, board-pack generator. Neither contains invoices,
  so recognised vs deferred revenue was not computable before this migration.

  Objects
    revenue_jint(text), revenue_jts(text)   safe parsers (NULL instead of an error on malformed payloads)
    revenue_price_stream_map                staff-maintained: stripe_price_id -> stream (results_based, ...)
    revenue_paid_invoices_v                 one row per PAID Stripe invoice (duplicate events collapsed)
    revenue_invoice_lines_v                 one row per invoice line: net amount, period, stream, flags
    revenue_recognition_schedule_v          line x month: recognised, billed, deferred (cumulative, telescoping)
    revenue_recognition_monthly_v           month x currency x stream: opening deferred + billed - recognised = closing
    revenue_refunds_monthly_v               refunds per month from charge.refunded (shown, NOT netted)
    revenue_data_health_v                   one row: what the data can and cannot support
    staff_revenue_recognition(from, to)     staff-only report (jsonb)
    staff_revenue_stream_map_list/set/delete

  PROPOSED treatment (every accounting policy below is a [COUNSEL] decision; see docs/finance/revenue-recognition.md):
    * Net amount of a line = amount - all discounts - tax that is INCLUDED in the price. Tax collected is never revenue.
    * Ratable lines (period end > start) are recognised straight-line by elapsed TIME (seconds) across UTC months.
      A month's amount is round(net x elapsed) minus the previous cumulative amount, so the months always add up
      to the net amount exactly (no rounding drift).
    * Point-in-time lines (no period, or end <= start) are recognised in full in the month of their start.
    * Nothing is recognised before the month the invoice was PAID (data limit: unpaid invoices are not in the
      stored events). Service already elapsed when payment arrives is therefore recognised in the payment month
      (catch-up). This also guarantees deferred revenue is never negative for positive lines.
    * Usage and results-based amounts are billed in arrears (the period just closed), so they land in the month
      of payment, not the month of usage. Whether to accrue unbilled usage is a [COUNSEL] decision.
    * No currency conversion: every figure is per currency, in Stripe minor units.

  Time basis: UTC months. Event-time (paid_at from the invoice, else the Stripe event `created`).

  Access: RLS-free views with NO grant to anon/authenticated (security_invoker); staff read only through
  staff_revenue_recognition (checks is_vireek_staff and writes staff_audit_log). Idempotent.
  Requires: billing_events, is_vireek_staff(uuid), staff_audit_log, _growth_assert_staff / _growth_assert_range
  (20281104000000_growth_analytics_phase2.sql).

  NOT EXECUTED IN PRODUCTION. Verified only against a stub-schema Postgres 16 (see the verification report).
  Run on a staging copy of production data first and compare with Stripe's revenue-recognition report [VERIFY].

  ROLLBACK (no table other than revenue_price_stream_map is created; no source data is touched):
    DROP FUNCTION IF EXISTS public.staff_revenue_stream_map_delete(text), public.staff_revenue_stream_map_set(text, text, text),
      public.staff_revenue_stream_map_list(), public.staff_revenue_recognition(date, date);
    DROP VIEW IF EXISTS public.revenue_data_health_v, public.revenue_refunds_monthly_v, public.revenue_recognition_monthly_v,
      public.revenue_recognition_schedule_v, public.revenue_invoice_lines_v, public.revenue_paid_invoices_v;
    DROP TABLE IF EXISTS public.revenue_price_stream_map;   -- the mapping is staff input: export first
    DROP FUNCTION IF EXISTS public.revenue_jts(text), public.revenue_jint(text);
*/

-- =====================================================================
-- 1) Safe parsers. Malformed Stripe payloads must yield NULL, never abort a report.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.revenue_jint(p text)
RETURNS bigint
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$ SELECT CASE WHEN p ~ '^-?[0-9]{1,15}$' THEN p::bigint END $$;

-- Unix seconds -> timestamptz (bounded to 2000-01-01 .. 2100-01-01 so garbage cannot explode a month series).
CREATE OR REPLACE FUNCTION public.revenue_jts(p text)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$ SELECT CASE WHEN p ~ '^[0-9]{1,12}$' AND p::bigint BETWEEN 946684800 AND 4102444800 THEN to_timestamp(p::bigint) END $$;

REVOKE ALL ON FUNCTION public.revenue_jint(text), public.revenue_jts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revenue_jint(text), public.revenue_jts(text) TO authenticated, service_role;

-- =====================================================================
-- 2) Price -> stream map (the only way SQL can tell the Results Plan prices from ordinary metered prices;
--    the real price ids live in environment secrets such as STRIPE_RESULTS_METERED_PRICE_ID).
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.revenue_price_stream_map (
  stripe_price_id text PRIMARY KEY CHECK (stripe_price_id ~ '^price_[A-Za-z0-9_]{1,200}$'),
  stream text NOT NULL CHECK (stream IN ('subscription', 'usage_overage', 'results_based')),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.revenue_price_stream_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revenue_price_stream_map FROM anon, authenticated;

-- =====================================================================
-- 3) One row per paid invoice. invoice.paid and invoice.payment_succeeded describe the same invoice:
--    the latest stored event wins, so a replay or a double delivery can never count an invoice twice.
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_paid_invoices_v WITH (security_invoker = true) AS
SELECT DISTINCT ON (x.invoice_id)
  x.invoice_id,
  x.stripe_event_id,
  x.event_type,
  x.currency,
  x.paid_at,
  x.billing_reason,
  x.customer_id,
  x.subscription_id,
  x.total_cents,
  x.total_excluding_tax_cents,
  x.lines_has_more,
  x.lines
FROM (
  SELECT
    e.inv ->> 'id' AS invoice_id,
    e.stripe_event_id,
    e.event_type,
    e.created_at AS event_row_at,
    lower(nullif(btrim(e.inv ->> 'currency'), '')) AS currency,
    coalesce(public.revenue_jts(e.inv #>> '{status_transitions,paid_at}'),
             public.revenue_jts(e.payload ->> 'created'),
             e.created_at) AS paid_at,
    e.inv ->> 'billing_reason' AS billing_reason,
    CASE WHEN jsonb_typeof(e.inv -> 'customer') = 'string' THEN e.inv ->> 'customer' END AS customer_id,
    CASE WHEN jsonb_typeof(e.inv -> 'subscription') = 'string' THEN e.inv ->> 'subscription' END AS subscription_id,
    public.revenue_jint(e.inv ->> 'total') AS total_cents,
    public.revenue_jint(e.inv ->> 'total_excluding_tax') AS total_excluding_tax_cents,
    (e.inv #>> '{lines,has_more}') = 'true' AS lines_has_more,
    CASE WHEN jsonb_typeof(e.inv #> '{lines,data}') = 'array' THEN e.inv #> '{lines,data}' ELSE '[]'::jsonb END AS lines
  FROM (
    SELECT b.stripe_event_id, b.event_type, b.created_at, b.payload, b.payload #> '{data,object}' AS inv
    FROM public.billing_events b
    WHERE b.event_type IN ('invoice.paid', 'invoice.payment_succeeded')
  ) e
  WHERE jsonb_typeof(e.inv) = 'object'
    AND coalesce(e.inv ->> 'id', '') <> ''
    AND e.inv ->> 'status' = 'paid'
) x
ORDER BY x.invoice_id, x.event_row_at DESC, x.stripe_event_id DESC;

-- =====================================================================
-- 4) One row per invoice line.
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_invoice_lines_v WITH (security_invoker = true) AS
WITH raw AS (
  SELECT
    i.invoice_id, i.currency, i.paid_at, i.customer_id,
    l.ord::integer AS line_no,
    l.line,
    public.revenue_jint(l.line ->> 'amount') AS gross_cents,
    coalesce((SELECT sum(public.revenue_jint(d ->> 'amount'))
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.line -> 'discount_amounts') = 'array' THEN l.line -> 'discount_amounts' ELSE '[]'::jsonb END) d), 0)::bigint AS discount_cents,
    coalesce((SELECT sum(public.revenue_jint(t ->> 'amount'))
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.line -> 'tax_amounts') = 'array' THEN l.line -> 'tax_amounts' ELSE '[]'::jsonb END) t
              WHERE t ->> 'inclusive' = 'true'), 0)::bigint AS inclusive_tax_cents,
    public.revenue_jts(l.line #>> '{period,start}') AS period_start,
    public.revenue_jts(l.line #>> '{period,end}') AS period_end,
    (l.line ->> 'proration') = 'true' AS is_proration,
    l.line #>> '{price,id}' AS price_id,
    l.line #>> '{price,recurring,usage_type}' AS usage_type,
    nullif(l.line #>> '{metadata,vireek_overage_key}', '') IS NOT NULL AS has_overage_key,
    coalesce(nullif(l.line ->> 'id', ''), i.invoice_id || ':' || l.ord::text) AS line_id
  FROM public.revenue_paid_invoices_v i
  CROSS JOIN LATERAL jsonb_array_elements(i.lines) WITH ORDINALITY AS l(line, ord)
  WHERE jsonb_typeof(l.line) = 'object'
)
SELECT
  r.invoice_id,
  r.line_id,
  r.line_no,
  r.currency,
  r.customer_id,
  r.paid_at,
  r.gross_cents,
  r.discount_cents,
  r.inclusive_tax_cents,
  CASE WHEN r.gross_cents IS NULL THEN NULL
       ELSE r.gross_cents - r.discount_cents - r.inclusive_tax_cents END AS net_cents,
  r.period_start,
  r.period_end,
  (r.period_start IS NOT NULL AND r.period_end IS NOT NULL AND r.period_end > r.period_start) AS is_ratable,
  r.is_proration,
  r.price_id,
  r.usage_type,
  r.has_overage_key,
  CASE
    WHEN r.has_overage_key THEN 'usage_overage'
    WHEN m.stream IS NOT NULL THEN m.stream
    WHEN r.usage_type = 'metered' THEN 'metered_unmapped'
    ELSE 'subscription'
  END AS stream,
  (m.stream IS NOT NULL) AS stream_from_map,
  -- A line can be scheduled only with a currency, a net amount and a sane period (or none).
  CASE
    WHEN r.currency IS NULL THEN 'currency_missing'
    WHEN r.gross_cents IS NULL THEN 'amount_missing'
    WHEN r.period_start IS NOT NULL AND r.period_end IS NOT NULL AND r.period_end > r.period_start
         AND r.period_end - r.period_start > interval '5 years' THEN 'period_out_of_range'
    WHEN (r.line #>> '{period,start}') IS NOT NULL AND r.period_start IS NULL THEN 'period_out_of_range'
    ELSE NULL
  END AS exclusion_reason
FROM raw r
LEFT JOIN public.revenue_price_stream_map m ON m.stripe_price_id = r.price_id;

-- =====================================================================
-- 5) Schedule: line x UTC month. Cumulative recognised(month end) = round(net x elapsed fraction), gated by the
--    payment month. Monthly amount = difference of consecutive cumulatives (telescopes to the net amount).
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_recognition_schedule_v WITH (security_invoker = true) AS
WITH lines AS (
  SELECT l.*,
    (l.period_start AT TIME ZONE 'UTC') AS ps,
    (l.period_end AT TIME ZONE 'UTC') AS pe,
    date_trunc('month', l.paid_at AT TIME ZONE 'UTC') AS paid_month
  FROM public.revenue_invoice_lines_v l
  WHERE l.exclusion_reason IS NULL
),
grid AS (
  SELECT l.*, g.m AS month_start, (g.m + interval '1 month') AS month_end
  FROM lines l
  CROSS JOIN LATERAL generate_series(
    date_trunc('month', least(coalesce(l.ps, l.paid_month), l.paid_month)),
    date_trunc('month', greatest(coalesce(CASE WHEN l.is_ratable THEN l.pe - interval '1 microsecond' ELSE l.ps END, l.paid_month), l.paid_month)),
    interval '1 month') AS g(m)
),
cum AS (
  SELECT g.*,
    CASE
      WHEN g.month_end <= g.paid_month THEN 0::bigint                       -- never before the payment month
      WHEN g.is_ratable THEN round(g.net_cents::numeric * greatest(0::numeric, least(1::numeric,
             extract(epoch FROM (least(g.month_end, g.pe) - g.ps)) / extract(epoch FROM (g.pe - g.ps)))))::bigint
      WHEN g.ps IS NOT NULL AND g.month_end <= g.ps THEN 0::bigint        -- point in time, not reached yet
      ELSE g.net_cents                                                    -- point in time reached (or no period)
    END AS cum_recognised_cents
  FROM grid g
)
SELECT
  c.line_id, c.invoice_id, c.currency, c.stream,
  c.month_start::date AS month,
  c.net_cents,
  c.cum_recognised_cents,
  c.cum_recognised_cents - coalesce(lag(c.cum_recognised_cents) OVER (PARTITION BY c.line_id ORDER BY c.month_start), 0) AS recognised_cents,
  CASE WHEN c.month_start = c.paid_month THEN c.net_cents ELSE 0 END AS billed_cents,
  CASE WHEN c.month_start >= c.paid_month THEN c.net_cents ELSE 0 END - c.cum_recognised_cents AS deferred_end_cents
FROM cum c;

-- =====================================================================
-- 6) Monthly roll-forward per currency and stream.
--    opening deferred + billed (paid) - recognised = closing deferred   (identity is tested)
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_recognition_monthly_v WITH (security_invoker = true) AS
SELECT
  s.month,
  s.currency,
  s.stream,
  (sum(s.deferred_end_cents) - sum(s.billed_cents) + sum(s.recognised_cents))::bigint AS deferred_open_cents,
  sum(s.billed_cents)::bigint AS billed_cents,
  sum(s.recognised_cents)::bigint AS recognised_cents,
  sum(s.deferred_end_cents)::bigint AS deferred_close_cents,
  count(DISTINCT s.invoice_id) AS invoices,
  (s.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS is_partial
FROM public.revenue_recognition_schedule_v s
GROUP BY s.month, s.currency, s.stream;

-- =====================================================================
-- 7) Refunds (charge.refunded). amount_refunded is CUMULATIVE per charge: the monthly figure is the delta between
--    consecutive events of the same charge. Amounts are GROSS (they include tax) and are shown, never netted.
--    A refund with no invoice link (e.g. a minute top-up pack) is reported separately.
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_refunds_monthly_v WITH (security_invoker = true) AS
WITH ev AS (
  SELECT
    b.stripe_event_id,
    b.payload #>> '{data,object,id}' AS charge_id,
    coalesce(public.revenue_jts(b.payload ->> 'created'), b.created_at) AS event_at,
    lower(nullif(btrim(b.payload #>> '{data,object,currency}'), '')) AS currency,
    public.revenue_jint(b.payload #>> '{data,object,amount_refunded}') AS refunded_cum_cents,
    (jsonb_typeof(b.payload #> '{data,object,invoice}') = 'string' AND (b.payload #>> '{data,object,invoice}') <> '') AS invoice_linked
  FROM public.billing_events b
  WHERE b.event_type = 'charge.refunded'
),
d AS (
  SELECT ev.*,
    ev.refunded_cum_cents - coalesce(lag(ev.refunded_cum_cents) OVER (PARTITION BY ev.charge_id ORDER BY ev.event_at, ev.stripe_event_id), 0) AS delta_cents
  FROM ev
  WHERE ev.charge_id IS NOT NULL AND ev.refunded_cum_cents IS NOT NULL AND ev.currency IS NOT NULL
)
SELECT
  date_trunc('month', d.event_at AT TIME ZONE 'UTC')::date AS month,
  d.currency,
  coalesce(sum(d.delta_cents) FILTER (WHERE d.invoice_linked), 0)::bigint AS refunds_invoice_cents,
  coalesce(sum(d.delta_cents) FILTER (WHERE NOT d.invoice_linked), 0)::bigint AS refunds_unlinked_cents,
  count(DISTINCT d.charge_id) AS charges
FROM d
GROUP BY 1, 2;

-- =====================================================================
-- 8) Data health: what the stored events can and cannot support. A missing source is reported, never zero-filled.
-- =====================================================================
CREATE OR REPLACE VIEW public.revenue_data_health_v WITH (security_invoker = true) AS
WITH inv AS (
  SELECT i.invoice_id, i.lines_has_more, i.total_excluding_tax_cents,
    (SELECT sum(l.net_cents) FROM public.revenue_invoice_lines_v l WHERE l.invoice_id = i.invoice_id) AS lines_net_cents
  FROM public.revenue_paid_invoices_v i
)
SELECT
  (SELECT count(*) FROM public.billing_events WHERE event_type IN ('invoice.paid', 'invoice.payment_succeeded')) AS paid_invoice_events,
  (SELECT count(*) FROM inv) AS paid_invoices,
  (SELECT min(paid_at) FROM public.revenue_paid_invoices_v) AS first_paid_at,
  (SELECT max(paid_at) FROM public.revenue_paid_invoices_v) AS last_paid_at,
  (SELECT count(*) FROM inv WHERE lines_has_more) AS invoices_lines_truncated,
  (SELECT count(*) FROM inv WHERE NOT lines_has_more AND total_excluding_tax_cents IS NOT NULL AND lines_net_cents = total_excluding_tax_cents) AS invoices_reconciled,
  (SELECT count(*) FROM inv WHERE NOT lines_has_more AND total_excluding_tax_cents IS NOT NULL AND lines_net_cents IS DISTINCT FROM total_excluding_tax_cents) AS invoices_mismatch,
  (SELECT count(*) FROM inv WHERE NOT lines_has_more AND total_excluding_tax_cents IS NULL) AS invoices_reconciliation_unavailable,
  (SELECT count(*) FROM public.revenue_invoice_lines_v WHERE exclusion_reason IS NOT NULL) AS lines_excluded,
  (SELECT count(*) FROM public.revenue_invoice_lines_v WHERE stream = 'metered_unmapped') AS lines_metered_unmapped,
  (SELECT count(*) FROM public.billing_events WHERE event_type = 'charge.refunded') AS refund_events,
  (SELECT count(*) FROM public.billing_events WHERE event_type LIKE 'credit_note.%') AS credit_note_events,
  (SELECT count(*) FROM public.billing_events WHERE event_type IN ('invoice.voided', 'invoice.marked_uncollectible')) AS void_or_uncollectible_events;

-- =====================================================================
-- 9) Privileges: the views are internal. No client role may read them.
-- =====================================================================
REVOKE ALL ON public.revenue_paid_invoices_v, public.revenue_invoice_lines_v, public.revenue_recognition_schedule_v,
  public.revenue_recognition_monthly_v, public.revenue_refunds_monthly_v, public.revenue_data_health_v FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 10) Staff RPCs (is_vireek_staff checked inside, access written to staff_audit_log)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_revenue_recognition(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_rows jsonb; v_refunds jsonb; v_health jsonb;
BEGIN
  PERFORM public._growth_assert_staff('revenue_recognition');
  PERFORM public._growth_assert_range(p_from, p_to);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'month', m.month, 'currency', m.currency, 'stream', m.stream,
    'deferred_open_cents', m.deferred_open_cents, 'billed_cents', m.billed_cents,
    'recognised_cents', m.recognised_cents, 'deferred_close_cents', m.deferred_close_cents,
    'invoices', m.invoices, 'is_partial', m.is_partial
  ) ORDER BY m.month, m.currency, m.stream), '[]'::jsonb)
  INTO v_rows
  FROM public.revenue_recognition_monthly_v m
  WHERE m.month >= date_trunc('month', p_from)::date AND m.month <= p_to;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.month, r.currency), '[]'::jsonb)
  INTO v_refunds
  FROM public.revenue_refunds_monthly_v r
  WHERE r.month >= date_trunc('month', p_from)::date AND r.month <= p_to;

  SELECT to_jsonb(h) INTO v_health FROM public.revenue_data_health_v h;

  RETURN jsonb_build_object(
    'generated_at', now(), 'from', p_from, 'to', p_to,
    'basis', 'paid invoices only; UTC months; straight-line by time; per currency, minor units, no conversion; PROPOSED policy, pending counsel',
    'monthly', v_rows,
    'refunds', v_refunds,
    'data_health', v_health
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_revenue_stream_map_list()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('revenue_stream_map');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('stripe_price_id', m.stripe_price_id, 'stream', m.stream,
           'note', m.note, 'updated_at', m.updated_at) ORDER BY m.stripe_price_id)
         FROM public.revenue_price_stream_map m), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_revenue_stream_map_set(p_price_id text, p_stream text, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('revenue_stream_map', 'write');
  IF p_price_id IS NULL OR p_price_id !~ '^price_[A-Za-z0-9_]{1,200}$' THEN RAISE EXCEPTION 'invalid_price_id' USING ERRCODE = '22023'; END IF;
  IF p_stream IS NULL OR p_stream NOT IN ('subscription', 'usage_overage', 'results_based') THEN RAISE EXCEPTION 'invalid_stream' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.revenue_price_stream_map AS t (stripe_price_id, stream, note, updated_by, updated_at)
  VALUES (p_price_id, p_stream, nullif(left(btrim(coalesce(p_note, '')), 300), ''), auth.uid(), now())
  ON CONFLICT (stripe_price_id) DO UPDATE
    SET stream = EXCLUDED.stream, note = EXCLUDED.note, updated_by = auth.uid(), updated_at = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_revenue_stream_map_delete(p_price_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('revenue_stream_map', 'write');
  DELETE FROM public.revenue_price_stream_map WHERE stripe_price_id = p_price_id;
  RETURN FOUND;
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'staff_revenue_recognition(date, date)', 'staff_revenue_stream_map_list()',
    'staff_revenue_stream_map_set(text, text, text)', 'staff_revenue_stream_map_delete(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;
