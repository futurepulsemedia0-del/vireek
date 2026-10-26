/*
  # Pay by Bank — ACH debit (+ RTP / FedNow adapter slots) for invoice links, memberships and payment plans

  ## What this adds
  - bank_payment_settings   per-account switches (enable, routing mode, amount window, provisional membership access)
  - bank_payment_attempts   one row per bank debit (PaymentIntent) with a monotonic state machine
  - bank_payment_events     immutable, idempotent event log (provider_event_id is UNIQUE)
  - bank_payment_methods    saved bank accounts / mandates (blocked / disputed tracking)
  - payment_requests.payment_rail / settlement_status, payment_plans.payment_rail
  - payment_plan_installments.status += 'pending_settlement'  (ACH is async: NEVER re-charge while it is in flight)
  - bank_attempt_apply()            service-role state machine (webhook + poller + dispute hook)
  - bank_attempt_post_accounting()  idempotent GL posting / reversal into ar_payments + journal
  - get_bank_payment_stats()        KPIs + lower-fee routing suggestions
  - set_bank_payment_settings(), bank_attempt_link_invoice(), bank_attempt_dismiss()   staff RPCs

  ## Money / accounting model
  Funds settle to the Stripe balance first, so a settled debit posts  DR 1050 Payment Processor Clearing / CR 1100 AR
  (only when it can be tied to an open AR invoice). Categorise the Stripe payout bank line to 1050 to clear it.
  A return / dispute posts a reversing entry and deletes the ar_payments row (same as bank-intelligence "unmatch").
  Processor fees are not posted (unknown until the balance transaction) — see docs/PAY_BY_BANK.md.

  ## Requires (already in your project)
  get_account_owner_id(), update_updated_at(), can_manage_payment_plans(), profiles, payment_requests, payment_plans,
  payment_plan_installments, memberships, notifications, chart_of_accounts, journal_entries/lines, ar_invoices,
  ar_payments, _gl_next_number(), _gl_assert_period_open(), log_plan_event(), notify_plan_owner(),
  finalize_plan_if_done(), mark_tip_refunded().

  ## Scheduling (run once, after deploying pay-by-bank-reconcile)
    select cron.schedule('pay-by-bank-reconcile', '5,35 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/pay-by-bank-reconcile',
        headers := jsonb_build_object('X-Cron-Secret', '<PAY_BY_BANK_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

-- =============================================================
-- 1. SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_payment_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  routing_mode text NOT NULL DEFAULT 'offer' CHECK (routing_mode IN ('offer', 'prefer')),
  min_amount_cents integer NOT NULL DEFAULT 5000 CHECK (min_amount_cents >= 50),
  max_amount_cents integer NOT NULL DEFAULT 2500000 CHECK (max_amount_cents >= 50),
  provisional_membership_access boolean NOT NULL DEFAULT true,
  provisional_limit_cents integer NOT NULL DEFAULT 50000 CHECK (provisional_limit_cents >= 0),
  rtp_enabled boolean NOT NULL DEFAULT false,
  fednow_enabled boolean NOT NULL DEFAULT false,
  capability_status text NOT NULL DEFAULT 'unknown' CHECK (capability_status IN ('unknown', 'inactive', 'pending', 'active')),
  capability_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_payment_settings_window CHECK (max_amount_cents >= min_amount_cents)
);

-- =============================================================
-- 2. ATTEMPTS / EVENTS / METHODS
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  installment_id uuid REFERENCES payment_plan_installments(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES payment_plans(id) ON DELETE SET NULL,
  membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  customer_name text,
  provider text NOT NULL DEFAULT 'stripe',
  rail text NOT NULL DEFAULT 'ach_debit' CHECK (rail IN ('ach_debit', 'instant_bank', 'rtp', 'fednow')),
  provider_payment_id text NOT NULL,
  provider_payment_method_id text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  tip_cents integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  fee_estimate_cents integer NOT NULL DEFAULT 0,
  card_fee_estimate_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('verification_required', 'processing', 'succeeded', 'failed', 'returned', 'disputed', 'canceled')),
  verification_method text CHECK (verification_method IS NULL OR verification_method IN ('instant', 'microdeposits')),
  failure_code text,
  failure_message text,
  return_code text,
  retryable boolean,
  bank_name text,
  account_last4 text,
  expected_settlement_date date,
  settled_at timestamptz,
  failed_at timestamptz,
  returned_at timestamptz,
  last_event_created bigint,
  provisional_access_granted boolean NOT NULL DEFAULT false,
  accounting_status text NOT NULL DEFAULT 'pending'
    CHECK (accounting_status IN ('pending', 'posted', 'unlinked', 'reversed', 'failed', 'skipped')),
  accounting_error text,
  ar_payment_id uuid REFERENCES ar_payments(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_attempts_user_created ON bank_payment_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_attempts_open ON bank_payment_attempts(updated_at)
  WHERE status IN ('processing', 'verification_required');
CREATE INDEX IF NOT EXISTS idx_bank_attempts_accounting ON bank_payment_attempts(accounting_status)
  WHERE accounting_status IN ('pending', 'failed', 'unlinked');
CREATE INDEX IF NOT EXISTS idx_bank_attempts_request ON bank_payment_attempts(payment_request_id) WHERE payment_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_attempts_installment ON bank_payment_attempts(installment_id) WHERE installment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES bank_payment_attempts(id) ON DELETE CASCADE,
  provider_event_id text UNIQUE,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_events_attempt ON bank_payment_events(attempt_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bank_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES payment_plans(id) ON DELETE SET NULL,
  membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  stripe_customer_id text,
  stripe_payment_method_id text NOT NULL,
  bank_name text,
  account_last4 text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'revoked', 'disputed')),
  status_reason text,
  mandate_accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, stripe_payment_method_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_methods_pm ON bank_payment_methods(stripe_payment_method_id);

DROP TRIGGER IF EXISTS trigger_bank_settings_updated_at ON bank_payment_settings;
CREATE TRIGGER trigger_bank_settings_updated_at BEFORE UPDATE ON bank_payment_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_bank_attempts_updated_at ON bank_payment_attempts;
CREATE TRIGGER trigger_bank_attempts_updated_at BEFORE UPDATE ON bank_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_bank_methods_updated_at ON bank_payment_methods;
CREATE TRIGGER trigger_bank_methods_updated_at BEFORE UPDATE ON bank_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 3. COLUMNS ON EXISTING TABLES + status widening
-- =============================================================
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS payment_rail text,
  ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'none'
    CHECK (settlement_status IN ('none', 'processing', 'settled', 'returned'));

ALTER TABLE payment_plans
  ADD COLUMN IF NOT EXISTS payment_rail text NOT NULL DEFAULT 'card' CHECK (payment_rail IN ('card', 'bank'));

-- payment_plan_installments.status: add 'pending_settlement' (robust to constraint drift, same pattern as refunds migration)
DO $$
DECLARE
  v_con record;
  v_vals text[];
BEGIN
  FOR v_con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    WHERE c.conrelid = 'public.payment_plan_installments'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%scheduled%'
      AND pg_get_constraintdef(c.oid) ILIKE '%requires_action%'
  LOOP
    IF v_con.def ILIKE '%pending_settlement%' THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT t.m[1]) INTO v_vals
    FROM regexp_matches(v_con.def, '''([a-z_]+)''', 'g') AS t(m);
    v_vals := coalesce(v_vals, ARRAY[]::text[]) || ARRAY['pending_settlement'];
    EXECUTE format('ALTER TABLE public.payment_plan_installments DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format(
      'ALTER TABLE public.payment_plan_installments ADD CONSTRAINT %I CHECK (status IN (%s))',
      v_con.conname,
      (SELECT string_agg(quote_literal(x), ', ') FROM (SELECT DISTINCT unnest(v_vals) AS x) s)
    );
  END LOOP;
END $$;

-- A plan must not be marked completed while a bank debit is still settling.
-- NOTE: same body as your current finalize_plan_if_done() plus 'pending_settlement' in the open-status list.
-- If you changed that function in your live database, only add 'pending_settlement' to its status list instead.
CREATE OR REPLACE FUNCTION public.finalize_plan_if_done(p_plan uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_plan payment_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.status NOT IN ('active', 'paused') THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM payment_plan_installments WHERE plan_id = p_plan
             AND status IN ('scheduled', 'processing', 'requires_action', 'failed', 'pending_settlement')) THEN RETURN; END IF;
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
-- 4. RLS — clients can only READ; every write is an RPC / service role
-- =============================================================
ALTER TABLE bank_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_bank_payment_settings" ON bank_payment_settings;
CREATE POLICY "select_own_bank_payment_settings" ON bank_payment_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());
DROP POLICY IF EXISTS "select_own_bank_payment_attempts" ON bank_payment_attempts;
CREATE POLICY "select_own_bank_payment_attempts" ON bank_payment_attempts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());
DROP POLICY IF EXISTS "select_own_bank_payment_events" ON bank_payment_events;
CREATE POLICY "select_own_bank_payment_events" ON bank_payment_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());
DROP POLICY IF EXISTS "select_own_bank_payment_methods" ON bank_payment_methods;
CREATE POLICY "select_own_bank_payment_methods" ON bank_payment_methods FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_payment_plans());

REVOKE INSERT, UPDATE, DELETE ON bank_payment_settings, bank_payment_attempts, bank_payment_events, bank_payment_methods FROM anon, authenticated;
REVOKE ALL ON bank_payment_settings, bank_payment_attempts, bank_payment_events, bank_payment_methods FROM anon;

-- =============================================================
-- 5. PURE HELPERS
-- =============================================================
-- ESTIMATES ONLY (used for savings suggestions). Keep in sync with supabase/functions/_shared/bankPayments/logic.ts
-- and verify against your Stripe pricing page. rtp / fednow are provider specific and unavailable through Stripe -> 0.
CREATE OR REPLACE FUNCTION public.bank_fee_estimate(p_rail text, p_cents integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rail
    WHEN 'card' THEN round(p_cents * 0.029 + 30)::integer
    WHEN 'ach_debit' THEN LEAST(round(p_cents * 0.008)::integer, 500)
    WHEN 'instant_bank' THEN round(p_cents * 0.026)::integer
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public._bank_notify(p_user uuid, p_title text, p_message text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (p_user, 'system', p_title, p_message, '/dashboard/pay-by-bank');
$$;
REVOKE ALL ON FUNCTION public._bank_notify(uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._bank_ensure_accounts(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system) VALUES
    (p_user, '1000', 'Cash and Bank', 'asset', 'debit', true),
    (p_user, '1050', 'Payment Processor Clearing', 'asset', 'debit', true),
    (p_user, '1100', 'Accounts Receivable', 'asset', 'debit', true)
  ON CONFLICT (user_id, code) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public._bank_ensure_accounts(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._bank_post_je(
  p_user uuid, p_date date, p_memo text, p_source_type text, p_source_id uuid, p_lines jsonb, p_reversal_of uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry uuid; v_line jsonb; v_debit bigint := 0; v_credit bigint := 0; v_n integer := 0;
BEGIN
  PERFORM public._gl_assert_period_open(p_user, p_date);
  IF jsonb_array_length(p_lines) < 2 THEN RAISE EXCEPTION 'A journal entry needs at least two lines'; END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_debit := v_debit + coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := v_credit + coalesce((v_line->>'credit_cents')::bigint, 0);
  END LOOP;
  IF v_debit <> v_credit THEN RAISE EXCEPTION 'Journal entry does not balance: % debit vs % credit', v_debit, v_credit; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bank-gl:' || p_user::text, 0));
  INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id, reversal_of_id)
  VALUES (p_user, public._gl_next_number(p_user, 'JE', 'journal_entries'), p_date, p_memo, p_source_type, p_source_id, p_reversal_of)
  RETURNING id INTO v_entry;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description)
    VALUES (v_entry, v_n, (v_line->>'account_id')::uuid, coalesce((v_line->>'debit_cents')::integer, 0),
            coalesce((v_line->>'credit_cents')::integer, 0), v_line->>'description');
  END LOOP;
  RETURN v_entry;
END $$;
REVOKE ALL ON FUNCTION public._bank_post_je(uuid, date, text, text, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. ACCOUNTING — post (settled) / reverse (returned or disputed). Idempotent.
-- =============================================================
CREATE OR REPLACE FUNCTION public._bank_post_accounting(p_attempt uuid, p_invoice uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a bank_payment_attempts%ROWTYPE;
  v_inv ar_invoices%ROWTYPE;
  v_job uuid; v_base integer; v_clear uuid; v_ar uuid; v_je uuid; v_pay uuid; v_uses_ar boolean;
  v_orig journal_entries%ROWTYPE; v_rev uuid; v_after integer;
BEGIN
  SELECT * INTO a FROM bank_payment_attempts WHERE id = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  -- ---- reversal path -------------------------------------------------------
  IF a.status IN ('returned', 'disputed') THEN
    IF a.accounting_status = 'reversed' THEN RETURN 'reversed'; END IF;
    IF a.journal_entry_id IS NULL OR a.accounting_status NOT IN ('posted', 'failed') THEN
      UPDATE bank_payment_attempts SET accounting_status = 'skipped', accounting_error = NULL WHERE id = a.id;
      RETURN 'skipped';
    END IF;
    SELECT * INTO v_orig FROM journal_entries WHERE id = a.journal_entry_id;
    v_rev := public._bank_post_je(
      a.user_id, current_date, 'Reversal: bank payment ' || coalesce(a.return_code, a.status) || ' (' || a.provider_payment_id || ')',
      'reversal', a.journal_entry_id,
      (SELECT jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit_cents', l.credit_cents, 'credit_cents', l.debit_cents,
                                          'description', 'Bank payment returned') ORDER BY l.line_number)
         FROM journal_lines l WHERE l.journal_entry_id = a.journal_entry_id),
      a.journal_entry_id);
    IF a.ar_payment_id IS NOT NULL THEN
      SELECT * INTO v_inv FROM ar_invoices WHERE id = (SELECT invoice_id FROM ar_payments WHERE id = a.ar_payment_id) FOR UPDATE;
      IF FOUND AND v_inv.status <> 'void' THEN
        v_after := GREATEST(v_inv.amount_paid_cents - (a.amount_cents - a.tip_cents), 0);
        UPDATE ar_invoices SET amount_paid_cents = v_after,
          status = CASE WHEN v_after <= 0 THEN (CASE WHEN due_date < current_date THEN 'overdue' ELSE 'sent' END) ELSE 'partially_paid' END,
          updated_at = now()
        WHERE id = v_inv.id;
      END IF;
      DELETE FROM ar_payments WHERE id = a.ar_payment_id;
    END IF;
    UPDATE bank_payment_attempts SET accounting_status = 'reversed', accounting_error = NULL,
      reversal_journal_entry_id = v_rev, ar_payment_id = NULL WHERE id = a.id;
    RETURN 'reversed';
  END IF;

  -- ---- posting path --------------------------------------------------------
  IF a.status <> 'succeeded' THEN RETURN 'not_settled'; END IF;
  IF a.accounting_status IN ('posted', 'reversed', 'skipped') THEN RETURN a.accounting_status; END IF;
  v_base := a.amount_cents - a.tip_cents;      -- the tip is booked by finalize_paid_payment_request (Tips Payable)
  IF v_base <= 0 THEN
    UPDATE bank_payment_attempts SET accounting_status = 'skipped', accounting_error = NULL WHERE id = a.id;
    RETURN 'skipped';
  END IF;

  IF p_invoice IS NOT NULL THEN
    SELECT * INTO v_inv FROM ar_invoices WHERE id = p_invoice AND user_id = a.user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF v_inv.status = 'void' THEN RAISE EXCEPTION 'Invoice is void'; END IF;
    IF v_inv.total_cents - v_inv.amount_paid_cents < v_base THEN
      RAISE EXCEPTION 'Invoice balance (%) is lower than this payment (%)', v_inv.total_cents - v_inv.amount_paid_cents, v_base;
    END IF;
  ELSE
    SELECT s.job_id INTO v_job FROM (
      SELECT pr.job_id FROM payment_requests pr WHERE pr.id = a.payment_request_id
      UNION ALL
      SELECT pl.job_id FROM payment_plans pl WHERE pl.id = a.plan_id
    ) s WHERE s.job_id IS NOT NULL LIMIT 1;
    IF v_job IS NOT NULL THEN
      SELECT * INTO v_inv FROM ar_invoices
      WHERE user_id = a.user_id AND job_id = v_job AND status IN ('sent', 'partially_paid', 'overdue')
        AND total_cents - amount_paid_cents >= v_base
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    END IF;
  END IF;

  IF v_inv.id IS NULL THEN
    v_uses_ar := EXISTS (SELECT 1 FROM ar_invoices WHERE user_id = a.user_id);
    UPDATE bank_payment_attempts
    SET accounting_status = CASE WHEN v_job IS NOT NULL AND v_uses_ar THEN 'unlinked' ELSE 'skipped' END,
        accounting_error = CASE WHEN v_job IS NOT NULL AND v_uses_ar THEN 'No open invoice matches this payment.' ELSE NULL END
    WHERE id = a.id;
    RETURN CASE WHEN v_job IS NOT NULL AND v_uses_ar THEN 'unlinked' ELSE 'skipped' END;
  END IF;

  PERFORM public._bank_ensure_accounts(a.user_id);
  SELECT id INTO v_clear FROM chart_of_accounts WHERE user_id = a.user_id AND code = '1050';
  SELECT id INTO v_ar FROM chart_of_accounts WHERE user_id = a.user_id AND code = '1100';
  v_je := public._bank_post_je(
    a.user_id, current_date, 'Bank payment (' || a.rail || ') for invoice ' || v_inv.invoice_number, 'ar_payment', v_inv.id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_clear, 'debit_cents', v_base, 'credit_cents', 0, 'description', 'Bank debit settled'),
      jsonb_build_object('account_id', v_ar, 'debit_cents', 0, 'credit_cents', v_base, 'description', 'Applied to AR')));
  INSERT INTO ar_payments (user_id, invoice_id, payment_request_id, amount_cents, payment_method, deposit_account_id, journal_entry_id)
  VALUES (a.user_id, v_inv.id, a.payment_request_id, v_base, 'ach', v_clear, v_je)
  RETURNING id INTO v_pay;
  UPDATE ar_invoices SET amount_paid_cents = amount_paid_cents + v_base,
    status = CASE WHEN amount_paid_cents + v_base >= total_cents THEN 'paid' ELSE 'partially_paid' END,
    updated_at = now()
  WHERE id = v_inv.id;
  UPDATE bank_payment_attempts SET accounting_status = 'posted', accounting_error = NULL, journal_entry_id = v_je, ar_payment_id = v_pay
  WHERE id = a.id;
  RETURN 'posted';
END $$;
REVOKE ALL ON FUNCTION public._bank_post_accounting(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Service-role wrapper: never throws; failures are recorded and retried by the reconcile cron.
CREATE OR REPLACE FUNCTION public.bank_attempt_post_accounting(p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  BEGIN
    v := public._bank_post_accounting(p_attempt_id, NULL);
  EXCEPTION WHEN OTHERS THEN
    UPDATE bank_payment_attempts SET accounting_status = 'failed', accounting_error = left(SQLERRM, 300)
    WHERE id = p_attempt_id AND accounting_status <> 'reversed';
    v := 'failed';
  END;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.bank_attempt_post_accounting(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_attempt_post_accounting(uuid) TO service_role;

-- =============================================================
-- 7. STATE MACHINE (service role): webhook, poller, dispute hook
--    p = { provider_payment_id, status, provider_event_id?, event_created?, event_type?, rail?, amount_cents?, tip_cents?,
--          payment_request_id?, installment_id?, membership_id?, membership_signup?, payment_method_id?, verification_method?,
--          failure_code?, failure_message?, return_code?, retryable?, bank_name?, account_last4?, expected_settlement_date? }
--    Returns { result: applied|duplicate|stale|ignored, attempt_id, status, previous_status, provisional_allowed, contact }
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_attempt_apply(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pid text := NULLIF(p->>'provider_payment_id', '');
  v_target text := p->>'status';
  v_event_id text := NULLIF(p->>'provider_event_id', '');
  v_created bigint := COALESCE(NULLIF(p->>'event_created', '')::bigint, extract(epoch FROM now())::bigint);
  v_req_id uuid := NULLIF(p->>'payment_request_id', '')::uuid;
  v_inst_id uuid := NULLIF(p->>'installment_id', '')::uuid;
  v_mem_id uuid := NULLIF(p->>'membership_id', '')::uuid;
  v_rail text := COALESCE(NULLIF(p->>'rail', ''), 'ach_debit');
  v_amount integer := NULLIF(p->>'amount_cents', '')::integer;
  v_tip integer := COALESCE(NULLIF(p->>'tip_cents', '')::integer, 0);
  v_user uuid; v_cust text; v_plan_id uuid; v_settings bank_payment_settings%ROWTYPE;
  v_req payment_requests%ROWTYPE; v_inst payment_plan_installments%ROWTYPE; v_plan payment_plans%ROWTYPE;
  v_a bank_payment_attempts%ROWTYPE; v_prev text; v_ev uuid; v_final boolean; v_retry boolean;
  v_provisional boolean := false; v_contact jsonb := NULL; v_code text; v_msg text;
BEGIN
  IF v_pid IS NULL OR v_target IS NULL OR v_target NOT IN ('verification_required', 'processing', 'succeeded', 'failed', 'returned', 'disputed', 'canceled') THEN
    RAISE EXCEPTION 'Invalid bank payment event' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_a FROM bank_payment_attempts WHERE provider = 'stripe' AND provider_payment_id = v_pid FOR UPDATE;
  IF FOUND THEN
    v_user := v_a.user_id;
    v_req_id := COALESCE(v_req_id, v_a.payment_request_id);
    v_inst_id := COALESCE(v_inst_id, v_a.installment_id);
    v_mem_id := COALESCE(v_mem_id, v_a.membership_id);
    v_amount := COALESCE(v_amount, v_a.amount_cents);
  ELSE
    IF v_target IN ('returned', 'disputed') THEN RETURN jsonb_build_object('result', 'ignored'); END IF;
    IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Invalid amount' USING ERRCODE = '22023'; END IF;
    IF v_req_id IS NOT NULL THEN
      SELECT * INTO v_req FROM payment_requests WHERE id = v_req_id;
      IF FOUND THEN v_user := v_req.user_id; v_cust := v_req.customer_name; ELSE v_req_id := NULL; END IF;
    END IF;
    IF v_user IS NULL AND v_inst_id IS NOT NULL THEN
      SELECT * INTO v_inst FROM payment_plan_installments WHERE id = v_inst_id;
      IF FOUND THEN
        SELECT * INTO v_plan FROM payment_plans WHERE id = v_inst.plan_id;
        v_user := v_plan.user_id; v_cust := v_plan.customer_name; v_plan_id := v_plan.id;
      ELSE v_inst_id := NULL; END IF;
    END IF;
    IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'ignored'); END IF;
    IF v_mem_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships WHERE id = v_mem_id AND user_id = v_user) THEN v_mem_id := NULL; END IF;
    INSERT INTO bank_payment_attempts (
      user_id, payment_request_id, installment_id, plan_id, membership_id, customer_name, rail, provider_payment_id,
      amount_cents, tip_cents, fee_estimate_cents, card_fee_estimate_cents
    ) VALUES (
      v_user, v_req_id, v_inst_id, v_plan_id, v_mem_id, v_cust, v_rail, v_pid,
      v_amount, LEAST(GREATEST(v_tip, 0), v_amount - 1), public.bank_fee_estimate(v_rail, v_amount), public.bank_fee_estimate('card', v_amount)
    ) ON CONFLICT (provider, provider_payment_id) DO NOTHING;
    SELECT * INTO v_a FROM bank_payment_attempts WHERE provider = 'stripe' AND provider_payment_id = v_pid FOR UPDATE;
    IF v_a.user_id <> v_user THEN RETURN jsonb_build_object('result', 'ignored'); END IF;
  END IF;

  -- idempotency: one row per provider event
  INSERT INTO bank_payment_events (user_id, attempt_id, provider_event_id, type, detail)
  VALUES (v_a.user_id, v_a.id, v_event_id, COALESCE(NULLIF(p->>'event_type', ''), v_target),
          jsonb_strip_nulls(jsonb_build_object('status', v_target, 'failure_code', p->>'failure_code', 'return_code', p->>'return_code')))
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING id INTO v_ev;
  IF v_ev IS NULL THEN RETURN jsonb_build_object('result', 'duplicate', 'attempt_id', v_a.id, 'status', v_a.status); END IF;

  v_prev := v_a.status;
  -- ordering guards
  IF v_prev IN ('returned', 'disputed') AND v_target NOT IN ('returned', 'disputed') THEN
    RETURN jsonb_build_object('result', 'stale', 'attempt_id', v_a.id, 'status', v_prev);
  END IF;
  IF v_prev = 'succeeded' AND v_target NOT IN ('succeeded', 'returned', 'disputed') THEN
    RETURN jsonb_build_object('result', 'stale', 'attempt_id', v_a.id, 'status', v_prev);
  END IF;
  IF v_target NOT IN ('returned', 'disputed') AND v_created < COALESCE(v_a.last_event_created, 0) THEN
    RETURN jsonb_build_object('result', 'stale', 'attempt_id', v_a.id, 'status', v_prev);
  END IF;
  IF v_prev = v_target AND v_target IN ('succeeded', 'returned', 'disputed', 'canceled') THEN
    RETURN jsonb_build_object('result', 'duplicate', 'attempt_id', v_a.id, 'status', v_prev);
  END IF;

  v_code := NULLIF(p->>'failure_code', '');
  v_msg := left(NULLIF(p->>'failure_message', ''), 300);
  v_retry := NULLIF(p->>'retryable', '')::boolean;

  UPDATE bank_payment_attempts SET
    status = v_target,
    last_event_created = GREATEST(COALESCE(last_event_created, 0), v_created),
    provider_payment_method_id = COALESCE(NULLIF(p->>'payment_method_id', ''), provider_payment_method_id),
    verification_method = COALESCE(NULLIF(p->>'verification_method', ''), verification_method),
    bank_name = COALESCE(NULLIF(p->>'bank_name', ''), bank_name),
    account_last4 = COALESCE(NULLIF(p->>'account_last4', ''), account_last4),
    expected_settlement_date = COALESCE(NULLIF(p->>'expected_settlement_date', '')::date, expected_settlement_date),
    failure_code = CASE WHEN v_target = 'failed' THEN v_code WHEN v_target IN ('processing', 'succeeded', 'verification_required') THEN NULL ELSE failure_code END,
    failure_message = CASE WHEN v_target = 'failed' THEN v_msg WHEN v_target IN ('processing', 'succeeded', 'verification_required') THEN NULL ELSE failure_message END,
    retryable = CASE WHEN v_target = 'failed' THEN v_retry WHEN v_target IN ('processing', 'succeeded') THEN NULL ELSE retryable END,
    return_code = CASE WHEN v_target IN ('returned', 'disputed') THEN COALESCE(NULLIF(p->>'return_code', ''), return_code) ELSE return_code END,
    settled_at = CASE WHEN v_target = 'succeeded' THEN COALESCE(settled_at, now()) ELSE settled_at END,
    failed_at = CASE WHEN v_target = 'failed' THEN now() ELSE failed_at END,
    returned_at = CASE WHEN v_target IN ('returned', 'disputed') THEN COALESCE(returned_at, now()) ELSE returned_at END
  WHERE id = v_a.id;

  SELECT * INTO v_settings FROM bank_payment_settings WHERE user_id = v_a.user_id;

  -- ---------------------------------------------------------------- effects
  IF v_target = 'processing' OR v_target = 'verification_required' THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      UPDATE payment_requests SET payment_rail = v_a.rail,
        settlement_status = CASE WHEN v_target = 'processing' THEN 'processing' ELSE 'none' END
      WHERE id = v_a.payment_request_id AND user_id = v_a.user_id AND status <> 'paid';
    END IF;
    IF v_target = 'processing' AND v_a.installment_id IS NOT NULL THEN
      UPDATE payment_plan_installments SET status = 'pending_settlement', payment_method = 'stripe',
        stripe_payment_intent_id = v_pid, last_error = NULL, next_attempt_at = NULL
      WHERE id = v_a.installment_id AND user_id = v_a.user_id AND status IN ('processing', 'scheduled', 'failed', 'requires_action');
    END IF;
    IF v_target = 'processing' AND v_a.membership_id IS NOT NULL AND p->>'membership_signup' = 'true'
       AND NOT v_a.provisional_access_granted
       AND COALESCE(v_settings.provisional_membership_access, false) AND v_a.amount_cents <= COALESCE(v_settings.provisional_limit_cents, 0) THEN
      v_provisional := true;
    END IF;

  ELSIF v_target = 'succeeded' THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      UPDATE payment_requests SET payment_rail = v_a.rail, settlement_status = 'settled'
      WHERE id = v_a.payment_request_id AND user_id = v_a.user_id;
    END IF;

  ELSIF v_target = 'canceled' THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      UPDATE payment_requests SET settlement_status = 'none' WHERE id = v_a.payment_request_id AND user_id = v_a.user_id AND status <> 'paid';
    END IF;

  ELSIF v_target = 'failed' THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      UPDATE payment_requests SET settlement_status = 'none' WHERE id = v_a.payment_request_id AND user_id = v_a.user_id AND status <> 'paid';
      SELECT * INTO v_req FROM payment_requests WHERE id = v_a.payment_request_id;
      IF FOUND THEN
        v_contact := jsonb_build_object('name', v_req.customer_name, 'email', v_req.customer_email, 'phone', v_req.customer_phone,
                                        'link_kind', 'pay', 'link_id', v_req.public_token);
      END IF;
    END IF;
    IF v_a.installment_id IS NOT NULL THEN
      SELECT * INTO v_inst FROM payment_plan_installments WHERE id = v_a.installment_id FOR UPDATE;
      IF FOUND AND v_inst.status = 'pending_settlement' THEN
        SELECT * INTO v_plan FROM payment_plans WHERE id = v_inst.plan_id;
        v_final := NOT COALESCE(v_retry, false) OR v_inst.attempt_count >= v_plan.max_charge_attempts;
        UPDATE payment_plan_installments SET status = 'failed', last_error = left(COALESCE(v_msg, 'Bank debit failed.'), 300),
          attempt_count = CASE WHEN v_final THEN GREATEST(attempt_count, v_plan.max_charge_attempts) ELSE attempt_count END,
          next_attempt_at = CASE WHEN v_final THEN NULL ELSE now() + make_interval(days => v_plan.retry_interval_days) END
        WHERE id = v_inst.id;
        PERFORM public.log_plan_event(v_plan.id, v_inst.id, 'payment_failed',
          jsonb_build_object('attempt', v_inst.attempt_count, 'error', left(COALESCE(v_msg, ''), 300), 'code', v_code, 'rail', 'bank', 'final', v_final));
        IF v_final THEN
          PERFORM public.notify_plan_owner(v_plan.user_id, v_plan.id, 'Bank debit failed',
            format('%s: installment %s failed (%s). Contact the customer, ask for a new bank account, or record an offline payment.',
                   v_plan.customer_name, v_inst.seq, COALESCE(v_code, 'bank error')));
        END IF;
        v_contact := jsonb_build_object('name', v_plan.customer_name, 'email', v_plan.customer_email, 'phone', v_plan.customer_phone,
                                        'link_kind', 'installment', 'link_id', v_inst.id);
      END IF;
    END IF;
    IF v_a.provisional_access_granted AND v_a.membership_id IS NOT NULL THEN
      BEGIN
        UPDATE memberships SET status = 'past_due' WHERE id = v_a.membership_id AND user_id = v_a.user_id AND status = 'active';
      EXCEPTION WHEN check_violation THEN NULL;  -- older schemas without 'past_due'
      END;
    END IF;
    PERFORM public._bank_notify(v_a.user_id, 'Bank payment failed',
      format('%s — %s (%s).', COALESCE(v_a.customer_name, 'A customer'), COALESCE(v_msg, 'the bank debit failed'), COALESCE(v_code, 'no code')));

  ELSIF v_target IN ('returned', 'disputed') THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      -- re-open the pay link so the customer can pay again; the job invoice status needs a human look
      UPDATE payment_requests SET status = CASE WHEN status = 'paid' THEN 'failed' ELSE status END, paid_at = NULL, settlement_status = 'returned'
      WHERE id = v_a.payment_request_id AND user_id = v_a.user_id;
      IF v_a.provider_payment_id IS NOT NULL THEN
        BEGIN PERFORM public.mark_tip_refunded(v_a.provider_payment_id); EXCEPTION WHEN OTHERS THEN NULL; END;
      END IF;
    END IF;
    IF v_a.installment_id IS NOT NULL THEN
      SELECT * INTO v_inst FROM payment_plan_installments WHERE id = v_a.installment_id FOR UPDATE;
      IF FOUND AND v_inst.status IN ('paid', 'pending_settlement') THEN
        SELECT * INTO v_plan FROM payment_plans WHERE id = v_inst.plan_id;
        UPDATE payment_plan_installments SET status = 'failed', paid_at = NULL, paid_cents = 0,
          attempt_count = GREATEST(attempt_count, v_plan.max_charge_attempts), next_attempt_at = NULL,
          last_error = left('Bank debit returned' || COALESCE(' (' || COALESCE(p->>'return_code', '') || ')', ''), 300)
        WHERE id = v_inst.id;
        IF v_plan.status = 'completed' THEN UPDATE payment_plans SET status = 'active' WHERE id = v_plan.id; END IF;
        PERFORM public.log_plan_event(v_plan.id, v_inst.id, 'payment_failed',
          jsonb_build_object('error', 'Bank debit returned', 'code', p->>'return_code', 'rail', 'bank', 'final', true));
        PERFORM public.notify_plan_owner(v_plan.user_id, v_plan.id, 'Bank debit returned',
          format('%s: installment %s was returned by the bank. Auto-charge is stopped for it.', v_plan.customer_name, v_inst.seq));
      END IF;
    END IF;
    IF v_a.provider_payment_method_id IS NOT NULL THEN
      UPDATE bank_payment_methods SET status = 'disputed', status_reason = left(COALESCE(p->>'return_code', 'returned'), 200)
      WHERE user_id = v_a.user_id AND stripe_payment_method_id = v_a.provider_payment_method_id;
    END IF;
    IF v_a.provisional_access_granted AND v_a.membership_id IS NOT NULL THEN
      BEGIN
        UPDATE memberships SET status = 'past_due' WHERE id = v_a.membership_id AND user_id = v_a.user_id AND status = 'active';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
    END IF;
    PERFORM public._bank_notify(v_a.user_id, 'Bank payment returned',
      format('%s — the bank returned %s (%s). The invoice was re-opened; review its status.',
             COALESCE(v_a.customer_name, 'A customer'), to_char(v_a.amount_cents / 100.0, 'FM999,999,990.00'), COALESCE(p->>'return_code', 'return')));
  END IF;

  -- the customer must be reachable to finish microdeposit verification
  IF v_contact IS NULL AND v_target = 'verification_required' THEN
    IF v_a.payment_request_id IS NOT NULL THEN
      SELECT * INTO v_req FROM payment_requests WHERE id = v_a.payment_request_id;
      IF FOUND THEN
        v_contact := jsonb_build_object('name', v_req.customer_name, 'email', v_req.customer_email, 'phone', v_req.customer_phone,
                                        'link_kind', 'pay', 'link_id', v_req.public_token);
      END IF;
    ELSIF v_a.installment_id IS NOT NULL THEN
      SELECT * INTO v_plan FROM payment_plans WHERE id = (SELECT plan_id FROM payment_plan_installments WHERE id = v_a.installment_id);
      IF FOUND THEN
        v_contact := jsonb_build_object('name', v_plan.customer_name, 'email', v_plan.customer_email, 'phone', v_plan.customer_phone,
                                        'link_kind', 'installment', 'link_id', v_a.installment_id);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('result', 'applied', 'attempt_id', v_a.id, 'status', v_target, 'previous_status', v_prev,
                            'provisional_allowed', v_provisional, 'contact', v_contact);
END $$;
REVOKE ALL ON FUNCTION public.bank_attempt_apply(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_attempt_apply(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.bank_attempt_mark_provisional(p_attempt_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE bank_payment_attempts SET provisional_access_granted = true WHERE id = p_attempt_id;
$$;
REVOKE ALL ON FUNCTION public.bank_attempt_mark_provisional(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_attempt_mark_provisional(uuid) TO service_role;

-- =============================================================
-- 8. BANK METHODS (service role)
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_method_upsert(
  p_user uuid, p_plan uuid, p_membership uuid, p_customer text, p_pm text, p_bank_name text, p_last4 text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_pm IS NULL OR p_user IS NULL THEN RETURN; END IF;
  INSERT INTO bank_payment_methods (user_id, plan_id, membership_id, stripe_customer_id, stripe_payment_method_id, bank_name, account_last4)
  VALUES (p_user, p_plan, p_membership, p_customer, p_pm, p_bank_name, p_last4)
  ON CONFLICT (user_id, stripe_payment_method_id) DO UPDATE SET
    plan_id = COALESCE(EXCLUDED.plan_id, bank_payment_methods.plan_id),
    membership_id = COALESCE(EXCLUDED.membership_id, bank_payment_methods.membership_id),
    stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, bank_payment_methods.stripe_customer_id),
    bank_name = COALESCE(EXCLUDED.bank_name, bank_payment_methods.bank_name),
    account_last4 = COALESCE(EXCLUDED.account_last4, bank_payment_methods.account_last4),
    status = 'active', status_reason = NULL;
END $$;
REVOKE ALL ON FUNCTION public.bank_method_upsert(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_method_upsert(uuid, uuid, uuid, text, text, text, text) TO service_role;

-- Marks the plan as bank-funded once its saved payment method is a bank account.
CREATE OR REPLACE FUNCTION public.bank_plan_set_rail(p_plan uuid, p_pm text, p_customer text, p_bank_name text, p_last4 text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE payment_plans SET payment_rail = 'bank' WHERE id = p_plan RETURNING user_id INTO v_user;
  IF v_user IS NOT NULL THEN PERFORM public.bank_method_upsert(v_user, p_plan, NULL, p_customer, p_pm, p_bank_name, p_last4); END IF;
END $$;
REVOKE ALL ON FUNCTION public.bank_plan_set_rail(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_plan_set_rail(uuid, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.bank_method_set_status(p_pm text, p_status text, p_reason text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  IF p_status NOT IN ('active', 'blocked', 'revoked', 'disputed') THEN RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023'; END IF;
  FOR r IN
    WITH u AS (
      UPDATE bank_payment_methods SET status = p_status, status_reason = left(p_reason, 200)
      WHERE stripe_payment_method_id = p_pm AND status IS DISTINCT FROM p_status
        AND (p_status <> 'active' OR status = 'blocked')   -- only a block can be lifted automatically
      RETURNING user_id, plan_id, account_last4
    ) SELECT * FROM u
  LOOP
    v_n := v_n + 1;
    IF p_status <> 'active' THEN
      PERFORM public._bank_notify(r.user_id, 'Customer bank account unusable',
        format('A saved bank account%s was %s%s. Ask the customer for a new payment method before the next debit.',
               COALESCE(' ending ' || r.account_last4, ''), p_status, COALESCE(' (' || p_reason || ')', '')));
      IF r.plan_id IS NOT NULL THEN
        PERFORM public.log_plan_event(r.plan_id, NULL, 'bank_method_' || p_status, jsonb_build_object('reason', left(COALESCE(p_reason, ''), 200)));
      END IF;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.bank_method_set_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_method_set_status(text, text, text) TO service_role;

-- =============================================================
-- 9. POLLER SUPPORT (service role)
-- =============================================================
CREATE OR REPLACE FUNCTION public.list_stale_bank_attempts(p_hours integer DEFAULT 168, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'provider_payment_id', provider_payment_id, 'status', status)), '[]'::jsonb)
  FROM (
    SELECT id, provider_payment_id, status FROM bank_payment_attempts
    WHERE status IN ('processing', 'verification_required') AND updated_at < now() - make_interval(hours => GREATEST(p_hours, 1))
    ORDER BY updated_at LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ) t;
$$;
REVOKE ALL ON FUNCTION public.list_stale_bank_attempts(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_stale_bank_attempts(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.list_bank_attempts_needing_accounting(p_limit integer DEFAULT 100)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(id), '{}') FROM (
    SELECT id FROM bank_payment_attempts
    WHERE (status = 'succeeded' AND accounting_status IN ('pending', 'failed', 'unlinked'))
       OR (status IN ('returned', 'disputed') AND accounting_status IN ('posted', 'failed') AND journal_entry_id IS NOT NULL)
    ORDER BY updated_at LIMIT LEAST(GREATEST(p_limit, 1), 500)
  ) t;
$$;
REVOKE ALL ON FUNCTION public.list_bank_attempts_needing_accounting(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_bank_attempts_needing_accounting(integer) TO service_role;

-- =============================================================
-- 10. STAFF RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_bank_payment_settings(p jsonb)
RETURNS bank_payment_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_cur bank_payment_settings%ROWTYPE; v_row bank_payment_settings%ROWTYPE;
  v_min integer; v_max integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  INSERT INTO bank_payment_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_cur FROM bank_payment_settings WHERE user_id = v_owner FOR UPDATE;
  v_min := COALESCE(NULLIF(p->>'min_amount_cents', '')::integer, v_cur.min_amount_cents);
  v_max := COALESCE(NULLIF(p->>'max_amount_cents', '')::integer, v_cur.max_amount_cents);
  IF v_min < 50 OR v_max < v_min OR v_max > 100000000 THEN RAISE EXCEPTION 'Invalid amount window' USING ERRCODE = '22023'; END IF;
  IF COALESCE(p->>'routing_mode', v_cur.routing_mode) NOT IN ('offer', 'prefer') THEN RAISE EXCEPTION 'Invalid routing mode' USING ERRCODE = '22023'; END IF;
  UPDATE bank_payment_settings SET
    enabled = COALESCE(NULLIF(p->>'enabled', '')::boolean, enabled),
    routing_mode = COALESCE(NULLIF(p->>'routing_mode', ''), routing_mode),
    min_amount_cents = v_min,
    max_amount_cents = v_max,
    provisional_membership_access = COALESCE(NULLIF(p->>'provisional_membership_access', '')::boolean, provisional_membership_access),
    provisional_limit_cents = COALESCE(NULLIF(p->>'provisional_limit_cents', '')::integer, provisional_limit_cents),
    rtp_enabled = COALESCE(NULLIF(p->>'rtp_enabled', '')::boolean, rtp_enabled),
    fednow_enabled = COALESCE(NULLIF(p->>'fednow_enabled', '')::boolean, fednow_enabled)
  WHERE user_id = v_owner RETURNING * INTO v_row;
  RETURN v_row;
END $$;
GRANT EXECUTE ON FUNCTION public.set_bank_payment_settings(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.bank_attempt_link_invoice(p_attempt_id uuid, p_invoice_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_status text;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bank_payment_attempts WHERE id = p_attempt_id AND user_id = v_owner
                 AND status = 'succeeded' AND accounting_status IN ('unlinked', 'failed', 'pending', 'skipped')) THEN
    RAISE EXCEPTION 'This payment cannot be linked' USING ERRCODE = 'P0002';
  END IF;
  v_status := public._bank_post_accounting(p_attempt_id, p_invoice_id);
  RETURN v_status;
END $$;
GRANT EXECUTE ON FUNCTION public.bank_attempt_link_invoice(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.bank_attempt_dismiss(p_attempt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE bank_payment_attempts SET accounting_status = 'skipped', accounting_error = NULL
  WHERE id = p_attempt_id AND user_id = v_owner AND accounting_status IN ('unlinked', 'failed');
  IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to dismiss' USING ERRCODE = 'P0002'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.bank_attempt_dismiss(uuid) TO authenticated;

-- Open invoices a staff member can link an unlinked bank payment to.
CREATE OR REPLACE FUNCTION public.list_linkable_invoices(p_min_balance_cents integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', id, 'invoice_number', invoice_number, 'balance_cents', total_cents - amount_paid_cents,
                                         'due_date', due_date, 'status', status) ORDER BY due_date)
    FROM (SELECT * FROM ar_invoices WHERE user_id = v_owner AND status IN ('sent', 'partially_paid', 'overdue')
            AND total_cents - amount_paid_cents >= GREATEST(p_min_balance_cents, 1)
          ORDER BY due_date LIMIT 100) i
  ), '[]'::jsonb);
END $$;
GRANT EXECUTE ON FUNCTION public.list_linkable_invoices(integer) TO authenticated;

-- =============================================================
-- 11. STATS + LOWER-FEE ROUTING SUGGESTIONS
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_bank_payment_stats(p_days integer DEFAULT 90)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 90), 7), 365);
  v_since timestamptz;
  v_min integer; v_max integer; v_res jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_payment_plans() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  v_since := now() - make_interval(days => v_days);
  SELECT COALESCE(min_amount_cents, 5000), COALESCE(max_amount_cents, 2500000) INTO v_min, v_max
  FROM (SELECT 1) x LEFT JOIN bank_payment_settings s ON s.user_id = v_owner;

  SELECT jsonb_build_object(
    'days', v_days,
    'bank_collected_cents', COALESCE(sum(amount_cents) FILTER (WHERE status = 'succeeded' AND settled_at >= v_since), 0),
    'in_flight_cents', COALESCE(sum(amount_cents) FILTER (WHERE status IN ('processing', 'verification_required')), 0),
    'in_flight_count', count(*) FILTER (WHERE status IN ('processing', 'verification_required')),
    'succeeded_count', count(*) FILTER (WHERE status = 'succeeded' AND settled_at >= v_since),
    'failed_count', count(*) FILTER (WHERE status = 'failed' AND failed_at >= v_since),
    'returned_count', count(*) FILTER (WHERE status IN ('returned', 'disputed') AND returned_at >= v_since),
    'success_rate', CASE WHEN count(*) FILTER (WHERE created_at >= v_since AND status IN ('succeeded', 'failed', 'returned', 'disputed')) = 0 THEN NULL
      ELSE round(count(*) FILTER (WHERE created_at >= v_since AND status = 'succeeded')::numeric
                 / count(*) FILTER (WHERE created_at >= v_since AND status IN ('succeeded', 'failed', 'returned', 'disputed')), 4) END,
    'fees_saved_cents', COALESCE(sum(card_fee_estimate_cents - fee_estimate_cents) FILTER (WHERE status = 'succeeded' AND settled_at >= v_since), 0),
    'avg_settle_days', round((avg(extract(epoch FROM (settled_at - created_at)) / 86400.0) FILTER (WHERE status = 'succeeded' AND settled_at >= v_since))::numeric, 1),
    'needs_review_count', count(*) FILTER (WHERE (status = 'succeeded' AND accounting_status IN ('unlinked', 'failed'))
                                                OR (status IN ('returned', 'disputed') AND accounting_status = 'failed'))
  ) INTO v_res FROM bank_payment_attempts WHERE user_id = v_owner;

  RETURN v_res || jsonb_build_object(
    'card_volume_cents', COALESCE((SELECT sum(round(amount * 100)) FROM payment_requests
        WHERE user_id = v_owner AND status = 'paid' AND paid_at >= v_since AND COALESCE(payment_rail, 'card') = 'card'), 0),
    'potential_savings_cents', COALESCE((SELECT sum(public.bank_fee_estimate('card', round(amount * 100)::integer)
                                                    - public.bank_fee_estimate('ach_debit', round(amount * 100)::integer))
        FROM payment_requests WHERE user_id = v_owner AND status = 'paid' AND paid_at >= v_since AND COALESCE(payment_rail, 'card') = 'card'
          AND round(amount * 100) BETWEEN v_min AND v_max), 0),
    'suggestions', COALESCE((
      SELECT jsonb_agg(s ORDER BY (s->>'potential_savings_cents')::bigint DESC) FROM (
        SELECT jsonb_build_object(
          'customer_name', min(customer_name),
          'payments', count(*),
          'card_volume_cents', sum(round(amount * 100))::bigint,
          'potential_savings_cents', sum(public.bank_fee_estimate('card', round(amount * 100)::integer)
                                         - public.bank_fee_estimate('ach_debit', round(amount * 100)::integer))::bigint,
          'reason', CASE WHEN count(*) >= 2 THEN 'Repeat customer paying by card' ELSE 'Large card payment' END) AS s
        FROM payment_requests
        WHERE user_id = v_owner AND status = 'paid' AND paid_at >= v_since AND COALESCE(payment_rail, 'card') = 'card'
          AND round(amount * 100) BETWEEN v_min AND v_max
        GROUP BY lower(btrim(customer_name))
        HAVING sum(public.bank_fee_estimate('card', round(amount * 100)::integer) - public.bank_fee_estimate('ach_debit', round(amount * 100)::integer)) >= 500
        ORDER BY sum(public.bank_fee_estimate('card', round(amount * 100)::integer) - public.bank_fee_estimate('ach_debit', round(amount * 100)::integer)) DESC
        LIMIT 10
      ) q
    ), '[]'::jsonb));
END $$;
GRANT EXECUTE ON FUNCTION public.get_bank_payment_stats(integer) TO authenticated;
