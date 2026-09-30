/*
  # Autonomous Revenue Protection (ARP)

  ## Why
  Revenue Recovery answers "what did we lose?". ARP answers "what is ABOUT to
  be lost, why, and did the fix actually work?" — as one closed loop:

      Detect  ->  Explain  ->  Recover  ->  Verify

  ## What this is (and is not)
  - It does NOT replace revenue_recovery_events. That ledger keeps recording
    what already happened. ARP is the layer on top that watches live data,
    stores an evidence-backed case per at-risk dollar, and closes each case
    only when the database proves the money moved.
  - Every dollar figure comes from real rows (quote totals, warranty costs,
    membership plan price, price-book/cost deltas) or from the account's own
    avg_job_value / price book. Nothing is invented; anything that cannot be
    priced is skipped, never guessed. Capacity (idle technician) value is
    labelled as an estimate and kept OUT of the "recoverable" headline.

  ## Seven detectors (all deterministic SQL — same philosophy as the rest of Vireek)
    quote_not_followed_up   sent quote, no response, past the follow-up window
    warranty_under_claim    claim under-filed vs. part+labor, or credit short of approval
    membership_renewal_missed  active plan lapsed un-renewed, or auto-renew off near renewal
    unbilled_job            completed job never invoiced
    part_markup_leakage     installed parts whose price-book price is below target markup
    cancelled_appointment   cancelled job with no rebooking
    technician_idle_time    open dispatch capacity in the next 48h (estimate)

  ## Verify semantics (honest by design)
    secured   = money proven to have moved (quote accepted, paid invoice, renewal, credit, rebooked job)
    protected = root cause fixed, cash still pending (claim corrected, price fixed, invoice sent, auto-renew on)
    A case only counts as Verified if Vireek's Recover step was started on it.
    If it resolves with no action logged it is 'self_resolved' — never claimed as a win.

  ## Security
  RLS keyed to get_account_owner_id(). No client INSERT/UPDATE/DELETE policy on
  cases or actions — all writes go through SECURITY DEFINER functions below.
  Internal scan functions are not callable by clients.

  ## Depends on
  20260922000000 (revenue_recovery_events, estimate_missed_call_value_cents),
  20260920000000 (quote_option_total_cents, quote_line_items_subtotal_cents),
  20260928000000_business_activity_ledger (append_activity_event),
  memberships / membership_plans / warranty_claims / job_parts_required /
  inventory_parts / price_book_items / team_members(dispatch fields).

  ## Deploy order
    1. Run this migration (SQL editor or `supabase db push`).
    2. Add src/lib/revenueProtection.ts and src/pages/RevenueProtectionPage.tsx.
    3. Apply the App.tsx + DashboardNav.tsx edits.
    4. No edge function needed. Scheduling uses pg_cron if enabled (see bottom).
*/

-- =============================================================
-- 1. SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS revenue_protection_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  quote_followup_hours integer NOT NULL DEFAULT 48 CHECK (quote_followup_hours BETWEEN 1 AND 720),
  renewal_lookahead_days integer NOT NULL DEFAULT 21 CHECK (renewal_lookahead_days BETWEEN 1 AND 120),
  min_parts_markup_pct integer NOT NULL DEFAULT 40 CHECK (min_parts_markup_pct BETWEEN 0 AND 500),
  idle_min_open_slots integer NOT NULL DEFAULT 2 CHECK (idle_min_open_slots BETWEEN 1 AND 20),
  idle_capacity_fill_pct integer NOT NULL DEFAULT 50 CHECK (idle_capacity_fill_pct BETWEEN 0 AND 100),
  timezone text NOT NULL DEFAULT 'UTC',
  last_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE revenue_protection_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_protection_settings" ON revenue_protection_settings;
CREATE POLICY "select_own_revenue_protection_settings" ON revenue_protection_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_revenue_protection_settings" ON revenue_protection_settings;
CREATE POLICY "insert_own_revenue_protection_settings" ON revenue_protection_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_revenue_protection_settings" ON revenue_protection_settings;
CREATE POLICY "update_own_revenue_protection_settings" ON revenue_protection_settings
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.arp_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_arp_settings_guard ON revenue_protection_settings;
CREATE TRIGGER trg_arp_settings_guard
  BEFORE INSERT OR UPDATE ON revenue_protection_settings
  FOR EACH ROW EXECUTE FUNCTION public.arp_settings_guard();

-- =============================================================
-- 2. CASES
-- =============================================================

CREATE TABLE IF NOT EXISTS revenue_protection_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  leak_type text NOT NULL CHECK (leak_type IN (
    'quote_not_followed_up', 'warranty_under_claim', 'membership_renewal_missed',
    'unbilled_job', 'part_markup_leakage', 'cancelled_appointment', 'technician_idle_time'
  )),
  subject_table text NOT NULL,
  subject_id uuid NOT NULL,
  subject_key text NOT NULL DEFAULT '',

  stage text NOT NULL DEFAULT 'explained' CHECK (stage IN (
    'explained', 'recovering', 'verified', 'self_resolved', 'lost', 'dismissed'
  )),

  customer_name text,
  customer_phone text,

  at_risk_cents integer NOT NULL DEFAULT 0 CHECK (at_risk_cents >= 0),
  value_basis text NOT NULL DEFAULT 'none'
    CHECK (value_basis IN ('quote_amount', 'warranty_costs', 'membership_plan', 'price_book_match',
                           'avg_job_value', 'ledger_estimate', 'cost_markup_gap', 'capacity_estimate', 'none')),
  confidence integer NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  is_capacity boolean NOT NULL DEFAULT false,

  reason_code text NOT NULL,
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_action jsonb NOT NULL DEFAULT '{}'::jsonb,

  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,

  recovery_started_at timestamptz,
  recovery_method text,
  recovery_started_by uuid,

  closed_at timestamptz,
  verification_kind text CHECK (verification_kind IS NULL OR verification_kind IN ('secured', 'protected', 'capacity_filled')),
  verified_amount_cents integer CHECK (verified_amount_cents IS NULL OR verified_amount_cents >= 0),
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,

  ledger_event_id uuid REFERENCES revenue_recovery_events(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, leak_type, subject_table, subject_id, subject_key)
);

