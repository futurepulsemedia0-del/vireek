/*
  # Home Demand Exchange — reverse marketplace

  Vireek detects FUTURE service demand from the data it already holds
  (equipment condition, predicted failures, warranties, permits, rebates,
  weather) and turns each real need into a qualified opportunity that is
  matched to the best available technician, then quoted, booked,
  dispatched and completed.

  Security model (same as the rest of the platform):
  - Every row is scoped to the account owner via public.get_account_owner_id().
  - Clients can only READ. All writes go through SECURITY DEFINER functions
    that re-verify ownership of every referenced customer / equipment /
    technician / job, and enforce the status state machine server-side.
  - demand_opportunity_events is append-only (trigger blocks UPDATE/DELETE).

  Depends on: profiles, customers, equipment, team_members, jobs,
              public.get_account_owner_id().
  Purely additive: CREATE ... IF NOT EXISTS / CREATE OR REPLACE only.
*/

-- =============================================================
-- 1. SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS demand_exchange_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  min_probability numeric(4,3) NOT NULL DEFAULT 0.350 CHECK (min_probability BETWEEN 0.05 AND 0.99),
  min_margin_pct smallint NOT NULL DEFAULT 25 CHECK (min_margin_pct BETWEEN 0 AND 80),
  horizon_days smallint NOT NULL DEFAULT 90 CHECK (horizon_days BETWEEN 14 AND 365),
  auto_match boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 2. OPPORTUNITIES
-- =============================================================
CREATE TABLE IF NOT EXISTS demand_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  kind text NOT NULL CHECK (kind IN (
    'predicted_failure', 'end_of_life', 'maintenance_due', 'warranty_window', 'permit_followup'
  )),
  title text NOT NULL CHECK (char_length(title) <= 200),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 600),
  trade text NOT NULL DEFAULT 'general',
  urgency text NOT NULL DEFAULT 'planned' CHECK (urgency IN ('urgent', 'soon', 'planned')),
  probability numeric(5,4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  demand_score smallint NOT NULL CHECK (demand_score BETWEEN 0 AND 100),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  est_revenue_cents integer NOT NULL DEFAULT 0 CHECK (est_revenue_cents >= 0),
  est_cost_cents integer NOT NULL DEFAULT 0 CHECK (est_cost_cents >= 0),
  est_margin_pct numeric(5,2) NOT NULL DEFAULT 0,
  required_skills text[] NOT NULL DEFAULT '{}',
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  match jsonb,
  status text NOT NULL DEFAULT 'detected' CHECK (status IN (
    'detected', 'matched', 'quoted', 'booked', 'dispatched', 'completed', 'dismissed', 'expired'
  )),
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  quoted_amount_cents integer CHECK (quoted_amount_cents IS NULL OR quoted_amount_cents >= 0),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  actual_revenue_cents integer CHECK (actual_revenue_cents IS NULL OR actual_revenue_cents >= 0),
  completed_at timestamptz,
  dismissed_reason text CHECK (dismissed_reason IS NULL OR char_length(dismissed_reason) <= 300),
  engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demand_opportunities_window CHECK (window_end > window_start)
);

-- One ACTIVE opportunity per detected need. Finished ones free the key so a
-- genuinely new need (next season, next failure) can be detected again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_opportunities_active
  ON demand_opportunities (user_id, dedupe_key)
  WHERE status IN ('detected', 'matched', 'quoted', 'booked', 'dispatched');
CREATE INDEX IF NOT EXISTS idx_demand_opportunities_user_status
  ON demand_opportunities (user_id, status, demand_score DESC);
CREATE INDEX IF NOT EXISTS idx_demand_opportunities_customer
  ON demand_opportunities (customer_id);
CREATE INDEX IF NOT EXISTS idx_demand_opportunities_job
  ON demand_opportunities (job_id) WHERE job_id IS NOT NULL;

