/*
  # In-person payments (Tap to Pay / Stripe Terminal, cash, check) + deposit tracking

  - job_payments: one row per in-person payment attempt/receipt.
      card_present  -> created by the `terminal-payments` edge function (service role),
                       finalized by that function and/or the Stripe webhook.
      cash / check  -> created ONLY via record_manual_payment() (SECURITY DEFINER).
  - payment_deposit_batches: a bank deposit (slip) grouping cash/check receipts.
  - Money is stored in integer cents. Clients never write these tables directly.
  - Online Checkout payments (payment_requests) stay as-is; _job_balance() combines both
    so a job can never be over-collected.
  - jobs.invoice_status is synced to 'paid' when balance hits zero. If the existing
    job-quality gate blocks that transition, the payment is STILL recorded (money was
    received) and the gate message is returned to the UI.
*/

ALTER TABLE stripe_connect_accounts
  ADD COLUMN IF NOT EXISTS terminal_location_id text;

-- =============================================================
-- Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public._is_account_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT tm.role IN ('owner', 'admin') FROM team_members tm WHERE tm.user_id = auth.uid() LIMIT 1),
    (SELECT p.role IN ('owner', 'admin') FROM profiles p WHERE p.id = auth.uid()),
    false
  );
$$;

-- Strictly boolean (never NULL): manager of the job's account, or the assigned technician.
CREATE OR REPLACE FUNCTION public._can_access_job_payments(p_job_user uuid, p_job_tech uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    p_job_user IS NOT NULL
    AND p_job_user = public.get_account_owner_id()
    AND (
      public._is_account_manager()
      OR COALESCE(p_job_tech = public.get_my_team_member_id(), false)
    ),
    false
  );
$$;

-- =============================================================
-- Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS payment_deposit_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_by_user_id uuid,
  created_by_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  deposited_at date NOT NULL DEFAULT current_date,
  bank_reference text CHECK (bank_reference IS NULL OR char_length(bank_reference) <= 80),
  deposit_slip_number text CHECK (deposit_slip_number IS NULL OR char_length(deposit_slip_number) <= 40),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  cash_cents bigint NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  check_cents bigint NOT NULL DEFAULT 0 CHECK (check_cents >= 0),
  payment_count integer NOT NULL CHECK (payment_count > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deposit_batches_user ON payment_deposit_batches(user_id, deposited_at DESC);

CREATE TABLE IF NOT EXISTS job_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('card_present', 'cash', 'check')),
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed', 'voided')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  currency text NOT NULL DEFAULT 'usd',
  tendered_cents integer CHECK (tendered_cents IS NULL OR tendered_cents >= amount_cents),
  recorded_by_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  recorded_by_user_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  -- check details
  check_number text,
  check_bank text CHECK (check_bank IS NULL OR char_length(check_bank) <= 80),
  check_payer_name text CHECK (check_payer_name IS NULL OR char_length(check_payer_name) <= 120),
  check_date date,
  -- card details (never a PAN — brand/last4 only, from Stripe)
  stripe_payment_intent_id text UNIQUE,
  card_brand text,
  card_last4 text,
  failure_message text,
  -- deposit tracking (cash/check only)
  deposit_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (deposit_status IN ('not_applicable', 'undeposited', 'deposited')),
  deposit_batch_id uuid REFERENCES payment_deposit_batches(id) ON DELETE SET NULL,
  -- void audit
  voided_at timestamptz,
  voided_by_user_id uuid,
  void_reason text,
  client_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_payments_check_number_required
    CHECK (method <> 'check' OR (check_number IS NOT NULL AND check_number ~ '^[A-Z0-9-]{1,20}$')),
  CONSTRAINT job_payments_deposit_scope
    CHECK ((method = 'card_present') = (deposit_status = 'not_applicable')),
  CONSTRAINT job_payments_deposit_batch_consistency
    CHECK ((deposit_status = 'deposited') = (deposit_batch_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_payments_request
  ON job_payments(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_payments_check_per_job
  ON job_payments(user_id, job_id, check_number) WHERE method = 'check' AND status <> 'voided';
CREATE INDEX IF NOT EXISTS idx_job_payments_job ON job_payments(job_id);
CREATE INDEX IF NOT EXISTS idx_job_payments_undeposited
  ON job_payments(user_id, received_at DESC) WHERE deposit_status = 'undeposited' AND status = 'succeeded';
CREATE INDEX IF NOT EXISTS idx_job_payments_batch ON job_payments(deposit_batch_id);

DROP TRIGGER IF EXISTS trigger_job_payments_updated_at ON job_payments;
CREATE TRIGGER trigger_job_payments_updated_at
  BEFORE UPDATE ON job_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Defense in depth: financial core fields are immutable once written.
CREATE OR REPLACE FUNCTION public.job_payments_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.job_id <> OLD.job_id OR NEW.method <> OLD.method
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.check_number IS DISTINCT FROM OLD.check_number THEN
    RAISE EXCEPTION 'job_payments core fields are immutable';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'a voided payment cannot be reopened';
  END IF;
  IF OLD.deposit_status = 'deposited' AND NEW.deposit_status <> 'deposited' THEN
    RAISE EXCEPTION 'a deposited payment cannot be un-deposited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_job_payments_guard ON job_payments;
CREATE TRIGGER trigger_job_payments_guard
  BEFORE UPDATE ON job_payments
  FOR EACH ROW EXECUTE FUNCTION public.job_payments_guard();

-- =============================================================
-- RLS: read-only for clients; managers see all, technicians see their own
-- =============================================================
ALTER TABLE job_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_deposit_batches ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON job_payments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON payment_deposit_batches FROM anon, authenticated;

DROP POLICY IF EXISTS "select_job_payments" ON job_payments;
CREATE POLICY "select_job_payments" ON job_payments FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public._is_account_manager() OR recorded_by_member_id = public.get_my_team_member_id())
  );

DROP POLICY IF EXISTS "select_deposit_batches" ON payment_deposit_batches;
CREATE POLICY "select_deposit_batches" ON payment_deposit_batches FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public._is_account_manager() OR created_by_member_id = public.get_my_team_member_id())
  );