CREATE INDEX IF NOT EXISTS idx_arp_cases_active
  ON revenue_protection_cases(user_id, at_risk_cents DESC) WHERE stage IN ('explained', 'recovering');
CREATE INDEX IF NOT EXISTS idx_arp_cases_closed
  ON revenue_protection_cases(user_id, closed_at DESC) WHERE closed_at IS NOT NULL;

ALTER TABLE revenue_protection_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_protection_cases" ON revenue_protection_cases;
CREATE POLICY "select_own_revenue_protection_cases" ON revenue_protection_cases
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE policy — writes only via the functions below.

CREATE OR REPLACE FUNCTION public.arp_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_arp_cases_updated_at ON revenue_protection_cases;
CREATE TRIGGER trg_arp_cases_updated_at
  BEFORE UPDATE ON revenue_protection_cases
  FOR EACH ROW EXECUTE FUNCTION public.arp_touch_updated_at();

-- =============================================================
-- 3. ACTION LOG (audit trail for Recover + Verify)
-- =============================================================

CREATE TABLE IF NOT EXISTS revenue_protection_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES revenue_protection_cases(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN (
    'detected', 'recovery_started', 'verified', 'self_resolved', 'lost', 'dismissed'
  )),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'ai')),
  actor_id uuid,
  method text,
  note text,
  amount_cents integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arp_actions_case ON revenue_protection_actions(case_id, created_at DESC);

