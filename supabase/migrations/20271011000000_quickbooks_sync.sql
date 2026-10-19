/*
# QuickBooks Online two-way sync

## What this migration does
Backend for the two-way sync of accounts, customers, items, invoices and payments with
QuickBooks Online, plus the mapping settings, conflict handling and sync log shown on
/dashboard/quickbooks.

- `qbo_connections`         one row per account owner (company, environment, settings, cursors)
- `qbo_connection_secrets`  OAuth tokens, ENCRYPTED, service-role only
- `qbo_record_links`        Vireek record <-> QuickBooks record, with the last-synced base snapshot
- `qbo_sync_runs`           one row per sync run (live progress + counters)
- `qbo_sync_log`            per-record events (created / updated / conflict / skipped / error)
- `can_manage_quickbooks()` permission helper (needs can_edit_business_profile AND can_view_billing)
- `updated_at` touch triggers on price_book_items / chart_of_accounts / ar_invoices (change detection)
- service-role-only functions that write invoices and payments THROUGH the existing general ledger
  rules (balanced entries, closed periods) with the QuickBooks transaction date

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Tokens never touch an RLS-readable table: `qbo_connection_secrets` has RLS on, zero policies and
   revoked privileges; the edge functions encrypt with QBO_TOKEN_ENCRYPTION_KEY (AES-256-GCM).
3. Clients can READ connection / runs / log / links when can_manage_quickbooks(). They can NEVER write
   them: connect, settings, sync, disconnect and conflict resolution go through edge functions that
   re-check the permission and validate input.
4. The qbo_* ledger functions are executable by service_role ONLY. They assume the owner's identity
   for the transaction so the original GL functions (period lock, balance check) apply unchanged.
5. One QuickBooks company can be linked to one Vireek account at a time (partial unique index).
*/

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_quickbooks()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_quickbooks() TO authenticated;

-- =============================================================
-- 2. CHANGE DETECTION (Vireek -> QuickBooks direction)
-- =============================================================

DROP TRIGGER IF EXISTS trg_qbo_touch_price_book_items ON public.price_book_items;
CREATE TRIGGER trg_qbo_touch_price_book_items BEFORE UPDATE ON public.price_book_items
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_qbo_touch_chart_of_accounts ON public.chart_of_accounts;
CREATE TRIGGER trg_qbo_touch_chart_of_accounts BEFORE UPDATE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_qbo_touch_ar_invoices ON public.ar_invoices;
CREATE TRIGGER trg_qbo_touch_ar_invoices BEFORE UPDATE ON public.ar_invoices
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_price_book_items_user_updated ON public.price_book_items (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_user_updated ON public.chart_of_accounts (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_ar_invoices_user_updated ON public.ar_invoices (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_ar_payments_user_created ON public.ar_payments (user_id, created_at, id);

-- =============================================================
-- 3. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.qbo_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,                       -- account owner id: one QuickBooks company per account
  realm_id text NOT NULL CHECK (realm_id ~ '^[0-9]{6,20}$'),
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  company_name text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,        -- mapping + conflict rules (validated server-side)
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,         -- per-entity pull / push watermarks
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  refresh_token_expires_at timestamptz,               -- Intuit refresh tokens expire after ~100 days of no use
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qbo_connections_live_realm
  ON public.qbo_connections (realm_id) WHERE status <> 'disconnected';

DROP TRIGGER IF EXISTS trg_qbo_touch_connections ON public.qbo_connections;
CREATE TRIGGER trg_qbo_touch_connections BEFORE UPDATE ON public.qbo_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.qbo_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qbo_connections_select" ON public.qbo_connections;
CREATE POLICY "qbo_connections_select" ON public.qbo_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());

-- =============================================================
-- 4. SECRETS (service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.qbo_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.qbo_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qbo_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.

-- =============================================================
-- 5. RECORD LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.qbo_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'item', 'invoice', 'payment')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,                          -- QuickBooks Id (payments: "<paymentId>:<invoiceId>")
  sync_token text,
  base jsonb NOT NULL DEFAULT '{}'::jsonb,            -- normalised values both sides held after the last sync
  conflict jsonb,                                     -- open manual conflict: { fields, reason, at }
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);

CREATE INDEX IF NOT EXISTS idx_qbo_links_conflict
  ON public.qbo_record_links (connection_id) WHERE conflict IS NOT NULL;

ALTER TABLE public.qbo_record_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qbo_links_select" ON public.qbo_record_links;
CREATE POLICY "qbo_links_select" ON public.qbo_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());

-- =============================================================
-- 6. RUNS + LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.qbo_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'webhook')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_qbo_runs_conn_started ON public.qbo_sync_runs (connection_id, started_at DESC);

