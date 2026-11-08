/*
  # Growth analytics, part 2 — attribution, spend, activation, trials, cohorts, plans, churn reasons,
  # acquisition (CAC inputs), experiments, alerts, digest snapshot, reconciliation log

  REQUIRES 20281103000000_growth_analytics_core.sql (subscription_facts, growth_mrr_movements_v).
  Additive only. The one CREATE OR REPLACE of an object from part 1 is staff_growth_mrr_bridge, which becomes a
  thin wrapper over the shared growth_period_summary() so the digest, alerts and dashboard use ONE definition.

  ## Security
  - Every new table: RLS enabled, no client policies, all privileges revoked from anon/authenticated.
  - Staff RPCs: SECURITY DEFINER + is_vireek_staff + audit row in staff_audit_log (action 'explorer_list' is the only
    value the existing CHECK allows; the view/op live in metadata). Reads are audited at most once a minute per view;
    writes are always audited.
  - record_signup_attribution / growth_get_variant: callable by authenticated users, only ever touch the CALLER'S
    OWN account, inputs are validated against strict patterns.
  - Service-role-only: growth_evaluate_alerts, growth_digest_snapshot, growth_period_summary.
  - No transcripts, phone numbers, emails or free-text churn details are returned by any growth RPC.

  ## Privacy
  growth_attribution is only written when the browser sends it, and the browser only sends it after analytics consent
  (src/lib/growth/growthAttribution.ts). No row => channel 'unknown' in reports.

  ## Rollback (reverse order)
    DROP FUNCTION IF EXISTS public.staff_growth_reconciliation_latest(), public.staff_growth_alerts_list(),
      public.staff_growth_alert_ack(uuid), public.staff_growth_alert_rule_set(text,boolean,numeric),
      public.growth_digest_snapshot(), public.growth_evaluate_alerts(), public._growth_fire_alert(text,numeric,jsonb),
      public.growth_primary_currency(), public.staff_growth_experiment_results(text),
      public.staff_growth_experiment_transition(text,text,text,boolean),
      public.staff_growth_experiment_create(text,text,text,text,integer,text,integer,numeric),
      public.staff_growth_experiments_list(), public.growth_get_variant(text),
      public.staff_growth_acquisition(date,date), public.staff_growth_churn_reasons(date,date),
      public.staff_growth_plans(date,date), public.staff_growth_retention_cohorts(integer),
      public.staff_growth_trials(date,date), public.staff_growth_activation(date,date),
      public.staff_growth_spend_delete(uuid), public.staff_growth_spend_upsert(text,date,bigint,text,text),
      public.staff_growth_spend_list(date,date), public.record_signup_attribution(text,text,text,text),
      public.growth_clean_token(text,integer), public._growth_assert_staff(text,text);
    DROP TABLE IF EXISTS public.growth_reconciliation_runs, public.growth_digest_log, public.growth_alert_events,
      public.growth_alert_rules, public.growth_experiment_assignments, public.growth_experiments,
      public.growth_marketing_spend, public.growth_attribution;
    (re-run part 1 to restore the original staff_growth_mrr_bridge body, or leave the wrapper.)
*/

-- =====================================================================
-- Helpers
-- =====================================================================
CREATE OR REPLACE FUNCTION public._growth_assert_staff(p_view text, p_op text DEFAULT 'read')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_email text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_op = 'read' AND EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid() AND l.action = 'explorer_list'
      AND l.metadata ->> 'view' = p_view AND l.metadata ->> 'op' = 'read'
      AND l.created_at > now() - interval '1 minute'
  ) THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
  VALUES (auth.uid(), v_email, 'explorer_list', jsonb_build_object('view', p_view, 'op', p_op));
END;
$$;

CREATE OR REPLACE FUNCTION public._growth_assert_range(p_from date, p_to date)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 800 THEN
    RAISE EXCEPTION 'invalid_range' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.growth_clean_token(p text, p_max integer DEFAULT 64)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN char_length(btrim(p)) BETWEEN 1 AND p_max AND lower(btrim(p)) ~ '^[a-z0-9][a-z0-9._~-]*$' THEN lower(btrim(p))
    ELSE NULL
  END;
$$;

