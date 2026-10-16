-- =============================================================
-- Expenses — capture, receipt OCR, categories, job allocation,
-- reimbursement.
--
-- Design (mirrors payroll / accounting in this repo):
--   * Every row is scoped by user_id = account owner id
--     (public.get_account_owner_id()), so team members share the
--     owner's books.
--   * expenses / expense_allocations are READ-ONLY from the client.
--     Every state change goes through the SECURITY DEFINER RPCs below,
--     which validate input, enforce the workflow
--     (draft -> submitted -> approved|rejected -> reimbursed), post the
--     balanced entries into the general ledger via post_journal_entry()
--     and write the audit log.
--   * Members see only their own expenses. Owners and members with
--     can_view_billing (or a custom role granting it) see everyone's and
--     may review / reimburse — but never their own expense unless they
--     are the account owner.
--   * Receipts live in a private bucket:
--       expense-receipts/{owner_id}/{submitter_uid}/{file}
--   * Job allocation does NOT write into job_cost_entries (its live
--     shape differs between migrations and client code). Instead the
--     view expense_job_costs exposes approved cost per job so job
--     profitability can add it in.
-- Depends on: 20260821101104 (profiles/team_members), 20260831090000
-- (audit_log, notifications), 20261103000000 (custom_roles),
-- 20261203000001 (general ledger), the get_account_owner_id() fix.
-- =============================================================

-- 1) Permission helper ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.uid() = public.get_account_owner_id(), false)
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND coalesce(cr.permissions->>'can_view_billing', tm.permissions->>'can_view_billing', 'false') = 'true'
    );
$$;

REVOKE ALL ON FUNCTION public.expense_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_is_manager() TO authenticated;

-- 2) Categories -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  gl_account_code text NOT NULL DEFAULT '6900',
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_expense_categories" ON expense_categories;
CREATE POLICY "select_expense_categories" ON expense_categories FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_expense_categories" ON expense_categories;
CREATE POLICY "insert_expense_categories" ON expense_categories FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.expense_is_manager() AND is_system = false);

DROP POLICY IF EXISTS "update_expense_categories" ON expense_categories;
CREATE POLICY "update_expense_categories" ON expense_categories FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.expense_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.expense_is_manager());

-- 3) Expenses ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- account owner (RLS scope)
  submitted_by uuid NOT NULL,                  -- auth user who captured it
  submitted_by_email text,
  vendor_name text NOT NULL CHECK (char_length(btrim(vendor_name)) BETWEEN 1 AND 120),
  expense_date date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0 AND tax_cents <= amount_cents),
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  payment_method text NOT NULL DEFAULT 'personal_card'
    CHECK (payment_method IN ('personal_card', 'cash', 'company_card', 'other')),
  is_reimbursable boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),

  receipt_path text,
  receipt_mime text,
  receipt_hash text CHECK (receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'),
  ocr_status text NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none', 'done', 'failed')),
  ocr_data jsonb,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'reimbursed')),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid,
  reimbursed_at timestamptz,
  reimbursed_by uuid,
  reimbursement_method text,
  reimbursement_reference text,
  reimbursement_journal_entry_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (NOT is_reimbursable OR payment_method <> 'company_card')
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_status_date ON expenses(user_id, status, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_submitter_date ON expenses(user_id, submitted_by, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
-- One live claim per physical receipt (a rejected claim may be re-filed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_receipt_hash
  ON expenses(user_id, receipt_hash) WHERE receipt_hash IS NOT NULL AND status <> 'rejected';

CREATE OR REPLACE FUNCTION public.expenses_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_touch_updated_at();

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_expenses" ON expenses;
CREATE POLICY "select_expenses" ON expenses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND (submitted_by = auth.uid() OR public.expense_is_manager()));

-- 4) Job allocation ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  UNIQUE (expense_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_allocations_job ON expense_allocations(job_id);
CREATE INDEX IF NOT EXISTS idx_expense_allocations_user ON expense_allocations(user_id);

ALTER TABLE expense_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_expense_allocations" ON expense_allocations;
CREATE POLICY "select_expense_allocations" ON expense_allocations FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (
      public.expense_is_manager()
      OR EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND e.submitted_by = auth.uid())
    )
  );