ALTER TABLE revenue_protection_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_protection_actions" ON revenue_protection_actions;
CREATE POLICY "select_own_revenue_protection_actions" ON revenue_protection_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. SMALL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_severity(p_cents integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_cents >= 200000 THEN 'critical'
    WHEN p_cents >= 75000 THEN 'high'
    WHEN p_cents >= 25000 THEN 'medium'
    ELSE 'low'
  END;
$$;

CREATE OR REPLACE FUNCTION public.arp_money(p_cents integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || to_char(COALESCE(p_cents, 0) / 100.0, 'FM999,999,990');
$$;

-- Same pricing math the ledger trigger uses, so a quote is worth the same
-- number everywhere in the product.
CREATE OR REPLACE FUNCTION public.arp_quote_total_cents(q public.quotes)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_total integer;
BEGIN
  IF jsonb_typeof(q.options) = 'array' AND jsonb_array_length(q.options) > 0 THEN
    v_total := COALESCE(
      public.quote_option_total_cents(q.options, COALESCE(q.selected_option_id, q.recommended_option_id), q.tax_percent),
      0
    );
  ELSE
    v_total := public.quote_line_items_subtotal_cents(q.line_items);
    v_total := v_total + round(v_total * COALESCE(q.tax_percent, 0) / 100.0);
  END IF;
  RETURN COALESCE(v_total, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.arp_avg_job_cents(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT round(bp.avg_job_value * 100)::integer FROM business_profile bp
      WHERE bp.user_id = p_user_id AND bp.avg_job_value IS NOT NULL AND bp.avg_job_value > 0),
    0
  );
$$;

-- =============================================================
-- 5. UPSERT HELPER (internal)
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_upsert_case(
  p_user_id uuid,
  p_leak_type text,
  p_subject_table text,
  p_subject_id uuid,
  p_subject_key text,
  p_customer_name text,
  p_customer_phone text,
  p_at_risk_cents integer,
  p_value_basis text,
  p_confidence integer,
  p_is_capacity boolean,
  p_reason_code text,
  p_explanation jsonb,
  p_recommended_action jsonb,
  p_due_at timestamptz,
  p_ledger_event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_inserted boolean;
BEGIN
  INSERT INTO revenue_protection_cases (
    user_id, leak_type, subject_table, subject_id, subject_key,
    customer_name, customer_phone, at_risk_cents, value_basis, confidence,
    severity, is_capacity, reason_code, explanation, recommended_action,
    due_at, ledger_event_id
  ) VALUES (
    p_user_id, p_leak_type, p_subject_table, p_subject_id, COALESCE(p_subject_key, ''),
    p_customer_name, p_customer_phone, GREATEST(p_at_risk_cents, 0), p_value_basis, p_confidence,
    public.arp_severity(p_at_risk_cents), p_is_capacity, p_reason_code, p_explanation, p_recommended_action,
    p_due_at, p_ledger_event_id
  )
  ON CONFLICT (user_id, leak_type, subject_table, subject_id, subject_key) DO UPDATE
    SET at_risk_cents = EXCLUDED.at_risk_cents,
        value_basis = EXCLUDED.value_basis,
        confidence = EXCLUDED.confidence,
        severity = EXCLUDED.severity,
        reason_code = EXCLUDED.reason_code,
        explanation = EXCLUDED.explanation,
        recommended_action = EXCLUDED.recommended_action,
        due_at = EXCLUDED.due_at,
        ledger_event_id = COALESCE(EXCLUDED.ledger_event_id, revenue_protection_cases.ledger_event_id),
        last_seen_at = now()
    WHERE revenue_protection_cases.stage IN ('explained', 'recovering')
  RETURNING id, (xmax = 0) INTO v_id, v_inserted;

  IF COALESCE(v_inserted, false) THEN
    INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, note, amount_cents)
    VALUES (p_user_id, v_id, 'detected', 'ai', p_explanation->>'summary', GREATEST(p_at_risk_cents, 0));

    PERFORM public.append_activity_event(
      'revenue_protection_case', v_id, 'revenue_protection.case_detected',
      jsonb_build_object('leak_type', p_leak_type, 'at_risk_cents', GREATEST(p_at_risk_cents, 0),
                         'reason_code', p_reason_code, 'is_capacity', p_is_capacity),
      'ai', NULL, NULL, '{}'::jsonb, p_user_id
    );
  END IF;

  RETURN COALESCE(v_inserted, false);
END;
$$;

-- =============================================================
-- 6. DETECT
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_detect_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s revenue_protection_settings%ROWTYPE;
  r record;
  t record;
  v_new integer := 0;
  v_ins boolean;
  v_est record;
  v_avg integer;
  v_cost integer;
  v_claimed integer;
  v_gap integer;
  v_hours integer;
  v_today date;
  v_day date;
  v_booked integer;
  v_open integer;
  v_target integer;
  v_leak_unit integer;
  v_value integer;
BEGIN
  SELECT * INTO s FROM revenue_protection_settings WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    INSERT INTO revenue_protection_settings (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
    SELECT * INTO s FROM revenue_protection_settings WHERE user_id = p_user_id;
  END IF;

  v_avg := public.arp_avg_job_cents(p_user_id);

  -- ---------------------------------------------------------
  -- 6.1 Quotes sent, no response, past the follow-up window
  -- ---------------------------------------------------------
  FOR r IN
    SELECT q.id, q.customer_name, q.customer_phone, q.sent_at, q.valid_until,
           public.arp_quote_total_cents(q) AS total_cents,
           e.id AS ledger_id, e.status AS ledger_status, e.last_follow_up_at
    FROM quotes q
    LEFT JOIN revenue_recovery_events e ON e.source_table = 'quotes' AND e.source_id = q.id
    WHERE q.user_id = p_user_id
      AND q.status = 'sent'
      AND q.sent_at IS NOT NULL
      AND q.sent_at <= now() - make_interval(hours => s.quote_followup_hours)
      AND (q.valid_until IS NULL OR q.valid_until >= CURRENT_DATE)
  LOOP
    CONTINUE WHEN r.total_cents <= 0;
    -- A human/workflow already followed up inside the window: not a leak yet.
    CONTINUE WHEN r.ledger_status = 'contacted'
      AND r.last_follow_up_at IS NOT NULL
      AND r.last_follow_up_at > now() - make_interval(hours => s.quote_followup_hours);

    v_hours := floor(extract(epoch FROM (now() - r.sent_at)) / 3600)::integer;

    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'quote_not_followed_up',
      p_subject_table => 'quotes', p_subject_id => r.id, p_subject_key => '',
      p_customer_name => r.customer_name, p_customer_phone => r.customer_phone,
      p_at_risk_cents => r.total_cents, p_value_basis => 'quote_amount', p_confidence => 70,
      p_is_capacity => false, p_reason_code => 'quote_no_response',
      p_explanation => jsonb_build_object(
        'summary', format('%s quote sent %s hours ago and nobody has responded or followed up.', public.arp_money(r.total_cents), v_hours),
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Quote value', 'value', public.arp_money(r.total_cents)),
          jsonb_build_object('label', 'Sent', 'value', to_char(r.sent_at, 'YYYY-MM-DD HH24:MI') || ' UTC'),
          jsonb_build_object('label', 'Hours silent', 'value', v_hours::text),
          jsonb_build_object('label', 'Follow-up window', 'value', s.quote_followup_hours::text || 'h')
        ),
        'math', 'Value = quote total (tiered or flat, incl. tax). Risk starts after the follow-up window.',
        'facts', jsonb_build_object('hours_silent', v_hours)
      ),
      p_recommended_action => jsonb_build_object('type', 'follow_up_quote', 'label', 'Follow up on the quote', 'href', '/dashboard/quotes'),
      p_due_at => COALESCE(((r.valid_until + 1)::timestamp AT TIME ZONE 'UTC'), r.sent_at + interval '30 days'),
      p_ledger_event_id => r.ledger_id
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.2 Warranty: under-claimed vs. real costs
  -- ---------------------------------------------------------
  FOR r IN
    SELECT w.id, w.customer_name, w.customer_phone, w.status, w.manufacturer, w.claim_deadline,
           COALESCE(w.part_cost_cents, 0) AS part_c, COALESCE(w.labor_cost_cents, 0) AS labor_c,
           COALESCE(w.claimed_amount_cents, 0) AS claimed_c
    FROM warranty_claims w
    WHERE w.user_id = p_user_id
      AND w.status IN ('eligible', 'packet_pending', 'submitted')
      AND (w.part_cost_cents IS NOT NULL OR w.labor_cost_cents IS NOT NULL)
      AND COALESCE(w.part_cost_cents, 0) + COALESCE(w.labor_cost_cents, 0) > COALESCE(w.claimed_amount_cents, 0)
  LOOP
    v_cost := r.part_c + r.labor_c;
    v_gap := v_cost - r.claimed_c;
    CONTINUE WHEN v_gap <= 0;

    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'warranty_under_claim',
      p_subject_table => 'warranty_claims', p_subject_id => r.id, p_subject_key => 'under_claim',
      p_customer_name => r.customer_name, p_customer_phone => r.customer_phone,
      p_at_risk_cents => v_gap, p_value_basis => 'warranty_costs',
      p_confidence => CASE WHEN r.claimed_c = 0 THEN 60 ELSE 80 END,
      p_is_capacity => false,
      p_reason_code => CASE WHEN r.claimed_c = 0 THEN 'warranty_unclaimed' ELSE 'warranty_under_claim' END,
      p_explanation => jsonb_build_object(
        'summary', CASE WHEN r.claimed_c = 0
          THEN format('%s of part + labor cost is eligible for warranty recovery but nothing has been claimed yet.', public.arp_money(v_gap))
          ELSE format('Claim is %s below the real part + labor cost (%s claimed vs %s spent).', public.arp_money(v_gap), public.arp_money(r.claimed_c), public.arp_money(v_cost)) END,
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Part cost', 'value', public.arp_money(r.part_c)),
          jsonb_build_object('label', 'Labor cost', 'value', public.arp_money(r.labor_c)),
          jsonb_build_object('label', 'Claimed', 'value', public.arp_money(r.claimed_c)),
          jsonb_build_object('label', 'Claim status', 'value', r.status),
          jsonb_build_object('label', 'Manufacturer', 'value', COALESCE(r.manufacturer, 'Not on file'))
        ),
        'math', 'Gap = (part cost + labor cost) - amount claimed.',
        'facts', jsonb_build_object('cost_cents', v_cost, 'claimed_cents', r.claimed_c)
      ),
      p_recommended_action => jsonb_build_object('type', 'amend_claim', 'label', 'Amend the claim to full cost', 'href', '/dashboard/warranty-claims'),
      p_due_at => CASE WHEN r.claim_deadline IS NULL THEN NULL ELSE ((r.claim_deadline + 1)::timestamp AT TIME ZONE 'UTC') END,
      p_ledger_event_id => NULL
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- Warranty: credit received short of what the manufacturer approved
  FOR r IN
    SELECT w.id, w.customer_name, w.customer_phone, w.manufacturer,
           COALESCE(w.approved_amount_cents, 0) AS approved_c,
           COALESCE(w.credit_received_cents, 0) AS credit_c
    FROM warranty_claims w
    WHERE w.user_id = p_user_id
      AND w.status = 'credit_received'
      AND w.approved_amount_cents IS NOT NULL
      AND COALESCE(w.credit_received_cents, 0) < w.approved_amount_cents
  LOOP
    v_gap := r.approved_c - r.credit_c;
    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'warranty_under_claim',
      p_subject_table => 'warranty_claims', p_subject_id => r.id, p_subject_key => 'credit_shortfall',
      p_customer_name => r.customer_name, p_customer_phone => r.customer_phone,
      p_at_risk_cents => v_gap, p_value_basis => 'warranty_costs', p_confidence => 85,
      p_is_capacity => false, p_reason_code => 'warranty_credit_shortfall',
      p_explanation => jsonb_build_object(
        'summary', format('Manufacturer approved %s but only %s was credited — %s is still owed.', public.arp_money(r.approved_c), public.arp_money(r.credit_c), public.arp_money(v_gap)),
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Approved', 'value', public.arp_money(r.approved_c)),
          jsonb_build_object('label', 'Credit received', 'value', public.arp_money(r.credit_c)),
          jsonb_build_object('label', 'Manufacturer', 'value', COALESCE(r.manufacturer, 'Not on file'))
        ),
        'math', 'Owed = approved amount - credit received.',
        'facts', jsonb_build_object('approved_cents', r.approved_c)
      ),
      p_recommended_action => jsonb_build_object('type', 'chase_credit', 'label', 'Chase the missing credit', 'href', '/dashboard/warranty-claims'),
      p_due_at => NULL, p_ledger_event_id => NULL
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.3 Memberships: lapsed un-renewed, or auto-renew off near renewal
  -- ---------------------------------------------------------
  FOR r IN
    SELECT m.id, m.customer_name, m.customer_phone, m.current_period_end, m.auto_renew,
           mp.name AS plan_name, mp.price_cents, mp.billing_interval
    FROM memberships m
    JOIN membership_plans mp ON mp.id = m.plan_id
    WHERE m.user_id = p_user_id
      AND m.status = 'active'
      AND m.current_period_end IS NOT NULL
      AND mp.price_cents > 0
      AND (
        m.current_period_end < now() - interval '2 days'
        OR (m.auto_renew = false AND m.current_period_end <= now() + make_interval(days => s.renewal_lookahead_days))
      )
  LOOP
    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'membership_renewal_missed',
      p_subject_table => 'memberships', p_subject_id => r.id, p_subject_key => '',
      p_customer_name => r.customer_name, p_customer_phone => r.customer_phone,
      p_at_risk_cents => r.price_cents, p_value_basis => 'membership_plan',
      p_confidence => CASE WHEN r.current_period_end < now() - interval '2 days' THEN 75 ELSE 55 END,
      p_is_capacity => false,
      p_reason_code => CASE WHEN r.current_period_end < now() - interval '2 days' THEN 'renewal_lapsed' ELSE 'auto_renew_off' END,
      p_explanation => jsonb_build_object(
        'summary', CASE WHEN r.current_period_end < now() - interval '2 days'
          THEN format('%s plan for this customer passed its renewal date on %s and has not renewed.', r.plan_name, to_char(r.current_period_end, 'YYYY-MM-DD'))
          ELSE format('Auto-renew is off and the %s plan renews on %s — at risk of silent churn.', r.plan_name, to_char(r.current_period_end, 'YYYY-MM-DD')) END,
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Plan', 'value', r.plan_name),
          jsonb_build_object('label', 'Price per cycle', 'value', public.arp_money(r.price_cents) || ' / ' || r.billing_interval),
          jsonb_build_object('label', 'Period end', 'value', to_char(r.current_period_end, 'YYYY-MM-DD')),
          jsonb_build_object('label', 'Auto-renew', 'value', CASE WHEN r.auto_renew THEN 'on' ELSE 'off' END)
        ),
        'math', 'Value = one billing cycle of the customer''s plan.',
        'facts', jsonb_build_object('period_end', r.current_period_end)
      ),
      p_recommended_action => jsonb_build_object('type', 'renewal_outreach', 'label', 'Reach out to renew', 'href', '/dashboard/memberships'),
      p_due_at => now() + interval '14 days', p_ledger_event_id => NULL
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.4 Completed jobs never invoiced
  -- ---------------------------------------------------------
  FOR r IN
    SELECT j.id, j.customer_name, j.service_type,
           COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) AS done_at
    FROM jobs j
    WHERE j.user_id = p_user_id
      AND j.job_status = 'completed'
      AND (j.invoice_amount IS NULL OR j.invoice_amount <= 0)
      AND j.invoice_status = 'not_sent'
      AND COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) <= now() - interval '24 hours'
      AND COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) >= now() - interval '90 days'
  LOOP
    SELECT * INTO v_est FROM public.estimate_missed_call_value_cents(p_user_id, r.service_type);
    CONTINUE WHEN v_est.value_cents IS NULL OR v_est.value_cents <= 0;

    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'unbilled_job',
      p_subject_table => 'jobs', p_subject_id => r.id, p_subject_key => '',
      p_customer_name => r.customer_name, p_customer_phone => NULL,
      p_at_risk_cents => v_est.value_cents, p_value_basis => v_est.basis,
      p_confidence => CASE WHEN v_est.basis = 'price_book_match' THEN 75 ELSE 55 END,
      p_is_capacity => false, p_reason_code => 'job_completed_not_invoiced',
      p_explanation => jsonb_build_object(
        'summary', format('Job completed %s days ago with no invoice or amount recorded — labor and parts are unbilled.', floor(extract(epoch FROM (now() - r.done_at)) / 86400)::integer),
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Service', 'value', COALESCE(r.service_type, 'Not on file')),
          jsonb_build_object('label', 'Completed', 'value', to_char(r.done_at, 'YYYY-MM-DD')),
          jsonb_build_object('label', 'Estimated value', 'value', public.arp_money(v_est.value_cents)),
          jsonb_build_object('label', 'Estimate basis', 'value', CASE WHEN v_est.basis = 'price_book_match' THEN 'Your price book' ELSE 'Your average job value' END)
        ),
        'math', 'Estimate = price-book match for the service, else your configured average job value. Never invented.',
        'facts', '{}'::jsonb
      ),
      p_recommended_action => jsonb_build_object('type', 'send_invoice', 'label', 'Send the invoice now', 'href', '/dashboard/jobs'),
      p_due_at => now() + interval '30 days', p_ledger_event_id => NULL
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.5 Part markup leakage (price-book price below target markup on parts actually installed, last 30d)
  -- ---------------------------------------------------------
  FOR r IN
    SELECT ip.id AS part_id, ip.name, ip.unit_cost_cents, pb.price_cents AS retail_cents, pb.service_name,
           SUM(jpr.quantity_required)::integer AS units
    FROM job_parts_required jpr
    JOIN inventory_parts ip ON ip.id = jpr.part_id
    JOIN price_book_items pb ON pb.id = ip.price_book_item_id AND pb.active
    WHERE jpr.user_id = p_user_id
      AND jpr.status = 'installed'
      AND jpr.updated_at >= now() - interval '30 days'
      AND ip.unit_cost_cents > 0
    GROUP BY ip.id, ip.name, ip.unit_cost_cents, pb.price_cents, pb.service_name
  LOOP
    v_target := ceil(r.unit_cost_cents * (1 + s.min_parts_markup_pct / 100.0))::integer;
    v_leak_unit := v_target - r.retail_cents;
    CONTINUE WHEN v_leak_unit <= 0;

    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'part_markup_leakage',
      p_subject_table => 'inventory_parts', p_subject_id => r.part_id, p_subject_key => '',
      p_customer_name => r.name, p_customer_phone => NULL,
      p_at_risk_cents => v_leak_unit * r.units, p_value_basis => 'cost_markup_gap', p_confidence => 85,
      p_is_capacity => false, p_reason_code => 'markup_below_target',
      p_explanation => jsonb_build_object(
        'summary', format('%s is priced %s below your %s%% minimum markup — %s units installed in the last 30 days leaked %s.', r.name, public.arp_money(v_leak_unit), s.min_parts_markup_pct, r.units, public.arp_money(v_leak_unit * r.units)),
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Unit cost', 'value', public.arp_money(r.unit_cost_cents)),
          jsonb_build_object('label', 'Price-book price', 'value', public.arp_money(r.retail_cents)),
          jsonb_build_object('label', 'Target price', 'value', public.arp_money(v_target)),
          jsonb_build_object('label', 'Units installed (30d)', 'value', r.units::text)
        ),
        'math', 'Leak = (cost x (1 + min markup) - price-book price) x units installed.',
        'facts', jsonb_build_object('target_cents', v_target)
      ),
      p_recommended_action => jsonb_build_object('type', 'reprice_part', 'label', 'Raise the price-book price', 'href', '/dashboard/price-book'),
      p_due_at => NULL, p_ledger_event_id => NULL
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.6 Cancelled appointments with no rebooking (bridges the ledger row)
  -- ---------------------------------------------------------
  FOR r IN
    SELECT j.id, j.customer_name, j.customer_phone, j.customer_id, j.lead_id,
           e.id AS ledger_id, e.estimated_value_cents, e.estimated_value_basis, e.occurred_at
    FROM jobs j
    JOIN revenue_recovery_events e ON e.source_table = 'jobs' AND e.source_id = j.id
    WHERE j.user_id = p_user_id
      AND j.job_status = 'cancelled'
      AND e.status IN ('open', 'contacted')
      AND e.estimated_value_cents > 0
      AND e.occurred_at >= now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.user_id = j.user_id AND j2.id <> j.id AND j2.job_status <> 'cancelled'
          AND j2.created_at >= e.occurred_at
          AND (
            (j.customer_id IS NOT NULL AND j2.customer_id = j.customer_id)
            OR (j.lead_id IS NOT NULL AND j2.lead_id = j.lead_id)
            OR lower(j2.customer_name) = lower(j.customer_name)
          )
      )
  LOOP
    v_ins := public.arp_upsert_case(
      p_user_id => p_user_id, p_leak_type => 'cancelled_appointment',
      p_subject_table => 'jobs', p_subject_id => r.id, p_subject_key => '',
      p_customer_name => r.customer_name, p_customer_phone => r.customer_phone,
      p_at_risk_cents => r.estimated_value_cents, p_value_basis => 'ledger_estimate', p_confidence => 60,
      p_is_capacity => false, p_reason_code => 'cancelled_not_rebooked',
      p_explanation => jsonb_build_object(
        'summary', format('Appointment cancelled %s days ago and the customer has not been rebooked.', floor(extract(epoch FROM (now() - r.occurred_at)) / 86400)::integer),
        'evidence', jsonb_build_array(
          jsonb_build_object('label', 'Cancelled', 'value', to_char(r.occurred_at, 'YYYY-MM-DD')),
          jsonb_build_object('label', 'Estimated value', 'value', public.arp_money(r.estimated_value_cents)),
          jsonb_build_object('label', 'Estimate basis', 'value', r.estimated_value_basis)
        ),
        'math', 'Value comes from the recovery ledger entry recorded when the job was cancelled.',
        'facts', '{}'::jsonb
      ),
      p_recommended_action => jsonb_build_object('type', 'rebook', 'label', 'Offer a new time', 'href', '/dashboard/calendar'),
      p_due_at => r.occurred_at + interval '14 days', p_ledger_event_id => r.ledger_id
    );
    IF v_ins THEN v_new := v_new + 1; END IF;
  END LOOP;

  -- ---------------------------------------------------------
  -- 6.7 Technician idle time (next 48h) — capacity ESTIMATE, excluded from the recoverable total
  -- ---------------------------------------------------------
  IF v_avg > 0 THEN
    v_today := (now() AT TIME ZONE s.timezone)::date;
    FOR t IN
      SELECT tm.id, COALESCE(tm.member_name, tm.member_email) AS name, tm.max_jobs_per_day
      FROM team_members tm
      WHERE tm.account_owner_id = p_user_id AND tm.dispatch_enabled
    LOOP
      FOR d IN 0..2 LOOP
        v_day := v_today + d;
        CONTINUE WHEN d = 0 AND extract(hour FROM (now() AT TIME ZONE s.timezone)) >= 12;

        SELECT count(*) INTO v_booked
        FROM jobs j
        WHERE j.user_id = p_user_id AND j.assigned_technician_id = t.id
          AND j.job_status <> 'cancelled' AND j.scheduled_datetime IS NOT NULL
          AND (j.scheduled_datetime AT TIME ZONE s.timezone)::date = v_day;

        v_open := t.max_jobs_per_day - v_booked;
        -- Only weekdays, or any day the technician already has work (avoids flagging days off).
        CONTINUE WHEN v_open < s.idle_min_open_slots;
        CONTINUE WHEN v_booked = 0 AND extract(isodow FROM v_day) NOT BETWEEN 1 AND 5;

        v_value := round(v_open * v_avg * s.idle_capacity_fill_pct / 100.0)::integer;
        CONTINUE WHEN v_value <= 0;

        v_ins := public.arp_upsert_case(
          p_user_id => p_user_id, p_leak_type => 'technician_idle_time',
          p_subject_table => 'team_members', p_subject_id => t.id, p_subject_key => v_day::text,
          p_customer_name => t.name, p_customer_phone => NULL,
          p_at_risk_cents => v_value, p_value_basis => 'capacity_estimate', p_confidence => 40,
          p_is_capacity => true, p_reason_code => 'open_dispatch_capacity',
          p_explanation => jsonb_build_object(
            'summary', format('%s has %s open job slots on %s (%s of %s booked).', t.name, v_open, to_char(v_day, 'Dy DD Mon'), v_booked, t.max_jobs_per_day),
            'evidence', jsonb_build_array(
              jsonb_build_object('label', 'Open slots', 'value', v_open::text),
              jsonb_build_object('label', 'Booked / max', 'value', v_booked::text || ' / ' || t.max_jobs_per_day::text),
              jsonb_build_object('label', 'Avg job value', 'value', public.arp_money(v_avg)),
              jsonb_build_object('label', 'Fill assumption', 'value', s.idle_capacity_fill_pct::text || '%')
            ),
            'math', 'Estimate = open slots x avg job value x fill assumption. Capacity opportunity, not lost cash.',
            'facts', jsonb_build_object('booked', v_booked, 'open', v_open, 'max', t.max_jobs_per_day)
          ),
          p_recommended_action => jsonb_build_object('type', 'fill_schedule', 'label', 'Fill the open slots', 'href', '/dashboard/dispatch'),
          p_due_at => ((v_day + 1)::timestamp AT TIME ZONE s.timezone), p_ledger_event_id => NULL
        );
        IF v_ins THEN v_new := v_new + 1; END IF;
      END LOOP;
    END LOOP;
  END IF;

  RETURN v_new;
