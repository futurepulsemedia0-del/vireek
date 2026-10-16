/*
  # Refunds, Credit Memos & Refund Accounting

  - refunds / credit_memos tables (read-only for clients; every write goes through
    service_role RPCs called by the issue-refund edge function and the Stripe webhook).
  - Flow: refund_reserve (lock + cap) -> Stripe -> refund_finalize (credit memo + GL entry).
  - GL entry: Dr 4950 Refunds and Allowances (+ Dr 2100 Sales Tax Payable when a linked AR
    invoice carried tax) / Cr 1000 Cash and Bank. A failed/cancelled Stripe refund posts a
    reversing entry (original stays posted so P&L nets to zero).
*/

-- 0. Allow refund-sourced journal entries (robust to constraint drift)
DO $$
DECLARE
  v_con record;
  v_vals text[];
BEGIN
  FOR v_con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    WHERE c.conrelid = 'public.journal_entries'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%source_type%'
  LOOP
    IF v_con.def ILIKE '%refund_reversal%' THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT t.m[1]) INTO v_vals
    FROM regexp_matches(v_con.def, '''([a-z_]+)''', 'g') AS t(m);
    v_vals := coalesce(v_vals, ARRAY[]::text[]) || ARRAY['refund', 'refund_reversal'];
    EXECUTE format('ALTER TABLE public.journal_entries DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format(
      'ALTER TABLE public.journal_entries ADD CONSTRAINT %I CHECK (source_type IN (%s))',
      v_con.conname,
      (SELECT string_agg(quote_literal(x), ', ') FROM (SELECT DISTINCT unnest(v_vals) AS x) s)
    );
  END LOOP;
END $$;

-- 1. Tables
CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  reason_code text NOT NULL CHECK (reason_code IN (
    'duplicate_charge', 'service_not_completed', 'quality_issue', 'pricing_adjustment',
    'customer_cancelled', 'goodwill', 'fraudulent', 'other'
  )),
  reason_note text CHECK (reason_note IS NULL OR length(reason_note) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  stripe_refund_id text UNIQUE,
  failure_reason text,
  idempotency_key text NOT NULL,
  notify_customer boolean NOT NULL DEFAULT true,
  notice_status text NOT NULL DEFAULT 'not_sent' CHECK (notice_status IN ('not_sent', 'sent', 'failed', 'skipped')),
  notice_sent_at timestamptz,
  credit_memo_number text,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  ar_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  accounting_status text NOT NULL DEFAULT 'pending' CHECK (accounting_status IN ('pending', 'posted', 'reversed', 'failed')),
  accounting_error text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refunds_user_created ON refunds(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_request_id);
CREATE INDEX IF NOT EXISTS idx_refunds_pending ON refunds(status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS credit_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  memo_number text NOT NULL,
  refund_id uuid NOT NULL UNIQUE REFERENCES refunds(id) ON DELETE RESTRICT,
  payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  ar_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  reason_code text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  UNIQUE (user_id, memo_number)
);

CREATE INDEX IF NOT EXISTS idx_credit_memos_user ON credit_memos(user_id, issued_at DESC);

DROP TRIGGER IF EXISTS trigger_refunds_updated_at ON refunds;
CREATE TRIGGER trigger_refunds_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 2. RLS: whole-account SELECT, no client writes
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_memos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_refunds" ON refunds;
CREATE POLICY "select_own_refunds" ON refunds FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_credit_memos" ON credit_memos;
CREATE POLICY "select_own_credit_memos" ON credit_memos FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE ON refunds, credit_memos FROM anon, authenticated;
REVOKE ALL ON refunds, credit_memos FROM anon;

-- 3. Internal helpers (service_role only)
CREATE OR REPLACE FUNCTION public._refund_committed_cents(p_payment_request_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Reservations that never reached Stripe (no stripe_refund_id) stop counting after 15 minutes;
  -- Stripe itself remains the final guard against refunding more than the charge.
  SELECT COALESCE(SUM(amount_cents), 0)::integer FROM refunds
  WHERE payment_request_id = p_payment_request_id
    AND (status = 'succeeded'
         OR (status = 'pending' AND (stripe_refund_id IS NOT NULL OR created_at > now() - interval '15 minutes')));
$$;

CREATE OR REPLACE FUNCTION public._refund_ensure_chart(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system) VALUES
    (p_user_id, '1000', 'Cash and Bank', 'asset', 'debit', true),
    (p_user_id, '2100', 'Sales Tax Payable', 'liability', 'credit', true),
    (p_user_id, '4000', 'Service Revenue', 'revenue', 'credit', true),
    (p_user_id, '4950', 'Refunds and Allowances', 'revenue', 'debit', true)
  ON CONFLICT (user_id, code) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public._refund_post_je(
  p_user_id uuid, p_entry_date date, p_memo text, p_source_type text, p_source_id uuid, p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_debit bigint := 0;
  v_credit bigint := 0;
  v_n integer := 0;
BEGIN
  PERFORM public._gl_assert_period_open(p_user_id, p_entry_date);
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_debit := v_debit + coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := v_credit + coalesce((v_line->>'credit_cents')::bigint, 0);
  END LOOP;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Journal entry does not balance: % debit vs % credit', v_debit, v_credit;
  END IF;
  IF v_debit > 2147483647 THEN
    RAISE EXCEPTION 'Amount exceeds the ledger line limit';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('refund-gl:' || p_user_id::text, 0));

  INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id, created_by)
  VALUES (p_user_id, public._gl_next_number(p_user_id, 'JE', 'journal_entries'), p_entry_date, p_memo, p_source_type, p_source_id, auth.uid())
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description)
    VALUES (v_entry_id, v_n, (v_line->>'account_id')::uuid,
            coalesce((v_line->>'debit_cents')::integer, 0), coalesce((v_line->>'credit_cents')::integer, 0),
            v_line->>'description');
  END LOOP;
  RETURN v_entry_id;