ALTER TABLE public.qbo_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qbo_runs_select" ON public.qbo_sync_runs;
CREATE POLICY "qbo_runs_select" ON public.qbo_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());

CREATE TABLE IF NOT EXISTS public.qbo_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.qbo_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'item', 'invoice', 'payment')),
  direction text NOT NULL CHECK (direction IN ('to_qbo', 'from_qbo', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'voided', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  intuit_tid text,                                    -- Intuit support correlation id for failed API calls
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qbo_log_conn_created ON public.qbo_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qbo_log_conn_action ON public.qbo_sync_log (connection_id, action, created_at DESC);

ALTER TABLE public.qbo_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qbo_log_select" ON public.qbo_sync_log;
CREATE POLICY "qbo_log_select" ON public.qbo_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'qbo_sync_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qbo_sync_runs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'qbo_connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qbo_connections;
  END IF;
END $$;

COMMENT ON TABLE public.qbo_connection_secrets IS
  'Encrypted QuickBooks OAuth tokens. Service role only: no RLS policies and no grants for anon/authenticated.';

-- =============================================================
-- 7. LEDGER FUNCTIONS (service_role only)
--    The edge function has no user session, so these assume the owner's identity for the current
--    transaction (the same mechanism PostgREST uses) and then call the ORIGINAL general-ledger
--    functions. Balanced entries and closed periods are therefore enforced exactly as everywhere else.
-- =============================================================

CREATE OR REPLACE FUNCTION public.qbo_assume_owner(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_owner) THEN
    RAISE EXCEPTION 'Unknown account owner';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
END;
$$;

-- p_lines: [{description, quantity, unit_price_cents, amount_cents, revenue_account_id?}]
CREATE OR REPLACE FUNCTION public.qbo_create_ar_invoice(
  p_owner uuid,
  p_customer_id uuid,
  p_issue_date date,
  p_due_date date,
  p_tax_cents integer,
  p_lines jsonb,
  p_invoice_number text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id uuid;
  v_line jsonb;
  v_n integer := 0;
  v_subtotal integer := 0;
  v_amount integer;
  v_ar uuid;
  v_tax uuid;
  v_def_rev uuid;
  v_rev uuid;
  v_je_lines jsonb := '[]'::jsonb;
  v_je uuid;
  v_number text;
BEGIN
  PERFORM public.qbo_assume_owner(p_owner);
  PERFORM public.ensure_default_chart_of_accounts();

  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = p_owner) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line';
  END IF;

  SELECT id INTO v_ar FROM chart_of_accounts WHERE user_id = p_owner AND code = '1100';
  SELECT id INTO v_tax FROM chart_of_accounts WHERE user_id = p_owner AND code = '2100';
  SELECT id INTO v_def_rev FROM chart_of_accounts WHERE user_id = p_owner AND code = '4000';

  SELECT coalesce(sum((l ->> 'amount_cents')::integer), 0) INTO v_subtotal FROM jsonb_array_elements(p_lines) l;
  IF v_subtotal + coalesce(p_tax_cents, 0) <= 0 THEN
    RAISE EXCEPTION 'Zero-value invoices are not synced';
  END IF;

  v_number := nullif(btrim(coalesce(p_invoice_number, '')), '');
  IF v_number IS NULL OR EXISTS (SELECT 1 FROM ar_invoices WHERE user_id = p_owner AND invoice_number = v_number) THEN
    v_number := public._gl_next_number(p_owner, 'INV', 'ar_invoices');
    WHILE EXISTS (SELECT 1 FROM ar_invoices WHERE user_id = p_owner AND invoice_number = v_number) LOOP
      v_number := v_number || '-' || substr(gen_random_uuid()::text, 1, 4);
    END LOOP;
  END IF;

  INSERT INTO ar_invoices (user_id, invoice_number, customer_id, status, issue_date, due_date, subtotal_cents, tax_cents)
  VALUES (p_owner, v_number, p_customer_id, 'sent', coalesce(p_issue_date, current_date),
          coalesce(p_due_date, coalesce(p_issue_date, current_date) + 30), v_subtotal, greatest(coalesce(p_tax_cents, 0), 0))
  RETURNING id INTO v_invoice_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    v_amount := (v_line ->> 'amount_cents')::integer;
    IF v_amount < 0 THEN RAISE EXCEPTION 'Negative invoice lines are not supported'; END IF;
    SELECT id INTO v_rev FROM chart_of_accounts
      WHERE id = nullif(v_line ->> 'revenue_account_id', '')::uuid AND user_id = p_owner AND is_active;
    v_rev := coalesce(v_rev, v_def_rev);
    INSERT INTO ar_invoice_lines (invoice_id, line_number, description, quantity, unit_price_cents, amount_cents, revenue_account_id)
    VALUES (v_invoice_id, v_n, left(coalesce(v_line ->> 'description', 'Item'), 1000), coalesce((v_line ->> 'quantity')::numeric, 1),
            coalesce((v_line ->> 'unit_price_cents')::integer, v_amount), v_amount, v_rev);
    IF v_amount > 0 THEN
      v_je_lines := v_je_lines || jsonb_build_object('account_id', v_rev, 'debit_cents', 0, 'credit_cents', v_amount, 'description', left(coalesce(v_line ->> 'description', 'Item'), 200));
    END IF;
  END LOOP;

  IF coalesce(p_tax_cents, 0) > 0 THEN
    v_je_lines := v_je_lines || jsonb_build_object('account_id', v_tax, 'debit_cents', 0, 'credit_cents', p_tax_cents, 'description', 'Sales tax');
  END IF;
  v_je_lines := jsonb_build_array(jsonb_build_object('account_id', v_ar, 'debit_cents', v_subtotal + coalesce(p_tax_cents, 0), 'credit_cents', 0, 'description', 'AR for invoice')) || v_je_lines;

  v_je := public.post_journal_entry(coalesce(p_issue_date, current_date), 'Invoice ' || v_number || ' (QuickBooks sync)', 'ar_invoice', v_invoice_id, v_je_lines);
  UPDATE ar_invoices SET journal_entry_id = v_je WHERE id = v_invoice_id;
  RETURN v_invoice_id;
END;
$$;

-- Replaces an UNPAID invoice's lines/tax/dates: voids the old journal entry and posts a new one.
CREATE OR REPLACE FUNCTION public.qbo_replace_ar_invoice(
  p_owner uuid,
  p_invoice_id uuid,
  p_issue_date date,
  p_due_date date,
  p_tax_cents integer,
  p_lines jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv ar_invoices%ROWTYPE;
  v_line jsonb;
  v_n integer := 0;
  v_subtotal integer := 0;
  v_amount integer;
  v_ar uuid;
  v_tax uuid;
  v_def_rev uuid;
  v_rev uuid;
  v_je_lines jsonb := '[]'::jsonb;
  v_je uuid;
BEGIN
  PERFORM public.qbo_assume_owner(p_owner);
  SELECT * INTO v_inv FROM ar_invoices WHERE id = p_invoice_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'Invoice is void'; END IF;
  IF v_inv.amount_paid_cents > 0 THEN RAISE EXCEPTION 'PAYMENTS_EXIST: invoice has payments and cannot be re-itemised'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line';
  END IF;

  SELECT id INTO v_ar FROM chart_of_accounts WHERE user_id = p_owner AND code = '1100';
  SELECT id INTO v_tax FROM chart_of_accounts WHERE user_id = p_owner AND code = '2100';
  SELECT id INTO v_def_rev FROM chart_of_accounts WHERE user_id = p_owner AND code = '4000';

  SELECT coalesce(sum((l ->> 'amount_cents')::integer), 0) INTO v_subtotal FROM jsonb_array_elements(p_lines) l;
  IF v_subtotal + coalesce(p_tax_cents, 0) <= 0 THEN RAISE EXCEPTION 'Zero-value invoices are not synced'; END IF;

  IF v_inv.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry(v_inv.journal_entry_id, 'QuickBooks sync: invoice amended');
  END IF;
  DELETE FROM ar_invoice_lines WHERE invoice_id = p_invoice_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    v_amount := (v_line ->> 'amount_cents')::integer;
    IF v_amount < 0 THEN RAISE EXCEPTION 'Negative invoice lines are not supported'; END IF;
    SELECT id INTO v_rev FROM chart_of_accounts
      WHERE id = nullif(v_line ->> 'revenue_account_id', '')::uuid AND user_id = p_owner AND is_active;
    v_rev := coalesce(v_rev, v_def_rev);
    INSERT INTO ar_invoice_lines (invoice_id, line_number, description, quantity, unit_price_cents, amount_cents, revenue_account_id)
    VALUES (p_invoice_id, v_n, left(coalesce(v_line ->> 'description', 'Item'), 1000), coalesce((v_line ->> 'quantity')::numeric, 1),
            coalesce((v_line ->> 'unit_price_cents')::integer, v_amount), v_amount, v_rev);
    IF v_amount > 0 THEN
      v_je_lines := v_je_lines || jsonb_build_object('account_id', v_rev, 'debit_cents', 0, 'credit_cents', v_amount, 'description', left(coalesce(v_line ->> 'description', 'Item'), 200));
    END IF;
  END LOOP;

  IF coalesce(p_tax_cents, 0) > 0 THEN
    v_je_lines := v_je_lines || jsonb_build_object('account_id', v_tax, 'debit_cents', 0, 'credit_cents', p_tax_cents, 'description', 'Sales tax');
  END IF;
  v_je_lines := jsonb_build_array(jsonb_build_object('account_id', v_ar, 'debit_cents', v_subtotal + coalesce(p_tax_cents, 0), 'credit_cents', 0, 'description', 'AR for invoice')) || v_je_lines;

  v_je := public.post_journal_entry(coalesce(p_issue_date, v_inv.issue_date), 'Invoice ' || v_inv.invoice_number || ' amended (QuickBooks sync)', 'ar_invoice', p_invoice_id, v_je_lines);
  UPDATE ar_invoices SET
    subtotal_cents = v_subtotal,
    tax_cents = greatest(coalesce(p_tax_cents, 0), 0),
    issue_date = coalesce(p_issue_date, issue_date),
    due_date = coalesce(p_due_date, due_date),
    journal_entry_id = v_je,
    updated_at = now()
  WHERE id = p_invoice_id;
END;
$$;

-- Voids an UNPAID invoice (reverses its journal entry).
CREATE OR REPLACE FUNCTION public.qbo_void_ar_invoice(p_owner uuid, p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv ar_invoices%ROWTYPE;
BEGIN
  PERFORM public.qbo_assume_owner(p_owner);
  SELECT * INTO v_inv FROM ar_invoices WHERE id = p_invoice_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RETURN; END IF;
  IF v_inv.amount_paid_cents > 0 THEN RAISE EXCEPTION 'PAYMENTS_EXIST: invoice has payments and cannot be voided'; END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry(v_inv.journal_entry_id, 'QuickBooks sync: invoice voided');
  END IF;
  UPDATE ar_invoices SET status = 'void', updated_at = now() WHERE id = p_invoice_id;
END;
$$;

-- Records a payment on its QuickBooks transaction date. Same rules as record_ar_payment().
CREATE OR REPLACE FUNCTION public.qbo_record_ar_payment(
  p_owner uuid,
  p_invoice_id uuid,
  p_amount_cents integer,
  p_method text,
  p_date date,
  p_deposit_account_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_paid integer;
  v_status text;
  v_ar uuid;
  v_cash uuid;
  v_je uuid;
  v_payment_id uuid;
  v_date date := coalesce(p_date, current_date);
BEGIN
  PERFORM public.qbo_assume_owner(p_owner);
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  SELECT total_cents, amount_paid_cents, status INTO v_total, v_paid, v_status
    FROM ar_invoices WHERE id = p_invoice_id AND user_id = p_owner FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_status = 'void' THEN RAISE EXCEPTION 'Invoice is void'; END IF;
  IF v_paid + p_amount_cents > v_total THEN
    RAISE EXCEPTION 'Payment of % would exceed invoice balance of %', p_amount_cents, v_total - v_paid;
  END IF;

  SELECT id INTO v_ar FROM chart_of_accounts WHERE user_id = p_owner AND code = '1100';
  SELECT id INTO v_cash FROM chart_of_accounts
    WHERE id = p_deposit_account_id AND user_id = p_owner AND is_active AND type = 'asset';
  v_cash := coalesce(v_cash, (SELECT id FROM chart_of_accounts WHERE user_id = p_owner AND code = '1000'));

  v_je := public.post_journal_entry(v_date, 'Payment for invoice ' || p_invoice_id::text || ' (QuickBooks sync)', 'ar_payment', p_invoice_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_cash, 'debit_cents', p_amount_cents, 'credit_cents', 0, 'description', 'Customer payment'),
      jsonb_build_object('account_id', v_ar, 'debit_cents', 0, 'credit_cents', p_amount_cents, 'description', 'Applied to AR')));

  INSERT INTO ar_payments (user_id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, journal_entry_id)
  VALUES (p_owner, p_invoice_id, p_amount_cents, v_date,
          CASE WHEN p_method IN ('card', 'ach', 'check', 'cash', 'other') THEN p_method ELSE 'other' END, v_cash, v_je)
  RETURNING id INTO v_payment_id;

  UPDATE ar_invoices SET
    amount_paid_cents = amount_paid_cents + p_amount_cents,
    status = CASE WHEN amount_paid_cents + p_amount_cents >= v_total THEN 'paid' ELSE 'partially_paid' END,
    updated_at = now()
  WHERE id = p_invoice_id;
  RETURN v_payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.qbo_assume_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_void_ar_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_record_ar_payment(uuid, uuid, integer, text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_assume_owner(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_void_ar_invoice(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_record_ar_payment(uuid, uuid, integer, text, date, uuid) TO service_role;

-- ## Scheduled sync (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.
--
--   select cron.schedule('qbo-sync-every-15-min', '*/15 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/qbo-sync-run',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $$);
