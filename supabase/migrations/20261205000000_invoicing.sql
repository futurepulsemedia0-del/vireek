/*
  # Invoicing

  Itemized, sequentially-numbered invoices with a public token-based
  view link — same security pattern as quotes/customer self-reschedule.
  Reuses the same line_items shape as `quotes` ({description, quantity,
  unit_price_cents}) so the two features share formatting/total logic
  on the frontend.
*/

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  invoice_number text,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  line_items jsonb NOT NULL DEFAULT '[]',
  tax_percent numeric NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'paid', 'void')),
  due_date date,
  invoice_token uuid NOT NULL DEFAULT gen_random_uuid(),
  sent_at timestamptz,
  viewed_at timestamptz,
  paid_at timestamptz,
  payment_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_token ON invoices(invoice_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(user_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_invoices" ON invoices;
CREATE POLICY "select_own_invoices" ON invoices FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_invoices" ON invoices;
CREATE POLICY "insert_own_invoices" ON invoices FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_invoices" ON invoices;
CREATE POLICY "update_own_invoices" ON invoices FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_invoices" ON invoices;
CREATE POLICY "delete_own_invoices" ON invoices FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Sequential per-account invoice numbers (INV-0001, INV-0002, ...)
-- =============================================================
ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS invoice_seq integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.assign_invoice_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
BEGIN
  IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
    INSERT INTO business_profile (user_id, invoice_seq)
    VALUES (NEW.user_id, 1)
    ON CONFLICT (user_id) DO UPDATE SET invoice_seq = business_profile.invoice_seq + 1
    RETURNING invoice_seq INTO v_seq;
    NEW.invoice_number := 'INV-' || lpad(v_seq::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_invoice_number ON invoices;
CREATE TRIGGER trg_assign_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.assign_invoice_number();

CREATE OR REPLACE FUNCTION public.touch_invoice_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_invoice_updated_at ON invoices;
CREATE TRIGGER trg_touch_invoice_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_invoice_updated_at();

-- =============================================================
-- Convert an accepted quote straight into an invoice
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_invoice_from_quote(p_quote_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_invoice_id uuid;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found or not authorized'; END IF;

  INSERT INTO invoices (user_id, quote_id, customer_name, customer_email, customer_phone, line_items, tax_percent, due_date)
  VALUES (v_quote.user_id, v_quote.id, v_quote.customer_name, v_quote.customer_email, v_quote.customer_phone, v_quote.line_items, v_quote.tax_percent, p_due_date)
  RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_invoice_from_quote(uuid, date) TO authenticated;

-- =============================================================
-- Public, token-gated view (same pattern as quotes)
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
  WHERE i.invoice_token = p_token AND i.status <> 'draft'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_invoice_for_token(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_invoice_view(p_token uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE invoices SET status = 'viewed', viewed_at = now()
  WHERE invoice_token = p_token AND status = 'sent';
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_view(uuid) TO anon, authenticated;