END $$;

-- 4. Step 1: reserve (row lock + refundable cap + idempotent replay)
CREATE OR REPLACE FUNCTION public.refund_reserve(
  p_user_id uuid, p_payment_request_id uuid, p_amount_cents integer, p_reason_code text,
  p_reason_note text, p_notify boolean, p_idempotency_key text, p_actor_id uuid, p_actor_email text
) RETURNS refunds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pr payment_requests%ROWTYPE;
  v_existing refunds%ROWTYPE;
  v_row refunds%ROWTYPE;
  v_total integer;
  v_remaining integer;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'A valid idempotency key is required';
  END IF;

  SELECT * INTO v_pr FROM payment_requests WHERE id = p_payment_request_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;

  SELECT * INTO v_existing FROM refunds WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.payment_request_id <> p_payment_request_id OR v_existing.amount_cents <> p_amount_cents THEN
      RAISE EXCEPTION 'This request key was already used for a different refund';
    END IF;
    RETURN v_existing;
  END IF;

  IF v_pr.status <> 'paid' THEN RAISE EXCEPTION 'Only paid payments can be refunded'; END IF;
  IF v_pr.stripe_payment_intent_id IS NULL THEN
    RAISE EXCEPTION 'This payment was not collected through Stripe, so it cannot be refunded here';
  END IF;

  -- Fail before any money moves if the books are closed for today.
  PERFORM public._gl_assert_period_open(p_user_id, current_date);

  v_total := round(v_pr.amount * 100)::integer;
  v_remaining := v_total - public._refund_committed_cents(v_pr.id);
  IF p_amount_cents > v_remaining THEN
    RAISE EXCEPTION 'Refund exceeds the refundable balance of % cents', GREATEST(v_remaining, 0);
  END IF;

  INSERT INTO refunds (
    user_id, payment_request_id, job_id, customer_name, customer_email, customer_phone,
    amount_cents, currency, reason_code, reason_note, notify_customer, idempotency_key,
    created_by, created_by_email
  ) VALUES (
    p_user_id, v_pr.id, v_pr.job_id, v_pr.customer_name, v_pr.customer_email, v_pr.customer_phone,
    p_amount_cents, v_pr.currency, p_reason_code, p_reason_note, coalesce(p_notify, true), p_idempotency_key,
    p_actor_id, p_actor_email
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $$;

-- 5. Step 3: finalize after Stripe accepted (credit memo + GL entry). Idempotent.
CREATE OR REPLACE FUNCTION public.refund_finalize(p_refund_id uuid, p_stripe_refund_id text, p_stripe_status text)
RETURNS refunds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r refunds%ROWTYPE;
  v_inv ar_invoices%ROWTYPE;
  v_tax integer := 0;
  v_net integer;
  v_cash uuid; v_tax_acct uuid; v_contra uuid; v_revenue uuid;
  v_lines jsonb;
  v_je uuid;
  v_memo_number text;
  v_status text;
BEGIN
  SELECT * INTO v_r FROM refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;

  IF v_r.status IN ('failed', 'canceled') THEN RETURN v_r; END IF;

  v_status := CASE
    WHEN v_r.status = 'succeeded' THEN 'succeeded'
    WHEN p_stripe_status = 'succeeded' THEN 'succeeded'
    WHEN p_stripe_status IN ('failed', 'canceled') THEN p_stripe_status
    ELSE 'pending' END;

  IF v_status IN ('failed', 'canceled') THEN
    UPDATE refunds SET stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id), status = v_status,
      failure_reason = 'Stripe could not complete this refund', completed_at = now()
    WHERE id = p_refund_id;
    SELECT * INTO v_r FROM refunds WHERE id = p_refund_id;
    RETURN v_r;
  END IF;

  IF v_r.journal_entry_id IS NOT NULL THEN
    UPDATE refunds SET stripe_refund_id = coalesce(stripe_refund_id, p_stripe_refund_id), status = v_status,
      completed_at = CASE WHEN v_status = 'succeeded' THEN coalesce(completed_at, now()) ELSE completed_at END
    WHERE id = p_refund_id;
    SELECT * INTO v_r FROM refunds WHERE id = p_refund_id;
    RETURN v_r;
  END IF;

  BEGIN
    SELECT i.* INTO v_inv
    FROM ar_payments ap JOIN ar_invoices i ON i.id = ap.invoice_id
    WHERE ap.payment_request_id = v_r.payment_request_id AND ap.user_id = v_r.user_id
    ORDER BY ap.created_at DESC LIMIT 1;
    IF FOUND AND v_inv.total_cents > 0 AND v_inv.tax_cents > 0 THEN
      v_tax := LEAST(v_r.amount_cents, round(v_r.amount_cents::numeric * v_inv.tax_cents / v_inv.total_cents)::integer);
    END IF;
    v_net := v_r.amount_cents - v_tax;

    PERFORM public._refund_ensure_chart(v_r.user_id);
    SELECT id INTO v_cash FROM chart_of_accounts WHERE user_id = v_r.user_id AND code = '1000';
    SELECT id INTO v_tax_acct FROM chart_of_accounts WHERE user_id = v_r.user_id AND code = '2100';
    SELECT id INTO v_revenue FROM chart_of_accounts WHERE user_id = v_r.user_id AND code = '4000';
    SELECT id INTO v_contra FROM chart_of_accounts WHERE user_id = v_r.user_id AND code = '4950' AND type = 'revenue';
    v_contra := coalesce(v_contra, v_revenue);

    v_lines := '[]'::jsonb;
    IF v_net > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_contra, 'debit_cents', v_net, 'credit_cents', 0, 'description', 'Customer refund'));
    END IF;
    IF v_tax > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_tax_acct, 'debit_cents', v_tax, 'credit_cents', 0, 'description', 'Sales tax refunded'));
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_r.amount_cents, 'description', 'Refund paid via Stripe'));

    v_memo_number := public._gl_next_number(v_r.user_id, 'CM', 'credit_memos');
    v_je := public._refund_post_je(v_r.user_id, current_date, 'Refund ' || v_memo_number, 'refund', v_r.id, v_lines);

    INSERT INTO credit_memos (user_id, memo_number, refund_id, payment_request_id, ar_invoice_id, customer_name,
                              amount_cents, tax_cents, reason_code, journal_entry_id)
    VALUES (v_r.user_id, v_memo_number, v_r.id, v_r.payment_request_id, v_inv.id, v_r.customer_name,
            v_r.amount_cents, v_tax, v_r.reason_code, v_je);

    UPDATE refunds SET
      stripe_refund_id = p_stripe_refund_id, status = v_status, journal_entry_id = v_je,
      credit_memo_number = v_memo_number, ar_invoice_id = v_inv.id,
      accounting_status = 'posted', accounting_error = NULL,
      completed_at = CASE WHEN v_status = 'succeeded' THEN now() ELSE completed_at END
    WHERE id = p_refund_id;
  EXCEPTION WHEN OTHERS THEN
    -- Money already moved at Stripe: keep the refund, flag the books for a retry.
    UPDATE refunds SET stripe_refund_id = p_stripe_refund_id, status = v_status,
      accounting_status = 'failed', accounting_error = left(SQLERRM, 300)
    WHERE id = p_refund_id;
  END;

  SELECT * INTO v_r FROM refunds WHERE id = p_refund_id;
  RETURN v_r;