-- Writes only through the RPCs (SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE ON expenses, expense_allocations FROM authenticated, anon;

-- Approved job cost per job (for job profitability). security_invoker keeps RLS.
CREATE OR REPLACE VIEW expense_job_costs WITH (security_invoker = true) AS
  SELECT a.user_id, a.job_id, sum(a.amount_cents)::bigint AS cost_cents, count(*)::integer AS expense_count
  FROM expense_allocations a
  JOIN expenses e ON e.id = a.expense_id
  WHERE e.status IN ('approved', 'reimbursed')
  GROUP BY a.user_id, a.job_id;

-- 5) Receipt storage (private) -------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts', 'expense-receipts', false, 10485760, -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path: {owner_id}/{submitter_uid}/{file}. Submitters write into their own
-- folder; managers can read/remove anyone's receipt in their account.
DROP POLICY IF EXISTS "expense_receipts_insert" ON storage.objects;
CREATE POLICY "expense_receipts_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "expense_receipts_select" ON storage.objects;
CREATE POLICY "expense_receipts_select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND ((storage.foldername(name))[2] = auth.uid()::text OR public.expense_is_manager())
  );

DROP POLICY IF EXISTS "expense_receipts_delete" ON storage.objects;
CREATE POLICY "expense_receipts_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- 6) OCR quota (service-role only, same pattern as field_estimate_usage) --------
CREATE TABLE IF NOT EXISTS expense_ocr_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE expense_ocr_usage ENABLE ROW LEVEL SECURITY; -- no policies on purpose

CREATE OR REPLACE FUNCTION public.consume_expense_ocr_quota(p_user_id uuid, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO expense_ocr_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE u.window_start END,
        request_count = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE u.request_count + 1 END
  RETURNING u.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_expense_ocr_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_expense_ocr_quota(uuid, integer, integer) TO service_role;

-- 7) RPC: seed categories + the reimbursement liability account ------------------
CREATE OR REPLACE FUNCTION public.ensure_default_expense_categories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public.ensure_default_chart_of_accounts();

  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system)
  VALUES (v_owner, '2050', 'Employee Reimbursements Payable', 'liability', 'credit', true)
  ON CONFLICT (user_id, code) DO NOTHING;

  INSERT INTO expense_categories (user_id, name, gl_account_code, is_system, sort_order) VALUES
    (v_owner, 'Fuel & Vehicle', '6100', true, 10),
    (v_owner, 'Parts & Materials', '5000', true, 20),
    (v_owner, 'Tools & Small Equipment', '6900', true, 30),
    (v_owner, 'Subcontractors', '5100', true, 40),
    (v_owner, 'Meals & Travel', '6900', true, 50),
    (v_owner, 'Permits & Licenses', '6900', true, 60),
    (v_owner, 'Marketing', '6200', true, 70),
    (v_owner, 'Software & Subscriptions', '6300', true, 80),
    (v_owner, 'Rent & Utilities', '6400', true, 90),
    (v_owner, 'Insurance', '6500', true, 100),
    (v_owner, 'Office Supplies', '6900', true, 110),
    (v_owner, 'Training', '6900', true, 120),
    (v_owner, 'Other', '6900', true, 999)
  ON CONFLICT (user_id, name) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 8) RPC: create / edit a draft and optionally submit it -------------------------
