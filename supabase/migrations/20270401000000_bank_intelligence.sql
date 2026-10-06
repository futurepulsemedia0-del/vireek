/*
  # Bank Intelligence + Financial Autopilot

  Closes the loop: Bank -> Transactions -> AI categorization -> Invoice/Bill
  matching -> Reconciliation -> Cash forecast -> Action.

  Builds ON TOP of 20261203000001_accounting_general_ledger.sql (reuses
  chart_of_accounts, journal_entries/lines, ar_invoices/ar_payments,
  ap_bills/ap_bill_payments) and touches none of its logic.

  Money convention: bank_transactions.amount_cents is SIGNED from the
  business's point of view — positive = money IN, negative = money OUT.

  Security model
  - Provider access tokens live ONLY in bank_connection_secrets (AES-GCM
    encrypted by the edge function; RLS on, zero policies, privileges
    revoked) — never readable from the browser.
  - Every ledger write goes through SECURITY DEFINER functions. Internal
    `_bank_*` functions take an explicit user id (needed by webhooks/cron
    running as service_role) and are executable by service_role ONLY.
  - Autopilot level defaults to 'review': nothing posts to the books
    without a human click until the owner opts in.
*/

-- =============================================================
-- 0. Allow bank-originated journal entries (robust to constraint drift)
-- =============================================================
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
    IF v_con.def ILIKE '%bank_transaction%' THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT t.m[1]) INTO v_vals
    FROM regexp_matches(v_con.def, '''([a-z_]+)''', 'g') AS t(m);
    v_vals := coalesce(v_vals, ARRAY[]::text[]) || ARRAY['bank_transaction', 'bank_opening_balance', 'bank_transfer'];
    EXECUTE format('ALTER TABLE public.journal_entries DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format(
      'ALTER TABLE public.journal_entries ADD CONSTRAINT %I CHECK (source_type IN (%s))',
      v_con.conname,
      (SELECT string_agg(quote_literal(x), ', ') FROM (SELECT DISTINCT unnest(v_vals) AS x) s)
    );
  END LOOP;
END $$;

-- =============================================================
-- 1. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'plaid' CHECK (provider IN ('plaid')),
  provider_item_id text NOT NULL,
  institution_id text,
  institution_name text NOT NULL DEFAULT 'Bank',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'error', 'disconnected')),
  sync_cursor text,
  initial_sync_complete boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_item_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_connections_user ON bank_connections(user_id, status);