-- =============================================================
-- Internal: balance + invoice sync (service role / other definer functions only)
-- =============================================================
CREATE OR REPLACE FUNCTION public._job_balance(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH j AS (
    SELECT COALESCE(round(invoice_amount * 100)::bigint, 0) AS invoice_cents FROM jobs WHERE id = p_job_id
  ), ip AS (
    SELECT COALESCE(sum(amount_cents), 0)::bigint AS cents
    FROM job_payments WHERE job_id = p_job_id AND status = 'succeeded'
  ), op AS (
    SELECT COALESCE(sum(round(amount * 100)), 0)::bigint AS cents
    FROM payment_requests WHERE job_id = p_job_id AND status = 'paid'
  )
  SELECT jsonb_build_object(
    'invoice_cents', j.invoice_cents,
    'paid_cents', ip.cents + op.cents,
    'balance_cents', GREATEST(j.invoice_cents - ip.cents - op.cents, 0)
  )
  FROM j, ip, op;
$$;

CREATE OR REPLACE FUNCTION public._sync_job_invoice_status(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_bal jsonb;
  v_target text;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  v_bal := public._job_balance(p_job_id);

  IF (v_bal->>'invoice_cents')::bigint > 0 AND (v_bal->>'balance_cents')::bigint = 0 THEN
    v_target := 'paid';
  ELSIF v_job.invoice_status = 'paid' THEN
    v_target := 'sent';  -- a payment was voided: reopen
  ELSE
    RETURN jsonb_build_object('changed', false);
  END IF;

  IF v_target = v_job.invoice_status THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  BEGIN
    UPDATE jobs SET invoice_status = v_target WHERE id = p_job_id;
    RETURN jsonb_build_object('changed', true, 'invoice_status', v_target);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'JOB_QUALITY_GATE_BLOCKED%' THEN
      RETURN jsonb_build_object('changed', false, 'gate_blocked', true, 'gate_message', SQLERRM);
    END IF;
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public._job_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._sync_job_invoice_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._job_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._sync_job_invoice_status(uuid) TO service_role;

-- =============================================================
-- RPC: job payment summary (what the technician sees)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_job_payment_summary(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_bal jsonb;
  v_payments jsonb;
  v_card_ready boolean;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT public._can_access_job_payments(v_job.user_id, v_job.assigned_technician_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  v_bal := public._job_balance(p_job_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.received_at DESC), '[]'::jsonb) INTO v_payments
  FROM (
    SELECT id, method, status, amount_cents, tendered_cents, received_at, note, check_number,
           check_bank, check_payer_name, card_brand, card_last4, deposit_status, failure_message
    FROM job_payments
    WHERE job_id = p_job_id AND status IN ('succeeded', 'pending', 'voided')
  ) r;

  SELECT COALESCE(bool_or(charges_enabled AND stripe_account_id IS NOT NULL), false) INTO v_card_ready
  FROM stripe_connect_accounts WHERE user_id = v_job.user_id;

  RETURN v_bal || jsonb_build_object('currency', 'usd', 'card_ready', COALESCE(v_card_ready, false), 'payments', v_payments);
END;
$$;

-- =============================================================
-- RPC: record cash / check
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_manual_payment(
  p_job_id uuid,
  p_method text,
  p_amount_cents integer,
  p_check_number text DEFAULT NULL,
  p_check_bank text DEFAULT NULL,
  p_check_payer text DEFAULT NULL,
  p_tendered_cents integer DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL,
  p_check_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_owner uuid;
  v_member uuid;
  v_existing job_payments%ROWTYPE;
  v_bal jsonb;
  v_check text;
  v_id uuid;
  v_inv jsonb;
  v_seen_elsewhere boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'check') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_method');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF NOT public._can_access_job_payments(v_job.user_id, v_job.assigned_technician_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  v_owner := v_job.user_id;
  v_member := public.get_my_team_member_id();

  -- Idempotent retry (same request id => same payment)
  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM job_payments
    WHERE user_id = v_owner AND client_request_id = p_client_request_id;
    IF FOUND THEN
      v_bal := public._job_balance(p_job_id);
      RETURN jsonb_build_object('success', true, 'duplicate', true, 'payment_id', v_existing.id,
                                'balance_cents', (v_bal->>'balance_cents')::bigint);
    END IF;
  END IF;

  v_bal := public._job_balance(p_job_id);
  IF (v_bal->>'invoice_cents')::bigint <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_invoice_amount');
  END IF;
  IF p_amount_cents > (v_bal->>'balance_cents')::bigint THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_balance',
                              'balance_cents', (v_bal->>'balance_cents')::bigint);
  END IF;

  IF p_method = 'check' THEN
    v_check := upper(btrim(COALESCE(p_check_number, '')));
    IF v_check !~ '^[A-Z0-9-]{1,20}$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_check_number');
    END IF;
    IF p_check_date IS NOT NULL AND p_check_date > current_date + 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'postdated_check');
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM job_payments
      WHERE user_id = v_owner AND method = 'check' AND status <> 'voided'
        AND check_number = v_check AND job_id <> p_job_id
        AND received_at > now() - interval '365 days'
    ) INTO v_seen_elsewhere;
  ELSE
    v_check := NULL;
    IF p_tendered_cents IS NOT NULL AND p_tendered_cents < p_amount_cents THEN
      RETURN jsonb_build_object('success', false, 'error', 'tendered_less_than_amount');
    END IF;
  END IF;

  BEGIN
    INSERT INTO job_payments (
      user_id, job_id, method, status, amount_cents, tendered_cents,
      recorded_by_member_id, recorded_by_user_id, note,
      check_number, check_bank, check_payer_name, check_date,
      deposit_status, client_request_id
    ) VALUES (
      v_owner, p_job_id, p_method, 'succeeded', p_amount_cents,
      CASE WHEN p_method = 'cash' THEN COALESCE(p_tendered_cents, p_amount_cents) ELSE NULL END,
      v_member, auth.uid(), NULLIF(btrim(COALESCE(p_note, '')), ''),
      v_check, NULLIF(btrim(COALESCE(p_check_bank, '')), ''), NULLIF(btrim(COALESCE(p_check_payer, '')), ''),
      CASE WHEN p_method = 'check' THEN p_check_date ELSE NULL END,
      'undeposited', p_client_request_id
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF p_client_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM job_payments WHERE user_id = v_owner AND client_request_id = p_client_request_id
    ) THEN
      RETURN jsonb_build_object('success', true, 'duplicate', true);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_check_number');
  END;

  v_inv := public._sync_job_invoice_status(p_job_id);
  v_bal := public._job_balance(p_job_id);

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', v_id,
    'balance_cents', (v_bal->>'balance_cents')::bigint,
    'invoice_gate_blocked', COALESCE((v_inv->>'gate_blocked')::boolean, false),
    'invoice_gate_message', v_inv->>'gate_message',
    'warning', CASE WHEN v_seen_elsewhere THEN 'check_number_seen_elsewhere' ELSE NULL END
  );