CREATE OR REPLACE FUNCTION public.save_expense(
  p_id uuid,
  p_data jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_submit boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row expenses%ROWTYPE;
  v_id uuid;
  v_vendor text;
  v_amount integer;
  v_tax integer;
  v_date date;
  v_cat uuid;
  v_method text;
  v_reimb boolean;
  v_notes text;
  v_receipt text;
  v_hash text;
  v_ocr_status text;
  v_email text;
  v_alloc jsonb := coalesce(p_allocations, '[]'::jsonb);
  v_a jsonb;
  v_alloc_total bigint := 0;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Invalid expense data'; END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM expenses WHERE id = p_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND OR v_row.submitted_by <> v_uid THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF v_row.status NOT IN ('draft', 'rejected') THEN
      RAISE EXCEPTION 'Only draft or rejected expenses can be edited';
    END IF;
  END IF;

  v_vendor := btrim(coalesce(p_data->>'vendor_name', ''));
  IF char_length(v_vendor) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Enter the vendor (up to 120 characters)'; END IF;

  IF coalesce(p_data->>'amount_cents', '') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Enter a valid amount'; END IF;
  v_amount := (p_data->>'amount_cents')::integer;
  IF v_amount NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION 'Enter a valid amount'; END IF;

  IF coalesce(p_data->>'tax_cents', '0') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Enter a valid tax amount'; END IF;
  v_tax := coalesce(p_data->>'tax_cents', '0')::integer;
  IF v_tax > v_amount THEN RAISE EXCEPTION 'Tax cannot exceed the total'; END IF;

  IF coalesce(p_data->>'expense_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Enter the expense date'; END IF;
  BEGIN
    v_date := (p_data->>'expense_date')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Enter a valid expense date';
  END;
  IF v_date > current_date + 1 THEN RAISE EXCEPTION 'The expense date cannot be in the future'; END IF;

  BEGIN
    v_cat := (p_data->>'category_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Choose a category';
  END;
  IF NOT EXISTS (SELECT 1 FROM expense_categories WHERE id = v_cat AND user_id = v_owner AND active) THEN
    RAISE EXCEPTION 'Choose an active category';
  END IF;

  v_method := coalesce(p_data->>'payment_method', 'personal_card');
  IF v_method NOT IN ('personal_card', 'cash', 'company_card', 'other') THEN RAISE EXCEPTION 'Invalid payment method'; END IF;
  v_reimb := CASE WHEN v_method = 'company_card' THEN false ELSE coalesce((p_data->>'is_reimbursable')::boolean, true) END;

  v_notes := nullif(btrim(coalesce(p_data->>'notes', '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN RAISE EXCEPTION 'Notes are limited to 2000 characters'; END IF;

  v_receipt := nullif(p_data->>'receipt_path', '');
  IF v_receipt IS NOT NULL
     AND v_receipt IS DISTINCT FROM (CASE WHEN p_id IS NULL THEN NULL ELSE v_row.receipt_path END)
     AND (v_receipt LIKE '%..%' OR v_receipt NOT LIKE v_owner::text || '/' || v_uid::text || '/%') THEN
    RAISE EXCEPTION 'Invalid receipt';
  END IF;
  v_hash := nullif(p_data->>'receipt_hash', '');
  v_ocr_status := coalesce(nullif(p_data->>'ocr_status', ''), 'none');
  IF v_ocr_status NOT IN ('none', 'done', 'failed') THEN v_ocr_status := 'none'; END IF;

  -- Allocations: [{job_id, amount_cents}] — empty means overhead (no job).
  IF jsonb_typeof(v_alloc) <> 'array' OR jsonb_array_length(v_alloc) > 20 THEN RAISE EXCEPTION 'Too many job allocations'; END IF;
  FOR v_a IN SELECT * FROM jsonb_array_elements(v_alloc) LOOP
    IF coalesce(v_a->>'amount_cents', '') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Each job allocation needs a positive amount'; END IF;
    IF (v_a->>'amount_cents')::integer < 1 THEN RAISE EXCEPTION 'Each job allocation needs a positive amount'; END IF;
    IF coalesce(v_a->>'job_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'A selected job was not found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = (v_a->>'job_id')::uuid AND user_id = v_owner) THEN
      RAISE EXCEPTION 'A selected job was not found';
    END IF;
    v_alloc_total := v_alloc_total + (v_a->>'amount_cents')::bigint;
  END LOOP;
  IF jsonb_array_length(v_alloc) > 0 THEN
    IF (SELECT count(DISTINCT x->>'job_id') FROM jsonb_array_elements(v_alloc) x) <> jsonb_array_length(v_alloc) THEN
      RAISE EXCEPTION 'Each job can only be allocated once';
    END IF;
    IF v_alloc_total <> v_amount THEN RAISE EXCEPTION 'Job allocations must add up to the expense total'; END IF;
  END IF;

  IF p_submit AND v_amount >= 7500 AND v_receipt IS NULL THEN
    RAISE EXCEPTION 'A receipt is required for expenses of $75.00 or more';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO expenses (user_id, submitted_by, submitted_by_email, vendor_name, expense_date, amount_cents, tax_cents,
        category_id, payment_method, is_reimbursable, notes, receipt_path, receipt_mime, receipt_hash, ocr_status, ocr_data,
        status, submitted_at)
      VALUES (v_owner, v_uid, v_email, v_vendor, v_date, v_amount, v_tax, v_cat, v_method, v_reimb, v_notes, v_receipt,
        nullif(p_data->>'receipt_mime', ''), v_hash, v_ocr_status,
        CASE WHEN jsonb_typeof(p_data->'ocr_data') = 'object' AND pg_column_size(p_data->'ocr_data') < 20000 THEN p_data->'ocr_data' END,
        CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
        CASE WHEN p_submit THEN now() END)
      RETURNING id INTO v_id;
    ELSE
      v_id := p_id;
      UPDATE expenses SET
        vendor_name = v_vendor, expense_date = v_date, amount_cents = v_amount, tax_cents = v_tax, category_id = v_cat,
        payment_method = v_method, is_reimbursable = v_reimb, notes = v_notes,
        receipt_path = v_receipt, receipt_mime = nullif(p_data->>'receipt_mime', ''), receipt_hash = v_hash,
        ocr_status = v_ocr_status,
        ocr_data = CASE WHEN jsonb_typeof(p_data->'ocr_data') = 'object' AND pg_column_size(p_data->'ocr_data') < 20000 THEN p_data->'ocr_data' END,
        status = CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
        submitted_at = CASE WHEN p_submit THEN now() END,
        reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
      WHERE id = v_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This receipt has already been filed on another expense';
  END;

  DELETE FROM expense_allocations WHERE expense_id = v_id;
  INSERT INTO expense_allocations (expense_id, user_id, job_id, amount_cents)
  SELECT v_id, v_owner, (x->>'job_id')::uuid, (x->>'amount_cents')::integer FROM jsonb_array_elements(v_alloc) x;

  IF p_submit THEN
    PERFORM public.log_audit_event(v_owner, 'expense_submitted', 'expenses', v_id::text);
    IF v_uid <> v_owner THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (v_owner, 'system', 'Expense awaiting review',
        coalesce(v_email, 'A team member') || ' submitted ' || to_char(v_amount / 100.0, 'FM$999,999,990.00') || ' for ' || v_vendor || '.',
        '/dashboard/expenses');
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

-- 9) RPC: approve / reject (posts to the ledger on approval) ---------------------
CREATE OR REPLACE FUNCTION public._expense_post_date(p_owner uuid, p_date date)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Posting into a closed period is rejected by the ledger, so fall back to today.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE user_id = p_owner AND status = 'closed' AND p_date BETWEEN period_start AND period_end
  ) THEN current_date ELSE p_date END;
$$;

CREATE OR REPLACE FUNCTION public.review_expense(p_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row expenses%ROWTYPE;
  v_expense_acct uuid;
  v_credit_acct uuid;
  v_gl_code text;
  v_je uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.expense_is_manager() THEN RAISE EXCEPTION 'You do not have permission to review expenses'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;

  SELECT * INTO v_row FROM expenses WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.status <> 'submitted' THEN RAISE EXCEPTION 'This expense is no longer awaiting review'; END IF;
  IF v_row.submitted_by = v_uid AND v_uid <> v_owner THEN RAISE EXCEPTION 'You cannot review your own expense'; END IF;

  IF p_decision = 'rejected' THEN
    IF v_note IS NULL OR char_length(v_note) < 3 THEN RAISE EXCEPTION 'Add a short reason for the rejection'; END IF;
    UPDATE expenses SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = left(v_note, 500) WHERE id = p_id;
    PERFORM public.log_audit_event(v_owner, 'expense_rejected', 'expenses', p_id::text);
    RETURN;
  END IF;

  PERFORM public.ensure_default_expense_categories();

  SELECT gl_account_code INTO v_gl_code FROM expense_categories WHERE id = v_row.category_id;
  SELECT id INTO v_expense_acct FROM chart_of_accounts WHERE user_id = v_owner AND code = coalesce(v_gl_code, '6900');
  IF v_expense_acct IS NULL THEN
    SELECT id INTO v_expense_acct FROM chart_of_accounts WHERE user_id = v_owner AND code = '6900';
  END IF;
  SELECT id INTO v_credit_acct FROM chart_of_accounts
    WHERE user_id = v_owner AND code = CASE WHEN v_row.is_reimbursable THEN '2050' ELSE '2200' END;
  IF v_expense_acct IS NULL OR v_credit_acct IS NULL THEN RAISE EXCEPTION 'Chart of accounts is missing a required account'; END IF;

  -- Dr expense / Cr reimbursements payable (paid personally) or credit card payable (company card).
  v_je := public.post_journal_entry(
    public._expense_post_date(v_owner, v_row.expense_date),
    'Expense: ' || v_row.vendor_name,
    'manual', p_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_expense_acct, 'debit_cents', v_row.amount_cents, 'credit_cents', 0, 'description', v_row.vendor_name),
      jsonb_build_object('account_id', v_credit_acct, 'debit_cents', 0, 'credit_cents', v_row.amount_cents, 'description', v_row.vendor_name)
    )
  );

  UPDATE expenses SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_note = left(v_note, 500), journal_entry_id = v_je
  WHERE id = p_id;
  PERFORM public.log_audit_event(v_owner, 'expense_approved', 'expenses', p_id::text);
END;
$$;

-- 10) RPC: reimburse one or many approved expenses (all-or-nothing) --------------
CREATE OR REPLACE FUNCTION public.reimburse_expenses(
  p_ids uuid[],
  p_method text,
  p_reference text DEFAULT NULL,
  p_paid_date date DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row expenses%ROWTYPE;
  v_id uuid;
  v_liability uuid;
  v_cash uuid;
  v_je uuid;
  v_date date := coalesce(p_paid_date, current_date);
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.expense_is_manager() THEN RAISE EXCEPTION 'You do not have permission to reimburse expenses'; END IF;
  IF p_ids IS NULL OR coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Select between 1 and 100 expenses'; END IF;
  IF p_method NOT IN ('cash', 'check', 'bank_transfer', 'payroll', 'other') THEN RAISE EXCEPTION 'Invalid reimbursement method'; END IF;
  IF v_date > current_date THEN RAISE EXCEPTION 'The payment date cannot be in the future'; END IF;

  PERFORM public.ensure_default_expense_categories();
  SELECT id INTO v_liability FROM chart_of_accounts WHERE user_id = v_owner AND code = '2050';
  SELECT id INTO v_cash FROM chart_of_accounts WHERE user_id = v_owner AND code = '1000';
  IF v_liability IS NULL OR v_cash IS NULL THEN RAISE EXCEPTION 'Chart of accounts is missing a required account'; END IF;

  FOR v_id IN SELECT t.x FROM (SELECT DISTINCT unnest(p_ids) AS x) t ORDER BY t.x LOOP
    SELECT * INTO v_row FROM expenses WHERE id = v_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF v_row.status <> 'approved' OR NOT v_row.is_reimbursable THEN
      RAISE EXCEPTION '% is not ready for reimbursement', v_row.vendor_name;
    END IF;

    v_je := public.post_journal_entry(
      public._expense_post_date(v_owner, v_date),
      'Reimbursement: ' || v_row.vendor_name,
      'manual', v_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_liability, 'debit_cents', v_row.amount_cents, 'credit_cents', 0, 'description', v_row.vendor_name),
        jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_row.amount_cents, 'description', v_row.vendor_name)
      )
    );

    UPDATE expenses SET status = 'reimbursed', reimbursed_at = v_date::timestamptz, reimbursed_by = v_uid,
      reimbursement_method = p_method, reimbursement_reference = left(nullif(btrim(coalesce(p_reference, '')), ''), 120),
      reimbursement_journal_entry_id = v_je
    WHERE id = v_id;
    PERFORM public.log_audit_event(v_owner, 'expense_reimbursed', 'expenses', v_id::text);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 11) RPC: delete a draft / rejected expense (returns the receipt path to remove) -