CREATE TABLE IF NOT EXISTS bank_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES bank_connections(id) ON DELETE CASCADE,
  access_token_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  provider_account_id text NOT NULL,
  name text NOT NULL DEFAULT 'Account',
  official_name text,
  mask text,
  account_type text NOT NULL DEFAULT 'other' CHECK (account_type IN ('depository', 'credit', 'loan', 'investment', 'other')),
  account_subtype text,
  iso_currency text NOT NULL DEFAULT 'USD',
  current_balance_cents bigint,
  available_balance_cents bigint,
  balance_as_of timestamptz,
  gl_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  include_in_forecast boolean NOT NULL DEFAULT true,
  opening_balance_posted boolean NOT NULL DEFAULT false,
  opening_balance_cents bigint,
  opening_balance_je_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_conn ON bank_accounts(connection_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  provider_transaction_id text NOT NULL,
  pending_provider_id text,
  posted_date date NOT NULL,
  authorized_date date,
  amount_cents bigint NOT NULL,
  name text NOT NULL DEFAULT '',
  merchant_name text,
  merchant_key text,
  provider_category text,
  payment_channel text,
  pending boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('pending', 'new', 'categorized', 'posted', 'transfer', 'removed')),
  category_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  category_source text CHECK (category_source IN ('rule', 'ai', 'user', 'processor')),
  category_confidence numeric(4, 3),
  category_reason text,
  category_confirmed boolean NOT NULL DEFAULT false,
  counterparty_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  counterparty_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  transfer_pair_id uuid,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_txn_user_date ON bank_transactions(user_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_user_status ON bank_transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_txn_account_date ON bank_transactions(bank_account_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_merchant ON bank_transactions(user_id, merchant_key) WHERE merchant_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ar', 'ap', 'ar_payment', 'ap_payment')),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'applied', 'rejected', 'superseded')),
  confidence numeric(4, 3) NOT NULL DEFAULT 0,
  method text NOT NULL DEFAULT 'exact_amount',
  explanation text,
  matched_cents bigint NOT NULL,
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  unmatched_cents bigint NOT NULL DEFAULT 0,
  auto_applied boolean NOT NULL DEFAULT false,
  applied_at timestamptz,
  applied_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_matches_txn ON bank_matches(bank_transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_matches_user_status ON bank_matches(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_matches_one_applied ON bank_matches(bank_transaction_id) WHERE status = 'applied';

CREATE TABLE IF NOT EXISTS bank_match_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES bank_matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ar_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE CASCADE,
  ap_bill_id uuid REFERENCES ap_bills(id) ON DELETE CASCADE,
  ar_payment_id uuid REFERENCES ar_payments(id) ON DELETE SET NULL,
  ap_payment_id uuid REFERENCES ap_bill_payments(id) ON DELETE SET NULL,
  link_mode text NOT NULL DEFAULT 'created' CHECK (link_mode IN ('created', 'linked')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  CHECK ((ar_invoice_id IS NOT NULL)::int + (ap_bill_id IS NOT NULL)::int
       + (ar_payment_id IS NOT NULL AND link_mode = 'linked')::int
       + (ap_payment_id IS NOT NULL AND link_mode = 'linked')::int >= 1)
);
CREATE INDEX IF NOT EXISTS idx_bank_match_items_match ON bank_match_items(match_id);
CREATE INDEX IF NOT EXISTS idx_bank_match_items_arp ON bank_match_items(ar_payment_id) WHERE ar_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_match_items_app ON bank_match_items(ap_payment_id) WHERE ap_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_categorization_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  match_field text NOT NULL DEFAULT 'merchant_key' CHECK (match_field IN ('merchant_key', 'name_contains')),
  pattern text NOT NULL CHECK (length(pattern) >= 3),
  direction text NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'learned' CHECK (source IN ('user', 'learned')),
  hits integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, match_field, pattern, direction)
);

CREATE TABLE IF NOT EXISTS bank_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  autopilot_level text NOT NULL DEFAULT 'review' CHECK (autopilot_level IN ('review', 'assisted', 'full')),
  ai_categorization_enabled boolean NOT NULL DEFAULT true,
  low_cash_threshold_cents bigint NOT NULL DEFAULT 0 CHECK (low_cash_threshold_cents >= 0),
  runway_alert_days integer NOT NULL DEFAULT 30 CHECK (runway_alert_days BETWEEN 7 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  brief_date date NOT NULL DEFAULT current_date,
  headline text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date)
);

-- =============================================================
-- 2. RLS + privileges (reads only from the client; writes via RPC)
-- =============================================================
ALTER TABLE bank_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_match_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_categorization_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_bank_connections" ON bank_connections;
CREATE POLICY "select_own_bank_connections" ON bank_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_accounts" ON bank_accounts;
CREATE POLICY "select_own_bank_accounts" ON bank_accounts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_transactions" ON bank_transactions;
CREATE POLICY "select_own_bank_transactions" ON bank_transactions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_matches" ON bank_matches;
CREATE POLICY "select_own_bank_matches" ON bank_matches FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_match_items" ON bank_match_items;
CREATE POLICY "select_own_bank_match_items" ON bank_match_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_rules" ON bank_categorization_rules;
CREATE POLICY "select_own_bank_rules" ON bank_categorization_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_bank_rules" ON bank_categorization_rules;
CREATE POLICY "delete_own_bank_rules" ON bank_categorization_rules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_briefs" ON bank_briefs;
CREATE POLICY "select_own_bank_briefs" ON bank_briefs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_bank_settings" ON bank_settings;
CREATE POLICY "select_own_bank_settings" ON bank_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_bank_settings" ON bank_settings;
CREATE POLICY "insert_own_bank_settings" ON bank_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_bank_settings" ON bank_settings;
CREATE POLICY "update_own_bank_settings" ON bank_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

REVOKE ALL ON bank_connection_secrets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON bank_connections, bank_accounts, bank_transactions, bank_matches, bank_match_items, bank_briefs FROM anon, authenticated;
REVOKE INSERT, UPDATE ON bank_categorization_rules FROM anon, authenticated;
REVOKE ALL ON bank_connections, bank_accounts, bank_transactions, bank_matches, bank_match_items, bank_categorization_rules, bank_briefs, bank_settings FROM anon;

-- =============================================================
-- 3. INTERNAL HELPERS (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public._bank_ensure_chart(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system) VALUES
    (p_user_id, '1000', 'Cash and Bank', 'asset', 'debit', true),
    (p_user_id, '1100', 'Accounts Receivable', 'asset', 'debit', true),
    (p_user_id, '2000', 'Accounts Payable', 'liability', 'credit', true),
    (p_user_id, '2200', 'Credit Card Payable', 'liability', 'credit', true),
    (p_user_id, '3000', 'Owner''s Equity', 'equity', 'credit', true),
    (p_user_id, '3100', 'Owner''s Draw', 'equity', 'debit', true),
    (p_user_id, '4900', 'Other Income', 'revenue', 'credit', true),
    (p_user_id, '6800', 'Bank and Processing Fees', 'expense', 'debit', true),
    (p_user_id, '6900', 'General and Administrative', 'expense', 'debit', true)
  ON CONFLICT (user_id, code) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public._bank_code_id(p_user_id uuid, p_code text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM chart_of_accounts WHERE user_id = p_user_id AND code = p_code;
$$;

CREATE OR REPLACE FUNCTION public._bank_payment_method(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_name ~* '\m(check|chk|cheque)\M' THEN 'check'
    WHEN p_name ~* '\m(ach|zelle|wire|eft|autopay)\M' THEN 'ach'
    WHEN p_name ~* '\m(stripe|square|paypal|visa|mastercard|amex|card)\M' THEN 'card'
    ELSE 'other' END;
$$;

CREATE OR REPLACE FUNCTION public._bank_post_je(
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

  PERFORM pg_advisory_xact_lock(hashtextextended('bank-gl:' || p_user_id::text, 0));

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

CREATE OR REPLACE FUNCTION public._bank_ensure_gl_account(p_user_id uuid, p_bank_account_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a bank_accounts%ROWTYPE;
  v_conn_name text;
  v_parent uuid;
  v_code text;
  v_is_liab boolean;
  v_id uuid;
BEGIN
  SELECT * INTO a FROM bank_accounts WHERE id = p_bank_account_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank account not found'; END IF;
  IF a.gl_account_id IS NOT NULL THEN RETURN a.gl_account_id; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('bank-chart:' || p_user_id::text, 0));
  PERFORM public._bank_ensure_chart(p_user_id);
  SELECT institution_name INTO v_conn_name FROM bank_connections WHERE id = a.connection_id;
  v_is_liab := a.account_type IN ('credit', 'loan');
  v_parent := public._bank_code_id(p_user_id, CASE WHEN v_is_liab THEN '2200' ELSE '1000' END);

  SELECT lpad(g::text, 4, '0') INTO v_code
  FROM generate_series(CASE WHEN v_is_liab THEN 2210 ELSE 1010 END, CASE WHEN v_is_liab THEN 2299 ELSE 1099 END) g
  WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.user_id = p_user_id AND c.code = lpad(g::text, 4, '0'))
  ORDER BY g LIMIT 1;
  IF v_code IS NULL THEN RAISE EXCEPTION 'No free ledger account codes left for bank accounts'; END IF;

  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system, parent_account_id)
  VALUES (p_user_id, v_code,
          left(coalesce(v_conn_name, 'Bank') || ' ' || a.name || CASE WHEN a.mask IS NOT NULL THEN ' ••' || a.mask ELSE '' END, 120),
          CASE WHEN v_is_liab THEN 'liability' ELSE 'asset' END,
          CASE WHEN v_is_liab THEN 'credit' ELSE 'debit' END,
          false, v_parent)
  RETURNING id INTO v_id;

  UPDATE bank_accounts SET gl_account_id = v_id, updated_at = now() WHERE id = a.id;
  RETURN v_id;
END $$;

-- ---------- apply an AR/AP match (the heart of reconciliation) ----------
CREATE OR REPLACE FUNCTION public._bank_apply_match(p_user_id uuid, p_match_id uuid, p_auto boolean, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m bank_matches%ROWTYPE;
  t bank_transactions%ROWTYPE;
  v_cash uuid;
  v_gl_id uuid;
  v_item record;
  v_inv record;
  v_bill record;
  v_pay record;
  v_total bigint := 0;
  v_expected bigint;
  v_je uuid;
  v_lines jsonb := '[]'::jsonb;
  v_new_id uuid;
  v_customer uuid;
  v_vendor uuid;
  v_distinct integer;
  v_method text;
  v_fee_acct uuid;
  v_reclass record;
BEGIN
  SELECT * INTO m FROM bank_matches WHERE id = p_match_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF m.status <> 'suggested' THEN RAISE EXCEPTION 'Match is no longer pending (%)', m.status; END IF;

  SELECT * INTO t FROM bank_transactions WHERE id = m.bank_transaction_id AND user_id = p_user_id FOR UPDATE;
  IF t.status NOT IN ('new', 'categorized') THEN RAISE EXCEPTION 'Transaction is already reconciled or not ready (%)', t.status; END IF;
  IF t.pending THEN RAISE EXCEPTION 'Pending transactions cannot be reconciled yet'; END IF;

  v_gl_id := public._bank_ensure_gl_account(p_user_id, t.bank_account_id);
  v_cash := v_gl_id;
  v_method := public._bank_payment_method(t.name);
  PERFORM public._bank_ensure_chart(p_user_id);

  IF m.kind IN ('ar', 'ar_payment') AND t.amount_cents <= 0 THEN RAISE EXCEPTION 'Receivable matches require a deposit'; END IF;
  IF m.kind IN ('ap', 'ap_payment') AND t.amount_cents >= 0 THEN RAISE EXCEPTION 'Payable matches require a withdrawal'; END IF;

  SELECT coalesce(sum(amount_cents), 0) INTO v_total FROM bank_match_items WHERE match_id = m.id;
  IF v_total = 0 THEN RAISE EXCEPTION 'Match has no items'; END IF;

  IF m.kind = 'ar' THEN
    v_expected := t.amount_cents + m.fee_cents;
    IF v_total <> v_expected THEN
      RAISE EXCEPTION 'Items total % does not equal deposit % plus fees %', v_total, t.amount_cents, m.fee_cents;
    END IF;
    FOR v_item IN SELECT * FROM bank_match_items WHERE match_id = m.id ORDER BY id LOOP
      SELECT id, total_cents, amount_paid_cents, status, customer_id INTO v_inv
      FROM ar_invoices WHERE id = v_item.ar_invoice_id AND user_id = p_user_id FOR UPDATE;
      IF v_inv.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
      IF v_inv.status IN ('void', 'draft', 'paid') THEN RAISE EXCEPTION 'Invoice is not open for payment (%)', v_inv.status; END IF;
      IF v_inv.amount_paid_cents + v_item.amount_cents > v_inv.total_cents THEN
        RAISE EXCEPTION 'Payment would exceed the invoice balance';
      END IF;
      INSERT INTO ar_payments (user_id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id)
      VALUES (p_user_id, v_inv.id, v_item.amount_cents, t.posted_date, v_method, v_cash)
      RETURNING id INTO v_new_id;
      UPDATE bank_match_items SET ar_payment_id = v_new_id, link_mode = 'created' WHERE id = v_item.id;
      UPDATE ar_invoices SET
        amount_paid_cents = amount_paid_cents + v_item.amount_cents,
        status = CASE WHEN amount_paid_cents + v_item.amount_cents >= total_cents THEN 'paid' ELSE 'partially_paid' END,
        updated_at = now()
      WHERE id = v_inv.id;
    END LOOP;
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_cash, 'debit_cents', t.amount_cents, 'credit_cents', 0, 'description', 'Bank deposit'));
    IF m.fee_cents > 0 THEN
      v_fee_acct := public._bank_code_id(p_user_id, '6800');
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_fee_acct, 'debit_cents', m.fee_cents, 'credit_cents', 0, 'description', 'Processing fees'));
    END IF;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', public._bank_code_id(p_user_id, '1100'), 'debit_cents', 0, 'credit_cents', v_total, 'description', 'Applied to receivables'));
    v_je := public._bank_post_je(p_user_id, t.posted_date, 'Bank deposit matched: ' || left(t.name, 80), 'bank_transaction', t.id, v_lines);

    SELECT count(DISTINCT customer_id) INTO v_distinct FROM ar_invoices
      WHERE id IN (SELECT ar_invoice_id FROM bank_match_items WHERE match_id = m.id);
    IF v_distinct = 1 THEN
      SELECT customer_id INTO v_customer FROM ar_invoices
        WHERE id IN (SELECT ar_invoice_id FROM bank_match_items WHERE match_id = m.id) LIMIT 1;
    END IF;

  ELSIF m.kind = 'ap' THEN
    v_expected := -t.amount_cents;
    IF v_total <> v_expected THEN
      RAISE EXCEPTION 'Items total % does not equal withdrawal %', v_total, v_expected;
    END IF;
    FOR v_item IN SELECT * FROM bank_match_items WHERE match_id = m.id ORDER BY id LOOP
      SELECT id, total_cents, amount_paid_cents, status INTO v_bill
      FROM ap_bills WHERE id = v_item.ap_bill_id AND user_id = p_user_id FOR UPDATE;
      IF v_bill.id IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
      IF v_bill.status IN ('void', 'draft', 'paid') THEN RAISE EXCEPTION 'Bill is not open for payment (%)', v_bill.status; END IF;
      IF v_bill.amount_paid_cents + v_item.amount_cents > v_bill.total_cents THEN
        RAISE EXCEPTION 'Payment would exceed the bill balance';
      END IF;
      INSERT INTO ap_bill_payments (user_id, bill_id, amount_cents, payment_date, payment_method, source_account_id)
      VALUES (p_user_id, v_bill.id, v_item.amount_cents, t.posted_date,
              CASE WHEN v_method IN ('ach', 'check', 'card') THEN v_method ELSE 'other' END, v_cash)
      RETURNING id INTO v_new_id;
      UPDATE bank_match_items SET ap_payment_id = v_new_id, link_mode = 'created' WHERE id = v_item.id;
      UPDATE ap_bills SET
        amount_paid_cents = amount_paid_cents + v_item.amount_cents,
        status = CASE WHEN amount_paid_cents + v_item.amount_cents >= total_cents THEN 'paid' ELSE 'partially_paid' END,
        updated_at = now()
      WHERE id = v_bill.id;
    END LOOP;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public._bank_code_id(p_user_id, '2000'), 'debit_cents', v_total, 'credit_cents', 0, 'description', 'Applied to payables'),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_total, 'description', 'Bank withdrawal'));
    v_je := public._bank_post_je(p_user_id, t.posted_date, 'Bank payment matched: ' || left(t.name, 80), 'bank_transaction', t.id, v_lines);

    SELECT count(DISTINCT vendor_id) INTO v_distinct FROM ap_bills
      WHERE id IN (SELECT ap_bill_id FROM bank_match_items WHERE match_id = m.id);
    IF v_distinct = 1 THEN
      SELECT vendor_id INTO v_vendor FROM ap_bills
        WHERE id IN (SELECT ap_bill_id FROM bank_match_items WHERE match_id = m.id) LIMIT 1;
    END IF;

  ELSE
    -- existing, manually recorded payments: link + reclass cash to the bank-specific account
    v_expected := abs(t.amount_cents);
    IF v_total <> v_expected THEN
      RAISE EXCEPTION 'Linked payments total % does not equal bank amount %', v_total, v_expected;
    END IF;
    FOR v_item IN SELECT * FROM bank_match_items WHERE match_id = m.id LOOP
      IF m.kind = 'ar_payment' THEN
        SELECT id, deposit_account_id AS acct, amount_cents INTO v_pay FROM ar_payments WHERE id = v_item.ar_payment_id AND user_id = p_user_id FOR UPDATE;
      ELSE
        SELECT id, source_account_id AS acct, amount_cents INTO v_pay FROM ap_bill_payments WHERE id = v_item.ap_payment_id AND user_id = p_user_id FOR UPDATE;
      END IF;
      IF v_pay.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
      IF v_pay.amount_cents <> v_item.amount_cents THEN RAISE EXCEPTION 'Payment amount changed since the suggestion was made'; END IF;
      IF EXISTS (
        SELECT 1 FROM bank_match_items i JOIN bank_matches bm ON bm.id = i.match_id
        WHERE bm.status = 'applied' AND bm.id <> m.id
          AND ((m.kind = 'ar_payment' AND i.ar_payment_id = v_item.ar_payment_id)
            OR (m.kind = 'ap_payment' AND i.ap_payment_id = v_item.ap_payment_id))
      ) THEN RAISE EXCEPTION 'Payment is already linked to another bank transaction'; END IF;
    END LOOP;

    FOR v_reclass IN
      SELECT p.acct, sum(p.amount_cents)::bigint AS amt
      FROM (
        SELECT CASE WHEN m.kind = 'ar_payment' THEN (SELECT deposit_account_id FROM ar_payments WHERE id = i.ar_payment_id)
                    ELSE (SELECT source_account_id FROM ap_bill_payments WHERE id = i.ap_payment_id) END AS acct,
               i.amount_cents
        FROM bank_match_items i WHERE i.match_id = m.id
      ) p WHERE p.acct <> v_cash GROUP BY p.acct
    LOOP
      IF m.kind = 'ar_payment' THEN
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', v_cash, 'debit_cents', v_reclass.amt, 'credit_cents', 0, 'description', 'Cash confirmed by bank'),
          jsonb_build_object('account_id', v_reclass.acct, 'debit_cents', 0, 'credit_cents', v_reclass.amt, 'description', 'Reclass from generic cash'));
      ELSE
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', v_reclass.acct, 'debit_cents', v_reclass.amt, 'credit_cents', 0, 'description', 'Reclass to generic cash'),
          jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_reclass.amt, 'description', 'Cash confirmed by bank'));
      END IF;
    END LOOP;
    IF jsonb_array_length(v_lines) >= 2 THEN
      v_je := public._bank_post_je(p_user_id, t.posted_date, 'Bank-confirmed payment: ' || left(t.name, 80), 'bank_transaction', t.id, v_lines);
    END IF;
  END IF;

  UPDATE bank_matches SET status = 'applied', applied_at = now(), applied_by = p_actor, auto_applied = p_auto WHERE id = m.id;
  UPDATE bank_matches SET status = 'superseded' WHERE bank_transaction_id = t.id AND id <> m.id AND status = 'suggested';
  UPDATE bank_transactions SET
    status = 'posted', journal_entry_id = v_je, posted_at = now(), updated_at = now(),
    category_account_id = NULL, category_confirmed = true,
    counterparty_customer_id = coalesce(v_customer, counterparty_customer_id),
    counterparty_vendor_id = coalesce(v_vendor, counterparty_vendor_id)
  WHERE id = t.id;
  RETURN v_je;