END $$;

-- 6. Webhook: Stripe refund status changes (pending -> succeeded, or later failed/canceled)
CREATE OR REPLACE FUNCTION public.refund_apply_stripe_update(
  p_stripe_refund_id text, p_stripe_status text, p_failure_reason text, p_refund_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r refunds%ROWTYPE;
  v_lines jsonb;
BEGIN
  SELECT * INTO v_r FROM refunds WHERE stripe_refund_id = p_stripe_refund_id FOR UPDATE;
  IF NOT FOUND AND p_refund_id IS NOT NULL THEN
    -- Webhook can beat refund_finalize; match on the id we put in Stripe metadata.
    SELECT * INTO v_r FROM refunds WHERE id = p_refund_id AND stripe_refund_id IS NULL FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN 'ignored'; END IF;

  IF v_r.stripe_refund_id IS NULL THEN
    UPDATE refunds SET stripe_refund_id = p_stripe_refund_id WHERE id = v_r.id;
  END IF;

  IF p_stripe_status = 'succeeded' THEN
    UPDATE refunds SET status = 'succeeded', completed_at = coalesce(completed_at, now())
    WHERE id = v_r.id AND status = 'pending';
    RETURN 'succeeded';
  END IF;

  IF p_stripe_status IN ('failed', 'canceled') AND v_r.status IN ('pending', 'succeeded') THEN
    UPDATE refunds SET status = p_stripe_status,
      failure_reason = left(coalesce(p_failure_reason, 'Stripe could not complete this refund'), 300),
      completed_at = now()
    WHERE id = v_r.id;

    IF v_r.journal_entry_id IS NOT NULL AND v_r.accounting_status = 'posted' THEN
      BEGIN
        SELECT jsonb_agg(jsonb_build_object(
          'account_id', account_id, 'debit_cents', credit_cents, 'credit_cents', debit_cents,
          'description', 'Reversal: ' || coalesce(description, 'refund')) ORDER BY line_number)
        INTO v_lines FROM journal_lines WHERE journal_entry_id = v_r.journal_entry_id;

        PERFORM public._refund_post_je(
          v_r.user_id, current_date, 'Reversal of refund ' || coalesce(v_r.credit_memo_number, v_r.id::text),
          'refund_reversal', v_r.id, v_lines);
        UPDATE refunds SET accounting_status = 'reversed' WHERE id = v_r.id;
        UPDATE credit_memos SET status = 'void', voided_at = now() WHERE refund_id = v_r.id;
      EXCEPTION WHEN OTHERS THEN
        UPDATE refunds SET accounting_status = 'failed', accounting_error = left('Reversal failed: ' || SQLERRM, 300)
        WHERE id = v_r.id;
      END;
    END IF;
    RETURN 'failed';
  END IF;

  RETURN 'ignored';
END $$;

REVOKE EXECUTE ON FUNCTION
  public._refund_committed_cents(uuid), public._refund_ensure_chart(uuid),
  public._refund_post_je(uuid, date, text, text, uuid, jsonb),
  public.refund_reserve(uuid, uuid, integer, text, text, boolean, text, uuid, text),
  public.refund_finalize(uuid, text, text),
  public.refund_apply_stripe_update(text, text, text, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public._refund_committed_cents(uuid), public._refund_ensure_chart(uuid),
  public._refund_post_je(uuid, date, text, text, uuid, jsonb),
  public.refund_reserve(uuid, uuid, integer, text, text, boolean, text, uuid, text),
  public.refund_finalize(uuid, text, text),
  public.refund_apply_stripe_update(text, text, text, uuid)
TO service_role;

-- 7. Client read RPC: paid Stripe payments with their refundable balance (owner-scoped)
CREATE OR REPLACE FUNCTION public.get_refundable_payments(
  p_search text DEFAULT NULL, p_limit integer DEFAULT 100, p_payment_id uuid DEFAULT NULL
)
RETURNS TABLE (
  payment_request_id uuid, job_id uuid, customer_name text, customer_email text, customer_phone text,
  amount_cents integer, currency text, paid_at timestamptz,
  refunded_cents integer, refundable_cents integer, in_flight_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_search text := nullif(btrim(lower(coalesce(p_search, ''))), '');
BEGIN
  v_user_id := public.get_account_owner_id();
  IF v_user_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT pr.id, pr.job_id, pr.customer_name, pr.customer_email, pr.customer_phone,
    round(pr.amount * 100)::integer, pr.currency, pr.paid_at,
    public._refund_committed_cents(pr.id),
    GREATEST(0, round(pr.amount * 100)::integer - public._refund_committed_cents(pr.id)),
    (SELECT count(*)::integer FROM refunds r WHERE r.payment_request_id = pr.id AND r.status = 'pending')
  FROM payment_requests pr
  WHERE pr.user_id = v_user_id
    AND pr.status = 'paid'
    AND pr.stripe_payment_intent_id IS NOT NULL
    AND (p_payment_id IS NULL OR pr.id = p_payment_id)
    AND (v_search IS NULL
         OR position(v_search in lower(pr.customer_name)) > 0
         OR position(v_search in lower(coalesce(pr.customer_email, ''))) > 0)
  ORDER BY pr.paid_at DESC NULLS LAST, pr.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 200);
END $$;

GRANT EXECUTE ON FUNCTION public.get_refundable_payments(text, integer, uuid) TO authenticated;
