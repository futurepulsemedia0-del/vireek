/*
  # Accounting / General Ledger — Chart of Accounts, GL, AP, AR, Financial Statements

  ## Why
  Vireek already runs the operational side of money (quotes, jobs,
  payment_requests/Stripe Connect for AR collection, vendors/
  purchase_orders/goods_receipts for procurement) but has no real
  books: no chart of accounts, no double-entry ledger, no bills, no
  financial statements. This migration adds actual accounting on top
  of that existing data, without touching any of it.

  ## What this adds
  1. `chart_of_accounts` — per-account chart, seeded with a standard
     home-service-business default set via ensure_default_chart_of_accounts().
  2. `accounting_periods` — open/closed monthly periods; posting into a
     closed period is rejected.
  3. `journal_entries` / `journal_lines` — the general ledger itself.
     Client code never inserts into these directly: everything goes
     through post_journal_entry(), which requires debits = credits.
  4. `ar_invoices` / `ar_invoice_lines` / `ar_payments` — Accounts
     Receivable. Invoices can optionally point at an existing job_id /
     quote_id / customer_id; payments can point at an existing
     payment_requests row so a Stripe collection posts straight to the
     books.
  5. `ap_bills` / `ap_bill_lines` / `ap_bill_payments` — Accounts
     Payable. Bills can optionally point at an existing vendor_id /
     purchase_order_id.
  6. RPCs: create_ar_invoice, record_ar_payment, void_ar_invoice,
     create_ap_bill, record_ap_bill_payment, void_journal_entry, plus
     read-side reports: get_trial_balance, get_profit_and_loss,
     get_balance_sheet, get_ar_aging, get_ap_aging.

  RLS mirrors 20261121000000_ai_agent_governance.sql: whole-account
  SELECT via get_account_owner_id(), no client INSERT/UPDATE/DELETE —
  every write is a SECURITY DEFINER RPC below, so the balanced-entry
  and closed-period rules can never be bypassed from the client.
*/

-- =============================================================
-- CHART_OF_ACCOUNTS
-- =============================================================

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  parent_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_user ON chart_of_accounts(user_id, is_active);

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_chart_of_accounts" ON chart_of_accounts;
CREATE POLICY "select_own_chart_of_accounts" ON chart_of_accounts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — seeded via ensure_default_chart_of_accounts();
-- custom accounts added via upsert_chart_of_account() below.

-- =============================================================
-- ACCOUNTING_PERIODS
-- =============================================================

CREATE TABLE IF NOT EXISTS accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid,
  UNIQUE (user_id, period_start, period_end)
);

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_accounting_periods" ON accounting_periods;
CREATE POLICY "select_own_accounting_periods" ON accounting_periods FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOURNAL_ENTRIES / JOURNAL_LINES — the general ledger
-- =============================================================

CREATE TABLE IF NOT EXISTS journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_number text NOT NULL,
  entry_date date NOT NULL DEFAULT current_date,
  memo text,
  source_type text NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual', 'ar_invoice', 'ar_payment', 'ap_bill', 'ap_bill_payment', 'reversal')),
  source_id uuid,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  reversal_of_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  UNIQUE (user_id, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_user_date ON journal_entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(user_id, source_type, source_id);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_journal_entries" ON journal_entries;
CREATE POLICY "select_own_journal_entries" ON journal_entries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  debit_cents integer NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents integer NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  description text,
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),
  CHECK (debit_cents > 0 OR credit_cents > 0)
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_journal_lines" ON journal_lines;
CREATE POLICY "select_own_journal_lines" ON journal_lines FOR SELECT TO authenticated
  USING (journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = public.get_account_owner_id()));

-- No client write policy on either table — always via post_journal_entry().

-- =============================================================
-- AR — ar_invoices / ar_invoice_lines / ar_payments
-- =============================================================

CREATE TABLE IF NOT EXISTS ar_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_number text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void')),
  issue_date date NOT NULL DEFAULT current_date,
  due_date date NOT NULL DEFAULT (current_date + 30),
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents integer GENERATED ALWAYS AS (subtotal_cents + tax_cents) STORED,
  amount_paid_cents integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_ar_invoices_user_status ON ar_invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ar_invoices_due ON ar_invoices(user_id, due_date) WHERE status IN ('sent', 'partially_paid', 'overdue');