END $$;

-- ---------- post a categorized (non-invoice) transaction ----------
CREATE OR REPLACE FUNCTION public._bank_post_categorization(p_user_id uuid, p_txn_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t bank_transactions%ROWTYPE;
  v_cash uuid;
  v_amt bigint;
  v_je uuid;
  v_lines jsonb;
BEGIN
  SELECT * INTO t FROM bank_transactions WHERE id = p_txn_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF t.status NOT IN ('new', 'categorized') THEN RAISE EXCEPTION 'Transaction is already reconciled or not ready (%)', t.status; END IF;
  IF t.pending THEN RAISE EXCEPTION 'Pending transactions cannot be posted yet'; END IF;
  IF t.category_account_id IS NULL THEN RAISE EXCEPTION 'Transaction has no category'; END IF;
  IF t.amount_cents = 0 THEN RAISE EXCEPTION 'Zero-amount transaction'; END IF;

  v_cash := public._bank_ensure_gl_account(p_user_id, t.bank_account_id);
  IF t.category_account_id = v_cash THEN RAISE EXCEPTION 'Category cannot be the bank account itself — use transfer detection'; END IF;
  v_amt := abs(t.amount_cents);

  IF t.amount_cents > 0 THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_cash, 'debit_cents', v_amt, 'credit_cents', 0, 'description', left(t.name, 120)),
      jsonb_build_object('account_id', t.category_account_id, 'debit_cents', 0, 'credit_cents', v_amt, 'description', left(t.name, 120)));
  ELSE
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', t.category_account_id, 'debit_cents', v_amt, 'credit_cents', 0, 'description', left(t.name, 120)),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_amt, 'description', left(t.name, 120)));
  END IF;

  v_je := public._bank_post_je(p_user_id, t.posted_date, 'Bank: ' || left(t.name, 100), 'bank_transaction', t.id, v_lines);
  UPDATE bank_transactions SET status = 'posted', journal_entry_id = v_je, posted_at = now(), updated_at = now() WHERE id = t.id;
  RETURN v_je;