END;
$$;

-- =============================================================
-- 7. VERIFY  (closes the loop against real data)
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_verify_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s revenue_protection_settings%ROWTYPE;
  c revenue_protection_cases%ROWTYPE;
  r record;
  v_resolved boolean;
  v_lost boolean;
  v_gone boolean;
  v_kind text;
  v_amount integer;
  v_note text;
  v_day date;
  v_booked integer;
  v_open_now integer;
  v_open_then integer;
  v_target integer;
  v_secured integer := 0;
  v_protected integer := 0;
  v_lost_n integer := 0;
  v_self integer := 0;
BEGIN
  INSERT INTO revenue_protection_settings (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM revenue_protection_settings WHERE user_id = p_user_id;

  FOR c IN
    SELECT * FROM revenue_protection_cases
    WHERE user_id = p_user_id AND stage IN ('explained', 'recovering')
  LOOP
    v_resolved := false; v_lost := false; v_gone := false; v_kind := NULL; v_amount := 0; v_note := NULL;

    IF c.leak_type = 'quote_not_followed_up' THEN
      SELECT q.status INTO r FROM quotes q WHERE q.id = c.subject_id AND q.user_id = p_user_id;
      IF NOT FOUND THEN v_gone := true;
      ELSIF r.status = 'accepted' THEN v_resolved := true; v_kind := 'secured'; v_amount := c.at_risk_cents; v_note := 'Quote accepted';
      ELSIF r.status IN ('declined', 'expired') THEN v_lost := true; v_note := 'Quote ' || r.status;
      END IF;

    ELSIF c.leak_type = 'warranty_under_claim' THEN
      SELECT w.status, COALESCE(w.part_cost_cents, 0) + COALESCE(w.labor_cost_cents, 0) AS cost_c,
             COALESCE(w.claimed_amount_cents, 0) AS claimed_c, COALESCE(w.approved_amount_cents, 0) AS approved_c,
             COALESCE(w.credit_received_cents, 0) AS credit_c
        INTO r FROM warranty_claims w WHERE w.id = c.subject_id AND w.user_id = p_user_id;
      IF NOT FOUND THEN v_gone := true;
      ELSIF c.subject_key = 'credit_shortfall' THEN
        IF r.credit_c >= r.approved_c THEN v_resolved := true; v_kind := 'secured'; v_amount := c.at_risk_cents; v_note := 'Full credit received'; END IF;
      ELSE
        IF r.status = 'credit_received' AND r.credit_c >= r.cost_c THEN
          v_resolved := true; v_kind := 'secured'; v_amount := c.at_risk_cents; v_note := 'Full credit received';
        ELSIF r.claimed_c >= r.cost_c THEN
          v_resolved := true; v_kind := 'protected'; v_amount := c.at_risk_cents; v_note := 'Claim amended to full cost';
        ELSIF r.status IN ('denied', 'closed') THEN
          v_lost := true; v_note := 'Claim ' || r.status;
        END IF;
      END IF;

    ELSIF c.leak_type = 'membership_renewal_missed' THEN
      SELECT m.status, m.current_period_end, m.auto_renew INTO r
        FROM memberships m WHERE m.id = c.subject_id AND m.user_id = p_user_id;
      IF NOT FOUND THEN v_gone := true;
      ELSIF r.status IN ('cancelled', 'churned') THEN v_lost := true; v_note := 'Membership ' || r.status;
      ELSIF r.status = 'active' AND r.current_period_end > now()
            AND r.current_period_end > COALESCE((c.explanation->'facts'->>'period_end')::timestamptz, '-infinity'::timestamptz) THEN
        v_resolved := true; v_kind := 'secured'; v_amount := c.at_risk_cents; v_note := 'Membership renewed';
      ELSIF c.reason_code = 'auto_renew_off' AND r.auto_renew THEN
        v_resolved := true; v_kind := 'protected'; v_amount := c.at_risk_cents; v_note := 'Auto-renew re-enabled';
      END IF;

    ELSIF c.leak_type = 'unbilled_job' THEN
      SELECT j.job_status, j.invoice_amount, j.invoice_status INTO r
        FROM jobs j WHERE j.id = c.subject_id AND j.user_id = p_user_id;
      IF NOT FOUND THEN v_gone := true;
      ELSIF r.job_status = 'cancelled' THEN v_gone := true;
      ELSIF r.invoice_status = 'paid' THEN
        v_resolved := true; v_kind := 'secured';
        v_amount := CASE WHEN COALESCE(r.invoice_amount, 0) > 0 THEN round(r.invoice_amount * 100)::integer ELSE c.at_risk_cents END;
        v_note := 'Invoice paid';
      ELSIF r.invoice_status <> 'not_sent' OR COALESCE(r.invoice_amount, 0) > 0 THEN
        v_resolved := true; v_kind := 'protected'; v_amount := c.at_risk_cents; v_note := 'Invoice issued, awaiting payment';
      END IF;

    ELSIF c.leak_type = 'part_markup_leakage' THEN
      SELECT ip.unit_cost_cents, pb.price_cents AS retail_cents INTO r
        FROM inventory_parts ip JOIN price_book_items pb ON pb.id = ip.price_book_item_id
        WHERE ip.id = c.subject_id AND ip.user_id = p_user_id;
      IF NOT FOUND THEN v_gone := true;
      ELSE
        v_target := ceil(r.unit_cost_cents * (1 + s.min_parts_markup_pct / 100.0))::integer;
        IF r.retail_cents >= v_target THEN
          v_resolved := true; v_kind := 'protected'; v_amount := c.at_risk_cents; v_note := 'Price now meets target markup';
        END IF;
      END IF;

    ELSIF c.leak_type = 'cancelled_appointment' THEN
      SELECT j2.id, j2.invoice_amount INTO r
        FROM jobs j
        JOIN jobs j2 ON j2.user_id = j.user_id AND j2.id <> j.id AND j2.job_status <> 'cancelled'
                    AND j2.created_at >= c.detected_at - interval '1 day'
                    AND ((j.customer_id IS NOT NULL AND j2.customer_id = j.customer_id)
                      OR (j.lead_id IS NOT NULL AND j2.lead_id = j.lead_id)
                      OR lower(j2.customer_name) = lower(j.customer_name))
        WHERE j.id = c.subject_id AND j.user_id = p_user_id
        ORDER BY j2.created_at DESC LIMIT 1;
      IF FOUND THEN
        v_resolved := true; v_kind := 'secured';
        v_amount := CASE WHEN COALESCE(r.invoice_amount, 0) > 0 THEN round(r.invoice_amount * 100)::integer ELSE c.at_risk_cents END;
        v_note := 'Customer rebooked';
      ELSIF c.due_at IS NOT NULL AND c.due_at < now() THEN
        v_lost := true; v_note := 'No rebooking within 14 days';
      END IF;

    ELSIF c.leak_type = 'technician_idle_time' THEN
      v_day := c.subject_key::date;
      SELECT count(*) INTO v_booked FROM jobs j
        WHERE j.user_id = p_user_id AND j.assigned_technician_id = c.subject_id
          AND j.job_status <> 'cancelled' AND j.scheduled_datetime IS NOT NULL
          AND (j.scheduled_datetime AT TIME ZONE s.timezone)::date = v_day;
      v_open_then := COALESCE((c.explanation->'facts'->>'open')::integer, 0);
      v_open_now := COALESCE((c.explanation->'facts'->>'max')::integer, 0) - v_booked;
      IF v_open_now < s.idle_min_open_slots THEN
        v_resolved := true; v_kind := 'capacity_filled'; v_amount := 0;
        v_note := format('%s slot(s) filled', GREATEST(v_open_then - v_open_now, 0));
      ELSIF v_day < (now() AT TIME ZONE s.timezone)::date THEN
        v_lost := true; v_note := 'Capacity went unused';
      END IF;
    END IF;

    IF v_gone THEN
      UPDATE revenue_protection_cases
        SET stage = 'dismissed', closed_at = now(), verification = jsonb_build_object('reason', 'source_removed_or_not_applicable')
        WHERE id = c.id;
      INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, note)
        VALUES (p_user_id, c.id, 'dismissed', 'ai', 'Source record removed or no longer applicable');

    ELSIF v_lost THEN
      UPDATE revenue_protection_cases
        SET stage = 'lost', closed_at = now(), verification = jsonb_build_object('reason', v_note)
        WHERE id = c.id;
      INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, note, amount_cents)
        VALUES (p_user_id, c.id, 'lost', 'ai', v_note, CASE WHEN c.is_capacity THEN 0 ELSE c.at_risk_cents END);
      v_lost_n := v_lost_n + 1;

    ELSIF v_resolved THEN
      IF c.stage = 'recovering' THEN
        UPDATE revenue_protection_cases
          SET stage = 'verified', closed_at = now(), verification_kind = v_kind, verified_amount_cents = v_amount,
              verification = jsonb_build_object('reason', v_note, 'verified_at', now())
          WHERE id = c.id;
        INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, note, amount_cents)
          VALUES (p_user_id, c.id, 'verified', 'ai', v_note, v_amount);
        IF v_kind = 'secured' THEN v_secured := v_secured + v_amount; ELSIF v_kind = 'protected' THEN v_protected := v_protected + v_amount; END IF;
      ELSE
        -- Resolved without any recovery action from us: never claimed as a win.
        UPDATE revenue_protection_cases
          SET stage = 'self_resolved', closed_at = now(), verified_amount_cents = 0,
              verification = jsonb_build_object('reason', v_note, 'resolved_without_intervention', true)
          WHERE id = c.id;
        INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, note)
          VALUES (p_user_id, c.id, 'self_resolved', 'ai', v_note);
        v_self := v_self + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('secured_cents', v_secured, 'protected_cents', v_protected, 'lost', v_lost_n, 'self_resolved', v_self);
