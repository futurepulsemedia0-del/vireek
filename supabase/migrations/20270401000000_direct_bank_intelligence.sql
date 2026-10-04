/*
  # Direct Bank Intelligence

  ## Why
  Closes the loop: BANK -> Transactions -> AI categorization -> Invoice/Bill
  matching -> Reconciliation -> Cash forecast -> Action. Provider-agnostic
  (provider = plaid | mx | finicity); Plaid is wired first.

  ## What this adds (no existing table is altered)
  1. bank_connections / bank_connection_secrets / bank_accounts
  2. bank_transactions (signed cents: positive = money IN) with AI/rule
     suggestions and reconciliation state
  3. bank_category_rules (learns from user corrections)
  4. RPCs: bank_apply_reconciliation (atomic, GL-safe), bank_ignore_transaction,
     bank_save_suggestions (service role only)

  ## Security
  - Access tokens live ONLY in bank_connection_secrets (RLS on, zero
    policies, privileges revoked) -> readable by service role only.
  - Client has SELECT only; every write is a SECURITY DEFINER RPC or an
    edge function, so balanced-entry / closed-period rules cannot be bypassed.
  - Team members need can_view_billing (bank_can_access()).
*/

CREATE OR REPLACE FUNCTION public.bank_can_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members
      WHERE member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND coalesce((permissions->>'can_view_billing')::boolean, false)
    );
$$;
GRANT EXECUTE ON FUNCTION public.bank_can_access() TO authenticated;

-- =============================================================
-- CONNECTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'plaid' CHECK (provider IN ('plaid', 'mx', 'finicity')),
  item_id text NOT NULL,
  institution_id text,
  institution_name text NOT NULL DEFAULT 'Bank',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'error', 'disconnected')),
  sync_cursor text,
  sync_locked_until timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, item_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_connections_user ON bank_connections(user_id, status);
ALTER TABLE bank_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_bank_connections" ON bank_connections;
CREATE POLICY "select_own_bank_connections" ON bank_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.bank_can_access());

CREATE TABLE IF NOT EXISTS bank_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES bank_connections(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bank_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bank_connection_secrets FROM anon, authenticated;

-- =============================================================
-- ACCOUNTS
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  provider_account_id text NOT NULL,
  name text NOT NULL,
  mask text,
  account_type text NOT NULL DEFAULT 'depository',
  subtype text,
  currency text NOT NULL DEFAULT 'USD',
  current_balance_cents bigint,
  available_balance_cents bigint,
  balance_updated_at timestamptz,
  ledger_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id, is_active);
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_bank_accounts" ON bank_accounts;
CREATE POLICY "select_own_bank_accounts" ON bank_accounts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.bank_can_access());

-- =============================================================
-- TRANSACTIONS  (amount_cents: positive = money IN, negative = money OUT)
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  provider_txn_id text NOT NULL,
  posted_date date NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  description text NOT NULL DEFAULT '',
  merchant_name text,
  provider_category text,
  pending boolean NOT NULL DEFAULT false,

  category_code text,
  category_label text,
  category_confidence numeric(4,3),
  category_source text CHECK (category_source IN ('rule', 'ai', 'user')),

  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'suggested', 'reconciled', 'ignored')),
  match_type text CHECK (match_type IN ('ar_invoice', 'ar_payment', 'ap_bill', 'ap_bill_payment', 'expense', 'income', 'transfer')),
  match_refs jsonb NOT NULL DEFAULT '[]',
  match_confidence numeric(4,3),
  match_reason text,

  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  reconciled_at timestamptz,
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_txn_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_txn_user_date ON bank_transactions(user_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_review ON bank_transactions(user_id, match_status) WHERE pending = false;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_bank_transactions" ON bank_transactions;
CREATE POLICY "select_own_bank_transactions" ON bank_transactions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.bank_can_access());

-- =============================================================
-- LEARNED CATEGORY RULES (merchant_key = first 3 lowercase alpha words)
-- =============================================================
CREATE TABLE IF NOT EXISTS bank_category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  merchant_key text NOT NULL,
  category_code text NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, merchant_key)
);
ALTER TABLE bank_category_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_bank_category_rules" ON bank_category_rules;
CREATE POLICY "select_own_bank_category_rules" ON bank_category_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.bank_can_access());