END;
$$;

-- =============================================================
-- RPC: void a cash/check payment (managers only, before deposit)
-- =============================================================
CREATE OR REPLACE FUNCTION public.void_job_payment(p_payment_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay job_payments%ROWTYPE;
  v_inv jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._is_account_manager() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_pay FROM job_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR v_pay.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF v_pay.method = 'card_present' THEN
    RETURN jsonb_build_object('success', false, 'error', 'use_stripe_refund');
  END IF;
  IF v_pay.status <> 'succeeded' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_voidable');
  END IF;
  IF v_pay.deposit_status = 'deposited' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_deposited');
  END IF;

  UPDATE job_payments
  SET status = 'voided', voided_at = now(), voided_by_user_id = auth.uid(), void_reason = btrim(p_reason)
  WHERE id = p_payment_id;

  v_inv := public._sync_job_invoice_status(v_pay.job_id);
  RETURN jsonb_build_object('success', true, 'invoice_gate_blocked', COALESCE((v_inv->>'gate_blocked')::boolean, false));
END;
$$;

-- =============================================================
-- RPC: create a bank deposit batch from undeposited cash/check
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_deposit_batch(
  p_payment_ids uuid[],
  p_deposited_at date DEFAULT current_date,
  p_bank_reference text DEFAULT NULL,
  p_slip_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_member uuid;
  v_manager boolean;
  v_ids uuid[];
  v_count integer;
  v_cash bigint;
  v_check bigint;
  v_batch uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;
  v_owner := public.get_account_owner_id();
  v_member := public.get_my_team_member_id();
  v_manager := public._is_account_manager();
  IF v_owner IS NULL OR NOT (v_manager OR v_member IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_ids FROM unnest(COALESCE(p_payment_ids, '{}')) AS x;
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_payments');
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_many_payments');
  END IF;
  IF p_deposited_at IS NULL OR p_deposited_at > current_date + 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_deposit_date');
  END IF;

  PERFORM 1 FROM job_payments WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;

  SELECT count(*),
         COALESCE(sum(amount_cents) FILTER (WHERE method = 'cash'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE method = 'check'), 0)
  INTO v_count, v_cash, v_check
  FROM job_payments
  WHERE id = ANY(v_ids)
    AND user_id = v_owner
    AND method IN ('cash', 'check')
    AND status = 'succeeded'
    AND deposit_status = 'undeposited'
    AND (v_manager OR recorded_by_member_id = v_member);

  IF v_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_selection');
  END IF;

  INSERT INTO payment_deposit_batches (
    user_id, created_by_user_id, created_by_member_id, deposited_at,
    bank_reference, deposit_slip_number, notes, cash_cents, check_cents, payment_count
  ) VALUES (
    v_owner, auth.uid(), v_member, p_deposited_at,
    NULLIF(btrim(COALESCE(p_bank_reference, '')), ''), NULLIF(btrim(COALESCE(p_slip_number, '')), ''),
    NULLIF(btrim(COALESCE(p_notes, '')), ''), v_cash, v_check, v_count
  ) RETURNING id INTO v_batch;

  UPDATE job_payments SET deposit_status = 'deposited', deposit_batch_id = v_batch WHERE id = ANY(v_ids);

  RETURN jsonb_build_object('success', true, 'batch_id', v_batch, 'cash_cents', v_cash,
                            'check_cents', v_check, 'payment_count', v_count);
END;
$$;

-- =============================================================
-- RPC: deposit overview (undeposited cash/check + recent batches)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_deposit_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_member uuid;
  v_manager boolean;
  v_undep jsonb;
  v_batches jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_owner := public.get_account_owner_id();
  v_member := public.get_my_team_member_id();
  v_manager := public._is_account_manager();
  IF v_owner IS NULL OR NOT (v_manager OR v_member IS NOT NULL) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.received_at DESC), '[]'::jsonb) INTO v_undep
  FROM (
    SELECT p.id, p.job_id, j.customer_name, p.method, p.amount_cents, p.received_at,
           p.check_number, p.check_bank
    FROM job_payments p
    JOIN jobs j ON j.id = p.job_id
    WHERE p.user_id = v_owner AND p.method IN ('cash', 'check')
      AND p.status = 'succeeded' AND p.deposit_status = 'undeposited'
      AND (v_manager OR p.recorded_by_member_id = v_member)
    ORDER BY p.received_at DESC
    LIMIT 500
  ) r;

  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC), '[]'::jsonb) INTO v_batches
  FROM (
    SELECT id, deposited_at, bank_reference, deposit_slip_number, notes,
           cash_cents, check_cents, payment_count, created_at
    FROM payment_deposit_batches
    WHERE user_id = v_owner AND (v_manager OR created_by_member_id = v_member)
    ORDER BY created_at DESC
    LIMIT 20
  ) b;

  RETURN jsonb_build_object('undeposited', v_undep, 'batches', v_batches);
END;
$$;

REVOKE ALL ON FUNCTION public.get_job_payment_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_manual_payment(uuid, text, integer, text, text, text, integer, text, uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_job_payment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_deposit_batch(uuid[], date, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_deposit_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_payment_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_payment(uuid, text, integer, text, text, text, integer, text, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_job_payment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_deposit_batch(uuid[], date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_deposit_overview() TO authenticated;
