/*
  # Multi-entity accounting — entities, intercompany, consolidation inputs

  Additive only: the existing general ledger (journal_entries / journal_lines) is the
  PRIMARY entity's books and is never altered. Subsidiaries get their own ledger
  (entity_journal_entries / entity_journal_lines) that shares the account's single
  chart_of_accounts. Intercompany transactions post matching entries in both entities
  atomically; consolidation math (eliminations, NCI) lives in src/lib/multiEntity.ts.

  All writes are SECURITY DEFINER RPCs (balanced entries, closed-period guard, owner /
  View Billing checks). Clients only SELECT through RLS.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS accounting_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 200),
  entity_type text NOT NULL DEFAULT 'operating' CHECK (entity_type IN ('operating', 'holding', 'branch', 'other')),
  country text CHECK (country IS NULL OR char_length(country) BETWEEN 2 AND 60),
  ownership_pct numeric(5, 2) NOT NULL DEFAULT 100 CHECK (ownership_pct > 0 AND ownership_pct <= 100),
  consolidation_method text NOT NULL DEFAULT 'full' CHECK (consolidation_method IN ('full', 'excluded')),
  is_primary boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_entities_primary ON accounting_entities (user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_accounting_entities_user ON accounting_entities (user_id, is_active);

ALTER TABLE accounting_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_accounting_entities" ON accounting_entities;
CREATE POLICY "select_own_accounting_entities" ON accounting_entities FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

CREATE TABLE IF NOT EXISTS entity_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entity_id uuid NOT NULL REFERENCES accounting_entities(id) ON DELETE RESTRICT,
  entry_number text NOT NULL,
  entry_date date NOT NULL,
  memo text,
  source_type text NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual', 'intercompany', 'intercompany_settlement', 'reversal')),
  source_id uuid,
  reversal_of_id uuid REFERENCES entity_journal_entries(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_entity_journal_entries_entity_date ON entity_journal_entries (entity_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_entity_journal_entries_source ON entity_journal_entries (user_id, source_type, source_id);

ALTER TABLE entity_journal_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_entity_journal_entries" ON entity_journal_entries;
CREATE POLICY "select_own_entity_journal_entries" ON entity_journal_entries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

CREATE TABLE IF NOT EXISTS entity_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES entity_journal_entries(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  description text,
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),
  CHECK (debit_cents > 0 OR credit_cents > 0)
);

CREATE INDEX IF NOT EXISTS idx_entity_journal_lines_entry ON entity_journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_entity_journal_lines_account ON entity_journal_lines (account_id);

ALTER TABLE entity_journal_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_entity_journal_lines" ON entity_journal_lines;
CREATE POLICY "select_own_entity_journal_lines" ON entity_journal_lines FOR SELECT TO authenticated
  USING (
    public.invoice_permission('can_view_billing')
    AND EXISTS (
      SELECT 1 FROM entity_journal_entries e
      WHERE e.id = entity_journal_lines.entry_id AND e.user_id = public.get_account_owner_id()
    )
  );

-- Which chart accounts play which intercompany role (elimination targets).
CREATE TABLE IF NOT EXISTS intercompany_accounts (
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('ic_receivable', 'ic_payable', 'ic_revenue', 'ic_expense', 'cash')),
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_intercompany_accounts_account ON intercompany_accounts (account_id);

ALTER TABLE intercompany_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_intercompany_accounts" ON intercompany_accounts;
CREATE POLICY "select_own_intercompany_accounts" ON intercompany_accounts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

CREATE TABLE IF NOT EXISTS intercompany_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  txn_number text NOT NULL,
  txn_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale', 'service', 'expense_recharge', 'loan')),
  from_entity_id uuid NOT NULL REFERENCES accounting_entities(id) ON DELETE RESTRICT,
  to_entity_id uuid NOT NULL REFERENCES accounting_entities(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_settled', 'settled', 'void')),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  from_entry_id uuid,
  to_entry_id uuid,
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 100),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (settled_cents <= amount_cents),
  UNIQUE (user_id, txn_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_intercompany_transactions_idem
  ON intercompany_transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intercompany_transactions_user_date ON intercompany_transactions (user_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_intercompany_transactions_status ON intercompany_transactions (user_id, status);

ALTER TABLE intercompany_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_intercompany_transactions" ON intercompany_transactions;
CREATE POLICY "select_own_intercompany_transactions" ON intercompany_transactions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

CREATE TABLE IF NOT EXISTS intercompany_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  txn_id uuid NOT NULL REFERENCES intercompany_transactions(id) ON DELETE RESTRICT,
  settle_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  from_entry_id uuid,
  to_entry_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intercompany_settlements_txn ON intercompany_settlements (txn_id);

ALTER TABLE intercompany_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_intercompany_settlements" ON intercompany_settlements;
CREATE POLICY "select_own_intercompany_settlements" ON intercompany_settlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================

-- p_mode: 'read' / 'write' need View Billing; 'config' needs the account owner.
CREATE OR REPLACE FUNCTION public._me_owner(p_mode text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No account found for this user' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'config' THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner') THEN
      RAISE EXCEPTION 'Only the account owner can change the entity structure' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'You need the View Billing permission for multi-entity accounting' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public._me_free_code(p_owner uuid, p_base integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code integer := p_base;
BEGIN
  WHILE EXISTS (SELECT 1 FROM chart_of_accounts WHERE user_id = p_owner AND code = v_code::text) LOOP
    v_code := v_code + 1;
  END LOOP;
  RETURN v_code::text;
END;
$$;

-- Idempotent: creates the intercompany accounts (never reusing an existing code) and role map.
CREATE OR REPLACE FUNCTION public._me_ensure_accounts(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ic_receivable', 'Intercompany Receivable', 'asset', 'debit', 1900),
      ('ic_payable', 'Intercompany Payable', 'liability', 'credit', 2900),
      ('ic_revenue', 'Intercompany Revenue', 'revenue', 'credit', 4950),
      ('ic_expense', 'Intercompany Expense', 'expense', 'debit', 6950)
    ) AS t(k_role, k_name, k_type, k_balance, k_base)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM intercompany_accounts WHERE user_id = p_owner AND role = r.k_role) THEN
      INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system)
      VALUES (p_owner, public._me_free_code(p_owner, r.k_base), r.k_name, r.k_type, r.k_balance, true)
      RETURNING id INTO v_id;
      INSERT INTO intercompany_accounts (user_id, role, account_id) VALUES (p_owner, r.k_role, v_id);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM intercompany_accounts WHERE user_id = p_owner AND role = 'cash') THEN
    v_id := NULL;
    SELECT id INTO v_id FROM chart_of_accounts
    WHERE user_id = p_owner AND code = '1000' AND type = 'asset' LIMIT 1;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM chart_of_accounts
      WHERE user_id = p_owner AND type = 'asset' AND is_active ORDER BY code LIMIT 1;
    END IF;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'No cash account exists in the chart of accounts';
    END IF;
    INSERT INTO intercompany_accounts (user_id, role, account_id) VALUES (p_owner, 'cash', v_id);
  END IF;
END;
$$;

-- Posts one balanced entry into an entity's ledger (primary -> legacy journal_entries).
CREATE OR REPLACE FUNCTION public._me_post(
  p_owner uuid, p_entity_id uuid, p_date date, p_memo text, p_source text, p_source_id uuid,
  p_lines jsonb, p_reversal_of uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary boolean;
  v_active boolean;
  v_entry uuid;
  v_line jsonb;
  v_dr bigint;
  v_cr bigint;
  v_total_dr bigint := 0;
  v_total_cr bigint := 0;
  v_n integer := 0;
BEGIN
  SELECT is_primary, is_active INTO v_primary, v_active
  FROM accounting_entities WHERE id = p_entity_id AND user_id = p_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entity not found';
  END IF;
  IF NOT v_active AND p_reversal_of IS NULL THEN
    RAISE EXCEPTION 'Entity is inactive';
  END IF;

  PERFORM public._gl_assert_period_open(p_owner, p_date);

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;
  IF jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'A journal entry is limited to 200 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_dr := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_cr := coalesce((v_line->>'credit_cents')::bigint, 0);
    IF v_dr < 0 OR v_cr < 0 OR (v_dr > 0) = (v_cr > 0) THEN
      RAISE EXCEPTION 'Each journal line needs exactly one positive debit or credit amount';
    END IF;
    IF v_primary AND (v_dr > 2147483647 OR v_cr > 2147483647) THEN
      RAISE EXCEPTION 'Amount is too large for the primary ledger';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM chart_of_accounts
      WHERE id = (v_line->>'account_id')::uuid AND user_id = p_owner AND (is_active OR p_reversal_of IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'A journal line uses an unknown or inactive account';
    END IF;
    v_total_dr := v_total_dr + v_dr;
    v_total_cr := v_total_cr + v_cr;
  END LOOP;

  IF v_total_dr <> v_total_cr THEN
    RAISE EXCEPTION 'Journal entry does not balance: % debit vs % credit', v_total_dr, v_total_cr;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('me-gl:' || p_owner::text, 0));

  IF v_primary THEN
    INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id, reversal_of_id, created_by)
    VALUES (
      p_owner, public._gl_next_number(p_owner, 'JE', 'journal_entries'), p_date, p_memo,
      CASE WHEN p_reversal_of IS NULL THEN 'manual' ELSE 'reversal' END,
      p_source_id, p_reversal_of, auth.uid()
    )
    RETURNING id INTO v_entry;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_n := v_n + 1;
      INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description)
      VALUES (
        v_entry, v_n, (v_line->>'account_id')::uuid,
        coalesce((v_line->>'debit_cents')::integer, 0), coalesce((v_line->>'credit_cents')::integer, 0),
        left(v_line->>'description', 300)
      );
    END LOOP;
  ELSE
    INSERT INTO entity_journal_entries (user_id, entity_id, entry_number, entry_date, memo, source_type, source_id, reversal_of_id, created_by)
    VALUES (
      p_owner, p_entity_id,
      'ME-' || to_char(p_date, 'YYYYMM') || '-'
        || lpad(((SELECT count(*) FROM entity_journal_entries WHERE user_id = p_owner) + 1)::text, 5, '0'),
      p_date, p_memo,
      CASE WHEN p_reversal_of IS NULL THEN p_source ELSE 'reversal' END,
      p_source_id, p_reversal_of, auth.uid()
    )
    RETURNING id INTO v_entry;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_n := v_n + 1;
      INSERT INTO entity_journal_lines (entry_id, line_number, account_id, debit_cents, credit_cents, description)
      VALUES (
        v_entry, v_n, (v_line->>'account_id')::uuid,
        coalesce((v_line->>'debit_cents')::bigint, 0), coalesce((v_line->>'credit_cents')::bigint, 0),
        left(v_line->>'description', 300)
      );
    END LOOP;
  END IF;

  RETURN v_entry;
END;
$$;

-- Posts the mirror image of an existing entry and flags the original as reversed.
CREATE OR REPLACE FUNCTION public._me_reverse_entry(
  p_owner uuid, p_entity_id uuid, p_entry_id uuid, p_source_id uuid, p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary boolean;
  v_lines jsonb;
  v_rev uuid;
BEGIN
  SELECT is_primary INTO v_primary FROM accounting_entities WHERE id = p_entity_id AND user_id = p_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entity not found';
  END IF;

  IF v_primary THEN
    SELECT jsonb_agg(
      jsonb_build_object('account_id', jl.account_id, 'debit_cents', jl.credit_cents, 'credit_cents', jl.debit_cents, 'description', jl.description)
      ORDER BY jl.line_number
    )
    INTO v_lines
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.id = p_entry_id AND je.user_id = p_owner;
  ELSE
    SELECT jsonb_agg(
      jsonb_build_object('account_id', el.account_id, 'debit_cents', el.credit_cents, 'credit_cents', el.debit_cents, 'description', el.description)
      ORDER BY el.line_number
    )
    INTO v_lines
    FROM entity_journal_lines el
    JOIN entity_journal_entries ee ON ee.id = el.entry_id
    WHERE ee.id = p_entry_id AND ee.user_id = p_owner;
  END IF;

  IF v_lines IS NULL THEN
    RAISE EXCEPTION 'Original journal entry not found';
  END IF;

  v_rev := public._me_post(
    p_owner, p_entity_id, current_date, 'Reversal: ' || left(btrim(p_reason), 200), 'reversal', p_source_id, v_lines, p_entry_id
  );

  IF v_primary THEN
    UPDATE journal_entries SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
    WHERE id = p_entry_id AND user_id = p_owner;
  ELSE
    UPDATE entity_journal_entries SET reversed_at = now() WHERE id = p_entry_id AND user_id = p_owner;
  END IF;

  RETURN v_rev;
END;
$$;

-- =============================================================
-- PUBLIC RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.me_setup(p_primary_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_primary uuid;
  v_name text;
BEGIN
  v_owner := public._me_owner('config');
  PERFORM public.ensure_default_chart_of_accounts();
  PERFORM pg_advisory_xact_lock(hashtextextended('me-setup:' || v_owner::text, 0));

  SELECT id INTO v_primary FROM accounting_entities WHERE user_id = v_owner AND is_primary;
  IF v_primary IS NULL THEN
    v_name := coalesce(nullif(btrim(p_primary_name), ''), 'Primary Entity');
    INSERT INTO accounting_entities (user_id, code, name, entity_type, is_primary)
    VALUES (v_owner, 'MAIN', left(v_name, 120), 'operating', true)
    RETURNING id INTO v_primary;
  END IF;

  PERFORM public._me_ensure_accounts(v_owner);
  RETURN jsonb_build_object('primary_entity_id', v_primary);
END;
$$;

CREATE OR REPLACE FUNCTION public.me_upsert_entity(
  p_id uuid, p_code text, p_name text, p_legal_name text, p_entity_type text, p_country text,
  p_ownership_pct numeric, p_method text, p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_id uuid;
  v_row accounting_entities%ROWTYPE;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
BEGIN
  v_owner := public._me_owner('config');

  IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' THEN
    RAISE EXCEPTION 'Entity code must be 1-20 letters, numbers, dashes or underscores';
  END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Entity name must be 1-120 characters';
  END IF;
  IF p_entity_type IS NULL OR p_entity_type NOT IN ('operating', 'holding', 'branch', 'other') THEN
    RAISE EXCEPTION 'Unknown entity type';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('full', 'excluded') THEN
    RAISE EXCEPTION 'Unknown consolidation method';
  END IF;
  IF p_ownership_pct IS NULL OR p_ownership_pct <= 0 OR p_ownership_pct > 100 THEN
    RAISE EXCEPTION 'Ownership must be above 0 and at most 100';
  END IF;

  IF p_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM accounting_entities WHERE user_id = v_owner AND is_primary) THEN
      RAISE EXCEPTION 'Run multi-entity setup first';
    END IF;
    INSERT INTO accounting_entities (user_id, code, name, legal_name, entity_type, country, ownership_pct, consolidation_method, is_active)
    VALUES (v_owner, v_code, v_name, nullif(btrim(p_legal_name), ''), p_entity_type, nullif(btrim(p_country), ''), round(p_ownership_pct, 2), p_method, true)
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_row FROM accounting_entities WHERE id = p_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Entity not found';
    END IF;
    IF v_row.is_primary AND (p_ownership_pct <> 100 OR p_method <> 'full' OR NOT coalesce(p_is_active, true)) THEN
      RAISE EXCEPTION 'The primary entity must stay active, fully consolidated and 100 percent owned';
    END IF;
    IF v_row.is_active AND NOT coalesce(p_is_active, true) AND EXISTS (
      SELECT 1 FROM intercompany_transactions
      WHERE user_id = v_owner AND status IN ('open', 'partially_settled')
        AND (from_entity_id = p_id OR to_entity_id = p_id)
    ) THEN
      RAISE EXCEPTION 'Settle or void open intercompany balances before deactivating this entity';
    END IF;
    UPDATE accounting_entities
    SET code = v_code, name = v_name, legal_name = nullif(btrim(p_legal_name), ''), entity_type = p_entity_type,
        country = nullif(btrim(p_country), ''), ownership_pct = round(p_ownership_pct, 2),
        consolidation_method = p_method, is_active = coalesce(p_is_active, true), updated_at = now()
    WHERE id = p_id AND user_id = v_owner;
    v_id := p_id;
  END IF;

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Entity code % is already in use', v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.me_post_entity_journal(p_entity_id uuid, p_date date, p_memo text, p_lines jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := public._me_owner('write');
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'A date is required';
  END IF;
  IF char_length(coalesce(p_memo, '')) > 500 THEN
    RAISE EXCEPTION 'Memo is limited to 500 characters';
  END IF;
  RETURN public._me_post(v_owner, p_entity_id, p_date, nullif(btrim(p_memo), ''), 'manual', NULL, p_lines, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.me_post_intercompany(
  p_from_entity uuid, p_to_entity uuid, p_kind text, p_date date, p_amount_cents bigint,
  p_description text, p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_existing uuid;
  v_txn uuid := gen_random_uuid();
  v_seq integer;
  v_num text;
  v_memo text;
  v_from accounting_entities%ROWTYPE;
  v_to accounting_entities%ROWTYPE;
  v_rec uuid;
  v_pay uuid;
  v_rev uuid;
  v_exp uuid;
  v_cash uuid;
  v_from_lines jsonb;
  v_to_lines jsonb;
  v_from_entry uuid;
  v_to_entry uuid;
BEGIN
  v_owner := public._me_owner('write');

  IF p_kind IS NULL OR p_kind NOT IN ('sale', 'service', 'expense_recharge', 'loan') THEN
    RAISE EXCEPTION 'Unknown intercompany transaction type';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'A date is required';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000000 THEN
    RAISE EXCEPTION 'Amount must be greater than zero and at most 1,000,000,000.00';
  END IF;
  IF p_from_entity IS NULL OR p_to_entity IS NULL OR p_from_entity = p_to_entity THEN
    RAISE EXCEPTION 'Choose two different entities';
  END IF;
  IF char_length(coalesce(p_description, '')) > 500 THEN
    RAISE EXCEPTION 'Description is limited to 500 characters';
  END IF;
  IF p_idempotency_key IS NOT NULL AND char_length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'Idempotency key is too long';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('me-ic:' || v_owner::text, 0));

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM intercompany_transactions
    WHERE user_id = v_owner AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_from FROM accounting_entities WHERE id = p_from_entity AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Providing entity not found';
  END IF;
  SELECT * INTO v_to FROM accounting_entities WHERE id = p_to_entity AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving entity not found';
  END IF;
  IF NOT v_from.is_active OR NOT v_to.is_active THEN
    RAISE EXCEPTION 'Both entities must be active';
  END IF;

  SELECT account_id INTO v_rec FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_receivable';
  SELECT account_id INTO v_pay FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_payable';
  SELECT account_id INTO v_rev FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_revenue';
  SELECT account_id INTO v_exp FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_expense';
  SELECT account_id INTO v_cash FROM intercompany_accounts WHERE user_id = v_owner AND role = 'cash';
  IF v_rec IS NULL OR v_pay IS NULL OR v_rev IS NULL OR v_exp IS NULL OR v_cash IS NULL THEN
    RAISE EXCEPTION 'Run multi-entity setup first';
  END IF;

  SELECT count(*) + 1 INTO v_seq FROM intercompany_transactions WHERE user_id = v_owner;
  v_num := 'IC-' || to_char(p_date, 'YYYYMM') || '-' || lpad(v_seq::text, 4, '0');
  v_memo := 'Intercompany ' || replace(p_kind, '_', ' ') || ' ' || v_num;

  IF p_kind = 'loan' THEN
    v_from_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_rec, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    );
    v_to_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_cash, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_pay, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    );
  ELSE
    v_from_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_rec, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_rev, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    );
    v_to_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_exp, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_pay, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    );
  END IF;

  INSERT INTO intercompany_transactions (
    id, user_id, txn_number, txn_date, kind, from_entity_id, to_entity_id, amount_cents, description, idempotency_key, created_by
  ) VALUES (
    v_txn, v_owner, v_num, p_date, p_kind, p_from_entity, p_to_entity, p_amount_cents,
    nullif(btrim(p_description), ''), p_idempotency_key, auth.uid()
  );

  v_from_entry := public._me_post(v_owner, p_from_entity, p_date, v_memo || ' to ' || v_to.code, 'intercompany', v_txn, v_from_lines, NULL);
  v_to_entry := public._me_post(v_owner, p_to_entity, p_date, v_memo || ' from ' || v_from.code, 'intercompany', v_txn, v_to_lines, NULL);

  UPDATE intercompany_transactions SET from_entry_id = v_from_entry, to_entry_id = v_to_entry WHERE id = v_txn;
  RETURN v_txn;
END;
$$;

CREATE OR REPLACE FUNCTION public.me_settle_intercompany(p_txn_id uuid, p_date date, p_amount_cents bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_t intercompany_transactions%ROWTYPE;
  v_rec uuid;
  v_pay uuid;
  v_cash uuid;
  v_memo text;
  v_settle uuid := gen_random_uuid();
  v_from_entry uuid;
  v_to_entry uuid;
  v_new_settled bigint;
BEGIN
  v_owner := public._me_owner('write');

  SELECT * INTO v_t FROM intercompany_transactions WHERE id = p_txn_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intercompany transaction not found';
  END IF;
  IF v_t.status NOT IN ('open', 'partially_settled') THEN
    RAISE EXCEPTION 'This transaction is not open for settlement';
  END IF;
  IF p_date IS NULL OR p_date < v_t.txn_date THEN
    RAISE EXCEPTION 'Settlement cannot be dated before the transaction';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Settlement amount must be greater than zero';
  END IF;
  IF p_amount_cents > v_t.amount_cents - v_t.settled_cents THEN
    RAISE EXCEPTION 'Settlement exceeds the outstanding balance';
  END IF;

  SELECT account_id INTO v_rec FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_receivable';
  SELECT account_id INTO v_pay FROM intercompany_accounts WHERE user_id = v_owner AND role = 'ic_payable';
  SELECT account_id INTO v_cash FROM intercompany_accounts WHERE user_id = v_owner AND role = 'cash';
  IF v_rec IS NULL OR v_pay IS NULL OR v_cash IS NULL THEN
    RAISE EXCEPTION 'Run multi-entity setup first';
  END IF;

  v_memo := 'Settlement of ' || v_t.txn_number;

  -- Receiving side (lender / seller): cash in, receivable down.
  v_from_entry := public._me_post(
    v_owner, v_t.from_entity_id, p_date, v_memo, 'intercompany_settlement', v_settle,
    jsonb_build_array(
      jsonb_build_object('account_id', v_cash, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_rec, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    ), NULL
  );
  -- Paying side (borrower / buyer): payable down, cash out.
  v_to_entry := public._me_post(
    v_owner, v_t.to_entity_id, p_date, v_memo, 'intercompany_settlement', v_settle,
    jsonb_build_array(
      jsonb_build_object('account_id', v_pay, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', v_memo),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', v_memo)
    ), NULL
  );

  INSERT INTO intercompany_settlements (id, user_id, txn_id, settle_date, amount_cents, from_entry_id, to_entry_id, created_by)
  VALUES (v_settle, v_owner, v_t.id, p_date, p_amount_cents, v_from_entry, v_to_entry, auth.uid());

  v_new_settled := v_t.settled_cents + p_amount_cents;
  UPDATE intercompany_transactions
  SET settled_cents = v_new_settled,
      status = CASE WHEN v_new_settled >= amount_cents THEN 'settled' ELSE 'partially_settled' END
  WHERE id = v_t.id;

  RETURN v_settle;
END;
$$;

CREATE OR REPLACE FUNCTION public.me_void_intercompany(p_txn_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_t intercompany_transactions%ROWTYPE;
BEGIN
  v_owner := public._me_owner('write');

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A reason of at least 3 characters is required';
  END IF;
  IF char_length(p_reason) > 300 THEN
    RAISE EXCEPTION 'Reason is limited to 300 characters';
  END IF;

  SELECT * INTO v_t FROM intercompany_transactions WHERE id = p_txn_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intercompany transaction not found';
  END IF;
  IF v_t.status = 'void' THEN
    RAISE EXCEPTION 'This transaction is already void';
  END IF;
  IF v_t.settled_cents > 0 THEN
    RAISE EXCEPTION 'Transactions with settlements cannot be voided';
  END IF;

  PERFORM public._me_reverse_entry(v_owner, v_t.from_entity_id, v_t.from_entry_id, v_t.id, p_reason);
  PERFORM public._me_reverse_entry(v_owner, v_t.to_entity_id, v_t.to_entry_id, v_t.id, p_reason);

  UPDATE intercompany_transactions
  SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  WHERE id = v_t.id;
END;
$$;

-- Raw per-entity, per-account balances: cumulative to p_end and within [p_start, p_end].
-- Returns a jsonb array; consolidation math is done client-side from this.
CREATE OR REPLACE FUNCTION public.me_entity_balances(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_result jsonb;
BEGIN
  v_owner := public._me_owner('read');
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid reporting period';
  END IF;

  WITH ent AS (
    SELECT id, is_primary FROM accounting_entities WHERE user_id = v_owner AND is_active
  ), src AS (
    SELECT e.id AS entity_id, jl.account_id, je.entry_date,
           jl.debit_cents::bigint AS dr, jl.credit_cents::bigint AS cr
    FROM ent e
    JOIN journal_entries je ON je.user_id = v_owner AND je.status = 'posted' AND je.entry_date <= p_end
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE e.is_primary
    UNION ALL
    SELECT e.id, el.account_id, ee.entry_date, el.debit_cents, el.credit_cents
    FROM ent e
    JOIN entity_journal_entries ee ON ee.entity_id = e.id AND ee.entry_date <= p_end
    JOIN entity_journal_lines el ON el.entry_id = ee.id
    WHERE NOT e.is_primary
  ), agg AS (
    SELECT s.entity_id, s.account_id,
           sum(s.dr) AS cum_dr, sum(s.cr) AS cum_cr,
           coalesce(sum(s.dr) FILTER (WHERE s.entry_date >= p_start), 0) AS per_dr,
           coalesce(sum(s.cr) FILTER (WHERE s.entry_date >= p_start), 0) AS per_cr
    FROM src s
    GROUP BY s.entity_id, s.account_id
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'entity_id', a.entity_id, 'account_id', a.account_id, 'code', c.code, 'name', c.name, 'type', c.type,
      'normal_balance', c.normal_balance, 'ic_role', m.role,
      'cum_debit_cents', a.cum_dr, 'cum_credit_cents', a.cum_cr,
      'period_debit_cents', a.per_dr, 'period_credit_cents', a.per_cr
    ) ORDER BY c.code, a.entity_id
  ), '[]'::jsonb)
  INTO v_result
  FROM agg a
  JOIN chart_of_accounts c ON c.id = a.account_id
  LEFT JOIN intercompany_accounts m ON m.account_id = a.account_id AND m.user_id = v_owner;

  RETURN v_result;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public._me_owner(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._me_free_code(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._me_ensure_accounts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._me_post(uuid, uuid, date, text, text, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._me_reverse_entry(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.me_setup(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_upsert_entity(uuid, text, text, text, text, text, numeric, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_post_entity_journal(uuid, date, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_post_intercompany(uuid, uuid, text, date, bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_settle_intercompany(uuid, date, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_void_intercompany(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_entity_balances(date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.me_setup(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_upsert_entity(uuid, text, text, text, text, text, numeric, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_post_entity_journal(uuid, date, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_post_intercompany(uuid, uuid, text, date, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_settle_intercompany(uuid, date, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_void_intercompany(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_entity_balances(date, date) TO authenticated;