END;
$$;

-- =============================================================
-- 8. SCAN ORCHESTRATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_scan_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new integer;
  v_verify jsonb;
BEGIN
  -- Verify first so cases that just resolved are not re-touched by detection.
  v_verify := public.arp_verify_user(p_user_id);
  v_new := public.arp_detect_user(p_user_id);
  UPDATE revenue_protection_settings SET last_scan_at = now() WHERE user_id = p_user_id;
  RETURN jsonb_build_object('new_cases', v_new, 'verification', v_verify, 'scanned_at', now());
END;
$$;

CREATE OR REPLACE FUNCTION public.arp_scan_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u record;
  v_count integer := 0;
BEGIN
  FOR u IN
    SELECT DISTINCT j.user_id
    FROM jobs j JOIN profiles p ON p.id = j.user_id
    WHERE j.created_at >= now() - interval '180 days'
  LOOP
    BEGIN
      PERFORM public.arp_scan_user(u.user_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One tenant's bad data must never stop the sweep for everyone else.
      RAISE WARNING 'arp_scan_user failed for %: %', u.user_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

-- =============================================================
-- 9. CLIENT RPCs  (Recover step + on-demand scan)
-- =============================================================

CREATE OR REPLACE FUNCTION public.arp_run_scan(p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  v_last timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT last_scan_at INTO v_last FROM revenue_protection_settings WHERE user_id = v_user;
  IF NOT p_force AND v_last IS NOT NULL AND v_last > now() - interval '20 seconds' THEN
    RETURN jsonb_build_object('throttled', true, 'scanned_at', v_last);
  END IF;
  RETURN public.arp_scan_user(v_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.arp_start_recovery(p_case_id uuid, p_method text, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  v_case revenue_protection_cases%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_method NOT IN ('callback', 'sms', 'email', 'quote_resent', 'invoice_sent', 'claim_amended',
                      'renewal_outreach', 'price_updated', 'rebooked', 'schedule_filled', 'other') THEN
    RAISE EXCEPTION 'Unknown recovery method: %', p_method USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case FROM revenue_protection_cases
    WHERE id = p_case_id AND user_id = v_user AND stage IN ('explained', 'recovering') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE revenue_protection_cases
    SET stage = 'recovering',
        recovery_started_at = COALESCE(recovery_started_at, now()),
        recovery_method = p_method,
        recovery_started_by = auth.uid()
    WHERE id = p_case_id;

  INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, actor_id, method, note)
    VALUES (v_user, p_case_id, 'recovery_started', 'user', auth.uid(), p_method, NULLIF(trim(COALESCE(p_note, '')), ''));

  PERFORM public.append_activity_event(
    'revenue_protection_case', p_case_id, 'revenue_protection.recovery_started',
    jsonb_build_object('method', p_method, 'leak_type', v_case.leak_type, 'at_risk_cents', v_case.at_risk_cents),
    'user', NULL, NULL, '{}'::jsonb, v_user
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.arp_dismiss_case(p_case_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  UPDATE revenue_protection_cases
    SET stage = 'dismissed', closed_at = now(),
        verification = jsonb_build_object('reason', 'dismissed_by_user', 'note', NULLIF(trim(COALESCE(p_note, '')), ''))
    WHERE id = p_case_id AND user_id = v_user AND stage IN ('explained', 'recovering');
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO revenue_protection_actions (user_id, case_id, action_type, actor_type, actor_id, note)
    VALUES (v_user, p_case_id, 'dismissed', 'user', auth.uid(), NULLIF(trim(COALESCE(p_note, '')), ''));
  RETURN true;
END;
$$;

-- =============================================================
-- 10. PERMISSIONS
-- =============================================================

REVOKE ALL ON FUNCTION public.arp_upsert_case(uuid, text, text, uuid, text, text, text, integer, text, integer, boolean, text, jsonb, jsonb, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arp_detect_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arp_verify_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arp_scan_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arp_scan_all() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.arp_scan_all() TO service_role;
GRANT EXECUTE ON FUNCTION public.arp_scan_user(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.arp_run_scan(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.arp_start_recovery(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.arp_dismiss_case(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arp_run_scan(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.arp_start_recovery(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.arp_dismiss_case(uuid, text) TO authenticated;

-- =============================================================
-- 11. REALTIME + SCHEDULE (both guarded — never fail the migration)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE revenue_protection_cases;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN RAISE NOTICE 'Could not add revenue_protection_cases to realtime: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-revenue-protection-scan', '*/10 * * * *', 'select public.arp_scan_all()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled — call select public.arp_scan_all() from any scheduler every 10 minutes.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule revenue protection scan: %', SQLERRM;
END $$;