-- =====================================================================
-- Shared period summary (replaces the inline query of part 1's bridge)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.growth_period_summary(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  WITH m AS (SELECT * FROM growth_mrr_movements_v),
  opening AS (
    SELECT DISTINCT ON (user_id, currency) user_id, currency, after_cents FROM m
    WHERE occurred_at < p_start ORDER BY user_id, currency, occurred_at DESC, stripe_event_id DESC
  ),
  closing AS (
    SELECT DISTINCT ON (user_id, currency) user_id, currency, after_cents FROM m
    WHERE occurred_at < p_end ORDER BY user_id, currency, occurred_at DESC, stripe_event_id DESC
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
            WHERE currency = pc.currency AND occurred_at >= p_start AND occurred_at < p_end GROUP BY movement) k),
    'cohort_n', (SELECT count(*) FROM cohort WHERE currency = pc.currency),
    'cohort_opening_cents', coalesce((SELECT sum(open_c) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_closing_cents', coalesce((SELECT sum(close_c) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_retained_floor_cents', coalesce((SELECT sum(least(open_c, close_c)) FROM cohort WHERE currency = pc.currency), 0),
    'cohort_churned_n', (SELECT count(*) FROM cohort WHERE currency = pc.currency AND close_c = 0)
  ) ORDER BY pc.currency), '[]'::jsonb)
  INTO v_result FROM per_cur pc;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_mrr_bridge(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_mrr_bridge');
  PERFORM public._growth_assert_range(p_from, p_to);
  RETURN jsonb_build_object(
    'generated_at', now(), 'from', p_from, 'to', p_to,
    'by_currency', public.growth_period_summary(p_from::timestamptz, (p_to + 1)::timestamptz)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.growth_primary_currency()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT currency FROM (
    SELECT currency, sum(mrr_cents) AS mrr
    FROM (SELECT DISTINCT ON (stripe_subscription_id) currency, mrr_cents FROM subscription_facts
          ORDER BY stripe_subscription_id, occurred_at DESC, id DESC) l
    WHERE currency IS NOT NULL GROUP BY currency ORDER BY mrr DESC LIMIT 1
  ) x;
$$;

-- =====================================================================
-- Attribution (consent-gated on the client; first-touch, insert-once)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.growth_attribution (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel ~ '^[a-z0-9][a-z0-9._~-]*$'),
  utm_source text, utm_medium text, utm_campaign text, referrer_host text,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.growth_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_attribution FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_signup_attribution(
  p_source text, p_medium text, p_campaign text, p_referrer_host text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid(); v_src text; v_med text; v_cam text; v_ref text; v_channel text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000'; END IF;
  -- attribution belongs to the account owner and only within a week of signup
  IF public.get_account_owner_id() IS DISTINCT FROM v_uid THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.created_at > now() - interval '7 days') THEN RETURN false; END IF;
  v_src := public.growth_clean_token(p_source);
  v_med := public.growth_clean_token(p_medium);
  v_cam := public.growth_clean_token(p_campaign, 100);
  v_ref := public.growth_clean_token(p_referrer_host, 100);
  v_channel := coalesce(v_src, CASE WHEN v_ref IS NOT NULL THEN 'referral' END, 'direct');
  INSERT INTO growth_attribution (user_id, channel, utm_source, utm_medium, utm_campaign, referrer_host)
  VALUES (v_uid, v_channel, v_src, v_med, v_cam, v_ref)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN FOUND;
END;
$$;

-- =====================================================================
-- Manual marketing spend (staff input; one row per channel/month/currency)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.growth_marketing_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel ~ '^[a-z0-9][a-z0-9._~-]{0,63}$'),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000000),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, month, currency)
);
ALTER TABLE public.growth_marketing_spend ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_marketing_spend FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_growth_spend_list(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_spend');
  PERFORM public._growth_assert_range(p_from, p_to);
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', s.id, 'channel', s.channel, 'month', s.month,
      'amount_cents', s.amount_cents, 'currency', s.currency, 'note', s.note) ORDER BY s.month DESC, s.channel)
    FROM growth_marketing_spend s
    WHERE s.month >= date_trunc('month', p_from)::date AND s.month <= p_to
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_spend_upsert(
  p_channel text, p_month date, p_amount_cents bigint, p_currency text, p_note text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_id uuid; v_ch text := public.growth_clean_token(p_channel); v_cur text := lower(btrim(coalesce(p_currency, '')));
BEGIN
  PERFORM public._growth_assert_staff('growth_spend', 'write');
  IF v_ch IS NULL THEN RAISE EXCEPTION 'invalid_channel' USING ERRCODE = '22023'; END IF;
  IF p_month IS NULL OR p_amount_cents IS NULL OR p_amount_cents < 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023'; END IF;
  INSERT INTO growth_marketing_spend (channel, month, amount_cents, currency, note, created_by)
  VALUES (v_ch, date_trunc('month', p_month)::date, p_amount_cents, v_cur, nullif(btrim(p_note), ''), auth.uid())
  ON CONFLICT (channel, month, currency)
  DO UPDATE SET amount_cents = EXCLUDED.amount_cents, note = EXCLUDED.note, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_spend_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_spend', 'write');
  DELETE FROM growth_marketing_spend WHERE id = p_id;
  RETURN FOUND;
END;
$$;

-- =====================================================================
-- Activation funnel (measured events only; no persona data exists yet)
--   activated  = first REAL call (>=20s, not the guided test call)
--   deeper     = first job created from a real call
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_activation(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_activation');
  PERFORM public._growth_assert_range(p_from, p_to);
  WITH test_calls AS (SELECT call_id FROM first_call_sessions WHERE call_id IS NOT NULL),
  owners AS (
    SELECT p.id, p.created_at FROM profiles p
    WHERE p.role = 'owner' AND p.created_at >= p_from::timestamptz AND p.created_at < (p_to + 1)::timestamptz
  ),
  rec AS (
    SELECT o.created_at AS signup_at,
      (SELECT min(f.answered_at) FROM first_call_sessions f WHERE f.user_id = o.id AND f.answered_at IS NOT NULL) AS test_call_answered_at,
      (SELECT min(c.call_datetime) FROM calls c
        WHERE c.user_id = o.id AND coalesce(c.duration_seconds, 0) >= 20
          AND c.id NOT IN (SELECT call_id FROM test_calls)) AS real_call_at,
      (SELECT min(j.created_at) FROM jobs j
        WHERE j.user_id = o.id AND j.call_id IS NOT NULL
          AND j.call_id NOT IN (SELECT call_id FROM test_calls)) AS booking_at,
      (SELECT a.channel FROM growth_attribution a WHERE a.user_id = o.id) AS channel
    FROM owners o
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'signups', (SELECT count(*) FROM rec),
    'test_call_answered', (SELECT count(*) FROM rec WHERE test_call_answered_at IS NOT NULL),
    'real_call', (SELECT count(*) FROM rec WHERE real_call_at IS NOT NULL),
    'booking', (SELECT count(*) FROM rec WHERE booking_at IS NOT NULL),
    'truncated', (SELECT count(*) > 5000 FROM rec),
    'records', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'signup_at', r.signup_at, 'test_call_answered_at', r.test_call_answered_at,
        'real_call_at', r.real_call_at, 'booking_at', r.booking_at, 'channel', r.channel) ORDER BY r.signup_at)
      FROM (SELECT * FROM rec ORDER BY signup_at LIMIT 5000) r
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- =====================================================================
-- Trials (one record per subscription that has a trial)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_trials(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_trials');
  PERFORM public._growth_assert_range(p_from, p_to);
  WITH s AS (
    SELECT f.stripe_subscription_id, f.user_id,
      coalesce(min(f.trial_start), min(f.occurred_at)) AS trial_start,
      max(f.trial_end) AS trial_end,
      min(f.occurred_at) FILTER (WHERE f.mrr_cents > 0) AS converted_at
    FROM subscription_facts f
    GROUP BY f.stripe_subscription_id, f.user_id
    HAVING max(f.trial_end) IS NOT NULL
       AND coalesce(min(f.trial_start), min(f.occurred_at)) >= p_from::timestamptz
       AND coalesce(min(f.trial_start), min(f.occurred_at)) < (p_to + 1)::timestamptz
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'truncated', (SELECT count(*) > 5000 FROM s),
    'records', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'trial_start', x.trial_start, 'trial_end', x.trial_end, 'converted_at', x.converted_at,
        'channel', coalesce(a.channel, 'unknown'), 'cohort_month', date_trunc('month', x.trial_start)::date
      ) ORDER BY x.trial_start)
      FROM (SELECT * FROM s ORDER BY trial_start LIMIT 5000) x
      LEFT JOIN growth_attribution a ON a.user_id = x.user_id
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- =====================================================================
-- Retention cohorts (paying accounts by month of first payment; computed on read, never stale)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_retention_cohorts(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_months integer := least(greatest(coalesce(p_months, 12), 1), 24); v_rows jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_cohorts');
  WITH first_paid AS (
    SELECT user_id, currency, min(occurred_at) AS first_at
    FROM growth_mrr_movements_v WHERE movement = 'new' GROUP BY user_id, currency
  ),
  cohorts AS (
    SELECT user_id, currency, date_trunc('month', first_at)::date AS cohort_month
    FROM first_paid
    WHERE first_at >= (date_trunc('month', now()) - make_interval(months => v_months))
  ),
  grid AS (
    SELECT c.user_id, c.currency, c.cohort_month, k.k,
      ((c.cohort_month + make_interval(months => k.k + 1))::date)::timestamptz AS boundary
    FROM cohorts c CROSS JOIN generate_series(0, v_months) AS k(k)
    WHERE (c.cohort_month + make_interval(months => k.k))::date <= date_trunc('month', now())::date
  ),
  state AS (
    SELECT g.*, coalesce((
      SELECT v.after_cents FROM growth_mrr_movements_v v
      WHERE v.user_id = g.user_id AND v.currency = g.currency AND v.occurred_at < g.boundary
      ORDER BY v.occurred_at DESC, v.stripe_event_id DESC LIMIT 1), 0) AS mrr
    FROM grid g
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'cohort_month', cohort_month, 'currency', currency, 'offset', k,
    'cohort_size', n, 'active_n', active_n, 'mrr_cents', mrr_sum,
    'is_partial', boundary > now()
  ) ORDER BY cohort_month, currency, k), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT cohort_month, currency, k, boundary, count(*) AS n, count(*) FILTER (WHERE mrr > 0) AS active_n, sum(mrr) AS mrr_sum
    FROM state GROUP BY cohort_month, currency, k, boundary
  ) t;
  RETURN jsonb_build_object('generated_at', now(), 'rows', v_rows);
