/*
  # Revenue Causality Graph

  ## Why
  Answers "which breakdown in my funnel cost me money, and how much?":
  Missed Call -> Delayed Response -> Quote Delay -> Customer Hesitation
  -> Lost Job -> Lost LTV.

  This function only AGGREGATES this account's own history into speed
  buckets (counts + wins). The economic model (exposure, ranges, what-if
  scenarios) runs client-side in src/lib/revenueCausalityModel.ts so it is
  unit-tested and the scenario slider is instant.

  ## Design rules
  - Only "mature" opportunities (older than 14 days) are counted, so recent
    leads that simply haven't resolved yet don't read as losses.
  - Inbound opportunities = calls with status 'missed' or 'callback_requested'
    (calls already handled by the AI are excluded to avoid selection bias).
  - First touch = earliest lead created for that call/phone, or outbound
    call to that phone, within 14 days of the call.
  - Money is in dollars (jobs.invoice_amount); quote totals are converted
    from cents. Read-only against source tables; writes one cache row.
*/

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION public.rcg_phone_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 7
              THEN right(regexp_replace(p, '\D', '', 'g'), 10) END
$$;

CREATE OR REPLACE FUNCTION public.rcg_num(p text, d numeric DEFAULT 0)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p ~ '^-?[0-9]+(\.[0-9]+)?$' THEN p::numeric ELSE d END
$$;

-- ---------- cache table ----------
CREATE TABLE IF NOT EXISTS revenue_causality_snapshots (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  result jsonb,
  computed_at timestamptz
);

ALTER TABLE revenue_causality_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_causality_snapshots" ON revenue_causality_snapshots;
CREATE POLICY "select_own_revenue_causality_snapshots" ON revenue_causality_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy: only the SECURITY DEFINER RPC below writes here.

