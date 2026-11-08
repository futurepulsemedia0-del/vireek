/*
  # Growth analytics core — subscription facts, MRR movements, staff-only RPCs

  ## What this adds (purely additive; no existing object is modified)
  - `subscription_facts`      append-only: one row per Stripe subscription event, holding the
                              subscription's MRR *after* that event. Derived ONLY from
                              `billing_events` (already written, idempotently, by stripe-webhook),
                              so stripe-webhook needs no change and a failure here can never block billing.
  - `growth_price_plan_map`   optional staff-maintained map stripe_price_id -> plan_id.
  - trigger on `billing_events` + `growth_backfill_subscription_facts()` (service role) to replay history.
  - view `growth_mrr_movements_v`  account-level movements: new / expansion / contraction / churn / reactivation.
  - `staff_growth_mrr_bridge(from, to)` and `staff_growth_data_quality()`  staff-only (is_vireek_staff).

  ## Definitions (must match docs in src/lib/growth/growthMetrics.ts)
  - MRR counts a subscription only while status IN ('active','past_due'). trialing/canceled/unpaid/
    incomplete/paused => 0. Yearly price / 12. Only month/year intervals are supported.
  - Percent-off coupons with duration 'forever' are applied; any other discount is NOT applied and the
    fact is flagged discount_unresolved (MRR may be overstated; surfaced in data quality).
  - Movement = change of the ACCOUNT's total MRR (sum over its subscriptions), ordered by Stripe
    `event.created` then row id (events can arrive out of order).
  - Single currency per row; no FX conversion. Results are grouped by currency.

  ## Security
  RLS enabled, no client policies; ALL privileges revoked from anon/authenticated. Access only via
  SECURITY DEFINER staff RPCs (is_vireek_staff) which write staff_audit_log (action 'explorer_list').

  ## Requires: profiles(stripe_customer_id,is_staff), billing_events, is_vireek_staff(uuid), staff_audit_log.
  ## Stripe dashboard: the webhook endpoint must also send customer.subscription.created.

  ## Rollback
    DROP TRIGGER IF EXISTS trg_growth_ingest_billing_event ON public.billing_events;
    DROP VIEW IF EXISTS public.growth_mrr_movements_v;
    DROP FUNCTION IF EXISTS public.staff_growth_mrr_bridge(date,date), public.staff_growth_data_quality(),
      public.growth_backfill_subscription_facts(), public.growth_ingest_billing_event(),
      public.growth_apply_billing_event(text,text,jsonb,timestamptz), public.growth_mrr_cents(jsonb,text,jsonb);
    DROP TABLE IF EXISTS public.subscription_facts, public.growth_price_plan_map;
*/

