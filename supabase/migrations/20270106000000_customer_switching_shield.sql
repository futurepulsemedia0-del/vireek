/*
  # Customer Switching Shield (predictive retention)

  Scores every customer 0-100 for "likely to leave" from signals that already
  exist in Vireek, opens ONE active case per at-risk customer, and lets the
  Save Customer Agent (Edge Function `switching-shield`) propose retention
  offers that a human approves before anything reaches the customer.

  Deterministic scoring lives here (explainable, never hallucinated); AI only
  narrates the plan. Rows are created by service-role code / SECURITY DEFINER
  functions only — clients can read and triage, never fabricate a case.

  Requires the migrations that add: jobs.customer_id, jobs.is_rework,
  jobs.completed_at, calls.customer_id, calls.is_voicemail,
  calls.voicemail_listened_at, calls.missed_opportunity_reason,
  call_feedback, review_requests, quotes. Missing simple columns are
  added below with IF NOT EXISTS (safe to re-run).
*/

-- 0. Idempotent prerequisites --------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_disputed boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_disputed_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_rework boolean NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason text;

-- 1. Settings (one row per account) ---------------------------------------
CREATE TABLE IF NOT EXISTS switching_shield_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  enabled boolean NOT NULL DEFAULT true,
  watch_threshold smallint NOT NULL DEFAULT 35 CHECK (watch_threshold BETWEEN 1 AND 99),
  at_risk_threshold smallint NOT NULL DEFAULT 55 CHECK (at_risk_threshold BETWEEN 2 AND 99),
  critical_threshold smallint NOT NULL DEFAULT 75 CHECK (critical_threshold BETWEEN 3 AND 100),
  lookback_days smallint NOT NULL DEFAULT 120 CHECK (lookback_days BETWEEN 30 AND 365),
  case_cooldown_days smallint NOT NULL DEFAULT 30 CHECK (case_cooldown_days BETWEEN 0 AND 180),
  max_discount_percent smallint NOT NULL DEFAULT 10 CHECK (max_discount_percent BETWEEN 0 AND 50),
  enabled_offers text[] NOT NULL DEFAULT ARRAY['priority_appointment','discount','free_inspection','manager_call','membership_offer','warranty_extension'],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (watch_threshold < at_risk_threshold AND at_risk_threshold < critical_threshold)
);

-- 2. Cases ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS switching_shield_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  risk_score smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  peak_risk_score smallint NOT NULL CHECK (peak_risk_score BETWEEN 0 AND 100),
  risk_level text NOT NULL CHECK (risk_level IN ('watch', 'at_risk', 'critical')),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  signal_count smallint NOT NULL DEFAULT 0,
  customer_value_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'action_pending', 'saved', 'lost', 'dismissed', 'cleared')),
  narrative text,
  talk_track text,
  plan_generated_at timestamptz,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_scored_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shield_one_active_case
  ON switching_shield_cases(customer_id) WHERE status IN ('open', 'action_pending');
CREATE INDEX IF NOT EXISTS idx_shield_cases_user_status ON switching_shield_cases(user_id, status, risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_shield_cases_customer ON switching_shield_cases(customer_id, closed_at DESC);

-- 3. Proposed / executed retention actions ---------------------------------
CREATE TABLE IF NOT EXISTS switching_shield_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES switching_shield_cases(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  offer_type text NOT NULL CHECK (offer_type IN (
    'priority_appointment', 'discount', 'free_inspection', 'manager_call', 'membership_offer', 'warranty_extension'
  )),
  channel text NOT NULL CHECK (channel IN ('sms', 'call_task')),
  message text NOT NULL,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'sent', 'completed', 'failed', 'rejected')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('accepted', 'declined', 'no_response')),
  decided_by uuid,
  executed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_actions_case ON switching_shield_actions(case_id);
CREATE INDEX IF NOT EXISTS idx_shield_actions_customer_sent ON switching_shield_actions(customer_id, executed_at DESC);