-- ---------- supporting indexes (no-ops if equivalents exist) ----------
CREATE INDEX IF NOT EXISTS idx_rcg_calls_user_status_dt ON calls(user_id, status, call_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_rcg_leads_user_created ON leads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rcg_quotes_user_sent ON quotes(user_id, sent_at DESC);

-- ---------- the engine ----------
CREATE OR REPLACE FUNCTION public.compute_revenue_causality_graph(p_days integer DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  v_from timestamptz;
  v_mature timestamptz := now() - interval '14 days';
  v_avg_job numeric;
  v_ltv_mult numeric;
  v_resp jsonb;
  v_quotes jsonb;
  v_lost integer;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  p_days := LEAST(GREATEST(COALESCE(p_days, 180), 30), 730);
  v_from := now() - make_interval(days => p_days);

  -- average completed job value (dollars)
  SELECT avg(invoice_amount) INTO v_avg_job
  FROM jobs
  WHERE user_id = v_user AND job_status = 'completed' AND invoice_amount > 0 AND created_at >= v_from;

  -- lifetime-value multiplier = avg customer LTV / avg job value (clamped 1..8, needs >= 10 profiles)
  SELECT CASE WHEN count(*) >= 10 AND v_avg_job > 0
              THEN LEAST(GREATEST(avg(lifetime_value_cents) / 100.0 / v_avg_job, 1), 8) END
  INTO v_ltv_mult
  FROM customer_ltv_profiles
  WHERE user_id = v_user AND completed_job_count >= 1;

  -- ===== Stage 1+2: missed calls -> response latency =====
  WITH lead_n AS (
    SELECT l.id, l.call_id, l.created_at, l.stage, public.rcg_phone_key(l.phone) AS ph
    FROM leads l
    WHERE l.user_id = v_user AND l.created_at >= v_from
  ),
  out_n AS (
    SELECT public.rcg_phone_key(oc.customer_phone) AS ph, oc.called_at AS t
    FROM outbound_calls oc
    WHERE oc.user_id = v_user AND oc.called_at IS NOT NULL AND oc.called_at >= v_from
  ),
  opp AS (
    SELECT c.id, c.call_datetime, c.status, public.rcg_phone_key(c.caller_phone) AS ph
    FROM calls c
    WHERE c.user_id = v_user
      AND c.call_datetime >= v_from AND c.call_datetime < v_mature
      AND c.status IN ('missed', 'callback_requested')
  ),
  enriched AS (
    SELECT o.id, o.status, o.call_datetime,
      (SELECT min(x.t) FROM (
          SELECT l.created_at AS t FROM lead_n l
          WHERE l.created_at >= o.call_datetime
            AND (l.call_id = o.id OR (o.ph IS NOT NULL AND l.ph = o.ph))
          UNION ALL
          SELECT u.t FROM out_n u
          WHERE o.ph IS NOT NULL AND u.ph = o.ph AND u.t >= o.call_datetime
        ) x
        WHERE x.t <= o.call_datetime + interval '14 days') AS touch_at,
      (EXISTS (SELECT 1 FROM lead_n l
               WHERE l.stage = 'won' AND l.created_at >= o.call_datetime
                 AND (l.call_id = o.id OR (o.ph IS NOT NULL AND l.ph = o.ph)))
       OR EXISTS (SELECT 1 FROM jobs j
                  WHERE j.user_id = v_user AND j.call_id = o.id AND j.job_status <> 'cancelled')) AS won
    FROM opp o
  ),
  bucketed AS (
    SELECT e.status, e.won,
      CASE
        WHEN e.touch_at IS NULL THEN 'never'
        WHEN extract(epoch FROM (e.touch_at - e.call_datetime)) / 3600.0 < 0.5 THEN 'lt_30m'
        WHEN extract(epoch FROM (e.touch_at - e.call_datetime)) / 3600.0 < 1 THEN '30m_1h'
        WHEN extract(epoch FROM (e.touch_at - e.call_datetime)) / 3600.0 < 4 THEN '1h_4h'
        WHEN extract(epoch FROM (e.touch_at - e.call_datetime)) / 3600.0 < 24 THEN '4h_24h'
        ELSE 'gte_24h'
      END AS bucket
    FROM enriched e
  ),
  agg AS (
    SELECT bucket, count(*) AS n, count(*) FILTER (WHERE won) AS wins
    FROM bucketed GROUP BY bucket
  )
  SELECT jsonb_build_object(
    'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', bucket, 'n', n, 'wins', wins)) FROM agg), '[]'::jsonb),
    'missed_total', (SELECT count(*) FROM calls
                      WHERE user_id = v_user AND status = 'missed' AND call_datetime >= v_from),
    'missed_unrecovered', (SELECT count(*) FROM bucketed WHERE status = 'missed' AND bucket = 'never')
  ) INTO v_resp;

  -- ===== Stage 3+4: quote delay -> customer hesitation =====
  WITH q AS (
    SELECT q.status, q.decline_reason, q.sent_at, q.responded_at,
      extract(epoch FROM (q.sent_at - l.created_at)) / 3600.0 AS delay_h,
      round(
        COALESCE((
          SELECT sum(public.rcg_num(li ->> 'quantity', 1) * public.rcg_num(li ->> 'unit_price_cents', 0))
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(q.line_items) = 'array' THEN q.line_items ELSE '[]'::jsonb END
          ) li
        ), 0) / 100.0 * (1 + COALESCE(q.tax_percent, 0) / 100.0), 2) AS total
    FROM quotes q
    JOIN leads l ON l.id = q.lead_id AND l.user_id = v_user
    WHERE q.user_id = v_user
      AND q.sent_at IS NOT NULL AND q.sent_at >= v_from AND q.sent_at >= l.created_at
      AND q.status IN ('accepted', 'declined', 'expired')
  ),
  b AS (
    SELECT
      CASE WHEN delay_h < 4 THEN 'lt_4h' WHEN delay_h < 24 THEN '4h_24h'
           WHEN delay_h < 72 THEN '24h_72h' ELSE 'gte_72h' END AS bucket,
      count(*) AS n,
      count(*) FILTER (WHERE status = 'accepted') AS wins,
      COALESCE(sum(total) FILTER (WHERE status = 'accepted'), 0) AS accepted_value,
      COALESCE(sum(total), 0) AS value_all
    FROM q GROUP BY 1
  ),
  reasons AS (
    SELECT btrim(decline_reason) AS reason, count(*) AS cnt, COALESCE(sum(total), 0) AS val
    FROM q
    WHERE status = 'declined' AND decline_reason IS NOT NULL AND btrim(decline_reason) <> ''
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 3
  )
  SELECT jsonb_build_object(
    'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', bucket, 'n', n, 'wins', wins,
        'accepted_value', round(accepted_value, 2), 'value_all', round(value_all, 2))) FROM b), '[]'::jsonb),
    'accepted', (SELECT count(*) FROM q WHERE status = 'accepted'),
    'declined', (SELECT count(*) FROM q WHERE status = 'declined'),
    'expired',  (SELECT count(*) FROM q WHERE status = 'expired'),
    'lost_value', COALESCE((SELECT round(sum(total), 2) FROM q WHERE status IN ('declined', 'expired')), 0),
    'avg_value', (SELECT round(avg(total) FILTER (WHERE status = 'accepted' AND total > 0), 2) FROM q),
    'median_response_hours', (SELECT round(
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (responded_at - sent_at)) / 3600.0))::numeric, 1)
      FROM q WHERE responded_at IS NOT NULL AND responded_at >= sent_at),
    'top_decline_reasons', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'reason', reason, 'count', cnt, 'value', round(val, 2)) ORDER BY cnt DESC) FROM reasons), '[]'::jsonb)
  ) INTO v_quotes;

  -- ===== Stage 5: lost leads =====
  SELECT count(*) INTO v_lost
  FROM leads WHERE user_id = v_user AND stage = 'lost' AND created_at >= v_from;

  v_result := jsonb_build_object(
    'window_days', p_days,
    'computed_at', now(),
    'avg_job_value', round(v_avg_job, 2),
    'ltv_multiplier', round(v_ltv_mult, 2),
    'response', v_resp,
    'quotes', v_quotes,
    'lost_leads', v_lost
  );

  INSERT INTO revenue_causality_snapshots (user_id, result, computed_at)
  VALUES (v_user, v_result, now())
  ON CONFLICT (user_id) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_revenue_causality_graph(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_revenue_causality_graph(integer) TO authenticated;