CREATE TABLE IF NOT EXISTS public.growth_price_plan_map (
  stripe_price_id text PRIMARY KEY,
  plan_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscription_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  stripe_subscription_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  stripe_price_id text,
  plan_id text,
  billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  currency text,
  mrr_cents bigint NOT NULL CHECK (mrr_cents >= 0),
  trial_start timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  discount_unresolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_facts_user_time ON public.subscription_facts (user_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_subscription_facts_sub_time ON public.subscription_facts (stripe_subscription_id, occurred_at, id);

ALTER TABLE public.growth_price_plan_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_price_plan_map, public.subscription_facts FROM anon, authenticated;

-- Monthly recurring cents for one subscription object. Pure/immutable.
CREATE OR REPLACE FUNCTION public.growth_mrr_cents(p_item jsonb, p_status text, p_discount jsonb)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_unit numeric; v_qty numeric; v_count numeric; v_interval text; v_monthly numeric; v_pct numeric;
BEGIN
  IF p_status NOT IN ('active', 'past_due') OR p_item IS NULL THEN RETURN 0; END IF;
  v_unit := nullif(p_item #>> '{price,unit_amount}', '')::numeric;
  v_qty := coalesce(nullif(p_item ->> 'quantity', '')::numeric, 1);
  v_interval := p_item #>> '{price,recurring,interval}';
  v_count := coalesce(nullif(p_item #>> '{price,recurring,interval_count}', '')::numeric, 1);
  IF v_unit IS NULL OR v_count <= 0 THEN RETURN 0; END IF;
  IF v_interval = 'month' THEN v_monthly := v_unit * v_qty / v_count;
  ELSIF v_interval = 'year' THEN v_monthly := v_unit * v_qty / (12 * v_count);
  ELSE RETURN 0; END IF;
  IF p_discount #>> '{coupon,duration}' = 'forever' AND (p_discount #>> '{coupon,percent_off}') IS NOT NULL THEN
    v_pct := (p_discount #>> '{coupon,percent_off}')::numeric;
    v_monthly := v_monthly * (1 - least(greatest(v_pct, 0), 100) / 100);
  END IF;
  RETURN round(v_monthly)::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.growth_apply_billing_event(p_event_id text, p_type text, p_payload jsonb, p_created timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  obj jsonb; v_user uuid; v_meta text; v_status text; v_item jsonb; v_price text; v_plan text;
  v_at timestamptz; v_discount jsonb; v_interval text;
BEGIN
  IF p_type NOT IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') THEN RETURN; END IF;
  obj := p_payload #> '{data,object}';
  IF obj IS NULL OR obj ->> 'id' IS NULL THEN RETURN; END IF;

  v_meta := obj #>> '{metadata,supabase_user_id}';
  IF v_meta ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_user FROM profiles WHERE id = v_meta::uuid;
  END IF;
  IF v_user IS NULL AND obj ->> 'customer' IS NOT NULL THEN
    SELECT id INTO v_user FROM profiles WHERE stripe_customer_id = obj ->> 'customer' LIMIT 1;
  END IF;
  IF v_user IS NULL THEN RETURN; END IF; -- unmatched: reported by staff_growth_data_quality()

  v_status := CASE WHEN p_type = 'customer.subscription.deleted' THEN 'canceled' ELSE coalesce(obj ->> 'status', 'incomplete') END;
  v_item := obj #> '{items,data,0}';
  v_price := v_item #>> '{price,id}';
  v_interval := v_item #>> '{price,recurring,interval}';
  v_discount := obj -> 'discount';
  SELECT m.plan_id INTO v_plan FROM growth_price_plan_map m WHERE m.stripe_price_id = v_price;
  v_plan := coalesce(v_plan, obj #>> '{metadata,plan_id}');
  v_at := CASE WHEN (p_payload ->> 'created') ~ '^[0-9]+$' THEN to_timestamp((p_payload ->> 'created')::bigint) ELSE p_created END;

  INSERT INTO subscription_facts (
    stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, stripe_price_id, plan_id,
    billing_interval, currency, mrr_cents, trial_start, trial_end, cancel_at_period_end, discount_unresolved
  ) VALUES (
    p_event_id, obj ->> 'id', v_user, v_at, p_type, v_status, v_price, v_plan,
    CASE WHEN v_interval IN ('month', 'year') THEN v_interval END,
    lower(coalesce(obj ->> 'currency', v_item #>> '{price,currency}')),
    public.growth_mrr_cents(v_item, v_status, v_discount),
    CASE WHEN (obj ->> 'trial_start') ~ '^[0-9]+$' THEN to_timestamp((obj ->> 'trial_start')::bigint) END,
    CASE WHEN (obj ->> 'trial_end') ~ '^[0-9]+$' THEN to_timestamp((obj ->> 'trial_end')::bigint) END,
    coalesce((obj ->> 'cancel_at_period_end')::boolean, false),
    v_discount IS NOT NULL AND v_discount <> 'null'::jsonb
      AND NOT (v_discount #>> '{coupon,duration}' = 'forever' AND (v_discount #>> '{coupon,percent_off}') IS NOT NULL)
  ) ON CONFLICT (stripe_event_id) DO NOTHING;
END;
$$;

-- Trigger wrapper: analytics must NEVER break billing, so every error is downgraded to a warning.
CREATE OR REPLACE FUNCTION public.growth_ingest_billing_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.growth_apply_billing_event(NEW.stripe_event_id, NEW.event_type, NEW.payload, NEW.created_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'growth_ingest_billing_event failed for %: %', NEW.stripe_event_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_growth_ingest_billing_event ON public.billing_events;
CREATE TRIGGER trg_growth_ingest_billing_event
  AFTER INSERT ON public.billing_events
  FOR EACH ROW EXECUTE FUNCTION public.growth_ingest_billing_event();

-- Replays stored events (idempotent: ON CONFLICT DO NOTHING). Service role only.
CREATE OR REPLACE FUNCTION public.growth_backfill_subscription_facts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE r record; v_before bigint; v_after bigint;
BEGIN
  SELECT count(*) INTO v_before FROM subscription_facts;
  FOR r IN
    SELECT e.stripe_event_id, e.event_type, e.payload, e.created_at
    FROM billing_events e
    WHERE e.event_type IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
      AND NOT EXISTS (SELECT 1 FROM subscription_facts f WHERE f.stripe_event_id = e.stripe_event_id)
    ORDER BY e.created_at
  LOOP
    PERFORM public.growth_apply_billing_event(r.stripe_event_id, r.event_type, r.payload, r.created_at);
  END LOOP;
  SELECT count(*) INTO v_after FROM subscription_facts;
  RETURN (v_after - v_before)::integer;
END;
$$;

-- Account-level movements. Account MRR after an event = running sum of per-subscription deltas.
CREATE OR REPLACE VIEW public.growth_mrr_movements_v AS
WITH sub_delta AS (
  SELECT f.*,
    f.mrr_cents - coalesce(lag(f.mrr_cents) OVER (PARTITION BY f.stripe_subscription_id ORDER BY f.occurred_at, f.id), 0) AS d
  FROM public.subscription_facts f
),
acct AS (
  SELECT s.*,
    sum(s.d) OVER (PARTITION BY s.user_id, s.currency ORDER BY s.occurred_at, s.id) AS after_cents
  FROM sub_delta s
),
x AS (
  SELECT a.user_id, a.currency, a.occurred_at, a.stripe_event_id, a.plan_id, a.d AS delta_cents,
    a.after_cents, a.after_cents - a.d AS before_cents,
    coalesce(max(a.after_cents) OVER (PARTITION BY a.user_id, a.currency ORDER BY a.occurred_at, a.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS max_prior_after_cents
  FROM acct a
)
SELECT user_id, currency, occurred_at, stripe_event_id, plan_id, delta_cents, before_cents, after_cents,
  CASE
    WHEN before_cents = 0 AND after_cents > 0 AND max_prior_after_cents = 0 THEN 'new'
    WHEN before_cents = 0 AND after_cents > 0 THEN 'reactivation'
    WHEN before_cents > 0 AND after_cents = 0 THEN 'churn'
    WHEN after_cents > before_cents THEN 'expansion'
    ELSE 'contraction'
  END AS movement
FROM x WHERE delta_cents <> 0;

REVOKE ALL ON public.growth_mrr_movements_v FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_growth_mrr_bridge(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_email text; v_start timestamptz; v_end timestamptz; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 800 THEN
    RAISE EXCEPTION 'invalid_range' USING ERRCODE = '22023';
  END IF;
  v_start := p_from::timestamptz;
  v_end := (p_to + 1)::timestamptz;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid() AND l.action = 'explorer_list'
      AND l.metadata ->> 'view' = 'growth_mrr_bridge' AND l.created_at > now() - interval '1 minute'
  ) THEN
    INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
    VALUES (auth.uid(), v_email, 'explorer_list', jsonb_build_object('view', 'growth_mrr_bridge'));
  END IF;

  WITH m AS (SELECT * FROM growth_mrr_movements_v),
  opening AS (
    SELECT DISTINCT ON (user_id, currency) user_id, currency, after_cents FROM m
    WHERE occurred_at < v_start ORDER BY user_id, currency, occurred_at DESC, stripe_event_id DESC
  ),
  closing AS (
    SELECT DISTINCT ON (user_id, currency) user_id, currency, after_cents FROM m
    WHERE occurred_at < v_end ORDER BY user_id, currency, occurred_at DESC, stripe_event_id DESC
  ),
  cohort AS (
    SELECT o.user_id, o.currency, o.after_cents AS open_c, coalesce(c.after_cents, 0) AS close_c
    FROM opening o LEFT JOIN closing c USING (user_id, currency) WHERE o.after_cents > 0
  ),
  per_cur AS (SELECT currency FROM m GROUP BY currency)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'currency', pc.currency,
    'opening_mrr_cents', coalesce((SELECT sum(after_cents) FROM opening o WHERE o.currency = pc.currency), 0),
    'closing_mrr_cents', coalesce((SELECT sum(after_cents) FROM closing c WHERE c.currency = pc.currency), 0),
    'movements', (
      SELECT coalesce(jsonb_object_agg(k.movement, jsonb_build_object('cents', k.cents, 'n', k.n)), '{}'::jsonb)
      FROM (SELECT movement, sum(abs(delta_cents)) AS cents, count(*) AS n FROM m
            WHERE currency = pc.currency AND occurred_at >= v_start AND occurred_at < v_end GROUP BY movement) k),
    'cohort_n', (SELECT count(*) FROM cohort WHERE currency = pc.currency),
    'cohort_opening_cents', coalesce((SELECT sum(open_c) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_closing_cents', coalesce((SELECT sum(close_c) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_retained_floor_cents', coalesce((SELECT sum(least(open_c, close_c)) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_churned_n', (SELECT count(*) FROM cohort WHERE currency = pc.currency AND close_c = 0)
  ) ORDER BY pc.currency), '[]'::jsonb)
  INTO v_result FROM per_cur pc;

  RETURN jsonb_build_object('generated_at', now(), 'from', p_from, 'to', p_to, 'by_currency', v_result);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_data_quality()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'generated_at', now(),
    'subscription_events_total_90d', (SELECT count(*) FROM billing_events
       WHERE event_type LIKE 'customer.subscription.%' AND created_at > now() - interval '90 days'),
    'subscription_events_without_fact_90d', (SELECT count(*) FROM billing_events e
       WHERE e.event_type IN ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted')
         AND e.created_at > now() - interval '90 days'
         AND NOT EXISTS (SELECT 1 FROM subscription_facts f WHERE f.stripe_event_id = e.stripe_event_id)),
    'has_subscription_created_events', EXISTS (SELECT 1 FROM billing_events WHERE event_type = 'customer.subscription.created'),
    'profiles_with_subscription_but_no_fact', (SELECT count(*) FROM profiles p
       WHERE p.stripe_subscription_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM subscription_facts f WHERE f.stripe_subscription_id = p.stripe_subscription_id)),
    'paying_facts_without_plan', (SELECT count(*) FROM subscription_facts WHERE mrr_cents > 0 AND plan_id IS NULL),
    'prices_without_plan_map', (SELECT count(DISTINCT stripe_price_id) FROM subscription_facts f
       WHERE f.stripe_price_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM growth_price_plan_map m WHERE m.stripe_price_id = f.stripe_price_id)),
    'facts_with_unresolved_discount', (SELECT count(*) FROM subscription_facts WHERE discount_unresolved),
    'distinct_currencies', (SELECT count(DISTINCT currency) FROM subscription_facts WHERE currency IS NOT NULL),
    'unsupported_interval_active', (SELECT count(*) FROM subscription_facts
       WHERE status IN ('active','past_due') AND billing_interval IS NULL),
    'stripe_live_reconciliation', 'not_implemented'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.growth_apply_billing_event(text,text,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_ingest_billing_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_backfill_subscription_facts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_growth_mrr_bridge(date,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_growth_data_quality() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_growth_mrr_bridge(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_growth_data_quality() TO authenticated;
