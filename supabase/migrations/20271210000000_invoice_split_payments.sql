/*
  # Split payments — several payers on one invoice

  Lets one invoice be paid by multiple parties (customer + insurer,
  landlord + tenant, ...). Each payer has a fixed share and their own
  secure pay link (/pay-share/:token).

  Design notes
  - The existing ledger stays the single source of truth. Every payment —
    manual or online — is still a row in `invoice_payments`; it just carries
    a `payer_id`. Invoice balance, status, refunds, void and the PDF keep
    working with no changes.
  - Totals are NEVER recomputed here: every function calls the same
    `invoice_total_cents()` the existing invoice RPCs use.
  - Shares are resolved by the client (fixed / percent / remainder) and the
    database only enforces the invariants: 2-10 payers, every amount > 0, and
    the amounts add up to the invoice total to the cent.
  - `plan_total_cents` snapshots the total the split was built for. If the
    invoice is edited afterwards the split is "stale": payer links stop
    accepting money until staff re-save the split.
  - No client INSERT/UPDATE/DELETE policies. Writes go through the SECURITY
    DEFINER RPCs below (invoice row locked, audit entry in the same
    transaction). The public pay page uses two service-role-only functions.
*/

-- =============================================================
-- Tables / columns
-- =============================================================

CREATE TABLE IF NOT EXISTS invoice_split_payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  role text NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer', 'insurer', 'landlord', 'tenant', 'property_manager', 'warranty', 'other')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR length(email) <= 254),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  share_type text NOT NULL DEFAULT 'fixed' CHECK (share_type IN ('fixed', 'percent', 'remainder')),
  share_value numeric CHECK (share_value IS NULL OR share_value >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  plan_total_cents bigint NOT NULL CHECK (plan_total_cents > 0),
  public_token text NOT NULL UNIQUE
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  stripe_payment_intent_id text,
  needs_review boolean NOT NULL DEFAULT false,
  link_sent_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_split_payers_invoice ON invoice_split_payers(invoice_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_split_payers_user ON invoice_split_payers(user_id);

ALTER TABLE invoice_split_payers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_invoice_split_payers" ON invoice_split_payers;
CREATE POLICY "select_invoice_split_payers" ON invoice_split_payers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES invoice_split_payers(id) ON DELETE SET NULL;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_payer ON invoice_payments(payer_id) WHERE payer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payments_intent
  ON invoice_payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- =============================================================
-- Internal helpers
-- =============================================================

-- Payments minus refunds for a whole invoice.
CREATE OR REPLACE FUNCTION public._invoice_net_paid(p_invoice_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
    - COALESCE((SELECT SUM(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0)
  )::bigint;
$$;

-- Payments minus refunds attributed to one payer.
CREATE OR REPLACE FUNCTION public._split_payer_net_paid(p_payer_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE payer_id = p_payer_id), 0)
    - COALESCE((
        SELECT SUM(r.amount_cents)
        FROM invoice_refunds r
        JOIN invoice_payments p ON p.id = r.payment_id
        WHERE p.payer_id = p_payer_id
      ), 0)
  )::bigint;
$$;

REVOKE ALL ON FUNCTION public._invoice_net_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._split_payer_net_paid(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- Staff RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_invoice_split(p_invoice_id uuid, p_payers jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_count integer;
  v_sum bigint := 0;
  v_remainders integer := 0;
  v_el jsonb;
  v_ord integer;
  v_id uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_name text;
  v_role text;
  v_stype text;
  v_sval numeric;
  v_amount bigint;
  v_email text;
  v_phone text;
  v_net bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_payers IS NULL OR jsonb_typeof(p_payers) <> 'array' THEN
    RAISE EXCEPTION 'Payers must be a list';
  END IF;
  v_count := jsonb_array_length(p_payers);
  IF v_count < 2 OR v_count > 10 THEN
    RAISE EXCEPTION 'A split needs between 2 and 10 payers';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is void'; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  IF v_total <= 0 THEN RAISE EXCEPTION 'This invoice has no amount to split'; END IF;

  -- Pass 1: validate everything before touching any row.
  FOR v_el, v_ord IN
    SELECT t.value, t.ord::integer FROM jsonb_array_elements(p_payers) WITH ORDINALITY AS t(value, ord)
  LOOP
    IF jsonb_typeof(v_el) <> 'object' THEN RAISE EXCEPTION 'Payer % is invalid', v_ord; END IF;

    v_name := btrim(COALESCE(v_el->>'name', ''));
    IF length(v_name) < 1 OR length(v_name) > 120 THEN RAISE EXCEPTION 'Payer % needs a name (up to 120 characters)', v_ord; END IF;

    v_role := COALESCE(v_el->>'role', '');
    IF v_role NOT IN ('customer', 'insurer', 'landlord', 'tenant', 'property_manager', 'warranty', 'other') THEN
      RAISE EXCEPTION 'Payer % has an invalid role', v_ord;
    END IF;

    v_stype := COALESCE(v_el->>'share_type', '');
    IF v_stype NOT IN ('fixed', 'percent', 'remainder') THEN RAISE EXCEPTION 'Payer % has an invalid share type', v_ord; END IF;
    IF v_stype = 'remainder' THEN v_remainders := v_remainders + 1; END IF;
    IF v_stype = 'percent' THEN
      IF COALESCE(v_el->>'share_value', '') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'Payer % has an invalid percentage', v_ord; END IF;
      v_sval := (v_el->>'share_value')::numeric;
      IF v_sval <= 0 OR v_sval > 100 THEN RAISE EXCEPTION 'Payer % has an invalid percentage', v_ord; END IF;
    END IF;

    IF COALESCE(v_el->>'amount_cents', '') !~ '^[0-9]{1,15}$' THEN RAISE EXCEPTION 'Payer % has an invalid amount', v_ord; END IF;
    v_amount := (v_el->>'amount_cents')::bigint;
    IF v_amount <= 0 THEN RAISE EXCEPTION 'Payer % must owe more than $0.00', v_ord; END IF;
    v_sum := v_sum + v_amount;

    v_email := NULLIF(btrim(COALESCE(v_el->>'email', '')), '');
    IF v_email IS NOT NULL AND (length(v_email) > 254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
      RAISE EXCEPTION 'Payer % has an invalid email address', v_ord;
    END IF;
    v_phone := NULLIF(btrim(COALESCE(v_el->>'phone', '')), '');
    IF v_phone IS NOT NULL AND length(v_phone) > 40 THEN RAISE EXCEPTION 'Payer % has an invalid phone number', v_ord; END IF;

    IF NULLIF(v_el->>'id', '') IS NOT NULL THEN
      IF (v_el->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Payer % has an invalid id', v_ord; END IF;
      v_id := (v_el->>'id')::uuid;
      IF v_id = ANY(v_seen) THEN RAISE EXCEPTION 'Payer % is listed twice', v_ord; END IF;
      IF NOT EXISTS (SELECT 1 FROM invoice_split_payers WHERE id = v_id AND invoice_id = p_invoice_id AND user_id = v_owner) THEN
        RAISE EXCEPTION 'Payer % does not belong to this invoice', v_ord;
      END IF;
      v_net := public._split_payer_net_paid(v_id);
      IF v_amount < v_net THEN
        RAISE EXCEPTION 'The share for % cannot be lower than the $% already paid', v_name, to_char(v_net / 100.0, 'FM999999990.00');
      END IF;
      v_seen := array_append(v_seen, v_id);
    END IF;
  END LOOP;

  IF v_remainders > 1 THEN RAISE EXCEPTION 'Only one payer can cover the remainder'; END IF;
  IF v_sum <> v_total THEN
    RAISE EXCEPTION 'Shares add up to $% but the invoice total is $%',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  END IF;

  -- Payers who already paid can never be dropped from the plan.
  IF EXISTS (
    SELECT 1
    FROM invoice_payments pay
    JOIN invoice_split_payers sp ON sp.id = pay.payer_id
    WHERE sp.invoice_id = p_invoice_id AND sp.user_id = v_owner AND NOT (sp.id = ANY(v_seen))
  ) THEN
    RAISE EXCEPTION 'A payer who has already paid cannot be removed from the split';
  END IF;

  DELETE FROM invoice_split_payers
   WHERE invoice_id = p_invoice_id AND user_id = v_owner AND NOT (id = ANY(v_seen));

  -- Pass 2: write.
  FOR v_el, v_ord IN
    SELECT t.value, t.ord::integer FROM jsonb_array_elements(p_payers) WITH ORDINALITY AS t(value, ord)
  LOOP
    v_name := btrim(v_el->>'name');
    v_role := v_el->>'role';
    v_stype := v_el->>'share_type';
    v_amount := (v_el->>'amount_cents')::bigint;
    v_email := NULLIF(btrim(COALESCE(v_el->>'email', '')), '');
    v_phone := NULLIF(btrim(COALESCE(v_el->>'phone', '')), '');
    v_sval := CASE
      WHEN v_stype = 'percent' THEN (v_el->>'share_value')::numeric
      WHEN v_stype = 'fixed' THEN v_amount::numeric
      ELSE NULL
    END;
    v_id := NULLIF(v_el->>'id', '')::uuid;

    IF v_id IS NULL THEN
      INSERT INTO invoice_split_payers
        (user_id, invoice_id, sort_order, role, name, email, phone, share_type, share_value, amount_cents, plan_total_cents)
      VALUES
        (v_owner, p_invoice_id, v_ord, v_role, v_name, v_email, v_phone, v_stype, v_sval, v_amount, v_total);
    ELSE
      UPDATE invoice_split_payers
         SET sort_order = v_ord, role = v_role, name = v_name, email = v_email, phone = v_phone,
             share_type = v_stype, share_value = v_sval, amount_cents = v_amount,
             plan_total_cents = v_total, updated_at = now()
       WHERE id = v_id AND invoice_id = p_invoice_id AND user_id = v_owner;
    END IF;
  END LOOP;

  PERFORM public._invoice_audit(v_owner, 'invoice_split_saved', p_invoice_id,
    jsonb_build_object('payers', v_count, 'total_cents', v_total));
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_invoice_split(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv invoices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF EXISTS (
    SELECT 1
    FROM invoice_payments pay
    JOIN invoice_split_payers sp ON sp.id = pay.payer_id
    WHERE sp.invoice_id = p_invoice_id AND sp.user_id = v_owner
  ) THEN
    RAISE EXCEPTION 'Money was already collected through this split, so it cannot be removed';
  END IF;

  DELETE FROM invoice_split_payers WHERE invoice_id = p_invoice_id AND user_id = v_owner;
  PERFORM public._invoice_audit(v_owner, 'invoice_split_removed', p_invoice_id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_split_payment(
  p_payer_id uuid,
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
  v_payer invoice_split_payers%ROWTYPE;
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  IF p_method NOT IN ('cash', 'check', 'card', 'bank_transfer', 'other') THEN RAISE EXCEPTION 'Invalid payment method'; END IF;
  IF p_paid_at IS NOT NULL AND p_paid_at > now() + interval '1 day' THEN RAISE EXCEPTION 'Payment date cannot be in the future'; END IF;

  SELECT * INTO v_payer FROM invoice_split_payers WHERE id = p_payer_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payer not found'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = v_payer.invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is void'; END IF;

  -- The payer may have been removed while we waited for the invoice lock.
  SELECT * INTO v_payer FROM invoice_split_payers WHERE id = p_payer_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payer not found'; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  IF v_payer.plan_total_cents <> v_total THEN
    RAISE EXCEPTION 'The invoice total changed after this split was created. Update the split first';
  END IF;
  IF p_amount_cents > v_total - public._invoice_net_paid(v_inv.id) THEN
    RAISE EXCEPTION 'Payment exceeds the balance due';
  END IF;

  INSERT INTO invoice_payments
    (user_id, invoice_id, amount_cents, method, reference, note, paid_at, created_by_email, payer_id)
  VALUES
    (v_owner, v_inv.id, p_amount_cents, p_method, NULLIF(btrim(p_reference), ''), NULLIF(btrim(p_note), ''),
     COALESCE(p_paid_at, now()), (SELECT email FROM auth.users WHERE id = auth.uid()), v_payer.id)
  RETURNING id INTO v_id;

  PERFORM public._invoice_recalc(v_inv.id);
  PERFORM public._invoice_audit(v_owner, 'invoice_split_payment_recorded', v_inv.id,
    jsonb_build_object('payment_id', v_id, 'payer_id', v_payer.id, 'payer', v_payer.name,
                       'amount_cents', p_amount_cents, 'method', p_method));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_invoice_split(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_invoice_split(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_split_payment(uuid, bigint, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice_split(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_invoice_split(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_split_payment(uuid, bigint, text, text, timestamptz, text) TO authenticated;

-- =============================================================
-- Public pay page (service role only; called by the edge functions)
-- =============================================================

CREATE OR REPLACE FUNCTION public.split_payer_summary(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payer invoice_split_payers%ROWTYPE;
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_balance bigint;
  v_paid bigint;
  v_remaining bigint;
  v_payable bigint;
  v_business text;
  v_status text;
  v_reason text := NULL;
BEGIN
  SELECT * INTO v_payer FROM invoice_split_payers WHERE public_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = v_payer.invoice_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT company_name INTO v_business FROM profiles WHERE id = v_inv.user_id;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  v_balance := GREATEST(0, v_total - public._invoice_net_paid(v_inv.id));
  v_paid := GREATEST(0, public._split_payer_net_paid(v_payer.id));
  v_remaining := GREATEST(0, v_payer.amount_cents - v_paid);
  v_payable := LEAST(v_remaining, v_balance);

  IF v_inv.status = 'void' THEN
    v_status := 'blocked'; v_reason := 'void';
  ELSIF v_payable <= 0 THEN
    v_status := 'paid';
  ELSIF v_inv.status = 'draft' THEN
    v_status := 'blocked'; v_reason := 'not_ready';
  ELSIF v_payer.plan_total_cents <> v_total THEN
    v_status := 'blocked'; v_reason := 'changed';
  ELSE
    v_status := 'open';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'reason', v_reason,
    'payer_id', v_payer.id,
    'user_id', v_inv.user_id,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'business_name', v_business,
    'payer_name', v_payer.name,
    'payer_email', v_payer.email,
    'role', v_payer.role,
    'due_date', v_inv.due_date,
    'share_cents', v_payer.amount_cents,
    'paid_cents', v_paid,
    'payable_cents', v_payable,
    'stripe_payment_intent_id', v_payer.stripe_payment_intent_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_split_payment(
  p_payer_id uuid,
  p_user_id uuid,
  p_payment_intent_id text,
  p_amount_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payer invoice_split_payers%ROWTYPE;
  v_inv invoices%ROWTYPE;
  v_total bigint;
  v_id uuid;
BEGIN
  IF p_payment_intent_id IS NULL OR length(p_payment_intent_id) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- The owner id comes from server-set intent metadata and must match the payer row.
  SELECT * INTO v_payer FROM invoice_split_payers WHERE id = p_payer_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'payer_not_found'); END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = v_payer.invoice_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'payer_not_found'); END IF;

  -- Idempotent: Stripe retries webhooks.
  IF EXISTS (SELECT 1 FROM invoice_payments WHERE stripe_payment_intent_id = p_payment_intent_id) THEN
    RETURN jsonb_build_object('status', 'already_recorded');
  END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);

  -- Money moved but it cannot be booked (void invoice, or more than the balance):
  -- never auto-fix silently. Flag the payer and leave an audit entry for a human.
  IF v_inv.status = 'void' OR p_amount_cents > v_total - public._invoice_net_paid(v_inv.id) THEN
    UPDATE invoice_split_payers SET needs_review = true, updated_at = now() WHERE id = v_payer.id;
    PERFORM public._invoice_audit(p_user_id, 'invoice_split_payment_needs_review', v_inv.id,
      jsonb_build_object('payer_id', v_payer.id, 'payer', v_payer.name,
                         'amount_cents', p_amount_cents, 'payment_intent', p_payment_intent_id));
    RETURN jsonb_build_object('status', 'needs_review');
  END IF;

  INSERT INTO invoice_payments
    (user_id, invoice_id, amount_cents, method, reference, note, paid_at, payer_id, stripe_payment_intent_id)
  VALUES
    (p_user_id, v_inv.id, p_amount_cents, 'card', p_payment_intent_id,
     'Paid online by ' || v_payer.name, now(), v_payer.id, p_payment_intent_id)
  RETURNING id INTO v_id;

  PERFORM public._invoice_recalc(v_inv.id);
  PERFORM public._invoice_audit(p_user_id, 'invoice_split_payment_recorded', v_inv.id,
    jsonb_build_object('payment_id', v_id, 'payer_id', v_payer.id, 'payer', v_payer.name,
                       'amount_cents', p_amount_cents, 'method', 'card', 'online', true));
  RETURN jsonb_build_object('status', 'recorded', 'payment_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.split_payer_summary(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_split_payment(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.split_payer_summary(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_split_payment(uuid, uuid, text, bigint) TO service_role;
