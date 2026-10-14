/*
  # Invoice detail — payments, refunds, reminders, audit trail

  Adds the ledger tables behind /dashboard/invoicing/:id.

  Design notes
  - Money is stored as integer cents, same unit as `invoices.line_items`.
  - All three new tables are scoped to the account via get_account_owner_id()
    (same pattern as `invoices`) AND require the `can_view_billing`
    permission to read.
  - There are deliberately NO client INSERT/UPDATE/DELETE policies. Payments
    and refunds are written only through the SECURITY DEFINER RPCs below,
    which lock the invoice row, validate against the live balance (no
    overpayment, no over-refund, no double-submit race), recompute the
    invoice status and write an audit entry in the same transaction.
    Reminders are written only by the `invoice-email` edge function
    (service role).
  - Invoice balance = total − (sum(payments) − sum(refunds)).
  - Existing invoices already marked `paid` are backfilled with one payment
    for the full total so their balance reads $0.00.
*/

-- =============================================================
-- Helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.invoice_total_cents(p_items jsonb, p_tax numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (s.sub + round(s.sub * COALESCE(p_tax, 0) / 100))::bigint
  FROM (
    SELECT COALESCE(SUM(
      COALESCE((e->>'quantity')::numeric, 0) * COALESCE((e->>'unit_price_cents')::numeric, 0)
    ), 0) AS sub
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS e
  ) s;
$$;

-- Owner, or a team member whose (custom-role-overridden) permissions allow p_key.
CREATE OR REPLACE FUNCTION public.invoice_permission(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT true FROM profiles WHERE id = auth.uid() AND role = 'owner'),
    (
      SELECT COALESCE((cr.permissions->>p_key)::boolean, (tm.permissions->>p_key)::boolean, false)
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    ),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.invoice_permission(text) TO authenticated;

-- =============================================================
-- Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL DEFAULT 'other'
    CHECK (method IN ('cash', 'check', 'card', 'bank_transfer', 'other')),
  reference text,
  note text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial', 'resend', 'reminder')),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  error text,
  sent_by uuid,
  sent_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_user ON invoice_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_invoice_refunds_invoice ON invoice_refunds(invoice_id, refunded_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_refunds_payment ON invoice_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_invoice_reminders_invoice ON invoice_reminders(invoice_id, created_at DESC);

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_invoice_payments" ON invoice_payments;
CREATE POLICY "select_invoice_payments" ON invoice_payments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "select_invoice_refunds" ON invoice_refunds;
CREATE POLICY "select_invoice_refunds" ON invoice_refunds FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "select_invoice_reminders" ON invoice_reminders;
CREATE POLICY "select_invoice_reminders" ON invoice_reminders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

-- Structured details for the audit trail (amounts, methods, reasons).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details jsonb;
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(user_id, target_table, target_id, created_at DESC);

-- =============================================================
-- Backfill: invoices already marked paid get one full payment
-- =============================================================

INSERT INTO invoice_payments (user_id, invoice_id, amount_cents, method, note, paid_at, created_by)
SELECT i.user_id, i.id, public.invoice_total_cents(i.line_items, i.tax_percent),
       CASE WHEN i.payment_method IN ('cash', 'check', 'card', 'bank_transfer') THEN i.payment_method ELSE 'other' END,
       'Backfilled from legacy "Mark paid"', COALESCE(i.paid_at, i.updated_at), NULL
FROM invoices i
WHERE i.status = 'paid'
  AND public.invoice_total_cents(i.line_items, i.tax_percent) > 0
  AND NOT EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id);

-- =============================================================
-- Internal helpers (not granted to clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._invoice_audit(
  p_owner uuid, p_action text, p_invoice_id uuid, p_details jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (user_id, actor_id, actor_email, action, target_table, target_id, details)
  VALUES (p_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          p_action, 'invoices', p_invoice_id::text, p_details);
END;
$$;

CREATE OR REPLACE FUNCTION public._invoice_recalc(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_net bigint;
  v_last record;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_inv.status = 'void' THEN RETURN; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  SELECT COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - COALESCE((SELECT SUM(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0)
    INTO v_net;

  IF v_total > 0 AND v_net >= v_total THEN
    SELECT paid_at, method INTO v_last FROM invoice_payments
      WHERE invoice_id = p_invoice_id ORDER BY paid_at DESC, created_at DESC LIMIT 1;
    UPDATE invoices
       SET status = 'paid', paid_at = COALESCE(v_last.paid_at, now()), payment_method = v_last.method
     WHERE id = p_invoice_id;
  ELSIF v_inv.status = 'paid' THEN
    UPDATE invoices
       SET status = CASE WHEN viewed_at IS NOT NULL THEN 'viewed' WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'draft' END,
           paid_at = NULL, payment_method = NULL
     WHERE id = p_invoice_id;
  END IF;
END;
$$;

-- =============================================================
-- Public RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_reference text DEFAULT NULL,
  p_paid_at timestamptz DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_net bigint;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  IF p_method NOT IN ('cash', 'check', 'card', 'bank_transfer', 'other') THEN RAISE EXCEPTION 'Invalid payment method'; END IF;
  IF p_paid_at IS NOT NULL AND p_paid_at > now() + interval '1 day' THEN RAISE EXCEPTION 'Payment date cannot be in the future'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is void'; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  SELECT COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - COALESCE((SELECT SUM(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0)
    INTO v_net;
  IF p_amount_cents > v_total - v_net THEN RAISE EXCEPTION 'Payment exceeds the balance due'; END IF;

  INSERT INTO invoice_payments (user_id, invoice_id, amount_cents, method, reference, note, paid_at, created_by_email)
  VALUES (v_owner, p_invoice_id, p_amount_cents, p_method, NULLIF(btrim(p_reference), ''), NULLIF(btrim(p_note), ''),
          COALESCE(p_paid_at, now()), (SELECT email FROM auth.users WHERE id = auth.uid()))
  RETURNING id INTO v_id;

  PERFORM public._invoice_recalc(p_invoice_id);
  PERFORM public._invoice_audit(v_owner, 'invoice_payment_recorded', p_invoice_id,
    jsonb_build_object('payment_id', v_id, 'amount_cents', p_amount_cents, 'method', p_method));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_invoice_refund(
  p_invoice_id uuid,
  p_payment_id uuid,
  p_amount_cents bigint,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv invoices%ROWTYPE;
  v_pay invoice_payments%ROWTYPE;
  v_refunded bigint;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  SELECT * INTO v_pay FROM invoice_payments WHERE id = p_payment_id AND invoice_id = p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found on this invoice'; END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_refunded FROM invoice_refunds WHERE payment_id = p_payment_id;
  IF p_amount_cents > v_pay.amount_cents - v_refunded THEN RAISE EXCEPTION 'Refund exceeds the refundable amount of this payment'; END IF;

  INSERT INTO invoice_refunds (user_id, invoice_id, payment_id, amount_cents, reason, created_by_email)
  VALUES (v_owner, p_invoice_id, p_payment_id, p_amount_cents, btrim(p_reason),
          (SELECT email FROM auth.users WHERE id = auth.uid()))
  RETURNING id INTO v_id;

  PERFORM public._invoice_recalc(p_invoice_id);
  PERFORM public._invoice_audit(v_owner, 'invoice_refund_recorded', p_invoice_id,
    jsonb_build_object('refund_id', v_id, 'payment_id', p_payment_id, 'amount_cents', p_amount_cents, 'reason', btrim(p_reason)));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv invoices%ROWTYPE;
  v_net bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is already void'; END IF;

  SELECT COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - COALESCE((SELECT SUM(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0)
    INTO v_net;
  IF v_net > 0 THEN RAISE EXCEPTION 'Refund all payments before voiding this invoice'; END IF;

  UPDATE invoices SET status = 'void' WHERE id = p_invoice_id;
  PERFORM public._invoice_audit(v_owner, 'invoice_voided', p_invoice_id, jsonb_build_object('reason', btrim(p_reason)));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_invoice_audit_trail(p_invoice_id uuid)
RETURNS TABLE (id uuid, action text, actor_email text, details jsonb, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.invoice_permission('can_view_audit_log')
     OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE invoices.id = p_invoice_id AND invoices.user_id = v_owner) THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  RETURN QUERY
  SELECT a.id, a.action, a.actor_email, a.details, a.created_at
  FROM audit_log a
  WHERE a.user_id = v_owner AND a.target_table = 'invoices' AND a.target_id = p_invoice_id::text
  ORDER BY a.created_at DESC
  LIMIT 200;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_refund(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_invoice(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_audit_trail(uuid) TO authenticated;

-- =============================================================
-- Voided invoices no longer resolve on the public customer link
-- (same signature/columns as 20261205000000_invoicing.sql).
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_invoice_for_token(p_token uuid)
RETURNS TABLE (
  invoice_id uuid, invoice_number text, customer_name text, line_items jsonb,
  tax_percent numeric, status text, due_date date, notes text, business_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.invoice_number, i.customer_name, i.line_items, i.tax_percent, i.status, i.due_date, i.notes, p.company_name
  FROM invoices i
  JOIN profiles p ON p.id = i.user_id
  WHERE i.invoice_token = p_token AND i.status NOT IN ('draft', 'void')
  LIMIT 1;
$$;
