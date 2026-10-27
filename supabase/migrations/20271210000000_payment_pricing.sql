/*
  # Card surcharge / convenience fee + cash discount (dual pricing)

  - payment_pricing_settings   one row per account (mode, rates, state, wording, compliance acknowledgement)
  - payment_pricing_history    append-only audit of every settings change
  - payment_requests           + fee columns (fee charged / refunded / label / card funding / method)
  - payment_price_adjustments  one row per cash discount given (reversed automatically if the payment is voided)
  - record_payment_request_fee()          service role: stores the fee outcome after Stripe confirms the charge
  - record_discounted_manual_payment()    cash/check payment WITH the cash discount, atomic, idempotent
  - get_job_pricing_ledger()              fees + discounts for a job (receipts / job screen)

  Additive only. finalize_paid_payment_request(), _job_balance() and record_manual_payment() are NOT changed:
  the invoice amount (payment_requests.amount / jobs.invoice_amount) stays the price of the work, and the fee
  is tracked beside it exactly like tip_cents is.

  Requires earlier migrations: get_account_owner_id(), _is_account_manager(), _can_access_job_payments(),
  _job_balance(), record_manual_payment(), job_payments (in_person_payments), payment_requests (tipping).
*/

-- =============================================================
-- 1. Settings (+ audit)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_pricing_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'surcharge', 'convenience_fee', 'cash_discount')),
  surcharge_bps integer NOT NULL DEFAULT 0 CHECK (surcharge_bps BETWEEN 0 AND 300),
  flat_fee_cents integer NOT NULL DEFAULT 0 CHECK (flat_fee_cents BETWEEN 0 AND 5000),
  cash_discount_bps integer NOT NULL DEFAULT 0 CHECK (cash_discount_bps BETWEEN 0 AND 500),
  exclude_debit boolean NOT NULL DEFAULT true,
  business_state text CHECK (business_state IS NULL OR business_state ~ '^[A-Z]{2}$'),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
  disclosure text NOT NULL DEFAULT '' CHECK (char_length(disclosure) <= 400),
  compliance_acknowledged_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pps_mode_values CHECK (
    mode = 'off'
    OR (mode = 'surcharge' AND surcharge_bps > 0)
    OR (mode = 'convenience_fee' AND flat_fee_cents > 0)
    OR (mode = 'cash_discount' AND cash_discount_bps > 0)
  ),
  CONSTRAINT pps_ack_required CHECK (mode = 'off' OR compliance_acknowledged_at IS NOT NULL),
  CONSTRAINT pps_state_required CHECK (mode NOT IN ('surcharge', 'convenience_fee') OR business_state IS NOT NULL),
  CONSTRAINT pps_banned_states CHECK (NOT (mode IN ('surcharge', 'convenience_fee') AND business_state IN ('CT', 'MA', 'PR'))),
  CONSTRAINT pps_colorado_cap CHECK (NOT (mode = 'surcharge' AND business_state = 'CO' AND surcharge_bps > 200))
);

CREATE OR REPLACE FUNCTION public.pps_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  NEW.business_state := upper(NEW.business_state);
  NEW.label := btrim(NEW.label);
  NEW.disclosure := btrim(NEW.disclosure);
  -- The acknowledgement time is always the server's clock, never the client's.
  IF TG_OP = 'INSERT' THEN
    IF NEW.compliance_acknowledged_at IS NOT NULL THEN NEW.compliance_acknowledged_at := now(); END IF;
  ELSIF NEW.compliance_acknowledged_at IS DISTINCT FROM OLD.compliance_acknowledged_at THEN
    NEW.compliance_acknowledged_at := CASE WHEN NEW.compliance_acknowledged_at IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pps_before_write ON public.payment_pricing_settings;
CREATE TRIGGER trg_pps_before_write
  BEFORE INSERT OR UPDATE ON public.payment_pricing_settings
  FOR EACH ROW EXECUTE FUNCTION public.pps_before_write();