END $$;

-- ---------- detect + post transfers between the owner's own accounts ----------
CREATE OR REPLACE FUNCTION public._bank_detect_transfers(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_out_gl uuid;
  v_in_gl uuid;
  v_je uuid;
  v_amt bigint;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT o.id AS out_id, i.id AS in_id, o.bank_account_id AS out_acct, i.bank_account_id AS in_acct,
           i.amount_cents AS amt, o.posted_date AS out_date, o.name AS out_name
    FROM bank_transactions o
    JOIN bank_transactions i
      ON i.user_id = o.user_id AND i.amount_cents = -o.amount_cents
     AND i.bank_account_id <> o.bank_account_id
     AND abs(i.posted_date - o.posted_date) <= 4
    WHERE o.user_id = p_user_id AND o.amount_cents < 0
      AND o.status = 'new' AND i.status = 'new' AND NOT o.pending AND NOT i.pending
      AND (o.name || ' ' || i.name) ~* '(transfer|xfer|online pmt|payment thank you|autopay|crcardpmt|epayment|credit card|card payment|from chk|to chk|from sav|to sav)'
    ORDER BY abs(i.posted_date - o.posted_date), o.posted_date, o.id
  LOOP
    IF (SELECT count(*) FROM bank_transactions WHERE id IN (r.out_id, r.in_id) AND status = 'new') <> 2 THEN CONTINUE; END IF;
    BEGIN
      v_out_gl := public._bank_ensure_gl_account(p_user_id, r.out_acct);
      v_in_gl := public._bank_ensure_gl_account(p_user_id, r.in_acct);
      v_amt := r.amt;
      v_je := public._bank_post_je(p_user_id, r.out_date, 'Transfer between bank accounts', 'bank_transfer', r.out_id,
        jsonb_build_array(
          jsonb_build_object('account_id', v_in_gl, 'debit_cents', v_amt, 'credit_cents', 0, 'description', 'Transfer in'),
          jsonb_build_object('account_id', v_out_gl, 'debit_cents', 0, 'credit_cents', v_amt, 'description', 'Transfer out')));
      UPDATE bank_transactions SET status = 'transfer', journal_entry_id = v_je, posted_at = now(), updated_at = now(),
        transfer_pair_id = CASE WHEN id = r.out_id THEN r.in_id ELSE r.out_id END
      WHERE id IN (r.out_id, r.in_id);
      UPDATE bank_matches SET status = 'superseded' WHERE bank_transaction_id IN (r.out_id, r.in_id) AND status = 'suggested';
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE; -- e.g. closed period: leave both for manual handling
    END;
  END LOOP;
  RETURN v_count;
END $$;

-- ---------- undo a reconciled transaction (clean void, no double-reversal) ----------
CREATE OR REPLACE FUNCTION public._bank_undo(p_user_id uuid, p_txn_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t bank_transactions%ROWTYPE;
  v_ids uuid[];
  v_je uuid;
  v_date date;
  v_match record;
  v_item record;
  v_was_removed boolean;
BEGIN
  SELECT * INTO t FROM bank_transactions WHERE id = p_txn_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF t.status NOT IN ('posted', 'transfer', 'removed') THEN RAISE EXCEPTION 'Transaction is not reconciled'; END IF;
  v_was_removed := (t.status = 'removed');

  v_ids := ARRAY[t.id] || CASE WHEN t.transfer_pair_id IS NOT NULL THEN ARRAY[t.transfer_pair_id] ELSE ARRAY[]::uuid[] END;

  SELECT * INTO v_match FROM bank_matches WHERE bank_transaction_id = t.id AND status = 'applied';
  IF FOUND THEN
    FOR v_item IN SELECT * FROM bank_match_items WHERE match_id = v_match.id LOOP
      IF v_item.link_mode = 'created' AND v_item.ar_payment_id IS NOT NULL THEN
        DELETE FROM ar_payments WHERE id = v_item.ar_payment_id AND user_id = p_user_id;
        UPDATE ar_invoices SET
          amount_paid_cents = greatest(amount_paid_cents - v_item.amount_cents, 0),
          status = CASE
            WHEN amount_paid_cents - v_item.amount_cents <= 0 THEN CASE WHEN due_date < current_date THEN 'overdue' ELSE 'sent' END
            WHEN amount_paid_cents - v_item.amount_cents < total_cents THEN 'partially_paid'
            ELSE 'paid' END,
          updated_at = now()
        WHERE id = v_item.ar_invoice_id AND user_id = p_user_id;
      ELSIF v_item.link_mode = 'created' AND v_item.ap_payment_id IS NOT NULL THEN
        DELETE FROM ap_bill_payments WHERE id = v_item.ap_payment_id AND user_id = p_user_id;
        UPDATE ap_bills SET
          amount_paid_cents = greatest(amount_paid_cents - v_item.amount_cents, 0),
          status = CASE
            WHEN amount_paid_cents - v_item.amount_cents <= 0 THEN 'approved'
            WHEN amount_paid_cents - v_item.amount_cents < total_cents THEN 'partially_paid'
            ELSE 'paid' END,
          updated_at = now()
        WHERE id = v_item.ap_bill_id AND user_id = p_user_id;
      END IF;
    END LOOP;
    UPDATE bank_matches SET status = 'rejected' WHERE id = v_match.id;
  END IF;

  SELECT journal_entry_id INTO v_je FROM bank_transactions WHERE id = t.id;
  IF v_je IS NOT NULL THEN
    SELECT entry_date INTO v_date FROM journal_entries WHERE id = v_je AND user_id = p_user_id;
    PERFORM public._gl_assert_period_open(p_user_id, v_date);
    UPDATE journal_entries SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = 'Bank reconciliation undone'
    WHERE id = v_je AND user_id = p_user_id AND status = 'posted';
  END IF;

  UPDATE bank_transactions SET
    status = CASE WHEN id = t.id AND v_was_removed THEN 'removed' ELSE 'new' END,
    journal_entry_id = NULL, posted_at = NULL, transfer_pair_id = NULL,
    category_account_id = NULL, category_source = NULL, category_confidence = NULL, category_reason = NULL,
    category_confirmed = false, updated_at = now()
  WHERE id = ANY (v_ids) AND user_id = p_user_id;
END $$;

REVOKE EXECUTE ON FUNCTION public._bank_ensure_chart(uuid), public._bank_code_id(uuid, text), public._bank_post_je(uuid, date, text, text, uuid, jsonb),
  public._bank_ensure_gl_account(uuid, uuid), public._bank_apply_match(uuid, uuid, boolean, uuid),
  public._bank_post_categorization(uuid, uuid), public._bank_detect_transfers(uuid), public._bank_undo(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bank_ensure_chart(uuid), public._bank_code_id(uuid, text), public._bank_post_je(uuid, date, text, text, uuid, jsonb),
  public._bank_ensure_gl_account(uuid, uuid), public._bank_apply_match(uuid, uuid, boolean, uuid),
  public._bank_post_categorization(uuid, uuid), public._bank_detect_transfers(uuid), public._bank_undo(uuid, uuid)
  TO service_role;

-- =============================================================
-- 4. CLIENT RPCs (authenticated, owner-scoped)
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_apply_match(p_match_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public._bank_apply_match(public.get_account_owner_id(), p_match_id, false, auth.uid());
END $$;

CREATE OR REPLACE FUNCTION public.bank_reject_match(p_match_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE bank_matches SET status = 'rejected'
  WHERE id = p_match_id AND user_id = public.get_account_owner_id() AND status = 'suggested';
END $$;

CREATE OR REPLACE FUNCTION public.bank_confirm_categorization(
  p_txn_id uuid, p_account_id uuid, p_remember boolean DEFAULT true, p_vendor_id uuid DEFAULT NULL, p_customer_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  t bank_transactions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE id = p_account_id AND user_id = v_user AND is_active) THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  SELECT * INTO t FROM bank_transactions WHERE id = p_txn_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF t.status NOT IN ('new', 'categorized') THEN RAISE EXCEPTION 'Transaction is already reconciled (%)', t.status; END IF;

  UPDATE bank_transactions SET
    category_account_id = p_account_id, category_source = 'user', category_confidence = 1,
    category_reason = 'Confirmed by you', category_confirmed = true, status = 'categorized',
    counterparty_vendor_id = coalesce(p_vendor_id, counterparty_vendor_id),
    counterparty_customer_id = coalesce(p_customer_id, counterparty_customer_id), updated_at = now()
  WHERE id = t.id;

  IF p_remember AND t.merchant_key IS NOT NULL AND length(t.merchant_key) >= 3 THEN
    INSERT INTO bank_categorization_rules (user_id, match_field, pattern, direction, account_id, vendor_id, source, hits)
    VALUES (v_user, 'merchant_key', t.merchant_key, CASE WHEN t.amount_cents >= 0 THEN 'in' ELSE 'out' END, p_account_id, p_vendor_id, 'learned', 1)
    ON CONFLICT (user_id, match_field, pattern, direction)
    DO UPDATE SET account_id = EXCLUDED.account_id, vendor_id = coalesce(EXCLUDED.vendor_id, bank_categorization_rules.vendor_id),
                  hits = bank_categorization_rules.hits + 1, is_active = true;
  END IF;

  RETURN public._bank_post_categorization(v_user, t.id);
END $$;

CREATE OR REPLACE FUNCTION public.bank_bulk_confirm(p_txn_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  v_id uuid;
  v_ok integer := 0;
  v_fail integer := 0;
BEGIN
  IF coalesce(array_length(p_txn_ids, 1), 0) > 200 THEN RAISE EXCEPTION 'Too many transactions at once (max 200)'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_txn_ids, ARRAY[]::uuid[]) LOOP
    BEGIN
      UPDATE bank_transactions SET category_confirmed = true, updated_at = now()
      WHERE id = v_id AND user_id = v_user AND status = 'categorized' AND category_account_id IS NOT NULL;
      IF NOT FOUND THEN v_fail := v_fail + 1; CONTINUE; END IF;
      PERFORM public._bank_post_categorization(v_user, v_id);
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('posted', v_ok, 'failed', v_fail);
END $$;

CREATE OR REPLACE FUNCTION public.bank_undo_transaction(p_txn_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._bank_undo(public.get_account_owner_id(), p_txn_id);
END $$;

CREATE OR REPLACE FUNCTION public.bank_post_opening_balance(p_bank_account_id uuid, p_offset_account_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  a bank_accounts%ROWTYPE;
  v_gl uuid;
  v_offset uuid;
  v_sum bigint;
  v_open bigint;
  v_date date;
  v_je uuid;
  v_is_liab boolean;
BEGIN
  SELECT * INTO a FROM bank_accounts WHERE id = p_bank_account_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank account not found'; END IF;
  IF a.opening_balance_posted THEN RAISE EXCEPTION 'Opening balance was already posted'; END IF;
  IF a.current_balance_cents IS NULL THEN RAISE EXCEPTION 'No bank balance available yet — sync first'; END IF;
  IF EXISTS (SELECT 1 FROM bank_connections WHERE id = a.connection_id AND NOT initial_sync_complete) THEN
    RAISE EXCEPTION 'Initial transaction history is still loading';
  END IF;

  v_gl := public._bank_ensure_gl_account(v_user, a.id);
  PERFORM public._bank_ensure_chart(v_user);
  v_offset := coalesce(p_offset_account_id, public._bank_code_id(v_user, '3000'));
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE id = v_offset AND user_id = v_user) THEN RAISE EXCEPTION 'Offset account not found'; END IF;
  IF v_offset = v_gl THEN RAISE EXCEPTION 'Offset account cannot be the bank account itself'; END IF;

  v_is_liab := a.account_type IN ('credit', 'loan');
  SELECT coalesce(sum(amount_cents), 0), min(posted_date) INTO v_sum, v_date
  FROM bank_transactions WHERE bank_account_id = a.id AND NOT pending AND status <> 'removed';
  v_date := coalesce(v_date, current_date) - 1;

  v_open := CASE WHEN v_is_liab THEN a.current_balance_cents + v_sum ELSE a.current_balance_cents - v_sum END;

  IF v_open <> 0 THEN
    v_je := public._bank_post_je(v_user, v_date, 'Opening balance — ' || a.name, 'bank_opening_balance', a.id,
      CASE
        WHEN (NOT v_is_liab AND v_open > 0) OR (v_is_liab AND v_open < 0) THEN jsonb_build_array(
          jsonb_build_object('account_id', v_gl, 'debit_cents', abs(v_open), 'credit_cents', 0, 'description', 'Opening balance'),
          jsonb_build_object('account_id', v_offset, 'debit_cents', 0, 'credit_cents', abs(v_open), 'description', 'Opening balance'))
        ELSE jsonb_build_array(
          jsonb_build_object('account_id', v_offset, 'debit_cents', abs(v_open), 'credit_cents', 0, 'description', 'Opening balance'),
          jsonb_build_object('account_id', v_gl, 'debit_cents', 0, 'credit_cents', abs(v_open), 'description', 'Opening balance'))
      END);
  END IF;

  UPDATE bank_accounts SET opening_balance_posted = true, opening_balance_cents = v_open, opening_balance_je_id = v_je, updated_at = now() WHERE id = a.id;
  RETURN v_open;
END $$;

CREATE OR REPLACE FUNCTION public.bank_get_reconciliation()
RETURNS TABLE (
  bank_account_id uuid, account_name text, mask text, institution_name text, account_type text,
  bank_balance_cents bigint, gl_balance_cents bigint, unreconciled_cents bigint, variance_cents bigint,
  unreconciled_count bigint, opening_balance_posted boolean, gl_mapped boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := public.get_account_owner_id();
BEGIN
  RETURN QUERY
  SELECT a.id, a.name, a.mask, c.institution_name, a.account_type,
    coalesce(a.current_balance_cents, 0)::bigint,
    g.bal::bigint,
    u.amt::bigint,
    (coalesce(a.current_balance_cents, 0) - (g.bal + u.amt))::bigint,
    u.cnt::bigint,
    a.opening_balance_posted,
    a.gl_account_id IS NOT NULL
  FROM bank_accounts a
  JOIN bank_connections c ON c.id = a.connection_id
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(CASE WHEN a.account_type IN ('credit', 'loan') THEN jl.credit_cents - jl.debit_cents ELSE jl.debit_cents - jl.credit_cents END), 0) AS bal
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = a.gl_account_id AND je.status = 'posted' AND je.user_id = v_user AND je.entry_date <= current_date
  ) g
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(CASE WHEN a.account_type IN ('credit', 'loan') THEN -t.amount_cents ELSE t.amount_cents END), 0) AS amt, count(*) AS cnt
    FROM bank_transactions t
    WHERE t.bank_account_id = a.id AND NOT t.pending AND t.status IN ('new', 'categorized')
  ) u
  WHERE a.user_id = v_user AND a.is_active AND c.status <> 'disconnected'
  ORDER BY c.institution_name, a.name;
END $$;

CREATE OR REPLACE FUNCTION public.bank_get_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := public.get_account_owner_id();
  v_res jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_cash_cents', coalesce((SELECT sum(current_balance_cents) FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
        WHERE a.user_id = v_user AND a.is_active AND a.account_type = 'depository' AND c.status <> 'disconnected'), 0),
    'inflow_7d_cents', coalesce((SELECT sum(amount_cents) FROM bank_transactions WHERE user_id = v_user AND NOT pending AND status NOT IN ('transfer', 'removed')
        AND amount_cents > 0 AND posted_date >= current_date - 7), 0),
    'outflow_7d_cents', coalesce((SELECT -sum(amount_cents) FROM bank_transactions WHERE user_id = v_user AND NOT pending AND status NOT IN ('transfer', 'removed')
        AND amount_cents < 0 AND posted_date >= current_date - 7), 0),
    'new_count', (SELECT count(*) FROM bank_transactions WHERE user_id = v_user AND status = 'new' AND NOT pending),
    'to_approve_count', (SELECT count(*) FROM bank_transactions WHERE user_id = v_user AND status = 'categorized' AND NOT pending),
    'pending_match_count', (SELECT count(DISTINCT bank_transaction_id) FROM bank_matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id
        WHERE m.user_id = v_user AND m.status = 'suggested' AND t.status IN ('new', 'categorized')),
    'unreconciled_inflow_cents', coalesce((SELECT sum(amount_cents) FROM bank_transactions WHERE user_id = v_user AND NOT pending
        AND status IN ('new', 'categorized') AND amount_cents > 0), 0),
    'posted_count', (SELECT count(*) FROM bank_transactions WHERE user_id = v_user AND NOT pending AND status IN ('posted', 'transfer')),
    'total_count', (SELECT count(*) FROM bank_transactions WHERE user_id = v_user AND NOT pending AND status <> 'removed')
  ) INTO v_res;
  RETURN v_res;