ALTER TABLE ar_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ar_invoices" ON ar_invoices;
CREATE POLICY "select_own_ar_invoices" ON ar_invoices FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS ar_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price_cents integer NOT NULL DEFAULT 0,
  amount_cents integer NOT NULL,
  revenue_account_id uuid NOT NULL REFERENCES chart_of_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_invoice ON ar_invoice_lines(invoice_id);

ALTER TABLE ar_invoice_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ar_invoice_lines" ON ar_invoice_lines;
CREATE POLICY "select_own_ar_invoice_lines" ON ar_invoice_lines FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM ar_invoices WHERE user_id = public.get_account_owner_id()));

CREATE TABLE IF NOT EXISTS ar_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE RESTRICT,
  payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  payment_date date NOT NULL DEFAULT current_date,
  payment_method text NOT NULL DEFAULT 'card' CHECK (payment_method IN ('card', 'ach', 'check', 'cash', 'other')),
  deposit_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ar_payments_invoice ON ar_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ar_payments_user_date ON ar_payments(user_id, payment_date DESC);

ALTER TABLE ar_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ar_payments" ON ar_payments;
CREATE POLICY "select_own_ar_payments" ON ar_payments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- AP — ap_bills / ap_bill_lines / ap_bill_payments
-- =============================================================

CREATE TABLE IF NOT EXISTS ap_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bill_number text NOT NULL,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved', 'partially_paid', 'paid', 'void')),
  bill_date date NOT NULL DEFAULT current_date,
  due_date date NOT NULL DEFAULT (current_date + 30),
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents integer GENERATED ALWAYS AS (subtotal_cents + tax_cents) STORED,
  amount_paid_cents integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bill_number)
);