CREATE TABLE IF NOT EXISTS public.payment_pricing_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_settings jsonb,
  new_settings jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pps_history_user ON public.payment_pricing_history(user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.pps_log_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF (v_old - 'updated_at' - 'updated_by') = (v_new - 'updated_at' - 'updated_by') THEN
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO public.payment_pricing_history (user_id, changed_by, old_settings, new_settings)
  VALUES (NEW.user_id, auth.uid(), v_old, v_new);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pps_log_history ON public.payment_pricing_settings;
CREATE TRIGGER trg_pps_log_history
  AFTER INSERT OR UPDATE ON public.payment_pricing_settings
  FOR EACH ROW EXECUTE FUNCTION public.pps_log_history();

ALTER TABLE public.payment_pricing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_pricing_history ENABLE ROW LEVEL SECURITY;

-- Everyone on the account can READ the settings (technicians need the cash price); only managers WRITE.
DROP POLICY IF EXISTS "pps_select" ON public.payment_pricing_settings;
CREATE POLICY "pps_select" ON public.payment_pricing_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pps_insert" ON public.payment_pricing_settings;
CREATE POLICY "pps_insert" ON public.payment_pricing_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public._is_account_manager());
DROP POLICY IF EXISTS "pps_update" ON public.payment_pricing_settings;
CREATE POLICY "pps_update" ON public.payment_pricing_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._is_account_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public._is_account_manager());

DROP POLICY IF EXISTS "pps_history_select" ON public.payment_pricing_history;
CREATE POLICY "pps_history_select" ON public.payment_pricing_history FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._is_account_manager());

-- =============================================================
-- 2. Fee columns on payment_requests (the invoice amount column is NEVER touched)
-- =============================================================
ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS fee_cents integer NOT NULL DEFAULT 0 CONSTRAINT payment_requests_fee_cents_check CHECK (fee_cents >= 0),
  ADD COLUMN IF NOT EXISTS fee_refunded_cents integer NOT NULL DEFAULT 0 CONSTRAINT payment_requests_fee_refunded_check CHECK (fee_refunded_cents >= 0),
  ADD COLUMN IF NOT EXISTS fee_mode text,
  ADD COLUMN IF NOT EXISTS fee_label text,
  ADD COLUMN IF NOT EXISTS fee_bps integer,
  ADD COLUMN IF NOT EXISTS fee_refund_reason text,
  ADD COLUMN IF NOT EXISTS payment_method_type text,
  ADD COLUMN IF NOT EXISTS card_funding text;

