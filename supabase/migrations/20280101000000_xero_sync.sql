/*
# Xero sync (OAuth 2.0)

## What this migration does
Backend for the sync of accounts, contacts, items, invoices, payments and tax rates with Xero,
including multi-currency invoices, the mapping settings, conflict handling and sync log shown on
/dashboard/xero. It follows the QuickBooks sync pattern (20271011000000_quickbooks_sync.sql).

NOT LIVE-VERIFIED against a real Xero organisation: see XERO_SYNC.md.

- `xero_connections`         one row per account owner (Xero organisation, base currency, settings, cursors)
- `xero_connection_secrets`  OAuth tokens, ENCRYPTED, service-role only
- `xero_record_links`        Vireek record <-> Xero record, with the last-synced base snapshot
                             (foreign-currency invoices keep their original currency, rate and amounts in base.__fx)
- `xero_sync_runs`           one row per sync run (live progress + counters)
- `xero_sync_log`            per-record events (created / updated / conflict / skipped / error)
- `xero_tax_rates`           read-only copy of the organisation's Xero tax rates (mapping dropdowns)
- `can_manage_xero()`        permission helper (needs can_edit_business_profile AND can_view_billing)
- service-role-only xero_* ledger functions: write invoices and payments THROUGH the existing general
  ledger rules (balanced entries, closed periods) with the Xero transaction date, always in the BASE currency

## Security model (identical to QuickBooks)
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Tokens never touch an RLS-readable table: `xero_connection_secrets` has RLS on, zero policies and
   revoked privileges; the edge functions encrypt with XERO_TOKEN_ENCRYPTION_KEY (AES-256-GCM).
3. Clients can READ connection / runs / log / links / tax rates when can_manage_xero(). They can NEVER
   write them: connect, settings, sync, disconnect and conflict resolution go through edge functions.
4. The xero_* ledger functions are executable by service_role ONLY.
5. One Xero organisation can be linked to one Vireek account at a time (partial unique index).
*/

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_xero()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_xero() TO authenticated;

-- =============================================================
-- 2. CHANGE DETECTION (Vireek -> Xero direction). Idempotent; shares indexes with the QuickBooks sync.
-- =============================================================

DROP TRIGGER IF EXISTS trg_xero_touch_price_book_items ON public.price_book_items;
CREATE TRIGGER trg_xero_touch_price_book_items BEFORE UPDATE ON public.price_book_items
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();
DROP TRIGGER IF EXISTS trg_xero_touch_chart_of_accounts ON public.chart_of_accounts;
CREATE TRIGGER trg_xero_touch_chart_of_accounts BEFORE UPDATE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();
DROP TRIGGER IF EXISTS trg_xero_touch_ar_invoices ON public.ar_invoices;
CREATE TRIGGER trg_xero_touch_ar_invoices BEFORE UPDATE ON public.ar_invoices
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_price_book_items_user_updated ON public.price_book_items (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_user_updated ON public.chart_of_accounts (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_ar_invoices_user_updated ON public.ar_invoices (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_ar_payments_user_created ON public.ar_payments (user_id, created_at, id);

-- =============================================================
-- 3. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.xero_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,                       -- account owner id: one Xero organisation per account
  tenant_id uuid NOT NULL,                            -- Xero organisation (tenant) id
  xero_connection_id uuid,                            -- Xero "connection" id, used to disconnect at Xero
  organisation_name text,
  base_currency text CHECK (base_currency IS NULL OR base_currency ~ '^[A-Z]{3}$'),
  country_code text,
  is_demo boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  refresh_token_expires_at timestamptz,               -- Xero refresh tokens expire after 60 days without use
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_xero_connections_live_tenant
  ON public.xero_connections (tenant_id) WHERE status <> 'disconnected';

DROP TRIGGER IF EXISTS trg_xero_touch_connections ON public.xero_connections;
CREATE TRIGGER trg_xero_touch_connections BEFORE UPDATE ON public.xero_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.xero_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xero_connections_select" ON public.xero_connections;
CREATE POLICY "xero_connections_select" ON public.xero_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_xero());

-- =============================================================
-- 4. SECRETS (service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.xero_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.xero_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.xero_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.

-- =============================================================
-- 5. RECORD LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.xero_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.xero_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('account', 'contact', 'item', 'invoice', 'payment')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,                          -- Xero GUID (AccountID / ContactID / ItemID / InvoiceID / PaymentID)
  remote_version text,                                -- Xero UpdatedDateUTC at the last sync (informational)
  base jsonb NOT NULL DEFAULT '{}'::jsonb,            -- normalised values both sides held after the last sync (+ __fx / __code metadata)
  conflict jsonb,                                     -- open manual conflict: { fields, sig, reason }
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),        -- idempotency: a Xero record can only ever map to one Vireek record
  UNIQUE (connection_id, entity, vireek_id)           -- ... and vice versa
);

CREATE INDEX IF NOT EXISTS idx_xero_links_conflict
  ON public.xero_record_links (connection_id) WHERE conflict IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xero_links_account_code
  ON public.xero_record_links (connection_id, (base ->> 'code')) WHERE entity = 'account';

ALTER TABLE public.xero_record_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xero_links_select" ON public.xero_record_links;
CREATE POLICY "xero_links_select" ON public.xero_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_xero());