CREATE OR REPLACE FUNCTION public.delete_expense(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_row.submitted_by <> auth.uid() THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.status NOT IN ('draft', 'rejected') THEN RAISE EXCEPTION 'Only draft or rejected expenses can be deleted'; END IF;
  DELETE FROM expenses WHERE id = p_id;
  PERFORM public.log_audit_event(v_owner, 'expense_deleted', 'expenses', p_id::text);
  RETURN v_row.receipt_path;
END;
$$;

-- 12) RPC: dashboard summary (managers: whole account; members: their own) --------
CREATE OR REPLACE FUNCTION public.get_expense_summary(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_mgr boolean := public.expense_is_manager();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  WITH s AS (
    SELECT * FROM expenses e WHERE e.user_id = v_owner AND (v_mgr OR e.submitted_by = v_uid)
  )
  SELECT jsonb_build_object(
    'pending_count', (SELECT count(*) FROM s WHERE status = 'submitted'),
    'pending_cents', (SELECT coalesce(sum(amount_cents), 0) FROM s WHERE status = 'submitted'),
    'owed_count', (SELECT count(*) FROM s WHERE status = 'approved' AND is_reimbursable),
    'owed_cents', (SELECT coalesce(sum(amount_cents), 0) FROM s WHERE status = 'approved' AND is_reimbursable),
    'period_cents', (SELECT coalesce(sum(amount_cents), 0) FROM s
                     WHERE status IN ('approved', 'reimbursed') AND expense_date BETWEEN p_start AND p_end),
    'reimbursed_cents', (SELECT coalesce(sum(amount_cents), 0) FROM s
                         WHERE status = 'reimbursed' AND reimbursed_at::date BETWEEN p_start AND p_end),
    'by_category', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.cents DESC) FROM (
        SELECT c.name, sum(s.amount_cents)::bigint AS cents
        FROM s JOIN expense_categories c ON c.id = s.category_id
        WHERE s.status IN ('approved', 'reimbursed') AND s.expense_date BETWEEN p_start AND p_end
        GROUP BY c.name ORDER BY cents DESC LIMIT 8
      ) x), '[]'::jsonb),
    'by_job', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.cents DESC) FROM (
        SELECT j.id AS job_id, j.customer_name, sum(a.amount_cents)::bigint AS cents
        FROM s JOIN expense_allocations a ON a.expense_id = s.id JOIN jobs j ON j.id = a.job_id
        WHERE s.status IN ('approved', 'reimbursed') AND s.expense_date BETWEEN p_start AND p_end
        GROUP BY j.id, j.customer_name ORDER BY cents DESC LIMIT 5
      ) x), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

-- 13) Grants -----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ensure_default_expense_categories() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_expense(uuid, jsonb, jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_expense(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reimburse_expenses(uuid[], text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_expense(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_expense_summary(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._expense_post_date(uuid, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ensure_default_expense_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(uuid, jsonb, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_expense(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reimburse_expenses(uuid[], text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expense(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_expense_summary(date, date) TO authenticated;