-- Called by the Stripe webhook (service role) once the charge is confirmed and any fee refund is issued.
-- Idempotent: running it twice with the same values changes nothing.
CREATE OR REPLACE FUNCTION public.record_payment_request_fee(
  p_request_id uuid,
  p_fee_cents integer,
  p_refunded_cents integer,
  p_mode text,
  p_label text,
  p_bps integer,
  p_refund_reason text,
  p_method_type text,
  p_funding text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r payment_requests%ROWTYPE;
BEGIN
  IF p_fee_cents IS NULL OR p_fee_cents < 0 OR p_refunded_cents IS NULL OR p_refunded_cents < 0 OR p_refunded_cents > p_fee_cents THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO r FROM payment_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF r.status <> 'paid' THEN RETURN jsonb_build_object('status', 'not_paid'); END IF;

  UPDATE payment_requests
    SET fee_cents = p_fee_cents,
        fee_refunded_cents = p_refunded_cents,
        fee_mode = NULLIF(btrim(COALESCE(p_mode, '')), ''),
        fee_label = left(NULLIF(btrim(COALESCE(p_label, '')), ''), 40),
        fee_bps = p_bps,
        fee_refund_reason = left(NULLIF(btrim(COALESCE(p_refund_reason, '')), ''), 40),
        payment_method_type = left(NULLIF(btrim(COALESCE(p_method_type, '')), ''), 40),
        card_funding = left(NULLIF(btrim(COALESCE(p_funding, '')), ''), 20),
        total_charged_cents = round(r.amount * 100)::integer + r.tip_cents + p_fee_cents - p_refunded_cents
    WHERE id = r.id;

  RETURN jsonb_build_object('status', 'recorded', 'kept_cents', p_fee_cents - p_refunded_cents);
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_request_fee(uuid, integer, integer, text, text, integer, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_request_fee(uuid, integer, integer, text, text, integer, text, text, text) TO service_role;

-- =============================================================
-- 3. Cash discount ledger
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_price_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_payment_id uuid REFERENCES job_payments(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'cash_discount' CHECK (kind IN ('cash_discount')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  discount_bps integer NOT NULL CHECK (discount_bps > 0),
  settled_cents integer NOT NULL CHECK (settled_cents > 0),
  client_request_id uuid,
  reversed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_adjustments_request
  ON public.payment_price_adjustments(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_adjustments_job ON public.payment_price_adjustments(job_id);
CREATE INDEX IF NOT EXISTS idx_price_adjustments_payment ON public.payment_price_adjustments(job_payment_id) WHERE job_payment_id IS NOT NULL;

ALTER TABLE public.payment_price_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_price_adjustments" ON public.payment_price_adjustments;
CREATE POLICY "select_own_price_adjustments" ON public.payment_price_adjustments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No write policies: rows are written only by record_discounted_manual_payment().

-- Voiding a discounted cash/check payment gives the discount back to the invoice, so the job is not left under-priced.
CREATE OR REPLACE FUNCTION public._reverse_cash_discount_on_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a payment_price_adjustments%ROWTYPE;
BEGIN
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    FOR a IN
      SELECT * FROM payment_price_adjustments WHERE job_payment_id = NEW.id AND reversed_at IS NULL FOR UPDATE
    LOOP
      UPDATE jobs SET invoice_amount = round((invoice_amount + a.amount_cents / 100.0)::numeric, 2) WHERE id = a.job_id;
      UPDATE payment_price_adjustments SET reversed_at = now() WHERE id = a.id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reverse_cash_discount_on_void ON public.job_payments;
CREATE TRIGGER trg_reverse_cash_discount_on_void
  AFTER UPDATE OF status ON public.job_payments
  FOR EACH ROW EXECUTE FUNCTION public._reverse_cash_discount_on_void();

-- =============================================================
-- 4. Cash / check payment WITH the cash discount
--    settled = what the payment settles at the listed (card) price. The customer pays settled - discount.
--    The discount is a price reduction on the job, recorded in the ledger, in the same transaction as the payment.
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_discounted_manual_payment(
  p_job_id uuid,
  p_method text,
  p_settled_cents integer,
  p_expected_discount_cents integer,
  p_client_request_id uuid,
  p_tendered_cents integer DEFAULT NULL,
  p_check_number text DEFAULT NULL,
  p_check_bank text DEFAULT NULL,
  p_check_payer text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_check_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_cfg payment_pricing_settings%ROWTYPE;
  v_existing payment_price_adjustments%ROWTYPE;
  v_bal jsonb;
  v_discount integer;
  v_cash integer;
  v_adj uuid;
  v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'check') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_method');
  END IF;
  IF p_settled_cents IS NULL OR p_settled_cents <= 0 OR p_settled_cents > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF p_client_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF NOT public._can_access_job_payments(v_job.user_id, v_job.assigned_technician_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  -- Idempotent retry: the same request id is the same payment.
  SELECT * INTO v_existing FROM payment_price_adjustments
    WHERE user_id = v_job.user_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    v_bal := public._job_balance(p_job_id);
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'payment_id', v_existing.job_payment_id,
                              'balance_cents', (v_bal->>'balance_cents')::bigint, 'discount_cents', v_existing.amount_cents);
  END IF;

  SELECT * INTO v_cfg FROM payment_pricing_settings WHERE user_id = v_job.user_id;
  IF NOT FOUND OR v_cfg.mode <> 'cash_discount' OR v_cfg.cash_discount_bps <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'discount_not_enabled');
  END IF;

  v_bal := public._job_balance(p_job_id);
  IF (v_bal->>'invoice_cents')::bigint <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_invoice_amount');
  END IF;
  IF p_settled_cents > (v_bal->>'balance_cents')::bigint THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_balance', 'balance_cents', (v_bal->>'balance_cents')::bigint);
  END IF;

  -- Half-up on the cent, identical to cashDiscountForBps() in the shared TypeScript engine.
  v_discount := ((p_settled_cents::bigint * v_cfg.cash_discount_bps + 5000) / 10000)::integer;
  IF v_discount <= 0 OR v_discount >= p_settled_cents THEN
    RETURN jsonb_build_object('success', false, 'error', 'discount_too_small');
  END IF;
  IF p_expected_discount_cents IS DISTINCT FROM v_discount THEN
    RETURN jsonb_build_object('success', false, 'error', 'discount_changed', 'discount_cents', v_discount);
  END IF;

  v_cash := p_settled_cents - v_discount;
  IF p_method = 'cash' AND p_tendered_cents IS NOT NULL AND p_tendered_cents < v_cash THEN
    RETURN jsonb_build_object('success', false, 'error', 'tendered_less_than_amount');
  END IF;

  -- One atomic unit: if recording the payment is refused for any reason, the price change is rolled back with it.
  BEGIN
    UPDATE jobs
      SET invoice_amount = round((invoice_amount - v_discount / 100.0)::numeric, 2)
      WHERE id = p_job_id;

    INSERT INTO payment_price_adjustments (user_id, job_id, kind, amount_cents, discount_bps, settled_cents, client_request_id, created_by)
    VALUES (v_job.user_id, p_job_id, 'cash_discount', v_discount, v_cfg.cash_discount_bps, p_settled_cents, p_client_request_id, auth.uid())
    RETURNING id INTO v_adj;

    v_res := public.record_manual_payment(
      p_job_id => p_job_id,
      p_method => p_method,
      p_amount_cents => v_cash,
      p_check_number => p_check_number,
      p_check_bank => p_check_bank,
      p_check_payer => p_check_payer,
      p_tendered_cents => p_tendered_cents,
      p_note => p_note,
      p_client_request_id => p_client_request_id,
      p_check_date => p_check_date
    );

    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'pricing_inner:%', COALESCE(v_res->>'error', 'unknown') USING ERRCODE = 'P0001';
    END IF;

    UPDATE payment_price_adjustments
      SET job_payment_id = NULLIF(v_res->>'payment_id', '')::uuid
      WHERE id = v_adj;
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'error', regexp_replace(SQLERRM, '^pricing_inner:', ''));
  END;

  RETURN v_res || jsonb_build_object('discount_cents', v_discount, 'settled_cents', p_settled_cents, 'cash_cents', v_cash);
END;
$$;

REVOKE ALL ON FUNCTION public.record_discounted_manual_payment(uuid, text, integer, integer, uuid, integer, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_discounted_manual_payment(uuid, text, integer, integer, uuid, integer, text, text, text, text, date) TO authenticated;

-- =============================================================
-- 5. Fees + discounts for one job (job screen / receipts)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_job_pricing_ledger(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT public._can_access_job_payments(v_job.user_id, v_job.assigned_technician_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  RETURN jsonb_build_object(
    'fees', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'payment_request_id', pr.id, 'paid_at', pr.paid_at, 'fee_cents', pr.fee_cents,
        'refunded_cents', pr.fee_refunded_cents, 'label', pr.fee_label, 'mode', pr.fee_mode,
        'method_type', pr.payment_method_type, 'funding', pr.card_funding, 'refund_reason', pr.fee_refund_reason
      ) ORDER BY pr.paid_at)
      FROM payment_requests pr
      WHERE pr.job_id = p_job_id AND pr.status = 'paid' AND pr.fee_cents > 0
    ), '[]'::jsonb),
    'discounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'created_at', a.created_at, 'amount_cents', a.amount_cents,
        'discount_bps', a.discount_bps, 'settled_cents', a.settled_cents, 'reversed', a.reversed_at IS NOT NULL
      ) ORDER BY a.created_at)
      FROM payment_price_adjustments a
      WHERE a.job_id = p_job_id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_job_pricing_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_pricing_ledger(uuid) TO authenticated;
