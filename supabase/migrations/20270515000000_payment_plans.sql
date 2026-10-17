/*
  # Payment Plans — deposits, installments, late fees, reminders, auto-charge

  ## Money flow (same trust model as payment_requests)
  Destination charges on the platform account (transfer_data.destination = the contractor's
  Connect account). The customer pays the deposit through Stripe Checkout, which also saves the
  card for off-session use (customer consent = completing Checkout after seeing the plan terms).
  Later installments are charged off-session by the payment-plan-runner edge function.

  ## Design
  - All money in integer cents. Installments are generated SERVER-SIDE by create_payment_plan();
    the client only previews the same schedule.
  - Late fees: assessed once per installment, never compounding, only on plans whose terms the
    customer accepted, bounded by a sanity guard (<= 25% of the smallest installment) and an
    optional cap. Late-fee law differs by state/country — the owner is responsible for the rates.
  - Staff access = account owner or team member with permissions.can_view_billing. Everything is
    scoped by public.get_account_owner_id(). Clients can only READ tables; every write goes through
    the RPCs below (staff) or service-role RPCs (webhook / runner).
  - Charging is claim-based (claim_installment_for_charge) so overlapping cron runs can never
    double-charge, and Stripe idempotency keys include the attempt number.

  ## Requires (already in your project)
  get_account_owner_id(), update_updated_at(), profiles, team_members, jobs(invoice_status),
  notifications.

  ## Scheduling (run once, after deploying payment-plan-runner)
    select cron.schedule('payment-plan-runner', '7 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/payment-plan-runner',
        headers := jsonb_build_object('X-Cron-Secret', '<PAYMENT_PLAN_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

-- =============================================================
-- ACCESS HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_payment_plans()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_payment_plans() TO authenticated;

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS payment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
  customer_email text,
  customer_phone text,
  currency text NOT NULL DEFAULT 'usd',
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  deposit_cents bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  installment_count integer NOT NULL CHECK (installment_count BETWEEN 1 AND 24),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  first_due_date date NOT NULL,
  late_fee_type text NOT NULL DEFAULT 'none' CHECK (late_fee_type IN ('none', 'flat', 'percent')),
  late_fee_value numeric NOT NULL DEFAULT 0 CHECK (late_fee_value >= 0), -- cents when flat, percent when percent
  late_fee_cap_cents bigint NOT NULL DEFAULT 0 CHECK (late_fee_cap_cents >= 0), -- 0 = no cap
  grace_days integer NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 30),
  auto_charge boolean NOT NULL DEFAULT true,
  max_charge_attempts integer NOT NULL DEFAULT 3 CHECK (max_charge_attempts BETWEEN 1 AND 6),
  retry_interval_days integer NOT NULL DEFAULT 2 CHECK (retry_interval_days BETWEEN 1 AND 7),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_authorization', 'active', 'paused', 'completed', 'canceled')),
  stripe_customer_id text,
  stripe_payment_method_id text,
  authorization_url text,
  authorization_session_id text,
  authorization_sent_at timestamptz,
  terms_text text,
  terms_accepted_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  CONSTRAINT payment_plans_deposit_lt_total CHECK (deposit_cents < total_cents),
  CONSTRAINT payment_plans_no_card_needs_deposit CHECK (deposit_cents > 0 OR auto_charge)
);
CREATE INDEX IF NOT EXISTS idx_payment_plans_user_status ON payment_plans(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_plans_job ON payment_plans(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind IN ('deposit', 'installment')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  late_fee_cents bigint NOT NULL DEFAULT 0 CHECK (late_fee_cents >= 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'requires_action', 'failed', 'paid', 'waived', 'canceled')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  paid_at timestamptz,
  paid_cents bigint NOT NULL DEFAULT 0,
  payment_method text CHECK (payment_method IS NULL OR payment_method IN ('stripe', 'offline')),
  stripe_payment_intent_id text,
  pay_link_url text,
  pay_link_created_at timestamptz,
  last_error text,
  reminders_sent text[] NOT NULL DEFAULT '{}',
  late_fee_assessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_plan_installments_open ON payment_plan_installments(due_date)
  WHERE status IN ('scheduled', 'failed', 'requires_action', 'processing');
CREATE INDEX IF NOT EXISTS idx_plan_installments_user ON payment_plan_installments(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_plan_installments_pi ON payment_plan_installments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_plan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_id uuid REFERENCES payment_plan_installments(id) ON DELETE SET NULL,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_events_plan ON payment_plan_events(plan_id, created_at DESC);

DROP TRIGGER IF EXISTS trigger_payment_plans_updated_at ON payment_plans;
CREATE TRIGGER trigger_payment_plans_updated_at BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_plan_installments_updated_at ON payment_plan_installments;
CREATE TRIGGER trigger_plan_installments_updated_at BEFORE UPDATE ON payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- RLS — read-only for clients
-- =============================================================
ALTER TABLE payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plan_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plan_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_payment_plans" ON payment_plans;
CREATE POLICY "select_own_payment_plans" ON payment_plans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());
DROP POLICY IF EXISTS "select_own_plan_installments" ON payment_plan_installments;
CREATE POLICY "select_own_plan_installments" ON payment_plan_installments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());
DROP POLICY IF EXISTS "select_own_plan_events" ON payment_plan_events;
CREATE POLICY "select_own_plan_events" ON payment_plan_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.log_plan_event(p_plan uuid, p_installment uuid, p_type text, p_detail jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO payment_plan_events (user_id, plan_id, installment_id, type, detail)
  SELECT user_id, id, p_installment, p_type, COALESCE(p_detail, '{}') FROM payment_plans WHERE id = p_plan;
$$;
REVOKE ALL ON FUNCTION public.log_plan_event(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_plan_owner(p_user uuid, p_plan uuid, p_title text, p_message text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (p_user, 'system', p_title, p_message, '/dashboard/payment-plans?p=' || p_plan::text);
$$;
REVOKE ALL ON FUNCTION public.notify_plan_owner(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Marks the plan completed (and the job paid) once nothing collectable is left.
CREATE OR REPLACE FUNCTION public.finalize_plan_if_done(p_plan uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_plan payment_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.status NOT IN ('active', 'paused') THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM payment_plan_installments WHERE plan_id = p_plan
             AND status IN ('scheduled', 'processing', 'requires_action', 'failed')) THEN RETURN; END IF;
  UPDATE payment_plans SET status = 'completed' WHERE id = p_plan;
  IF v_plan.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM payment_plan_installments WHERE plan_id = p_plan AND status = 'paid') THEN
    UPDATE jobs SET invoice_status = 'paid' WHERE id = v_plan.job_id AND user_id = v_plan.user_id;
  END IF;
  PERFORM public.log_plan_event(p_plan, NULL, 'plan_completed');
  PERFORM public.notify_plan_owner(v_plan.user_id, p_plan, 'Payment plan completed',
    v_plan.customer_name || '''s plan is fully paid.');
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_plan_if_done(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- STAFF RPC: create (generates the schedule)
-- p = { job_id?, customer_name, customer_email?, customer_phone?, total_cents, deposit_cents,
--       installment_count, frequency, first_due_date, late_fee_type, late_fee_value, late_fee_cap_cents,
--       grace_days, auto_charge, max_charge_attempts, retry_interval_days, notes? }
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_payment_plan(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_total bigint := (p ->> 'total_cents')::bigint;
  v_deposit bigint := COALESCE((p ->> 'deposit_cents')::bigint, 0);
  v_n integer := (p ->> 'installment_count')::integer;
  v_freq text := p ->> 'frequency';
  v_first date := (p ->> 'first_due_date')::date;
  v_fee_type text := COALESCE(p ->> 'late_fee_type', 'none');
  v_fee_value numeric := COALESCE((p ->> 'late_fee_value')::numeric, 0);
  v_rem bigint; v_base bigint; v_extra integer; v_min bigint;
  v_job uuid := NULLIF(p ->> 'job_id', '')::uuid;
  v_plan uuid;
  i integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_total IS NULL OR v_total <= 0 OR v_total > 100000000 THEN RAISE EXCEPTION 'Invalid total amount' USING ERRCODE = '22023'; END IF;
  IF v_deposit < 0 OR v_deposit >= v_total THEN RAISE EXCEPTION 'Deposit must be less than the total' USING ERRCODE = '22023'; END IF;
  IF v_n IS NULL OR v_n < 1 OR v_n > 24 THEN RAISE EXCEPTION 'Installments must be between 1 and 24' USING ERRCODE = '22023'; END IF;
  IF v_freq NOT IN ('weekly', 'biweekly', 'monthly') THEN RAISE EXCEPTION 'Invalid frequency' USING ERRCODE = '22023'; END IF;
  IF v_first IS NULL OR v_first < current_date THEN RAISE EXCEPTION 'First due date cannot be in the past' USING ERRCODE = '22023'; END IF;
  IF NULLIF(btrim(p ->> 'customer_name'), '') IS NULL THEN RAISE EXCEPTION 'Customer name is required' USING ERRCODE = '22023'; END IF;
  IF NULLIF(p ->> 'customer_email', '') IS NULL AND NULLIF(p ->> 'customer_phone', '') IS NULL THEN
    RAISE EXCEPTION 'Add a customer email or phone number' USING ERRCODE = '22023';
  END IF;
  IF v_deposit = 0 AND NOT COALESCE((p ->> 'auto_charge')::boolean, true) THEN
    RAISE EXCEPTION 'A plan without a deposit must use auto-charge' USING ERRCODE = '22023';
  END IF;
  IF v_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  v_rem := v_total - v_deposit;
  v_base := v_rem / v_n;
  v_extra := (v_rem % v_n)::integer;               -- first v_extra installments carry +1 cent
  v_min := v_base;
  IF v_min < 500 THEN RAISE EXCEPTION 'Each installment must be at least 5.00' USING ERRCODE = '22023'; END IF;

  IF v_fee_type NOT IN ('none', 'flat', 'percent') THEN RAISE EXCEPTION 'Invalid late fee type' USING ERRCODE = '22023'; END IF;
  IF v_fee_type = 'percent' AND v_fee_value > 25 THEN RAISE EXCEPTION 'Late fee cannot exceed 25%% of an installment' USING ERRCODE = '22023'; END IF;
  IF v_fee_type = 'flat' AND v_fee_value > v_min * 0.25 THEN RAISE EXCEPTION 'Late fee cannot exceed 25%% of the smallest installment' USING ERRCODE = '22023'; END IF;

  INSERT INTO payment_plans (
    user_id, job_id, customer_name, customer_email, customer_phone, total_cents, deposit_cents, installment_count,
    frequency, first_due_date, late_fee_type, late_fee_value, late_fee_cap_cents, grace_days, auto_charge,
    max_charge_attempts, retry_interval_days, notes
  ) VALUES (
    v_owner, v_job, btrim(p ->> 'customer_name'), NULLIF(btrim(p ->> 'customer_email'), ''), NULLIF(btrim(p ->> 'customer_phone'), ''),
    v_total, v_deposit, v_n, v_freq, v_first, v_fee_type, CASE WHEN v_fee_type = 'none' THEN 0 ELSE v_fee_value END,
    CASE WHEN v_fee_type = 'none' THEN 0 ELSE COALESCE((p ->> 'late_fee_cap_cents')::bigint, 0) END,
    COALESCE((p ->> 'grace_days')::integer, 3), COALESCE((p ->> 'auto_charge')::boolean, true),
    COALESCE((p ->> 'max_charge_attempts')::integer, 3), COALESCE((p ->> 'retry_interval_days')::integer, 2),
    NULLIF(btrim(COALESCE(p ->> 'notes', '')), '')
  ) RETURNING id INTO v_plan;

  IF v_deposit > 0 THEN
    INSERT INTO payment_plan_installments (user_id, plan_id, seq, kind, amount_cents, due_date)
    VALUES (v_owner, v_plan, 0, 'deposit', v_deposit, current_date);
  END IF;
  FOR i IN 1..v_n LOOP
    INSERT INTO payment_plan_installments (user_id, plan_id, seq, kind, amount_cents, due_date)
    VALUES (v_owner, v_plan, i, 'installment', v_base + CASE WHEN i <= v_extra THEN 1 ELSE 0 END,
      CASE v_freq
        WHEN 'weekly' THEN v_first + (i - 1) * 7
        WHEN 'biweekly' THEN v_first + (i - 1) * 14
        ELSE (v_first + make_interval(months => i - 1))::date
      END);
  END LOOP;

  PERFORM public.log_plan_event(v_plan, NULL, 'plan_created', jsonb_build_object('total_cents', v_total, 'deposit_cents', v_deposit, 'installments', v_n));
  RETURN v_plan;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_payment_plan(jsonb) TO authenticated;

-- =============================================================
-- STAFF RPCs: waive fee, record offline payment, pause / resume / cancel
-- =============================================================
CREATE OR REPLACE FUNCTION public.waive_plan_late_fee(p_installment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row payment_plan_installments%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE payment_plan_installments SET late_fee_cents = 0
  WHERE id = p_installment_id AND user_id = v_owner AND status IN ('scheduled', 'failed', 'requires_action') AND late_fee_cents > 0
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'No open late fee on this installment' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.log_plan_event(v_row.plan_id, v_row.id, 'late_fee_waived');
END; $$;
GRANT EXECUTE ON FUNCTION public.waive_plan_late_fee(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_offline_installment_payment(p_installment_id uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row payment_plan_installments%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE payment_plan_installments i SET status = 'paid', paid_at = now(), paid_cents = i.amount_cents + i.late_fee_cents,
    payment_method = 'offline', last_error = NULL, next_attempt_at = NULL
  FROM payment_plans pl
  WHERE i.id = p_installment_id AND i.user_id = v_owner AND pl.id = i.plan_id AND pl.status IN ('active', 'paused', 'pending_authorization')
    AND i.status IN ('scheduled', 'failed', 'requires_action')
  RETURNING i.* INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'This installment cannot be marked as paid' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.log_plan_event(v_row.plan_id, v_row.id, 'offline_payment_recorded', jsonb_build_object('note', left(COALESCE(p_note, ''), 300)));
  PERFORM public.finalize_plan_if_done(v_row.plan_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.record_offline_installment_payment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_payment_plan_status(p_plan_id uuid, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_plan payment_plans%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE = 'P0002'; END IF;
  IF p_action = 'pause' AND v_plan.status = 'active' THEN
    UPDATE payment_plans SET status = 'paused' WHERE id = p_plan_id;
  ELSIF p_action = 'resume' AND v_plan.status = 'paused' THEN
    UPDATE payment_plans SET status = 'active' WHERE id = p_plan_id;
  ELSIF p_action = 'cancel' AND v_plan.status IN ('draft', 'pending_authorization', 'active', 'paused') THEN
    UPDATE payment_plan_installments SET status = 'canceled', next_attempt_at = NULL
      WHERE plan_id = p_plan_id AND status IN ('scheduled', 'failed', 'requires_action');
    UPDATE payment_plans SET status = 'canceled', canceled_at = now() WHERE id = p_plan_id;
  ELSE
    RAISE EXCEPTION 'That action is not available for this plan' USING ERRCODE = '22023';
  END IF;
  PERFORM public.log_plan_event(p_plan_id, NULL, 'plan_' || p_action);
END; $$;
GRANT EXECUTE ON FUNCTION public.set_payment_plan_status(uuid, text) TO authenticated;

-- =============================================================
-- STATS
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_payment_plan_stats()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_res jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'active_plans', (SELECT count(*) FROM payment_plans WHERE user_id = v_owner AND status IN ('active', 'paused')),
    'awaiting_approval', (SELECT count(*) FROM payment_plans WHERE user_id = v_owner AND status IN ('draft', 'pending_authorization')),
    'outstanding_cents', COALESCE(sum(i.amount_cents + i.late_fee_cents) FILTER (WHERE i.status IN ('scheduled', 'processing', 'requires_action', 'failed') AND pl.status IN ('active', 'paused')), 0),
    'overdue_cents', COALESCE(sum(i.amount_cents + i.late_fee_cents) FILTER (WHERE i.status IN ('scheduled', 'requires_action', 'failed') AND i.due_date < current_date AND pl.status IN ('active', 'paused')), 0),
    'overdue_count', count(*) FILTER (WHERE i.status IN ('scheduled', 'requires_action', 'failed') AND i.due_date < current_date AND pl.status IN ('active', 'paused')),
    'due_7d_cents', COALESCE(sum(i.amount_cents + i.late_fee_cents) FILTER (WHERE i.status IN ('scheduled', 'failed') AND i.due_date BETWEEN current_date AND current_date + 7 AND pl.status = 'active'), 0),
    'collected_30d_cents', COALESCE(sum(i.paid_cents) FILTER (WHERE i.status = 'paid' AND i.paid_at >= now() - interval '30 days'), 0),
    'late_fees_assessed_cents', COALESCE(sum(i.late_fee_cents) FILTER (WHERE i.late_fee_assessed_at IS NOT NULL AND i.status <> 'canceled'), 0),
    'failed_charges', count(*) FILTER (WHERE i.status = 'failed' AND i.attempt_count >= pl.max_charge_attempts AND pl.status IN ('active', 'paused'))
  ) INTO v_res
  FROM payment_plan_installments i JOIN payment_plans pl ON pl.id = i.plan_id
  WHERE i.user_id = v_owner;
  RETURN COALESCE(v_res, '{}'::jsonb);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_payment_plan_stats() TO authenticated;

-- =============================================================
-- SERVICE-ROLE RPCs (webhook / runner / actions edge functions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.activate_payment_plan(p_plan_id uuid, p_payment_method text, p_customer text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_plan payment_plans%ROWTYPE;
BEGIN
  UPDATE payment_plans SET status = 'active', terms_accepted_at = COALESCE(terms_accepted_at, now()),
    stripe_payment_method_id = COALESCE(p_payment_method, stripe_payment_method_id),
    stripe_customer_id = COALESCE(p_customer, stripe_customer_id)
  WHERE id = p_plan_id AND status IN ('draft', 'pending_authorization')
  RETURNING * INTO v_plan;
  IF FOUND THEN
    PERFORM public.log_plan_event(p_plan_id, NULL, 'customer_approved');
    PERFORM public.notify_plan_owner(v_plan.user_id, p_plan_id, 'Payment plan approved', v_plan.customer_name || ' approved the plan and saved a payment method.');
  ELSIF p_payment_method IS NOT NULL THEN  -- card refresh on an already-active plan
    UPDATE payment_plans SET stripe_payment_method_id = p_payment_method, stripe_customer_id = COALESCE(p_customer, stripe_customer_id)
    WHERE id = p_plan_id AND status IN ('active', 'paused');
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.activate_payment_plan(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_payment_plan(uuid, text, text) TO service_role;

-- p_status: 'succeeded' | 'failed' | 'requires_action'. Idempotent per installment.
CREATE OR REPLACE FUNCTION public.apply_plan_payment(p_installment_id uuid, p_payment_intent text, p_status text, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i payment_plan_installments%ROWTYPE; v_plan payment_plans%ROWTYPE; v_final boolean;
BEGIN
  SELECT * INTO v_i FROM payment_plan_installments WHERE id = p_installment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_i.status = 'paid' THEN RETURN jsonb_build_object('result', 'noop'); END IF;
  SELECT * INTO v_plan FROM payment_plans WHERE id = v_i.plan_id;

  IF p_status = 'succeeded' THEN
    UPDATE payment_plan_installments SET status = 'paid', paid_at = now(), paid_cents = amount_cents + late_fee_cents,
      payment_method = 'stripe', stripe_payment_intent_id = COALESCE(p_payment_intent, stripe_payment_intent_id),
      last_error = NULL, next_attempt_at = NULL WHERE id = p_installment_id;
    PERFORM public.log_plan_event(v_i.plan_id, v_i.id, 'payment_succeeded', jsonb_build_object('cents', v_i.amount_cents + v_i.late_fee_cents));
    PERFORM public.finalize_plan_if_done(v_i.plan_id);
    RETURN jsonb_build_object('result', 'paid');
  ELSIF p_status = 'requires_action' THEN
    UPDATE payment_plan_installments SET status = 'requires_action', stripe_payment_intent_id = COALESCE(p_payment_intent, stripe_payment_intent_id),
      last_error = 'The customer must confirm this payment.', next_attempt_at = NULL WHERE id = p_installment_id;
    PERFORM public.log_plan_event(v_i.plan_id, v_i.id, 'payment_requires_action');
    RETURN jsonb_build_object('result', 'requires_action');
  ELSE
    v_final := v_i.attempt_count >= v_plan.max_charge_attempts;
    UPDATE payment_plan_installments SET status = 'failed', last_error = left(COALESCE(p_error, 'Card was declined.'), 300),
      next_attempt_at = CASE WHEN v_final THEN NULL ELSE now() + make_interval(days => v_plan.retry_interval_days) END
    WHERE id = p_installment_id;
    PERFORM public.log_plan_event(v_i.plan_id, v_i.id, 'payment_failed', jsonb_build_object('attempt', v_i.attempt_count, 'error', left(COALESCE(p_error, ''), 300), 'final', v_final));
    IF v_final THEN
      PERFORM public.notify_plan_owner(v_plan.user_id, v_plan.id, 'Auto-charge failed',
        format('%s: installment %s failed %s times. Contact the customer or record an offline payment.', v_plan.customer_name, v_i.seq, v_i.attempt_count));
    END IF;
    RETURN jsonb_build_object('result', 'failed', 'final', v_final);
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.apply_plan_payment(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_plan_payment(uuid, text, text, text) TO service_role;

-- Atomically claims an installment for charging. Returns NULL when someone else has it / it is not chargeable.
-- A 'processing' row stuck for > 30 min is re-claimed WITHOUT bumping attempt_count so the same Stripe idempotency key replays.
CREATE OR REPLACE FUNCTION public.claim_installment_for_charge(p_installment_id uuid, p_manual boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i payment_plan_installments%ROWTYPE; v_plan payment_plans%ROWTYPE;
BEGIN
  SELECT i.* INTO v_i FROM payment_plan_installments i WHERE i.id = p_installment_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_plan FROM payment_plans WHERE id = v_i.plan_id;
  IF v_plan.status <> 'active' OR v_plan.stripe_customer_id IS NULL OR v_plan.stripe_payment_method_id IS NULL OR v_plan.terms_accepted_at IS NULL THEN RETURN NULL; END IF;

  IF v_i.status = 'processing' AND v_i.last_attempt_at < now() - interval '30 minutes' THEN
    UPDATE payment_plan_installments SET last_attempt_at = now() WHERE id = v_i.id;
  ELSIF v_i.status IN ('scheduled', 'failed', 'requires_action')
        AND (p_manual OR v_i.attempt_count < v_plan.max_charge_attempts)
        AND (p_manual OR v_i.next_attempt_at IS NULL OR v_i.next_attempt_at <= now()) THEN
    UPDATE payment_plan_installments SET status = 'processing', attempt_count = attempt_count + 1, last_attempt_at = now() WHERE id = v_i.id
    RETURNING * INTO v_i;
  ELSE
    RETURN NULL;
  END IF;
  SELECT * INTO v_i FROM payment_plan_installments WHERE id = v_i.id;
  RETURN jsonb_build_object('installment', to_jsonb(v_i), 'plan', to_jsonb(v_plan));
END; $$;
REVOKE ALL ON FUNCTION public.claim_installment_for_charge(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_installment_for_charge(uuid, boolean) TO service_role;

-- Installments the runner should try to auto-charge now (due day starts charging at 14:00 UTC).
CREATE OR REPLACE FUNCTION public.list_installments_to_charge(p_limit integer DEFAULT 100)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(id), '{}') FROM (
    SELECT i.id FROM payment_plan_installments i JOIN payment_plans pl ON pl.id = i.plan_id
    WHERE pl.status = 'active' AND pl.auto_charge AND pl.stripe_payment_method_id IS NOT NULL
      AND i.kind = 'installment'
      AND ((i.status IN ('scheduled', 'failed') AND i.attempt_count < pl.max_charge_attempts
            AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now())
            AND (i.due_date::timestamp + interval '14 hours') <= (now() AT TIME ZONE 'UTC'))
           OR (i.status = 'processing' AND i.last_attempt_at < now() - interval '30 minutes'))
    ORDER BY i.due_date LIMIT LEAST(GREATEST(p_limit, 1), 500)
  ) t;
$$;
REVOKE ALL ON FUNCTION public.list_installments_to_charge(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_installments_to_charge(integer) TO service_role;

-- Installments eligible for a reminder check (runner decides the stage with pure logic).
CREATE OR REPLACE FUNCTION public.list_installments_for_reminders()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'plan_id', i.plan_id, 'seq', i.seq, 'kind', i.kind, 'amount_cents', i.amount_cents, 'late_fee_cents', i.late_fee_cents,
    'due_date', i.due_date, 'status', i.status, 'reminders_sent', i.reminders_sent, 'pay_link_url', i.pay_link_url,
    'pay_link_created_at', i.pay_link_created_at, 'customer_name', pl.customer_name, 'customer_email', pl.customer_email,
    'customer_phone', pl.customer_phone, 'auto_charge', pl.auto_charge, 'currency', pl.currency, 'user_id', pl.user_id,
    'stripe_customer_id', pl.stripe_customer_id, 'max_attempts', pl.max_charge_attempts, 'attempt_count', i.attempt_count)), '[]'::jsonb)
  FROM payment_plan_installments i JOIN payment_plans pl ON pl.id = i.plan_id
  WHERE pl.status = 'active' AND i.status IN ('scheduled', 'failed', 'requires_action')
    AND i.due_date BETWEEN current_date - 60 AND current_date + 3;
$$;
REVOKE ALL ON FUNCTION public.list_installments_for_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_installments_for_reminders() TO service_role;

CREATE OR REPLACE FUNCTION public.mark_plan_reminders_sent(p_installment_id uuid, p_stages text[])
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE payment_plan_installments SET reminders_sent = (SELECT COALESCE(array_agg(DISTINCT s), '{}') FROM unnest(reminders_sent || p_stages) s)
  WHERE id = p_installment_id;
$$;
REVOKE ALL ON FUNCTION public.mark_plan_reminders_sent(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_plan_reminders_sent(uuid, text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.save_installment_pay_link(p_installment_id uuid, p_url text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE payment_plan_installments SET pay_link_url = p_url, pay_link_created_at = now() WHERE id = p_installment_id;
$$;
REVOKE ALL ON FUNCTION public.save_installment_pay_link(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_installment_pay_link(uuid, text) TO service_role;

-- Late fees: once per installment, only on accepted plans, never on deposits, after the grace period.
CREATE OR REPLACE FUNCTION public.assess_payment_plan_late_fees()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_fee bigint; v_count integer := 0;
BEGIN
  FOR r IN
    SELECT i.id AS iid, i.plan_id, i.seq, i.amount_cents, pl.user_id, pl.customer_name, pl.late_fee_type, pl.late_fee_value, pl.late_fee_cap_cents
    FROM payment_plan_installments i JOIN payment_plans pl ON pl.id = i.plan_id
    WHERE pl.status = 'active' AND pl.late_fee_type <> 'none' AND pl.terms_accepted_at IS NOT NULL
      AND i.kind = 'installment' AND i.status IN ('scheduled', 'failed', 'requires_action')
      AND i.late_fee_assessed_at IS NULL AND i.due_date + pl.grace_days < current_date
    FOR UPDATE OF i SKIP LOCKED
  LOOP
    v_fee := CASE r.late_fee_type WHEN 'flat' THEN round(r.late_fee_value) ELSE round(r.amount_cents * r.late_fee_value / 100) END;
    IF r.late_fee_cap_cents > 0 THEN v_fee := LEAST(v_fee, r.late_fee_cap_cents); END IF;
    IF v_fee <= 0 THEN
      UPDATE payment_plan_installments SET late_fee_assessed_at = now() WHERE id = r.iid;
      CONTINUE;
    END IF;
    UPDATE payment_plan_installments SET late_fee_cents = v_fee, late_fee_assessed_at = now() WHERE id = r.iid;
    PERFORM public.log_plan_event(r.plan_id, r.iid, 'late_fee_assessed', jsonb_build_object('cents', v_fee));
    PERFORM public.notify_plan_owner(r.user_id, r.plan_id, 'Late fee applied',
      format('A %s late fee was added to %s''s installment %s.', to_char(v_fee / 100.0, 'FM999,990.00'), r.customer_name, r.seq));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.assess_payment_plan_late_fees() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assess_payment_plan_late_fees() TO service_role;

-- The edge function stores the authorization link + the exact terms the customer saw.
CREATE OR REPLACE FUNCTION public.mark_plan_authorization_sent(p_plan_id uuid, p_session_id text, p_url text, p_customer text, p_terms text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_plans SET status = 'pending_authorization', authorization_session_id = p_session_id, authorization_url = p_url,
    stripe_customer_id = COALESCE(p_customer, stripe_customer_id), terms_text = p_terms, authorization_sent_at = now()
  WHERE id = p_plan_id AND status IN ('draft', 'pending_authorization');
  PERFORM public.log_plan_event(p_plan_id, NULL, 'authorization_sent');
END; $$;
REVOKE ALL ON FUNCTION public.mark_plan_authorization_sent(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_plan_authorization_sent(uuid, text, text, text, text) TO service_role;