-- =============================================================
-- 3. AUDIT LOG (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS demand_opportunity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES demand_opportunities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demand_events_opportunity
  ON demand_opportunity_events (opportunity_id, created_at);

CREATE OR REPLACE FUNCTION public.prevent_demand_event_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'demand_opportunity_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_demand_events_append_only ON demand_opportunity_events;
CREATE TRIGGER trg_demand_events_append_only
  BEFORE UPDATE OR DELETE ON demand_opportunity_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_demand_event_change();

-- =============================================================
-- 4. RLS — read-only for clients
-- =============================================================
ALTER TABLE demand_exchange_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_opportunity_events ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON demand_exchange_settings FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON demand_opportunities FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON demand_opportunity_events FROM authenticated, anon;
REVOKE SELECT ON demand_exchange_settings, demand_opportunities, demand_opportunity_events FROM anon;

DROP POLICY IF EXISTS "select_own_demand_exchange_settings" ON demand_exchange_settings;
CREATE POLICY "select_own_demand_exchange_settings" ON demand_exchange_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "select_own_demand_opportunities" ON demand_opportunities;
CREATE POLICY "select_own_demand_opportunities" ON demand_opportunities FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "select_own_demand_events" ON demand_opportunity_events;
CREATE POLICY "select_own_demand_events" ON demand_opportunity_events FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

-- =============================================================
-- 5. save_demand_exchange_settings
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_demand_exchange_settings(
  p_enabled boolean,
  p_min_probability numeric,
  p_min_margin_pct integer,
  p_horizon_days integer,
  p_auto_match boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  -- Only the account owner may change exchange policy.
  IF auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change Demand Exchange settings';
  END IF;

  INSERT INTO demand_exchange_settings (user_id, enabled, min_probability, min_margin_pct, horizon_days, auto_match, updated_at)
  VALUES (
    v_owner,
    COALESCE(p_enabled, true),
    LEAST(0.99, GREATEST(0.05, COALESCE(p_min_probability, 0.35))),
    LEAST(80, GREATEST(0, COALESCE(p_min_margin_pct, 25))),
    LEAST(365, GREATEST(14, COALESCE(p_horizon_days, 90))),
    COALESCE(p_auto_match, true),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    min_probability = EXCLUDED.min_probability,
    min_margin_pct = EXCLUDED.min_margin_pct,
    horizon_days = EXCLUDED.horizon_days,
    auto_match = EXCLUDED.auto_match,
    updated_at = now();
END;
$$;

-- =============================================================
-- 6. record_demand_opportunities (idempotent upsert of detections)
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_demand_opportunities(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item jsonb;
  v_customer uuid;
  v_equipment uuid;
  v_id uuid;
  v_inserted int := 0;
  v_updated int := 0;
  v_expired int := 0;
  v_existing uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) > 300 THEN
    RAISE EXCEPTION 'Too many items in one call (max 300)';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_customer := (v_item->>'customer_id')::uuid;
    v_equipment := NULLIF(v_item->>'equipment_id', '')::uuid;

    -- Ownership re-verified server-side: never trust client ids.
    IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = v_customer AND c.user_id = v_owner) THEN
      CONTINUE;
    END IF;
    IF v_equipment IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM equipment e WHERE e.id = v_equipment AND e.user_id = v_owner
    ) THEN
      v_equipment := NULL;
    END IF;

    SELECT o.id INTO v_existing
    FROM demand_opportunities o
    WHERE o.user_id = v_owner
      AND o.dedupe_key = v_item->>'dedupe_key'
      AND o.status IN ('detected', 'matched', 'quoted', 'booked', 'dispatched')
    LIMIT 1;

    IF v_existing IS NULL THEN
      INSERT INTO demand_opportunities (
        user_id, customer_id, equipment_id, dedupe_key, kind, title, summary, trade, urgency,
        probability, confidence, demand_score, window_start, window_end,
        est_revenue_cents, est_cost_cents, est_margin_pct, required_skills, signals, engine_version
      ) VALUES (
        v_owner, v_customer, v_equipment, v_item->>'dedupe_key', v_item->>'kind',
        left(v_item->>'title', 200), left(v_item->>'summary', 600),
        COALESCE(NULLIF(v_item->>'trade', ''), 'general'),
        COALESCE(NULLIF(v_item->>'urgency', ''), 'planned'),
        (v_item->>'probability')::numeric, (v_item->>'confidence')::numeric,
        (v_item->>'demand_score')::smallint,
        (v_item->>'window_start')::timestamptz, (v_item->>'window_end')::timestamptz,
        COALESCE((v_item->>'est_revenue_cents')::int, 0), COALESCE((v_item->>'est_cost_cents')::int, 0),
        COALESCE((v_item->>'est_margin_pct')::numeric, 0),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'required_skills', '[]'::jsonb))), '{}'),
        COALESCE(v_item->'signals', '[]'::jsonb),
        COALESCE(v_item->>'engine_version', '1.0.0')
      )
      RETURNING id INTO v_id;

      INSERT INTO demand_opportunity_events (opportunity_id, user_id, event_type, to_status, actor_id, detail)
      VALUES (v_id, v_owner, 'detected', 'detected', auth.uid(),
              jsonb_build_object('kind', v_item->>'kind', 'score', v_item->'demand_score'));
      v_inserted := v_inserted + 1;
    ELSE
      -- Refresh scoring only; never touch status / progress fields.
      UPDATE demand_opportunities SET
        title = left(v_item->>'title', 200),
        summary = left(v_item->>'summary', 600),
        urgency = COALESCE(NULLIF(v_item->>'urgency', ''), urgency),
        probability = (v_item->>'probability')::numeric,
        confidence = (v_item->>'confidence')::numeric,
        demand_score = (v_item->>'demand_score')::smallint,
        window_start = (v_item->>'window_start')::timestamptz,
        window_end = (v_item->>'window_end')::timestamptz,
        est_revenue_cents = COALESCE((v_item->>'est_revenue_cents')::int, est_revenue_cents),
        est_cost_cents = COALESCE((v_item->>'est_cost_cents')::int, est_cost_cents),
        est_margin_pct = COALESCE((v_item->>'est_margin_pct')::numeric, est_margin_pct),
        signals = COALESCE(v_item->'signals', signals),
        engine_version = COALESCE(v_item->>'engine_version', engine_version),
        updated_at = now()
      WHERE id = v_existing;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  -- Needs nobody acted on, long past their window, are closed honestly.
  WITH expired AS (
    UPDATE demand_opportunities
    SET status = 'expired', updated_at = now()
    WHERE user_id = v_owner
      AND status IN ('detected', 'matched')
      AND window_end < now() - interval '7 days'
    RETURNING id, status
  )
  INSERT INTO demand_opportunity_events (opportunity_id, user_id, event_type, from_status, to_status, actor_id, detail)
  SELECT id, v_owner, 'expired', NULL, 'expired', auth.uid(), '{}'::jsonb FROM expired;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'expired', v_expired);