-- 4. RLS -------------------------------------------------------------------
ALTER TABLE switching_shield_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE switching_shield_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE switching_shield_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_shield_settings" ON switching_shield_settings;
CREATE POLICY "select_own_shield_settings" ON switching_shield_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_shield_settings" ON switching_shield_settings;
CREATE POLICY "insert_own_shield_settings" ON switching_shield_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_shield_settings" ON switching_shield_settings;
CREATE POLICY "update_own_shield_settings" ON switching_shield_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_shield_cases" ON switching_shield_cases;
CREATE POLICY "select_own_shield_cases" ON switching_shield_cases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_shield_cases" ON switching_shield_cases;
CREATE POLICY "update_own_shield_cases" ON switching_shield_cases FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_shield_actions" ON switching_shield_actions;
CREATE POLICY "select_own_shield_actions" ON switching_shield_actions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_shield_actions" ON switching_shield_actions;
CREATE POLICY "update_own_shield_actions" ON switching_shield_actions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
-- No INSERT/DELETE policy on cases or actions on purpose: only service code creates them.

-- 5. Risk level helper -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.switching_shield_level(p_score int, p_at_risk int, p_critical int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_score >= p_critical THEN 'critical'
              WHEN p_score >= p_at_risk THEN 'at_risk'
              ELSE 'watch' END;
$$;

-- 6. Deterministic scoring (read-only) --------------------------------------
CREATE OR REPLACE FUNCTION public.switching_shield_score(p_user_id uuid, p_lookback int)
RETURNS TABLE (customer_id uuid, risk_score int, signals jsonb, customer_value_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH cust AS (
  SELECT c.id, right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) AS pd
  FROM customers c
  WHERE c.user_id = p_user_id
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id = c.id AND j.user_id = p_user_id)
),
hist AS (
  SELECT j.customer_id,
         count(*) FILTER (WHERE j.job_status = 'completed') AS n_done,
         min(coalesce(j.completed_at, j.scheduled_datetime, j.created_at)) FILTER (WHERE j.job_status = 'completed') AS first_done,
         max(coalesce(j.completed_at, j.scheduled_datetime, j.created_at)) FILTER (WHERE j.job_status = 'completed') AS last_done,
         bool_or(j.job_status IN ('scheduled', 'en_route', 'in_progress')
                 AND coalesce(j.scheduled_datetime, j.created_at) >= now()) AS has_upcoming,
         round(coalesce(sum(j.invoice_amount) FILTER (WHERE j.job_status = 'completed'), 0) * 100)::bigint AS value_cents
  FROM jobs j
  WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL
  GROUP BY j.customer_id
),
sig AS (
  -- 1. Booking decline: silent far longer than this customer's own rhythm
  SELECT h.customer_id, 'booking_decline'::text AS type,
         CASE WHEN extract(epoch FROM now() - h.last_done) / 86400.0
                   >= 2.5 * ((extract(epoch FROM h.last_done - h.first_done) / 86400.0) / (h.n_done - 1)) THEN 35 ELSE 25 END::numeric AS points,
         'No booking for ' || round(extract(epoch FROM now() - h.last_done) / 86400.0)::int
           || ' days; usual gap is about '
           || round((extract(epoch FROM h.last_done - h.first_done) / 86400.0) / (h.n_done - 1))::int || ' days.' AS detail,
         h.last_done AS occurred_at
  FROM hist h
  WHERE h.n_done >= 2 AND NOT h.has_upcoming
    AND h.last_done > h.first_done
    AND extract(epoch FROM now() - h.last_done) / 86400.0 BETWEEN 60 AND 540
    AND extract(epoch FROM now() - h.last_done) / 86400.0
        >= 1.75 * ((extract(epoch FROM h.last_done - h.first_done) / 86400.0) / (h.n_done - 1))
  UNION ALL
  -- 2a. Complaint: staff-flagged dispute
  SELECT j.customer_id, 'complaint', 30, 'Job flagged as disputed by staff.',
         coalesce(j.customer_disputed_at, j.created_at)
  FROM jobs j
  WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL AND j.customer_disputed = true
    AND j.job_status <> 'cancelled'
  UNION ALL
  -- 2b. Complaint: negative call sentiment
  SELECT ca.customer_id, 'complaint', 15, 'Call analysis detected negative sentiment.', ca.created_at
  FROM calls ca
  WHERE ca.user_id = p_user_id AND ca.customer_id IS NOT NULL AND ca.sentiment = 'negative'
    AND ca.created_at >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 3a. Price objection: quote declined on price
  SELECT cu.id, 'price_objection', 20, 'Quote declined because of price.', coalesce(q.responded_at, q.updated_at)
  FROM quotes q
  JOIN cust cu ON cu.pd <> '' AND cu.pd = right(regexp_replace(coalesce(q.customer_phone, ''), '\D', '', 'g'), 10)
  WHERE q.user_id = p_user_id AND q.status = 'declined' AND q.decline_reason = 'price'
    AND coalesce(q.responded_at, q.updated_at) >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 3b. Price objection: lost opportunity attributed to price on a call
  SELECT ca.customer_id, 'price_objection', 15, 'Call ended without booking; price was the objection.', ca.created_at
  FROM calls ca
  WHERE ca.user_id = p_user_id AND ca.customer_id IS NOT NULL
    AND ca.missed_opportunity_reason ~* '(price|cost|expensive|too much)'
    AND ca.created_at >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 4. Delayed response: voicemail left and still unheard after 4 hours
  SELECT ca.customer_id, 'delayed_response', 12, 'Voicemail left unanswered for hours.', ca.created_at
  FROM calls ca
  WHERE ca.user_id = p_user_id AND ca.customer_id IS NOT NULL
    AND ca.is_voicemail = true AND ca.voicemail_listened_at IS NULL
    AND ca.created_at < now() - interval '4 hours'
    AND ca.created_at >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 5a. Low satisfaction: private review request rating
  SELECT j.customer_id, 'low_satisfaction',
         CASE WHEN rr.rating <= 2 THEN 35 ELSE 20 END,
         'Customer rated the service ' || rr.rating || '/5.',
         coalesce(rr.completed_at, rr.sent_at)
  FROM review_requests rr
  JOIN jobs j ON j.id = rr.job_id
  WHERE rr.user_id = p_user_id AND j.customer_id IS NOT NULL
    AND rr.status = 'completed' AND rr.rating <= 3
    AND coalesce(rr.completed_at, rr.sent_at) >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 5b. Low satisfaction: call feedback
  SELECT ca.customer_id, 'low_satisfaction', 15, 'Call feedback rated ' || cf.rating || '/5.', cf.created_at
  FROM call_feedback cf
  JOIN calls ca ON ca.id = cf.call_id
  WHERE cf.user_id = p_user_id AND ca.customer_id IS NOT NULL AND cf.rating <= 2
    AND cf.created_at >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 6. Unresolved job: still open more than 72h after its date
  SELECT j.customer_id, 'unresolved_job', 18, 'A job has stayed open more than 3 days past its date.',
         coalesce(j.scheduled_datetime, j.created_at)
  FROM jobs j
  WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL
    AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
    AND coalesce(j.scheduled_datetime, j.created_at) < now() - interval '72 hours'
    AND coalesce(j.scheduled_datetime, j.created_at) >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 7. Repeated reservice: rework visits
  SELECT j.customer_id, 'repeat_reservice', 20, 'Return visit needed to redo earlier work.',
         coalesce(j.completed_at, j.scheduled_datetime, j.created_at)
  FROM jobs j
  WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL AND j.is_rework = true
    AND coalesce(j.completed_at, j.scheduled_datetime, j.created_at) >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 8a. Competitor mention in a call transcript
  SELECT ca.customer_id, 'competitor_mention', 30, 'Customer mentioned comparing or switching providers on a call.', ca.created_at
  FROM calls ca
  WHERE ca.user_id = p_user_id AND ca.customer_id IS NOT NULL
    AND ca.created_at >= now() - make_interval(days => p_lookback)
    AND ca.transcript ~* '(competitor|(another|other) (company|companies|contractor|contractors|provider|providers)|cheaper (elsewhere|somewhere|quote|option|price)|(second|another|other|competing) (quote|estimate|bid)|(switch|switching|go|going|went) (to|with) (someone|somebody|another|a different)|(cancel|cancelling|canceling) (my|our) (service|membership|plan|contract))'
  UNION ALL
  -- 8b. Competitor: quote lost to a competitor
  SELECT cu.id, 'competitor_mention', 35, 'Quote lost to a competitor.', coalesce(q.responded_at, q.updated_at)
  FROM quotes q
  JOIN cust cu ON cu.pd <> '' AND cu.pd = right(regexp_replace(coalesce(q.customer_phone, ''), '\D', '', 'g'), 10)
  WHERE q.user_id = p_user_id AND q.status = 'declined' AND q.decline_reason = 'went_competitor'
    AND coalesce(q.responded_at, q.updated_at) >= now() - make_interval(days => p_lookback)
  UNION ALL
  -- 9. Missed / cancelled appointment
  SELECT j.customer_id, 'missed_appointment',
         CASE WHEN j.job_status = 'no_show' THEN 15 ELSE 12 END,
         CASE WHEN j.job_status = 'no_show' THEN 'Customer missed an appointment.' ELSE 'An appointment was cancelled.' END,
         coalesce(j.scheduled_datetime, j.created_at)
  FROM jobs j
  WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL
    AND j.job_status IN ('no_show', 'cancelled')
    AND coalesce(j.scheduled_datetime, j.created_at) >= now() - make_interval(days => p_lookback)
),
caps(type, cap) AS (
  VALUES ('booking_decline', 35), ('complaint', 45), ('price_objection', 30), ('delayed_response', 24),
         ('low_satisfaction', 40), ('unresolved_job', 30), ('repeat_reservice', 40),
         ('competitor_mention', 45), ('missed_appointment', 30)
),
per_type AS (
  SELECT s.customer_id, s.type,
         least(sum(s.points * CASE WHEN s.occurred_at >= now() - interval '30 days' THEN 1.0
                                   WHEN s.occurred_at >= now() - interval '60 days' THEN 0.7
                                   ELSE 0.45 END), max(k.cap)) AS pts,
         count(*) AS n,
         max(s.occurred_at) AS last_at,
         (array_agg(s.detail ORDER BY s.occurred_at DESC NULLS LAST))[1] AS detail
  FROM sig s
  JOIN caps k ON k.type = s.type
  JOIN cust cu ON cu.id = s.customer_id
  GROUP BY s.customer_id, s.type
)
SELECT p.customer_id,
       least(100, round(sum(p.pts) + CASE WHEN count(*) >= 4 THEN 15 WHEN count(*) = 3 THEN 10 ELSE 0 END))::int AS risk_score,
       jsonb_agg(jsonb_build_object(
         'type', p.type, 'points', round(p.pts)::int, 'count', p.n, 'detail', p.detail, 'last_at', p.last_at
       ) ORDER BY p.pts DESC) AS signals,
       coalesce(max(h.value_cents), 0)::bigint AS customer_value_cents