-- =============================================================
-- RPC: bank_save_suggestions (service role only — used by analysis engine)
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_save_suggestions(p_user_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE bank_transactions t SET
    match_status = r.match_status,
    match_type = r.match_type,
    match_refs = coalesce(r.match_refs, '[]'::jsonb),
    match_confidence = r.match_confidence,
    match_reason = r.match_reason,
    category_code = r.category_code,
    category_label = r.category_label,
    category_confidence = r.category_confidence,
    category_source = r.category_source,
    updated_at = now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id uuid, match_status text, match_type text, match_refs jsonb, match_confidence numeric,
    match_reason text, category_code text, category_label text, category_confidence numeric, category_source text
  )
  WHERE t.id = r.id AND t.user_id = p_user_id AND t.match_status IN ('unmatched', 'suggested');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.bank_save_suggestions(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_save_suggestions(uuid, jsonb) TO service_role;

-- =============================================================
-- RPC: bank_ignore_transaction
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_ignore_transaction(p_txn_id uuid, p_ignore boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.bank_can_access() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE bank_transactions SET
    match_status = CASE WHEN p_ignore THEN 'ignored' ELSE 'unmatched' END,
    match_type = CASE WHEN p_ignore THEN NULL ELSE match_type END,
    match_refs = CASE WHEN p_ignore THEN '[]'::jsonb ELSE match_refs END,
    updated_at = now()
  WHERE id = p_txn_id AND user_id = public.get_account_owner_id() AND match_status <> 'reconciled';
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found or already reconciled'; END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.bank_ignore_transaction(uuid, boolean) TO authenticated;

-- =============================================================
-- RPC: bank_apply_reconciliation
-- Applies the stored suggestion (or a user-chosen category) atomically:
--   ar_invoice       -> posts DR cash / CR AR, records ar_payments (bank date)
--   ap_bill          -> posts DR AP / CR cash, records ap_bill_payments
--   ar_payment / ap_bill_payment -> already booked (e.g. Stripe): link only
--   expense / income -> posts to the chosen account
--   transfer         -> marks reconciled, no posting
-- Idempotent: an already-reconciled transaction returns its journal entry.
-- =============================================================
CREATE OR REPLACE FUNCTION public.bank_apply_reconciliation(p_txn_id uuid, p_category_code text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  t bank_transactions%ROWTYPE;
  v_type text;
  v_code text;
  v_cash uuid;
  v_ar uuid;
  v_ap uuid;
  v_acct uuid;
  v_acct_type text;
  v_je uuid;
  v_ref jsonb;
  v_sum bigint := 0;
  v_amt integer;
  v_abs bigint;
  v_total integer;
  v_paid integer;
  v_status text;
  v_key text;
  v_memo text;
BEGIN
  IF NOT public.bank_can_access() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  v_user := public.get_account_owner_id();

  SELECT * INTO t FROM bank_transactions WHERE id = p_txn_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF t.match_status = 'reconciled' THEN RETURN t.journal_entry_id; END IF;
  IF t.pending THEN RAISE EXCEPTION 'Pending transactions cannot be reconciled yet'; END IF;
  IF t.match_status = 'ignored' THEN RAISE EXCEPTION 'Restore this transaction before reconciling it'; END IF;
  IF t.currency <> 'USD' THEN RAISE EXCEPTION 'Only USD transactions can be posted to the books'; END IF;
  v_abs := abs(t.amount_cents);
  IF v_abs > 2000000000 THEN RAISE EXCEPTION 'Amount is too large to post automatically'; END IF;

  PERFORM public.ensure_default_chart_of_accounts();
  SELECT coalesce(ba.ledger_account_id, (
           SELECT id FROM chart_of_accounts
           WHERE user_id = v_user AND code = CASE WHEN ba.account_type = 'credit' THEN '2200' ELSE '1000' END))
    INTO v_cash FROM bank_accounts ba WHERE ba.id = t.account_id AND ba.user_id = v_user;
  SELECT id INTO v_ar FROM chart_of_accounts WHERE user_id = v_user AND code = '1100';
  SELECT id INTO v_ap FROM chart_of_accounts WHERE user_id = v_user AND code = '2000';

  v_type := t.match_type;
  v_code := coalesce(p_category_code, t.category_code);
  IF p_category_code IS NOT NULL THEN
    v_type := CASE WHEN t.amount_cents < 0 THEN 'expense' ELSE 'income' END;
  END IF;
  IF v_type IS NULL THEN RAISE EXCEPTION 'Choose a category or match before reconciling'; END IF;

  v_memo := left('Bank: ' || coalesce(nullif(t.merchant_name, ''), t.description), 200);

  IF v_type = 'ar_invoice' THEN
    IF t.amount_cents <= 0 THEN RAISE EXCEPTION 'Only deposits can match invoices'; END IF;
    FOR v_ref IN SELECT * FROM jsonb_array_elements(t.match_refs) LOOP
      v_amt := (v_ref->>'amount_cents')::integer;
      SELECT total_cents, amount_paid_cents, status INTO v_total, v_paid, v_status
        FROM ar_invoices WHERE id = (v_ref->>'id')::uuid AND user_id = v_user FOR UPDATE;
      IF v_total IS NULL THEN RAISE EXCEPTION 'A matched invoice no longer exists'; END IF;
      IF v_status NOT IN ('sent', 'partially_paid', 'overdue') THEN RAISE EXCEPTION 'A matched invoice is no longer open'; END IF;
      IF v_amt <= 0 OR v_paid + v_amt > v_total THEN RAISE EXCEPTION 'A matched invoice balance has changed — re-run analysis'; END IF;
      v_sum := v_sum + v_amt;
    END LOOP;
    IF v_sum <> t.amount_cents THEN RAISE EXCEPTION 'Matched invoices no longer add up to this deposit — re-run analysis'; END IF;
    v_je := public.post_journal_entry(t.posted_date, v_memo, 'ar_payment', t.id, jsonb_build_array(
      jsonb_build_object('account_id', v_cash, 'debit_cents', v_sum, 'credit_cents', 0, 'description', 'Bank deposit'),
      jsonb_build_object('account_id', v_ar, 'debit_cents', 0, 'credit_cents', v_sum, 'description', 'Applied to AR')));
    FOR v_ref IN SELECT * FROM jsonb_array_elements(t.match_refs) LOOP
      v_amt := (v_ref->>'amount_cents')::integer;
      INSERT INTO ar_payments (user_id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, journal_entry_id)
        VALUES (v_user, (v_ref->>'id')::uuid, v_amt, t.posted_date, 'ach', v_cash, v_je);
      UPDATE ar_invoices SET
        amount_paid_cents = amount_paid_cents + v_amt,
        status = CASE WHEN amount_paid_cents + v_amt >= total_cents THEN 'paid' ELSE 'partially_paid' END,
        updated_at = now()
      WHERE id = (v_ref->>'id')::uuid;
    END LOOP;

  ELSIF v_type = 'ap_bill' THEN
    IF t.amount_cents >= 0 THEN RAISE EXCEPTION 'Only withdrawals can match bills'; END IF;
    FOR v_ref IN SELECT * FROM jsonb_array_elements(t.match_refs) LOOP
      v_amt := (v_ref->>'amount_cents')::integer;
      SELECT total_cents, amount_paid_cents, status INTO v_total, v_paid, v_status
        FROM ap_bills WHERE id = (v_ref->>'id')::uuid AND user_id = v_user FOR UPDATE;
      IF v_total IS NULL THEN RAISE EXCEPTION 'A matched bill no longer exists'; END IF;
      IF v_status NOT IN ('approved', 'partially_paid') THEN RAISE EXCEPTION 'A matched bill is no longer open'; END IF;
      IF v_amt <= 0 OR v_paid + v_amt > v_total THEN RAISE EXCEPTION 'A matched bill balance has changed — re-run analysis'; END IF;
      v_sum := v_sum + v_amt;
    END LOOP;
    IF v_sum <> v_abs THEN RAISE EXCEPTION 'Matched bills no longer add up to this withdrawal — re-run analysis'; END IF;
    v_je := public.post_journal_entry(t.posted_date, v_memo, 'ap_bill_payment', t.id, jsonb_build_array(
      jsonb_build_object('account_id', v_ap, 'debit_cents', v_sum, 'credit_cents', 0, 'description', 'Bill paid'),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_sum, 'description', 'Bank withdrawal')));
    FOR v_ref IN SELECT * FROM jsonb_array_elements(t.match_refs) LOOP
      v_amt := (v_ref->>'amount_cents')::integer;
      INSERT INTO ap_bill_payments (user_id, bill_id, amount_cents, payment_date, payment_method, source_account_id, journal_entry_id)
        VALUES (v_user, (v_ref->>'id')::uuid, v_amt, t.posted_date, 'ach', v_cash, v_je);
      UPDATE ap_bills SET
        amount_paid_cents = amount_paid_cents + v_amt,
        status = CASE WHEN amount_paid_cents + v_amt >= total_cents THEN 'paid' ELSE 'partially_paid' END,
        updated_at = now()
      WHERE id = (v_ref->>'id')::uuid;
    END LOOP;

  ELSIF v_type IN ('ar_payment', 'ap_bill_payment') THEN
    FOR v_ref IN SELECT * FROM jsonb_array_elements(t.match_refs) LOOP
      IF v_type = 'ar_payment' THEN
        PERFORM 1 FROM ar_payments WHERE id = (v_ref->>'id')::uuid AND user_id = v_user;
      ELSE
        PERFORM 1 FROM ap_bill_payments WHERE id = (v_ref->>'id')::uuid AND user_id = v_user;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'A matched payment no longer exists'; END IF;
      IF EXISTS (
        SELECT 1 FROM bank_transactions o
        WHERE o.user_id = v_user AND o.id <> t.id AND o.match_status = 'reconciled'
          AND o.match_refs @> jsonb_build_array(jsonb_build_object('id', v_ref->>'id'))
      ) THEN RAISE EXCEPTION 'A matched payment is already linked to another bank transaction'; END IF;
      v_sum := v_sum + (v_ref->>'amount_cents')::bigint;
    END LOOP;
    IF v_sum <> v_abs THEN RAISE EXCEPTION 'Matched payments no longer add up to this transaction — re-run analysis'; END IF;

  ELSIF v_type IN ('expense', 'income') THEN
    IF v_code IS NULL THEN RAISE EXCEPTION 'Choose a category first'; END IF;
    SELECT id, type INTO v_acct, v_acct_type FROM chart_of_accounts
      WHERE user_id = v_user AND code = v_code AND is_active;
    IF v_acct IS NULL THEN RAISE EXCEPTION 'Account % does not exist or is inactive', v_code; END IF;
    IF v_type = 'expense' THEN
      IF t.amount_cents >= 0 OR v_acct_type <> 'expense' THEN RAISE EXCEPTION 'Withdrawals must be posted to an expense account'; END IF;
      v_je := public.post_journal_entry(t.posted_date, v_memo, 'manual', t.id, jsonb_build_array(
        jsonb_build_object('account_id', v_acct, 'debit_cents', v_abs, 'credit_cents', 0, 'description', v_memo),
        jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_abs, 'description', 'Bank withdrawal')));
    ELSE
      IF t.amount_cents <= 0 OR v_acct_type <> 'revenue' THEN RAISE EXCEPTION 'Deposits must be posted to a revenue account'; END IF;
      v_je := public.post_journal_entry(t.posted_date, v_memo, 'manual', t.id, jsonb_build_array(
        jsonb_build_object('account_id', v_cash, 'debit_cents', v_abs, 'credit_cents', 0, 'description', 'Bank deposit'),
        jsonb_build_object('account_id', v_acct, 'debit_cents', 0, 'credit_cents', v_abs, 'description', v_memo)));
    END IF;

  ELSIF v_type <> 'transfer' THEN
    RAISE EXCEPTION 'Unsupported match type %', v_type;
  END IF;

  UPDATE bank_transactions SET
    match_status = 'reconciled', match_type = v_type, journal_entry_id = v_je, reconciled_at = now(),
    category_code = CASE WHEN v_type IN ('expense', 'income') THEN v_code ELSE category_code END,
    category_source = CASE WHEN p_category_code IS NOT NULL THEN 'user' ELSE category_source END,
    match_refs = CASE WHEN p_category_code IS NOT NULL THEN '[]'::jsonb ELSE match_refs END,
    needs_review = false, updated_at = now()
  WHERE id = t.id;

  -- Learn from an explicit user category choice (same key as the TS engine).
  IF p_category_code IS NOT NULL THEN
    v_key := array_to_string((regexp_split_to_array(trim(regexp_replace(lower(coalesce(nullif(t.merchant_name, ''), t.description)), '[^a-z ]', ' ', 'g')), '\s+'))[1:3], ' ');
    IF v_key <> '' THEN
      INSERT INTO bank_category_rules (user_id, merchant_key, category_code)
        VALUES (v_user, v_key, p_category_code)
      ON CONFLICT (user_id, merchant_key)
        DO UPDATE SET category_code = EXCLUDED.category_code, hits = bank_category_rules.hits + 1, updated_at = now();
    END IF;
  END IF;

  RETURN v_je;
END;
$$;
GRANT EXECUTE ON FUNCTION public.bank_apply_reconciliation(uuid, text) TO authenticated;