END;
$$;

-- =====================================================================
-- Plan mix and upgrade/downgrade paths
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_plans(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_mix jsonb; v_paths jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_plans');
  PERFORM public._growth_assert_range(p_from, p_to);
  WITH latest AS (
    SELECT DISTINCT ON (stripe_subscription_id) * FROM subscription_facts
    ORDER BY stripe_subscription_id, occurred_at DESC, id DESC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'plan_id', plan_id, 'currency', currency, 'paying_n', paying_n, 'trialing_n', trialing_n, 'mrr_cents', mrr
  ) ORDER BY mrr DESC, plan_id), '[]'::jsonb)
  INTO v_mix
  FROM (
    SELECT coalesce(plan_id, 'unmapped') AS plan_id, currency,
      count(*) FILTER (WHERE status IN ('active', 'past_due')) AS paying_n,
      count(*) FILTER (WHERE status = 'trialing') AS trialing_n,
      coalesce(sum(mrr_cents), 0) AS mrr
    FROM latest GROUP BY coalesce(plan_id, 'unmapped'), currency
  ) m;

  WITH steps AS (
    SELECT occurred_at, currency, plan_id, mrr_cents,
      lag(plan_id) OVER w AS prev_plan, lag(mrr_cents) OVER w AS prev_mrr
    FROM subscription_facts
    WINDOW w AS (PARTITION BY stripe_subscription_id ORDER BY occurred_at, id)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'from_plan', from_plan, 'to_plan', to_plan, 'currency', currency, 'kind', kind, 'n', n, 'delta_cents', delta
  ) ORDER BY n DESC, from_plan, to_plan), '[]'::jsonb)
  INTO v_paths
  FROM (
    SELECT coalesce(prev_plan, 'unmapped') AS from_plan, coalesce(plan_id, 'unmapped') AS to_plan, currency,
      CASE WHEN mrr_cents > prev_mrr THEN 'upgrade' ELSE 'downgrade' END AS kind,
      count(*) AS n, sum(mrr_cents - prev_mrr) AS delta
    FROM steps
    WHERE prev_mrr > 0 AND mrr_cents > 0 AND plan_id IS DISTINCT FROM prev_plan
      AND occurred_at >= p_from::timestamptz AND occurred_at < (p_to + 1)::timestamptz
    GROUP BY coalesce(prev_plan, 'unmapped'), coalesce(plan_id, 'unmapped'), currency,
      CASE WHEN mrr_cents > prev_mrr THEN 'upgrade' ELSE 'downgrade' END
  ) p;
  RETURN jsonb_build_object('generated_at', now(), 'mix', v_mix, 'paths', v_paths);