FROM per_type p
LEFT JOIN hist h ON h.customer_id = p.customer_id
GROUP BY p.customer_id;
$$;

-- 7. Case maintenance --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_switching_shield_cases(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s switching_shield_settings%ROWTYPE;
  v_opened int := 0;
  v_updated int := 0;
  v_cleared int := 0;
BEGIN
  INSERT INTO switching_shield_settings (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO s FROM switching_shield_settings WHERE user_id = p_user_id;
  IF NOT s.enabled THEN
    RETURN jsonb_build_object('skipped', 'disabled', 'opened', 0, 'updated', 0, 'cleared', 0);
  END IF;

  DROP TABLE IF EXISTS _shield_scores;
  CREATE TEMP TABLE _shield_scores (
    customer_id uuid, risk_score int, signals jsonb, customer_value_cents bigint
  ) ON COMMIT DROP;
  INSERT INTO _shield_scores
    SELECT * FROM public.switching_shield_score(p_user_id, s.lookback_days);

  -- Update live cases (hysteresis: stay tracked until 10 points under "watch")
  UPDATE switching_shield_cases k
  SET risk_score = sc.risk_score,
      peak_risk_score = greatest(k.peak_risk_score, sc.risk_score),
      risk_level = public.switching_shield_level(sc.risk_score, s.at_risk_threshold, s.critical_threshold),
      signals = sc.signals,
      signal_count = jsonb_array_length(sc.signals),
      customer_value_cents = sc.customer_value_cents,
      last_scored_at = now(),
      updated_at = now()
  FROM _shield_scores sc
  WHERE k.user_id = p_user_id AND k.customer_id = sc.customer_id
    AND k.status IN ('open', 'action_pending')
    AND sc.risk_score >= s.watch_threshold - 10;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Auto-clear untouched cases whose risk faded (never clear a case a human is working)
  UPDATE switching_shield_cases k
  SET status = 'cleared', closed_at = now(),
      closed_note = 'Risk signals faded below the watch threshold.', updated_at = now()
  WHERE k.user_id = p_user_id AND k.status = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM _shield_scores sc
      WHERE sc.customer_id = k.customer_id AND sc.risk_score >= s.watch_threshold - 10
    );
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  -- Open new cases (needs 2+ signal families OR a genuinely high score)
  INSERT INTO switching_shield_cases
    (user_id, customer_id, risk_score, peak_risk_score, risk_level, signals, signal_count, customer_value_cents)
  SELECT p_user_id, sc.customer_id, sc.risk_score, sc.risk_score,
         public.switching_shield_level(sc.risk_score, s.at_risk_threshold, s.critical_threshold),
         sc.signals, jsonb_array_length(sc.signals), sc.customer_value_cents
  FROM _shield_scores sc
  WHERE sc.risk_score >= s.watch_threshold
    AND (jsonb_array_length(sc.signals) >= 2 OR sc.risk_score >= s.at_risk_threshold)
    AND NOT EXISTS (
      SELECT 1 FROM switching_shield_cases k
      WHERE k.customer_id = sc.customer_id
        AND (k.status IN ('open', 'action_pending')
             OR k.closed_at > now() - make_interval(days => s.case_cooldown_days))
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_opened = ROW_COUNT;

  RETURN jsonb_build_object('opened', v_opened, 'updated', v_updated, 'cleared', v_cleared);
END;
$$;

-- 8. Accounts to scan on cron -----------------------------------------------
CREATE OR REPLACE FUNCTION public.list_switching_shield_accounts()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.user_id FROM customers c
  WHERE NOT EXISTS (
    SELECT 1 FROM switching_shield_settings s WHERE s.user_id = c.user_id AND s.enabled = false
  );
$$;

-- 9. User-facing wrapper (scoped to the caller's own account) ---------------
CREATE OR REPLACE FUNCTION public.run_switching_shield()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.refresh_switching_shield_cases(v_owner);
END;
$$;

-- 10. Grants -------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.switching_shield_score(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_switching_shield_cases(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_switching_shield_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_switching_shield() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switching_shield_score(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_switching_shield_cases(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_switching_shield_accounts() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_switching_shield() TO authenticated;

-- 11. updated_at maintenance ----------------------------------------------------
DROP TRIGGER IF EXISTS trg_shield_settings_updated ON switching_shield_settings;
CREATE TRIGGER trg_shield_settings_updated BEFORE UPDATE ON switching_shield_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_shield_cases_updated ON switching_shield_cases;
CREATE TRIGGER trg_shield_cases_updated BEFORE UPDATE ON switching_shield_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
