/*
  # Customer Trust Bank

  A running trust BALANCE per customer, not a static score. Trust rises with
  on-time delivery, quality, transparency, fast resolution and kept promises;
  it falls with lateness, price surprises, rework, repeat contact and broken
  promises. The point is to catch EROSION before it shows up as churn or a
  bad review — so this ships two read paths: the current balance
  (customers.trust_score) and a 30-day erosion signal
  (get_trust_erosion_alerts) that flags customers dropping fast regardless
  of their absolute score.

  ## Design decisions worth knowing
  1. Deltas are a fixed, server-side lookup inside log_customer_trust_event()
     — never a client-supplied number. A buggy or malicious caller can log
     an event type, never an arbitrary point value.
  2. Automatic events only fire off signals that ALREADY exist and are
     already trustworthy in this schema: promises.status (promise_tracker),
     jobs.is_rework (rework_intelligence), jobs.job_status = 'cancelled',
     and calls.sentiment / repeat contact volume. Nothing here guesses at a
     column (like an on-time arrival timestamp) that doesn't exist yet —
     those become manual quick-log events instead, same philosophy as
     promise_tracker's "no automatic broken status" decision.
  3. Cross-table trigger writes are SECURITY DEFINER, matching the pattern
     already used in missed_revenue_recovery_ledger.sql.

  Purely additive.

  1. customers.trust_score              running balance, 0-100, default 75.
  2. customer_trust_events              append-only ledger (auto + manual).
  3. log_customer_trust_event()         SECURITY DEFINER RPC — the ONLY way
                                         a client can add a MANUAL event;
                                         looks up the delta itself.
  4. Triggers on promises / jobs / calls that post AUTO events.
  5. get_trust_erosion_alerts()         read-only RPC: customers whose
                                         trust dropped meaningfully in the
                                         last 30 days.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Running balance -------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS trust_score numeric NOT NULL DEFAULT 75
    CHECK (trust_score BETWEEN 0 AND 100);

-- 2) Ledger ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_trust_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- account owner
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'promise_kept', 'promise_broken', 'quality_rework', 'job_cancelled',
    'repeat_contact', 'negative_call_sentiment',
    'on_time_arrival', 'late_arrival', 'price_transparency', 'price_change_surprise',
    'fast_issue_resolution', 'slow_issue_resolution', 'went_above_and_beyond'
  )),
  delta integer NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  source_table text,
  source_id uuid,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_events_customer_created
  ON customer_trust_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_events_user_created
  ON customer_trust_events(user_id, created_at DESC);

ALTER TABLE customer_trust_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_trust_events" ON customer_trust_events;
CREATE POLICY "select_own_trust_events" ON customer_trust_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Intentionally no INSERT/UPDATE/DELETE policy for authenticated: rows are
-- only ever written by log_customer_trust_event() or the triggers below
-- (both SECURITY DEFINER), so a client can never inject a fake event or an
-- arbitrary point value.

-- Apply every new ledger row to the running balance, clamped 0-100.
CREATE OR REPLACE FUNCTION public.apply_customer_trust_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers
  SET trust_score = LEAST(100, GREATEST(0, trust_score + NEW.delta))
  WHERE id = NEW.customer_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_customer_trust_event ON customer_trust_events;
CREATE TRIGGER trg_apply_customer_trust_event
  AFTER INSERT ON customer_trust_events
  FOR EACH ROW EXECUTE FUNCTION public.apply_customer_trust_event();

-- 3) Manual quick-log RPC — the ONLY client-facing write path ---------------
CREATE OR REPLACE FUNCTION public.log_customer_trust_event(
  p_customer_id uuid,
  p_event_type text,
  p_note text DEFAULT NULL
)
RETURNS customer_trust_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_delta integer;
  v_row customer_trust_events;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;

  -- Fixed, server-side deltas. Only the MANUAL event types are accepted
  -- here — the AUTO ones below can only ever be posted by their own
  -- triggers, so a client can't fabricate a "promise_kept" it never earned.
  v_delta := CASE p_event_type
    WHEN 'on_time_arrival' THEN 5
    WHEN 'late_arrival' THEN -10
    WHEN 'price_transparency' THEN 6
    WHEN 'price_change_surprise' THEN -15
    WHEN 'fast_issue_resolution' THEN 12
    WHEN 'slow_issue_resolution' THEN -8
    WHEN 'went_above_and_beyond' THEN 15
    ELSE NULL
  END;

  IF v_delta IS NULL THEN
    RAISE EXCEPTION 'Invalid or non-manual trust event type.';
  END IF;

  INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, created_by)
  VALUES (v_owner, p_customer_id, p_event_type, v_delta, NULLIF(TRIM(COALESCE(p_note, '')), ''), 'manual', auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- 4) Automatic signals --------------------------------------------------------

-- promises: fulfilled -> +8, broken -> -15 (matched to the customer by phone)
CREATE OR REPLACE FUNCTION public.trust_signal_from_promise()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT id INTO v_customer_id
  FROM customers
  WHERE user_id = NEW.user_id AND phone = NEW.customer_phone
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, source_table, source_id)
    VALUES (
      NEW.user_id, v_customer_id,
      CASE WHEN NEW.status = 'fulfilled' THEN 'promise_kept' ELSE 'promise_broken' END,
      CASE WHEN NEW.status = 'fulfilled' THEN 8 ELSE -15 END,
      NEW.promise_text, 'auto', 'promises', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trust_signal_from_promise ON promises;
CREATE TRIGGER trg_trust_signal_from_promise
  AFTER UPDATE OF status ON promises
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('fulfilled', 'broken'))
  EXECUTE FUNCTION public.trust_signal_from_promise();

-- jobs: newly-detected rework -> -20, customer-side cancellation -> -12
CREATE OR REPLACE FUNCTION public.trust_signal_from_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    IF NEW.is_rework = true AND (OLD.is_rework IS DISTINCT FROM true) THEN
      INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, source_table, source_id)
      VALUES (NEW.user_id, NEW.customer_id, 'quality_rework', -20, 'A follow-up job was auto-detected as rework of a prior visit.', 'auto', 'jobs', NEW.id);
    END IF;

    IF NEW.job_status = 'cancelled' AND OLD.job_status IS DISTINCT FROM 'cancelled' THEN
      INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, source_table, source_id)
      VALUES (NEW.user_id, NEW.customer_id, 'job_cancelled', -12, 'Job was cancelled.', 'auto', 'jobs', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trust_signal_from_job ON jobs;
CREATE TRIGGER trg_trust_signal_from_job
  AFTER UPDATE ON jobs
  FOR EACH ROW
  WHEN (NEW.is_rework IS DISTINCT FROM OLD.is_rework OR NEW.job_status IS DISTINCT FROM OLD.job_status)
  EXECUTE FUNCTION public.trust_signal_from_job();

-- calls: 3rd+ contact within 14 days -> -6 (fires once, right when it crosses)
CREATE OR REPLACE FUNCTION public.trust_signal_from_repeat_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id uuid;
  v_recent_count integer;
BEGIN
  IF NEW.caller_phone IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM customers WHERE user_id = NEW.user_id AND phone = NEW.caller_phone LIMIT 1;

    IF v_customer_id IS NOT NULL THEN
      SELECT count(*) INTO v_recent_count
      FROM calls
      WHERE user_id = NEW.user_id AND caller_phone = NEW.caller_phone
        AND call_datetime >= now() - interval '14 days';

      IF v_recent_count = 3 THEN
        INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, source_table, source_id)
        VALUES (NEW.user_id, v_customer_id, 'repeat_contact', -6, 'Third contact from this customer within 14 days.', 'auto', 'calls', NEW.id);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trust_signal_from_repeat_contact ON calls;
CREATE TRIGGER trg_trust_signal_from_repeat_contact
  AFTER INSERT ON calls
  FOR EACH ROW EXECUTE FUNCTION public.trust_signal_from_repeat_contact();

-- calls: sentiment turns negative -> -10
CREATE OR REPLACE FUNCTION public.trust_signal_from_call_sentiment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  IF NEW.caller_phone IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM customers WHERE user_id = NEW.user_id AND phone = NEW.caller_phone LIMIT 1;
    IF v_customer_id IS NOT NULL THEN
      INSERT INTO customer_trust_events (user_id, customer_id, event_type, delta, reason, source, source_table, source_id)
      VALUES (NEW.user_id, v_customer_id, 'negative_call_sentiment', -10, LEFT(COALESCE(NEW.summary, 'A recent call came across negative.'), 200), 'auto', 'calls', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trust_signal_from_call_sentiment ON calls;
CREATE TRIGGER trg_trust_signal_from_call_sentiment
  AFTER UPDATE OF sentiment ON calls
  FOR EACH ROW
  WHEN (NEW.sentiment = 'negative' AND OLD.sentiment IS DISTINCT FROM 'negative')
  EXECUTE FUNCTION public.trust_signal_from_call_sentiment();

-- 5) Erosion detection (read-only, no AI needed) -----------------------------
-- Flags customers with a meaningfully negative NET delta in the last 30
-- days — a leading indicator independent of their absolute trust_score, so
-- even a historically great customer having a bad month gets caught early.
CREATE OR REPLACE FUNCTION public.get_trust_erosion_alerts(p_limit integer DEFAULT 8)
RETURNS TABLE (
  customer_id uuid,
  customer_name text,
  trust_score numeric,
  recent_30d_delta integer,
  event_count_30d integer,
  top_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  RETURN QUERY
  WITH recent AS (
    SELECT
      e.customer_id,
      SUM(e.delta) AS recent_delta,
      COUNT(*) AS cnt,
      (ARRAY_AGG(e.reason ORDER BY e.created_at DESC) FILTER (WHERE e.reason IS NOT NULL))[1] AS top_reason
    FROM customer_trust_events e
    WHERE e.user_id = v_owner AND e.created_at >= now() - interval '30 days'
    GROUP BY e.customer_id
  )
  SELECT c.id, c.name, c.trust_score, r.recent_delta::integer, r.cnt::integer, r.top_reason
  FROM recent r
  JOIN customers c ON c.id = r.customer_id
  WHERE r.recent_delta <= -15
  ORDER BY r.recent_delta ASC
  LIMIT GREATEST(1, LEAST(p_limit, 20));
END;
$$;