END;
$$;

-- =====================================================================
-- Churn reasons (from the cancel flow; free-text details are never returned)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_churn_reasons(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_churn_reasons');
  PERFORM public._growth_assert_range(p_from, p_to);
  RETURN jsonb_build_object(
    'generated_at', now(),
    'actions', coalesce((
      SELECT jsonb_object_agg(action, n) FROM (
        SELECT action, count(*) AS n FROM subscription_cancellations
        WHERE created_at >= p_from::timestamptz AND created_at < (p_to + 1)::timestamptz GROUP BY action) a
    ), '{}'::jsonb),
    'reasons', coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', reason, 'n', n) ORDER BY n DESC, reason) FROM (
        SELECT coalesce(reason, 'unspecified') AS reason, count(*) AS n FROM subscription_cancellations
        WHERE action = 'cancel_scheduled'
          AND created_at >= p_from::timestamptz AND created_at < (p_to + 1)::timestamptz
        GROUP BY coalesce(reason, 'unspecified')) r
    ), '[]'::jsonb)
  );
END;
$$;

-- =====================================================================
-- Acquisition: new paying customers + manual spend by channel (CAC inputs) and ARPA inputs
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_growth_acquisition(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_channels jsonb; v_current jsonb; v_cov jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_acquisition');
  PERFORM public._growth_assert_range(p_from, p_to);
  WITH new_m AS (
    SELECT v.currency, v.delta_cents, coalesce(a.channel, 'unknown') AS channel, (a.user_id IS NOT NULL) AS attributed
    FROM growth_mrr_movements_v v LEFT JOIN growth_attribution a ON a.user_id = v.user_id
    WHERE v.movement = 'new' AND v.occurred_at >= p_from::timestamptz AND v.occurred_at < (p_to + 1)::timestamptz
  ),
  agg AS (SELECT channel, currency, count(*) AS n, sum(delta_cents) AS mrr FROM new_m GROUP BY channel, currency),
  sp AS (
    SELECT channel, currency, sum(amount_cents) AS spend FROM growth_marketing_spend
    WHERE month >= date_trunc('month', p_from)::date AND month <= p_to GROUP BY channel, currency
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'channel', coalesce(agg.channel, sp.channel), 'currency', coalesce(agg.currency, sp.currency),
    'new_customers', coalesce(agg.n, 0), 'new_mrr_cents', coalesce(agg.mrr, 0), 'spend_cents', sp.spend
  ) ORDER BY coalesce(agg.n, 0) DESC, coalesce(agg.channel, sp.channel)), '[]'::jsonb)
  INTO v_channels
  FROM agg FULL OUTER JOIN sp ON sp.channel = agg.channel AND sp.currency = agg.currency;

  SELECT jsonb_build_object(
    'new_customers_total', count(*), 'new_customers_attributed', count(*) FILTER (WHERE attributed))
  INTO v_cov FROM (
    SELECT (a.user_id IS NOT NULL) AS attributed
    FROM growth_mrr_movements_v v LEFT JOIN growth_attribution a ON a.user_id = v.user_id
    WHERE v.movement = 'new' AND v.occurred_at >= p_from::timestamptz AND v.occurred_at < (p_to + 1)::timestamptz) c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'currency', currency, 'paying_accounts', paying, 'mrr_cents', mrr) ORDER BY currency), '[]'::jsonb)
  INTO v_current
  FROM (
    SELECT currency, count(*) FILTER (WHERE mrr_cents > 0) AS paying, sum(mrr_cents) AS mrr FROM (
      SELECT user_id, currency, sum(mrr_cents) AS mrr_cents FROM (
        SELECT DISTINCT ON (stripe_subscription_id) user_id, currency, mrr_cents FROM subscription_facts
        ORDER BY stripe_subscription_id, occurred_at DESC, id DESC) l
      WHERE currency IS NOT NULL GROUP BY user_id, currency) acct
    GROUP BY currency) z;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'spend_period_aligned', (p_from = date_trunc('month', p_from)::date
                             AND p_to = (date_trunc('month', p_to) + interval '1 month - 1 day')::date),
    'history_start', (SELECT min(occurred_at) FROM subscription_facts),
    'channels', v_channels, 'coverage', v_cov, 'current', v_current
  );