-- =============================================================
-- 6. RUNS + LOG + TAX RATES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.xero_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.xero_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'webhook')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_xero_runs_conn_started ON public.xero_sync_runs (connection_id, started_at DESC);

ALTER TABLE public.xero_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xero_runs_select" ON public.xero_sync_runs;
CREATE POLICY "xero_runs_select" ON public.xero_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_xero());

CREATE TABLE IF NOT EXISTS public.xero_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.xero_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.xero_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('account', 'contact', 'item', 'invoice', 'payment', 'tax_rate')),
  direction text NOT NULL CHECK (direction IN ('to_xero', 'from_xero', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'voided', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  xero_correlation_id text,                           -- Xero support correlation id for failed API calls
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_xero_log_conn_created ON public.xero_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_xero_log_conn_action ON public.xero_sync_log (connection_id, action, created_at DESC);

ALTER TABLE public.xero_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xero_log_select" ON public.xero_sync_log;
CREATE POLICY "xero_log_select" ON public.xero_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_xero());

CREATE TABLE IF NOT EXISTS public.xero_tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.xero_connections (id) ON DELETE CASCADE,
  tax_type text NOT NULL CHECK (tax_type ~ '^[A-Za-z0-9_-]{1,50}$'),
  name text NOT NULL,
  effective_rate numeric(9, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE',
  report_tax_type text,
  can_apply_to_revenue boolean NOT NULL DEFAULT true,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, tax_type)
);

ALTER TABLE public.xero_tax_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xero_tax_rates_select" ON public.xero_tax_rates;
CREATE POLICY "xero_tax_rates_select" ON public.xero_tax_rates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_xero());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'xero_sync_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.xero_sync_runs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'xero_connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.xero_connections;
  END IF;
END $$;

COMMENT ON TABLE public.xero_connection_secrets IS
  'Encrypted Xero OAuth tokens. Service role only: no RLS policies and no grants for anon/authenticated.';

-- =============================================================
-- =============================================================
-- 7. LEDGER FUNCTIONS (service_role only)
--    The edge function has no user session, so these assume the owner's identity for the current
--    transaction (the same mechanism PostgREST uses) and then call the ORIGINAL general-ledger
--    functions. Balanced entries and closed periods are therefore enforced exactly as everywhere else.
-- =============================================================

CREATE OR REPLACE FUNCTION public.xero_assume_owner(p_owner uuid)
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
CREATE OR REPLACE FUNCTION public.xero_create_ar_invoice(
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
  PERFORM public.xero_assume_owner(p_owner);
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

  v_je := public.post_journal_entry(coalesce(p_issue_date, current_date), 'Invoice ' || v_number || ' (Xero sync)', 'ar_invoice', v_invoice_id, v_je_lines);
  UPDATE ar_invoices SET journal_entry_id = v_je WHERE id = v_invoice_id;
  RETURN v_invoice_id;
END;
$$;

-- Replaces an UNPAID invoice's lines/tax/dates: voids the old journal entry and posts a new one.
CREATE OR REPLACE FUNCTION public.xero_replace_ar_invoice(
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
  PERFORM public.xero_assume_owner(p_owner);
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
    PERFORM public.void_journal_entry(v_inv.journal_entry_id, 'Xero sync: invoice amended');
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

  v_je := public.post_journal_entry(coalesce(p_issue_date, v_inv.issue_date), 'Invoice ' || v_inv.invoice_number || ' amended (Xero sync)', 'ar_invoice', p_invoice_id, v_je_lines);
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
CREATE OR REPLACE FUNCTION public.xero_void_ar_invoice(p_owner uuid, p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv ar_invoices%ROWTYPE;
BEGIN
  PERFORM public.xero_assume_owner(p_owner);
  SELECT * INTO v_inv FROM ar_invoices WHERE id = p_invoice_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RETURN; END IF;
  IF v_inv.amount_paid_cents > 0 THEN RAISE EXCEPTION 'PAYMENTS_EXIST: invoice has payments and cannot be voided'; END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry(v_inv.journal_entry_id, 'Xero sync: invoice voided');
  END IF;
  UPDATE ar_invoices SET status = 'void', updated_at = now() WHERE id = p_invoice_id;
END;
$$;

-- Records a payment on its Xero transaction date. Same rules as record_ar_payment().
CREATE OR REPLACE FUNCTION public.xero_record_ar_payment(
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
  PERFORM public.xero_assume_owner(p_owner);
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

  v_je := public.post_journal_entry(v_date, 'Payment for invoice ' || p_invoice_id::text || ' (Xero sync)', 'ar_payment', p_invoice_id,
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

REVOKE ALL ON FUNCTION public.xero_assume_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xero_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xero_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xero_void_ar_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xero_record_ar_payment(uuid, uuid, integer, text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_assume_owner(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.xero_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.xero_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.xero_void_ar_invoice(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.xero_record_ar_payment(uuid, uuid, integer, text, date, uuid) TO service_role;


-- ## Scheduled sync (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.
--
--   select cron.schedule('xero-sync-every-15-min', '*/15 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/xero-sync-run',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $$);