END;
$$;

-- =============================================================
-- 7. advance_demand_opportunity (server-enforced state machine)
--    match | quote | book | dispatch | complete | dismiss
-- =============================================================
CREATE OR REPLACE FUNCTION public.advance_demand_opportunity(
  p_id uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_opp demand_opportunities%ROWTYPE;
  v_tech uuid;
  v_when timestamptz;
  v_amount int;
  v_job uuid;
  v_customer customers%ROWTYPE;
  v_to text;
  v_revenue int;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_opp FROM demand_opportunities WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opportunity not found';
  END IF;

  IF p_action = 'match' THEN
    IF v_opp.status NOT IN ('detected', 'matched') THEN
      RAISE EXCEPTION 'Cannot match an opportunity that is %', v_opp.status;
    END IF;
    v_tech := NULLIF(p_payload->>'technician_id', '')::uuid;
    IF v_tech IS NULL OR NOT EXISTS (
      SELECT 1 FROM team_members t WHERE t.id = v_tech AND t.account_owner_id = v_owner
    ) THEN
      RAISE EXCEPTION 'Technician not found';
    END IF;
    UPDATE demand_opportunities
    SET match = p_payload->'match', assigned_technician_id = v_tech, status = 'matched', updated_at = now()
    WHERE id = p_id;
    v_to := 'matched';

  ELSIF p_action = 'quote' THEN
    IF v_opp.status NOT IN ('detected', 'matched', 'quoted') THEN
      RAISE EXCEPTION 'Cannot quote an opportunity that is %', v_opp.status;
    END IF;
    v_amount := (p_payload->>'amount_cents')::int;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RAISE EXCEPTION 'A valid quote amount is required';
    END IF;
    UPDATE demand_opportunities
    SET quoted_amount_cents = v_amount, status = 'quoted', updated_at = now()
    WHERE id = p_id;
    v_to := 'quoted';

  ELSIF p_action = 'book' THEN
    IF v_opp.status NOT IN ('detected', 'matched', 'quoted') THEN
      RAISE EXCEPTION 'Cannot book an opportunity that is %', v_opp.status;
    END IF;
    v_tech := COALESCE(NULLIF(p_payload->>'technician_id', '')::uuid, v_opp.assigned_technician_id);
    v_when := (p_payload->>'scheduled_at')::timestamptz;
    IF v_tech IS NULL OR NOT EXISTS (
      SELECT 1 FROM team_members t WHERE t.id = v_tech AND t.account_owner_id = v_owner
    ) THEN
      RAISE EXCEPTION 'A valid technician is required to book';
    END IF;
    IF v_when IS NULL OR v_when < now() - interval '1 hour' THEN
      RAISE EXCEPTION 'A future scheduled time is required';
    END IF;

    SELECT * INTO v_customer FROM customers WHERE id = v_opp.customer_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;

    INSERT INTO jobs (user_id, customer_id, customer_name, service_type, address,
                      scheduled_datetime, assigned_technician_id, job_status, notes)
    VALUES (v_owner, v_customer.id, v_customer.name, v_opp.title, v_customer.address,
            v_when, v_tech, 'scheduled',
            left('Created by Home Demand Exchange: ' || COALESCE(v_opp.summary, v_opp.title), 500))
    RETURNING id INTO v_job;

    UPDATE demand_opportunities
    SET job_id = v_job, assigned_technician_id = v_tech, status = 'booked', updated_at = now()
    WHERE id = p_id;
    v_to := 'booked';

  ELSIF p_action = 'dispatch' THEN
    IF v_opp.status <> 'booked' OR v_opp.job_id IS NULL THEN
      RAISE EXCEPTION 'Only a booked opportunity with a job can be dispatched';
    END IF;
    UPDATE demand_opportunities SET status = 'dispatched', updated_at = now() WHERE id = p_id;
    v_to := 'dispatched';

  ELSIF p_action = 'complete' THEN
    IF v_opp.status NOT IN ('booked', 'dispatched') OR v_opp.job_id IS NULL THEN
      RAISE EXCEPTION 'Only a booked or dispatched opportunity can be completed';
    END IF;
    -- Actual revenue comes from the real job invoice, not from the client.
    SELECT CASE WHEN j.invoice_amount IS NULL THEN NULL
                ELSE round(j.invoice_amount * 100)::int END
      INTO v_revenue
    FROM jobs j WHERE j.id = v_opp.job_id AND j.user_id = v_owner;
    UPDATE demand_opportunities
    SET status = 'completed', completed_at = now(),
        actual_revenue_cents = COALESCE(v_revenue, quoted_amount_cents), updated_at = now()
    WHERE id = p_id;
    v_to := 'completed';

  ELSIF p_action = 'dismiss' THEN
    IF v_opp.status IN ('completed', 'dismissed', 'expired') THEN
      RAISE EXCEPTION 'Opportunity is already closed';
    END IF;
    UPDATE demand_opportunities
    SET status = 'dismissed', dismissed_reason = left(p_payload->>'reason', 300), updated_at = now()
    WHERE id = p_id;
    v_to := 'dismissed';

  ELSE
    RAISE EXCEPTION 'Unknown action %', p_action;
  END IF;

  INSERT INTO demand_opportunity_events (opportunity_id, user_id, event_type, from_status, to_status, actor_id, detail)
  VALUES (p_id, v_owner, p_action, v_opp.status, v_to, auth.uid(),
          jsonb_build_object('technician_id', p_payload->>'technician_id'));

  RETURN jsonb_build_object('id', p_id, 'status', v_to, 'job_id', v_job);
END;
$$;

REVOKE ALL ON FUNCTION public.save_demand_exchange_settings(boolean, numeric, integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_demand_opportunities(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.advance_demand_opportunity(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_demand_exchange_settings(boolean, numeric, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_demand_opportunities(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_demand_opportunity(uuid, text, jsonb) TO authenticated;