END;
$$;

-- =====================================================================
-- Experiments (tenant-level, deterministic, sticky; exposure logged on first assignment)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.growth_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  hypothesis text NOT NULL CHECK (char_length(btrim(hypothesis)) BETWEEN 10 AND 1000),
  surface text NOT NULL CHECK (surface IN ('onboarding', 'trial', 'pricing')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'concluded', 'archived')),
  treatment_share integer NOT NULL DEFAULT 50 CHECK (treatment_share BETWEEN 5 AND 95),
  primary_metric text NOT NULL CHECK (primary_metric IN ('activated_7d', 'trial_to_paid')),
  min_runtime_days integer NOT NULL DEFAULT 14 CHECK (min_runtime_days BETWEEN 7 AND 90),
  alpha numeric(4, 3) NOT NULL DEFAULT 0.050 CHECK (alpha IN (0.010, 0.050, 0.100)),
  price_integrity_confirmed boolean NOT NULL DEFAULT false,
  approved_by uuid,
  started_at timestamptz,
  ended_at timestamptz,
  decision text CHECK (decision IS NULL OR decision IN ('adopt', 'iterate', 'reject')),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('running', 'concluded') OR started_at IS NOT NULL),
  CHECK (surface <> 'pricing' OR status NOT IN ('running', 'concluded') OR (price_integrity_confirmed AND approved_by IS NOT NULL)),
  CHECK (status <> 'concluded' OR decision IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.growth_experiment_assignments (
  experiment_id uuid NOT NULL REFERENCES public.growth_experiments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  arm text NOT NULL CHECK (arm IN ('control', 'treatment')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_growth_assign_tenant ON public.growth_experiment_assignments (tenant_id);
ALTER TABLE public.growth_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_experiment_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_experiments, public.growth_experiment_assignments FROM anon, authenticated;

-- Returns 'control' | 'treatment', or NULL when the caller is not part of the experiment (show the default UI).
CREATE OR REPLACE FUNCTION public.growth_get_variant(p_key text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_t uuid; e public.growth_experiments%ROWTYPE; v_arm text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000'; END IF;
  v_t := public.get_account_owner_id();
  SELECT * INTO e FROM growth_experiments WHERE key = p_key AND status = 'running';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT x.arm INTO v_arm FROM growth_experiment_assignments x WHERE x.experiment_id = e.id AND x.tenant_id = v_t;
  IF v_arm IS NOT NULL THEN RETURN v_arm; END IF;
  -- Only NEW accounts enter onboarding/trial tests; pricing tests exclude existing paying customers.
  IF e.surface IN ('onboarding', 'trial')
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_t AND p.created_at >= e.started_at) THEN RETURN NULL; END IF;
  IF e.surface = 'pricing'
     AND EXISTS (SELECT 1 FROM subscription_facts f WHERE f.user_id = v_t AND f.mrr_cents > 0) THEN RETURN NULL; END IF;
  v_arm := CASE WHEN public.feature_flag_bucket(v_t, 'exp:' || e.key) < e.treatment_share THEN 'treatment' ELSE 'control' END;
  INSERT INTO growth_experiment_assignments (experiment_id, tenant_id, arm) VALUES (e.id, v_t, v_arm)
  ON CONFLICT (experiment_id, tenant_id) DO NOTHING;
  RETURN v_arm;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_experiments_list()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_experiments');
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'key', e.key, 'name', e.name, 'hypothesis', e.hypothesis, 'surface', e.surface, 'status', e.status,
      'treatment_share', e.treatment_share, 'primary_metric', e.primary_metric,
      'min_runtime_days', e.min_runtime_days, 'alpha', e.alpha, 'started_at', e.started_at,
      'ended_at', e.ended_at, 'decision', e.decision,
      'assigned', (SELECT count(*) FROM growth_experiment_assignments x WHERE x.experiment_id = e.id)
    ) ORDER BY e.created_at DESC) FROM growth_experiments e), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_experiment_create(
  p_key text, p_name text, p_hypothesis text, p_surface text, p_treatment_share integer,
  p_primary_metric text, p_min_runtime_days integer, p_alpha numeric
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public._growth_assert_staff('growth_experiments', 'write');
  INSERT INTO growth_experiments (key, name, hypothesis, surface, treatment_share, primary_metric, min_runtime_days, alpha)
  VALUES (p_key, p_name, p_hypothesis, p_surface, coalesce(p_treatment_share, 50), p_primary_metric,
          coalesce(p_min_runtime_days, 14), coalesce(p_alpha, 0.05))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- draft->running, running->concluded (needs decision), draft|concluded->archived. Nothing else.
CREATE OR REPLACE FUNCTION public.staff_growth_experiment_transition(
  p_key text, p_to text, p_decision text DEFAULT NULL, p_price_integrity boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE e public.growth_experiments%ROWTYPE;
BEGIN
  PERFORM public._growth_assert_staff('growth_experiments', 'write');
  SELECT * INTO e FROM growth_experiments WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF e.status = 'draft' AND p_to = 'running' THEN
    IF e.surface = 'pricing' AND NOT coalesce(p_price_integrity, false) THEN
      RAISE EXCEPTION 'price_integrity_required' USING ERRCODE = '22023';
    END IF;
    UPDATE growth_experiments SET status = 'running', started_at = now(), approved_by = auth.uid(),
      price_integrity_confirmed = (e.surface = 'pricing' AND p_price_integrity), updated_at = now() WHERE id = e.id;
  ELSIF e.status = 'running' AND p_to = 'concluded' THEN
    IF p_decision IS NULL OR p_decision NOT IN ('adopt', 'iterate', 'reject') THEN RAISE EXCEPTION 'decision_required' USING ERRCODE = '22023'; END IF;
    UPDATE growth_experiments SET status = 'concluded', decision = p_decision, ended_at = now(), updated_at = now() WHERE id = e.id;
  ELSIF e.status IN ('draft', 'concluded') AND p_to = 'archived' THEN
    UPDATE growth_experiments SET status = 'archived', updated_at = now() WHERE id = e.id;
  ELSE
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;
  RETURN p_to;
END;
$$;

-- Raw per-arm counts only; all inference (p-values, SRM, guardrail verdicts) lives in src/lib/growth/growthExperiments.ts.
CREATE OR REPLACE FUNCTION public.staff_growth_experiment_results(p_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE e public.growth_experiments%ROWTYPE; v_arms jsonb;
BEGIN
  PERFORM public._growth_assert_staff('growth_experiment_results');
  SELECT * INTO e FROM growth_experiments WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  WITH test_calls AS (SELECT call_id FROM first_call_sessions WHERE call_id IS NOT NULL),
  a AS (SELECT x.arm, x.tenant_id, x.assigned_at FROM growth_experiment_assignments x WHERE x.experiment_id = e.id),
  t AS (
    SELECT a.arm, a.tenant_id,
      (a.assigned_at <= now() - interval '7 days') AS act_matured,
      EXISTS (SELECT 1 FROM calls c WHERE c.user_id = a.tenant_id AND coalesce(c.duration_seconds, 0) >= 20
              AND c.id NOT IN (SELECT call_id FROM test_calls)
              AND c.call_datetime >= a.assigned_at AND c.call_datetime <= a.assigned_at + interval '7 days') AS activated,
      tr.trial_end, tr.converted_at,
      EXISTS (SELECT 1 FROM subscription_facts f WHERE f.user_id = a.tenant_id AND f.mrr_cents > 0 AND f.occurred_at >= a.assigned_at) AS paying,
      EXISTS (SELECT 1 FROM subscription_cancellations s WHERE s.user_id = a.tenant_id AND s.action = 'cancel_scheduled' AND s.created_at >= a.assigned_at) AS cancel_req
    FROM a
    LEFT JOIN LATERAL (
      SELECT max(f.trial_end) AS trial_end, min(f.occurred_at) FILTER (WHERE f.mrr_cents > 0) AS converted_at
      FROM subscription_facts f WHERE f.user_id = a.tenant_id AND f.trial_end IS NOT NULL AND f.occurred_at >= a.assigned_at - interval '1 day'
    ) tr ON true
  )
  SELECT coalesce(jsonb_object_agg(arm, jsonb_build_object(
    'assigned', n,
    'activation_n', act_n, 'activation_k', act_k,
    'trial_n', tr_n, 'trial_k', tr_k,
    'paying_n', pay_n, 'cancel_k', cancel_k
  )), '{}'::jsonb) INTO v_arms
  FROM (
    SELECT arm, count(*) AS n,
      count(*) FILTER (WHERE act_matured) AS act_n,
      count(*) FILTER (WHERE act_matured AND activated) AS act_k,
      count(*) FILTER (WHERE trial_end IS NOT NULL AND (converted_at IS NOT NULL AND converted_at <= trial_end + interval '3 days' OR trial_end + interval '3 days' <= now())) AS tr_n,
      count(*) FILTER (WHERE trial_end IS NOT NULL AND converted_at IS NOT NULL AND converted_at <= trial_end + interval '3 days') AS tr_k,
      count(*) FILTER (WHERE paying) AS pay_n,
      count(*) FILTER (WHERE paying AND cancel_req) AS cancel_k
    FROM t GROUP BY arm
  ) s;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'experiment', jsonb_build_object('key', e.key, 'status', e.status, 'treatment_share', e.treatment_share,
      'primary_metric', e.primary_metric, 'min_runtime_days', e.min_runtime_days, 'alpha', e.alpha,
      'started_at', e.started_at, 'ended_at', e.ended_at, 'surface', e.surface),
    'arms', v_arms
  );
END;
$$;

-- =====================================================================
-- Alerts, digest snapshot, reconciliation log
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.growth_alert_rules (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  description text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  threshold numeric NOT NULL CHECK (threshold >= 0),
  min_sample integer NOT NULL DEFAULT 30 CHECK (min_sample >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.growth_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL REFERENCES public.growth_alert_rules(key) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  value numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid
);
CREATE INDEX IF NOT EXISTS idx_growth_alert_open ON public.growth_alert_events (rule_key, fired_at DESC) WHERE acknowledged_at IS NULL;
CREATE TABLE IF NOT EXISTS public.growth_digest_log (
  week_start date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL DEFAULT 0,
  snapshot jsonb
);
CREATE TABLE IF NOT EXISTS public.growth_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  triggered_by text NOT NULL CHECK (triggered_by IN ('cron', 'staff')),
  staff_id uuid,
  stripe_subscriptions integer NOT NULL,
  mismatches integer NOT NULL,
  summary jsonb NOT NULL,
  details jsonb NOT NULL
);
ALTER TABLE public.growth_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_digest_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_reconciliation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_alert_rules, public.growth_alert_events, public.growth_digest_log, public.growth_reconciliation_runs FROM anon, authenticated;

INSERT INTO public.growth_alert_rules (key, description, threshold, min_sample) VALUES
  ('data_gap_events', 'Stripe subscription events (older than 1h) that produced no subscription fact', 0, 0),
  ('past_due_accounts', 'Accounts currently past_due (card failing)', 5, 0),
  ('mrr_churn_30d_pct', 'Churned MRR in the last 30 days as % of opening MRR (needs a minimum paying cohort)', 5, 30),
  ('no_new_paid_days', 'Days without any new paying customer (needs >=60 days of history)', 21, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._growth_fire_alert(p_key text, p_value numeric, p_details jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM growth_alert_events WHERE rule_key = p_key AND acknowledged_at IS NULL AND fired_at > now() - interval '7 days') THEN
    RETURN false;
  END IF;
  INSERT INTO growth_alert_events (rule_key, value, details) VALUES (p_key, p_value, coalesce(p_details, '{}'::jsonb));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.growth_evaluate_alerts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r public.growth_alert_rules%ROWTYPE; v numeric; v_fired integer := 0; v_cur text; s jsonb; v_hist integer;
BEGIN
  FOR r IN SELECT * FROM growth_alert_rules WHERE enabled LOOP
    v := NULL;
    IF r.key = 'data_gap_events' THEN
      SELECT count(*) INTO v FROM billing_events e
      WHERE e.event_type IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
        AND e.created_at > now() - interval '30 days' AND e.created_at < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM subscription_facts f WHERE f.stripe_event_id = e.stripe_event_id);
      IF v > r.threshold AND public._growth_fire_alert(r.key, v, jsonb_build_object('window_days', 30)) THEN v_fired := v_fired + 1; END IF;

    ELSIF r.key = 'past_due_accounts' THEN
      SELECT count(*) INTO v FROM profiles WHERE subscription_status = 'past_due';
      IF v >= r.threshold AND public._growth_fire_alert(r.key, v, '{}'::jsonb) THEN v_fired := v_fired + 1; END IF;

    ELSIF r.key = 'mrr_churn_30d_pct' THEN
      v_cur := public.growth_primary_currency();
      IF v_cur IS NOT NULL THEN
        SELECT e INTO s FROM jsonb_array_elements(public.growth_period_summary(now() - interval '30 days', now())) e WHERE e ->> 'currency' = v_cur;
        IF s IS NOT NULL AND (s ->> 'cohort_n')::integer >= r.min_sample AND (s ->> 'opening_mrr_cents')::numeric > 0 THEN
          v := round(100 * coalesce((s #>> '{movements,churn,cents}')::numeric, 0) / (s ->> 'opening_mrr_cents')::numeric, 2);
          IF v >= r.threshold AND public._growth_fire_alert(r.key, v, jsonb_build_object('currency', v_cur, 'cohort_n', (s ->> 'cohort_n')::integer)) THEN
            v_fired := v_fired + 1;
          END IF;
        END IF;
      END IF;

    ELSIF r.key = 'no_new_paid_days' THEN
      SELECT coalesce(extract(day FROM now() - min(occurred_at))::integer, 0) INTO v_hist FROM subscription_facts;
      IF v_hist >= 60 AND NOT EXISTS (
        SELECT 1 FROM growth_mrr_movements_v WHERE movement = 'new' AND occurred_at > now() - make_interval(days => r.threshold::integer)
      ) AND public._growth_fire_alert(r.key, r.threshold, jsonb_build_object('history_days', v_hist)) THEN
        v_fired := v_fired + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_fired;
END;
$$;

CREATE OR REPLACE FUNCTION public.growth_digest_snapshot()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'generated_at', now(),
    'primary_currency', public.growth_primary_currency(),
    'week', public.growth_period_summary(now() - interval '7 days', now()),
    'prior_week', public.growth_period_summary(now() - interval '14 days', now() - interval '7 days'),
    'last_30d', public.growth_period_summary(now() - interval '30 days', now()),
    'history_days', coalesce((SELECT extract(day FROM now() - min(occurred_at))::integer FROM subscription_facts), 0),
    'trials_in_flight', (SELECT count(*) FROM (
        SELECT DISTINCT ON (stripe_subscription_id) status FROM subscription_facts
        ORDER BY stripe_subscription_id, occurred_at DESC, id DESC) l WHERE status = 'trialing'),
    'trials_ending_7d', (SELECT count(*) FROM (
        SELECT DISTINCT ON (stripe_subscription_id) status, trial_end FROM subscription_facts
        ORDER BY stripe_subscription_id, occurred_at DESC, id DESC) l
        WHERE status = 'trialing' AND trial_end IS NOT NULL AND trial_end < now() + interval '7 days'),
    'past_due_accounts', (SELECT count(*) FROM profiles WHERE subscription_status = 'past_due'),
    'signups_7_14d', (SELECT count(*) FROM profiles WHERE role = 'owner' AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days'),
    'activated_of_signups_7_14d', (SELECT count(*) FROM profiles p WHERE p.role = 'owner'
        AND p.created_at >= now() - interval '14 days' AND p.created_at < now() - interval '7 days'
        AND EXISTS (SELECT 1 FROM calls c WHERE c.user_id = p.id AND coalesce(c.duration_seconds, 0) >= 20
          AND c.id NOT IN (SELECT call_id FROM first_call_sessions WHERE call_id IS NOT NULL)
          AND c.call_datetime <= p.created_at + interval '7 days')),
    'open_alerts', coalesce((SELECT jsonb_agg(jsonb_build_object('rule_key', a.rule_key, 'value', a.value, 'fired_at', a.fired_at) ORDER BY a.fired_at DESC)
        FROM growth_alert_events a WHERE a.acknowledged_at IS NULL), '[]'::jsonb),
    'events_without_fact_30d', (SELECT count(*) FROM billing_events e
        WHERE e.event_type IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
          AND e.created_at > now() - interval '30 days' AND e.created_at < now() - interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM subscription_facts f WHERE f.stripe_event_id = e.stripe_event_id)),
    'running_experiments', (SELECT count(*) FROM growth_experiments WHERE status = 'running')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_alerts_list()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_alerts');
  RETURN jsonb_build_object(
    'rules', coalesce((SELECT jsonb_agg(jsonb_build_object('key', r.key, 'description', r.description, 'enabled', r.enabled,
      'threshold', r.threshold, 'min_sample', r.min_sample) ORDER BY r.key) FROM growth_alert_rules r), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(x ORDER BY (x ->> 'fired_at') DESC) FROM (
      SELECT jsonb_build_object('id', e.id, 'rule_key', e.rule_key, 'value', e.value, 'fired_at', e.fired_at,
        'acknowledged_at', e.acknowledged_at) AS x FROM growth_alert_events e ORDER BY e.fired_at DESC LIMIT 50) q), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_alert_ack(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_alerts', 'write');
  UPDATE growth_alert_events SET acknowledged_at = now(), acknowledged_by = auth.uid() WHERE id = p_id AND acknowledged_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_alert_rule_set(p_key text, p_enabled boolean, p_threshold numeric)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_alerts', 'write');
  IF p_threshold IS NULL OR p_threshold < 0 THEN RAISE EXCEPTION 'invalid_threshold' USING ERRCODE = '22023'; END IF;
  UPDATE growth_alert_rules SET enabled = coalesce(p_enabled, enabled), threshold = p_threshold, updated_at = now() WHERE key = p_key;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_growth_reconciliation_latest()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._growth_assert_staff('growth_reconciliation');
  RETURN jsonb_build_object(
    'latest', (SELECT jsonb_build_object('id', r.id, 'ran_at', r.ran_at, 'triggered_by', r.triggered_by,
        'stripe_subscriptions', r.stripe_subscriptions, 'mismatches', r.mismatches, 'summary', r.summary, 'details', r.details)
      FROM growth_reconciliation_runs r ORDER BY r.ran_at DESC LIMIT 1),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object('ran_at', h.ran_at, 'mismatches', h.mismatches,
        'stripe_subscriptions', h.stripe_subscriptions) ORDER BY h.ran_at DESC)
      FROM (SELECT * FROM growth_reconciliation_runs ORDER BY ran_at DESC LIMIT 10) h), '[]'::jsonb)
  );
END;
$$;

-- =====================================================================
-- Privileges
-- =====================================================================
REVOKE ALL ON FUNCTION public._growth_assert_staff(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._growth_assert_range(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._growth_fire_alert(text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_period_summary(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_primary_currency() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_evaluate_alerts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_digest_snapshot() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.record_signup_attribution(text,text,text,text)',
    'public.growth_get_variant(text)',
    'public.staff_growth_mrr_bridge(date,date)',
    'public.staff_growth_spend_list(date,date)',
    'public.staff_growth_spend_upsert(text,date,bigint,text,text)',
    'public.staff_growth_spend_delete(uuid)',
    'public.staff_growth_activation(date,date)',
    'public.staff_growth_trials(date,date)',
    'public.staff_growth_retention_cohorts(integer)',
    'public.staff_growth_plans(date,date)',
    'public.staff_growth_churn_reasons(date,date)',
    'public.staff_growth_acquisition(date,date)',
    'public.staff_growth_experiments_list()',
    'public.staff_growth_experiment_create(text,text,text,text,integer,text,integer,numeric)',
    'public.staff_growth_experiment_transition(text,text,text,boolean)',
    'public.staff_growth_experiment_results(text)',
    'public.staff_growth_alerts_list()',
    'public.staff_growth_alert_ack(uuid)',
    'public.staff_growth_alert_rule_set(text,boolean,numeric)',
    'public.staff_growth_reconciliation_latest()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;

-- =====================================================================
-- Service-role helper for the Stripe reconciliation edge function: latest fact per subscription.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.growth_latest_facts()
RETURNS TABLE (stripe_subscription_id text, status text, mrr_cents bigint, currency text, discount_unresolved boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT DISTINCT ON (f.stripe_subscription_id) f.stripe_subscription_id, f.status, f.mrr_cents, f.currency, f.discount_unresolved
  FROM subscription_facts f
  ORDER BY f.stripe_subscription_id, f.occurred_at DESC, f.id DESC;
$$;
REVOKE ALL ON FUNCTION public.growth_latest_facts() FROM PUBLIC, anon, authenticated;