END $$;

GRANT EXECUTE ON FUNCTION
  public.bank_apply_match(uuid), public.bank_reject_match(uuid),
  public.bank_confirm_categorization(uuid, uuid, boolean, uuid, uuid), public.bank_bulk_confirm(uuid[]),
  public.bank_undo_transaction(uuid), public.bank_post_opening_balance(uuid, uuid),
  public.bank_get_reconciliation(), public.bank_get_overview()
TO authenticated;

CREATE OR REPLACE FUNCTION public.bank_set_account_forecast(p_bank_account_id uuid, p_include boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE bank_accounts SET include_in_forecast = p_include, updated_at = now()
  WHERE id = p_bank_account_id AND user_id = public.get_account_owner_id();
END $$;
GRANT EXECUTE ON FUNCTION public.bank_set_account_forecast(uuid, boolean) TO authenticated;

-- Nightly safety-net sync (webhooks are the primary path). Guarded: only scheduled when pg_cron + pg_net exist
-- AND the project settings below are provided. Run once manually after deploy:
--   alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
--   alter database postgres set app.settings.service_role_key = '<service-role-key>';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-bank-nightly-sync', '20 5 * * *', $job$
      select net.http_post(
        url := current_setting('app.settings.functions_url', true) || '/bank-sync',
        headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true), 'Content-Type', 'application/json'),
        body := '{"all": true}'::jsonb
      );
    $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping bank nightly cron schedule: %', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION public.bank_save_settings(
  p_autopilot_level text DEFAULT NULL, p_ai_categorization boolean DEFAULT NULL,
  p_low_cash_threshold_cents bigint DEFAULT NULL, p_runway_alert_days integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := public.get_account_owner_id();
BEGIN
  INSERT INTO bank_settings (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
  UPDATE bank_settings SET
    autopilot_level = coalesce(p_autopilot_level, autopilot_level),
    ai_categorization_enabled = coalesce(p_ai_categorization, ai_categorization_enabled),
    low_cash_threshold_cents = coalesce(p_low_cash_threshold_cents, low_cash_threshold_cents),
    runway_alert_days = coalesce(p_runway_alert_days, runway_alert_days),
    updated_at = now()
  WHERE user_id = v_user;
END $$;
GRANT EXECUTE ON FUNCTION public.bank_save_settings(text, boolean, bigint, integer) TO authenticated;