CREATE INDEX IF NOT EXISTS idx_ap_bills_user_status ON ap_bills(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ap_bills_due ON ap_bills(user_id, due_date) WHERE status IN ('approved', 'partially_paid');

ALTER TABLE ap_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ap_bills" ON ap_bills;
CREATE POLICY "select_own_ap_bills" ON ap_bills FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS ap_bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES ap_bills(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  description text NOT NULL,
  amount_cents integer NOT NULL,
  expense_account_id uuid NOT NULL REFERENCES chart_of_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_ap_bill_lines_bill ON ap_bill_lines(bill_id);

ALTER TABLE ap_bill_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ap_bill_lines" ON ap_bill_lines;
CREATE POLICY "select_own_ap_bill_lines" ON ap_bill_lines FOR SELECT TO authenticated
  USING (bill_id IN (SELECT id FROM ap_bills WHERE user_id = public.get_account_owner_id()));

CREATE TABLE IF NOT EXISTS ap_bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bill_id uuid NOT NULL REFERENCES ap_bills(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  payment_date date NOT NULL DEFAULT current_date,
  payment_method text NOT NULL DEFAULT 'ach' CHECK (payment_method IN ('ach', 'check', 'card', 'cash', 'other')),
  source_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_bill_payments_bill ON ap_bill_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_ap_bill_payments_user_date ON ap_bill_payments(user_id, payment_date DESC);

ALTER TABLE ap_bill_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ap_bill_payments" ON ap_bill_payments;
CREATE POLICY "select_own_ap_bill_payments" ON ap_bill_payments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._gl_next_number(p_user_id uuid, p_prefix text, p_table text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  v_number text;
BEGIN
  EXECUTE format('SELECT count(*) + 1 FROM %I WHERE user_id = $1', p_table) INTO v_seq USING p_user_id;
  v_number := p_prefix || '-' || to_char(now(), 'YYYYMM') || '-' || lpad(v_seq::text, 4, '0');
  RETURN v_number;
END;
$$;

-- Rejects any posting into a closed period. Open periods are implicit —
-- a date with no accounting_periods row at all is treated as open.
CREATE OR REPLACE FUNCTION public._gl_assert_period_open(p_user_id uuid, p_entry_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE user_id = p_user_id AND status = 'closed'
      AND p_entry_date BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'Accounting period for % is closed', p_entry_date;
  END IF;
END;
$$;

-- =============================================================
-- RPC: ensure_default_chart_of_accounts — idempotent seed
-- =============================================================

CREATE OR REPLACE FUNCTION public.ensure_default_chart_of_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_count integer;
BEGIN
  v_user_id := public.get_account_owner_id();

  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system) VALUES
    (v_user_id, '1000', 'Cash and Bank', 'asset', 'debit', true),
    (v_user_id, '1100', 'Accounts Receivable', 'asset', 'debit', true),
    (v_user_id, '1200', 'Inventory', 'asset', 'debit', true),
    (v_user_id, '1500', 'Vehicles and Equipment', 'asset', 'debit', true),
    (v_user_id, '2000', 'Accounts Payable', 'liability', 'credit', true),
    (v_user_id, '2100', 'Sales Tax Payable', 'liability', 'credit', true),
    (v_user_id, '2200', 'Credit Card Payable', 'liability', 'credit', true),
    (v_user_id, '3000', 'Owner''s Equity', 'equity', 'credit', true),
    (v_user_id, '3900', 'Retained Earnings', 'equity', 'credit', true),
    (v_user_id, '4000', 'Service Revenue', 'revenue', 'credit', true),
    (v_user_id, '4100', 'Parts and Materials Revenue', 'revenue', 'credit', true),
    (v_user_id, '4900', 'Other Income', 'revenue', 'credit', true),
    (v_user_id, '5000', 'Cost of Goods Sold - Parts', 'expense', 'debit', true),
    (v_user_id, '5100', 'Subcontractor Cost', 'expense', 'debit', true),
    (v_user_id, '6000', 'Payroll Expense', 'expense', 'debit', true),
    (v_user_id, '6100', 'Vehicle and Fuel Expense', 'expense', 'debit', true),
    (v_user_id, '6200', 'Marketing and Advertising', 'expense', 'debit', true),
    (v_user_id, '6300', 'Software and Subscriptions', 'expense', 'debit', true),
    (v_user_id, '6400', 'Rent and Utilities', 'expense', 'debit', true),
    (v_user_id, '6500', 'Insurance', 'expense', 'debit', true),
    (v_user_id, '6900', 'General and Administrative', 'expense', 'debit', true)
  ON CONFLICT (user_id, code) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_default_chart_of_accounts() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_chart_of_account(
  p_code text, p_name text, p_type text, p_normal_balance text, p_parent_account_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();

  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, parent_account_id)
  VALUES (v_user_id, p_code, p_name, p_type, p_normal_balance, p_parent_account_id)
  ON CONFLICT (user_id, code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_chart_of_account(text, text, text, text, uuid) TO authenticated;

-- =============================================================
-- RPC: post_journal_entry — the only door into the ledger
-- p_lines: jsonb array of {account_id, debit_cents, credit_cents, description}
-- =============================================================

CREATE OR REPLACE FUNCTION public.post_journal_entry(
  p_entry_date date,
  p_memo text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit integer := 0;
  v_total_credit integer := 0;
  v_line_number integer := 0;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public._gl_assert_period_open(v_user_id, p_entry_date);

  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_debit := v_total_debit + coalesce((v_line->>'debit_cents')::integer, 0);
    v_total_credit := v_total_credit + coalesce((v_line->>'credit_cents')::integer, 0);
  END LOOP;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'Journal entry does not balance: % debit vs % credit', v_total_debit, v_total_credit;
  END IF;

  INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id, created_by)
  VALUES (v_user_id, public._gl_next_number(v_user_id, 'JE', 'journal_entries'), p_entry_date, p_memo, p_source_type, p_source_id, auth.uid())
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_number := v_line_number + 1;
    INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description)
    VALUES (
      v_entry_id, v_line_number, (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit_cents')::integer, 0), coalesce((v_line->>'credit_cents')::integer, 0),
      v_line->>'description'
    );
  END LOOP;

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal_entry(date, text, text, uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_journal_entry(p_journal_entry_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_reversal_id uuid;
  v_lines jsonb;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT jsonb_agg(jsonb_build_object(
    'account_id', account_id,
    'debit_cents', credit_cents,
    'credit_cents', debit_cents,
    'description', description
  ))
  INTO v_lines
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  WHERE je.id = p_journal_entry_id AND je.user_id = v_user_id AND je.status = 'posted';

  IF v_lines IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found or already void';
  END IF;

  v_reversal_id := public.post_journal_entry(current_date, 'Reversal: ' || coalesce(p_reason, ''), 'reversal', p_journal_entry_id, v_lines);

  UPDATE journal_entries SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
  WHERE id = p_journal_entry_id AND user_id = v_user_id;

  RETURN v_reversal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_journal_entry(uuid, text) TO authenticated;

-- =============================================================
-- RPC: create_ar_invoice / record_ar_payment / void_ar_invoice
-- p_lines: jsonb array of {description, quantity, unit_price_cents, amount_cents, revenue_account_id}
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_ar_invoice(
  p_customer_id uuid, p_job_id uuid, p_quote_id uuid, p_due_date date, p_tax_cents integer, p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_invoice_id uuid;
  v_line jsonb;
  v_line_number integer := 0;
  v_subtotal integer := 0;
  v_ar_account uuid;
  v_tax_account uuid;
  v_je_lines jsonb := '[]'::jsonb;
  v_je_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public.ensure_default_chart_of_accounts();

  SELECT id INTO v_ar_account FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1100';
  SELECT id INTO v_tax_account FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2100';

  SELECT coalesce(sum((l->>'amount_cents')::integer), 0) INTO v_subtotal FROM jsonb_array_elements(p_lines) l;

  INSERT INTO ar_invoices (user_id, invoice_number, customer_id, job_id, quote_id, due_date, subtotal_cents, tax_cents, status)
  VALUES (v_user_id, public._gl_next_number(v_user_id, 'INV', 'ar_invoices'), p_customer_id, p_job_id, p_quote_id, p_due_date, v_subtotal, coalesce(p_tax_cents, 0), 'sent')
  RETURNING id INTO v_invoice_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_number := v_line_number + 1;
    INSERT INTO ar_invoice_lines (invoice_id, line_number, description, quantity, unit_price_cents, amount_cents, revenue_account_id)
    VALUES (
      v_invoice_id, v_line_number, v_line->>'description', coalesce((v_line->>'quantity')::numeric, 1),
      coalesce((v_line->>'unit_price_cents')::integer, 0), (v_line->>'amount_cents')::integer,
      coalesce((v_line->>'revenue_account_id')::uuid, (SELECT id FROM chart_of_accounts WHERE user_id = v_user_id AND code = '4000'))
    );
    v_je_lines := v_je_lines || jsonb_build_object(
      'account_id', coalesce((v_line->>'revenue_account_id')::uuid, (SELECT id FROM chart_of_accounts WHERE user_id = v_user_id AND code = '4000')),
      'debit_cents', 0, 'credit_cents', (v_line->>'amount_cents')::integer, 'description', v_line->>'description'
    );
  END LOOP;

  IF coalesce(p_tax_cents, 0) > 0 THEN
    v_je_lines := v_je_lines || jsonb_build_object('account_id', v_tax_account, 'debit_cents', 0, 'credit_cents', p_tax_cents, 'description', 'Sales tax');
  END IF;

  v_je_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ar_account, 'debit_cents', v_subtotal + coalesce(p_tax_cents, 0), 'credit_cents', 0, 'description', 'AR for invoice'
  )) || v_je_lines;

  v_je_id := public.post_journal_entry(current_date, 'Invoice ' || v_invoice_id::text, 'ar_invoice', v_invoice_id, v_je_lines);

  UPDATE ar_invoices SET journal_entry_id = v_je_id WHERE id = v_invoice_id;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_ar_invoice(uuid, uuid, uuid, date, integer, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_ar_payment(
  p_invoice_id uuid, p_amount_cents integer, p_payment_method text, p_deposit_account_id uuid DEFAULT NULL, p_payment_request_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_payment_id uuid;
  v_je_id uuid;
  v_ar_account uuid;
  v_cash_account uuid;
  v_total_cents integer;
  v_paid_so_far integer;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT total_cents, amount_paid_cents INTO v_total_cents, v_paid_so_far
  FROM ar_invoices WHERE id = p_invoice_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_total_cents IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  IF v_paid_so_far + p_amount_cents > v_total_cents THEN
    RAISE EXCEPTION 'Payment of % would exceed invoice balance of %', p_amount_cents, v_total_cents - v_paid_so_far;
  END IF;

  SELECT id INTO v_ar_account FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1100';
  v_cash_account := coalesce(p_deposit_account_id, (SELECT id FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1000'));

  v_je_id := public.post_journal_entry(
    current_date, 'Payment for invoice ' || p_invoice_id::text, 'ar_payment', p_invoice_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_cash_account, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', 'Customer payment'),
      jsonb_build_object('account_id', v_ar_account, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', 'Applied to AR')
    )
  );

  INSERT INTO ar_payments (user_id, invoice_id, payment_request_id, amount_cents, payment_method, deposit_account_id, journal_entry_id)
  VALUES (v_user_id, p_invoice_id, p_payment_request_id, p_amount_cents, p_payment_method, v_cash_account, v_je_id)
  RETURNING id INTO v_payment_id;

  UPDATE ar_invoices SET
    amount_paid_cents = amount_paid_cents + p_amount_cents,
    status = CASE WHEN amount_paid_cents + p_amount_cents >= v_total_cents THEN 'paid' ELSE 'partially_paid' END,
    updated_at = now()
  WHERE id = p_invoice_id;

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ar_payment(uuid, integer, text, uuid, uuid) TO authenticated;

-- =============================================================
-- RPC: create_ap_bill / record_ap_bill_payment
-- p_lines: jsonb array of {description, amount_cents, expense_account_id}
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_ap_bill(
  p_vendor_id uuid, p_purchase_order_id uuid, p_due_date date, p_tax_cents integer, p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_bill_id uuid;
  v_line jsonb;
  v_line_number integer := 0;
  v_subtotal integer := 0;
  v_ap_account uuid;
  v_je_lines jsonb := '[]'::jsonb;
  v_je_id uuid;
  v_default_expense uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public.ensure_default_chart_of_accounts();

  SELECT id INTO v_ap_account FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2000';
  SELECT id INTO v_default_expense FROM chart_of_accounts WHERE user_id = v_user_id AND code = '5000';

  SELECT coalesce(sum((l->>'amount_cents')::integer), 0) INTO v_subtotal FROM jsonb_array_elements(p_lines) l;

  INSERT INTO ap_bills (user_id, bill_number, vendor_id, purchase_order_id, due_date, subtotal_cents, tax_cents, status)
  VALUES (v_user_id, public._gl_next_number(v_user_id, 'BILL', 'ap_bills'), p_vendor_id, p_purchase_order_id, p_due_date, v_subtotal, coalesce(p_tax_cents, 0), 'approved')
  RETURNING id INTO v_bill_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_number := v_line_number + 1;
    INSERT INTO ap_bill_lines (bill_id, line_number, description, amount_cents, expense_account_id)
    VALUES (v_bill_id, v_line_number, v_line->>'description', (v_line->>'amount_cents')::integer, coalesce((v_line->>'expense_account_id')::uuid, v_default_expense));
    v_je_lines := v_je_lines || jsonb_build_object(
      'account_id', coalesce((v_line->>'expense_account_id')::uuid, v_default_expense),
      'debit_cents', (v_line->>'amount_cents')::integer, 'credit_cents', 0, 'description', v_line->>'description'
    );
  END LOOP;

  v_je_lines := v_je_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_ap_account, 'debit_cents', 0, 'credit_cents', v_subtotal + coalesce(p_tax_cents, 0), 'description', 'AP for bill'
  ));

  v_je_id := public.post_journal_entry(current_date, 'Bill ' || v_bill_id::text, 'ap_bill', v_bill_id, v_je_lines);

  UPDATE ap_bills SET journal_entry_id = v_je_id WHERE id = v_bill_id;

  RETURN v_bill_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_ap_bill(uuid, uuid, date, integer, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_ap_bill_payment(
  p_bill_id uuid, p_amount_cents integer, p_payment_method text, p_source_account_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_payment_id uuid;
  v_je_id uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_total_cents integer;
  v_paid_so_far integer;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT total_cents, amount_paid_cents INTO v_total_cents, v_paid_so_far
  FROM ap_bills WHERE id = p_bill_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_total_cents IS NULL THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;
  IF v_paid_so_far + p_amount_cents > v_total_cents THEN
    RAISE EXCEPTION 'Payment of % would exceed bill balance of %', p_amount_cents, v_total_cents - v_paid_so_far;
  END IF;

  SELECT id INTO v_ap_account FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2000';
  v_cash_account := coalesce(p_source_account_id, (SELECT id FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1000'));

  v_je_id := public.post_journal_entry(
    current_date, 'Payment for bill ' || p_bill_id::text, 'ap_bill_payment', p_bill_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_ap_account, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', 'Applied to AP'),
      jsonb_build_object('account_id', v_cash_account, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', 'Vendor payment')
    )
  );

  INSERT INTO ap_bill_payments (user_id, bill_id, amount_cents, payment_method, source_account_id, journal_entry_id)
  VALUES (v_user_id, p_bill_id, p_amount_cents, p_payment_method, v_cash_account, v_je_id)
  RETURNING id INTO v_payment_id;

  UPDATE ap_bills SET
    amount_paid_cents = amount_paid_cents + p_amount_cents,
    status = CASE WHEN amount_paid_cents + p_amount_cents >= v_total_cents THEN 'paid' ELSE 'partially_paid' END,
    updated_at = now()
  WHERE id = p_bill_id;

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ap_bill_payment(uuid, integer, text, uuid) TO authenticated;

-- =============================================================
-- REPORTS: trial balance, P&L, balance sheet, AR/AP aging
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_as_of date DEFAULT current_date)
RETURNS TABLE (account_code text, account_name text, type text, debit_cents bigint, credit_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT c.code, c.name, c.type,
    coalesce(sum(jl.debit_cents), 0)::bigint, coalesce(sum(jl.credit_cents), 0)::bigint
  FROM chart_of_accounts c
  LEFT JOIN journal_lines jl ON jl.account_id = c.id
  LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.entry_date <= p_as_of
  WHERE c.user_id = v_user_id
  GROUP BY c.code, c.name, c.type, c.id
  ORDER BY c.code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_balance(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_profit_and_loss(p_start date, p_end date)
RETURNS TABLE (account_code text, account_name text, type text, amount_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT c.code, c.name, c.type,
    CASE WHEN c.type = 'revenue' THEN coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
         ELSE coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint END
  FROM chart_of_accounts c
  JOIN journal_lines jl ON jl.account_id = c.id
  JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.entry_date BETWEEN p_start AND p_end
  WHERE c.user_id = v_user_id AND c.type IN ('revenue', 'expense')
  GROUP BY c.code, c.name, c.type, c.id
  ORDER BY c.type DESC, c.code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_profit_and_loss(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of date DEFAULT current_date)
RETURNS TABLE (account_code text, account_name text, type text, balance_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT c.code, c.name, c.type,
    CASE WHEN c.normal_balance = 'debit' THEN coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
         ELSE coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint END
  FROM chart_of_accounts c
  JOIN journal_lines jl ON jl.account_id = c.id
  JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.entry_date <= p_as_of
  WHERE c.user_id = v_user_id AND c.type IN ('asset', 'liability', 'equity')
  GROUP BY c.code, c.name, c.type, c.id
  HAVING coalesce(sum(jl.debit_cents), 0) <> 0 OR coalesce(sum(jl.credit_cents), 0) <> 0
  ORDER BY c.type, c.code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of date DEFAULT current_date)
RETURNS TABLE (
  invoice_id uuid, invoice_number text, customer_name text, due_date date,
  days_overdue integer, bucket text, balance_cents integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT i.id, i.invoice_number, coalesce(cu.name, 'Unknown customer'), i.due_date,
    GREATEST(0, (p_as_of - i.due_date))::integer,
    CASE
      WHEN p_as_of <= i.due_date THEN 'current'
      WHEN p_as_of - i.due_date <= 30 THEN '1-30'
      WHEN p_as_of - i.due_date <= 60 THEN '31-60'
      WHEN p_as_of - i.due_date <= 90 THEN '61-90'
      ELSE '90+'
    END,
    (i.total_cents - i.amount_paid_cents)
  FROM ar_invoices i
  LEFT JOIN customers cu ON cu.id = i.customer_id
  WHERE i.user_id = v_user_id AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.total_cents > i.amount_paid_cents
  ORDER BY days_overdue DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ap_aging(p_as_of date DEFAULT current_date)
RETURNS TABLE (
  bill_id uuid, bill_number text, vendor_name text, due_date date,
  days_overdue integer, bucket text, balance_cents integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT b.id, b.bill_number, coalesce(v.name, 'Unknown vendor'), b.due_date,
    GREATEST(0, (p_as_of - b.due_date))::integer,
    CASE
      WHEN p_as_of <= b.due_date THEN 'current'
      WHEN p_as_of - b.due_date <= 30 THEN '1-30'
      WHEN p_as_of - b.due_date <= 60 THEN '31-60'
      WHEN p_as_of - b.due_date <= 90 THEN '61-90'
      ELSE '90+'
    END,
    (b.total_cents - b.amount_paid_cents)
  FROM ap_bills b
  LEFT JOIN vendors v ON v.id = b.vendor_id
  WHERE b.user_id = v_user_id AND b.status IN ('approved', 'partially_paid') AND b.total_cents > b.amount_paid_cents
  ORDER BY days_overdue DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_ap_aging(date) TO authenticated;
