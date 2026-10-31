/*
# NetSuite sync (SuiteTalk REST, token-based authentication)  --  NOT LIVE-VERIFIED

## What this migration does
Backend for the sync of customers, service items, invoices and payments with Oracle NetSuite, plus the
mapping settings, conflict handling and sync log shown on /dashboard/netsuite. It follows the QuickBooks
migration (20271011000000_quickbooks_sync.sql) table for table.

- `ns_connections`         one row per account owner (NetSuite account id, environment, settings, cursors)
- `ns_connection_secrets`  the four TBA credentials, ENCRYPTED as one blob, service-role only
- `ns_record_links`        Vireek record <-> NetSuite record, with the last-synced base snapshot
- `ns_sync_runs`           one row per sync run (live progress + counters)
- `ns_sync_log`            per-record events (created / updated / conflict / skipped / error)
- `can_manage_netsuite()`  permission helper (needs can_edit_business_profile AND can_view_billing)
- `ns_*` ledger functions  service-role-only; thin wrappers over the existing qbo_* ledger functions
                           (balanced entries, closed periods) that re-label the journal memo "NetSuite sync"

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Credentials never touch an RLS-readable table: `ns_connection_secrets` has RLS on, zero policies and
   revoked privileges; the edge functions encrypt with NS_TOKEN_ENCRYPTION_KEY (AES-256-GCM).
3. Clients can READ connection / runs / log / links when can_manage_netsuite(). They can NEVER write them:
   connect, settings, sync, disconnect and conflict resolution go through edge functions that re-check the
   permission and validate input.
4. The ns_* ledger functions are executable by service_role ONLY.
5. One NetSuite account can be linked to one Vireek account at a time (partial unique index).

## Requires
The QuickBooks sync migration (it provides the qbo_* ledger functions and the updated_at triggers/indexes
this sync reuses). This file fails early with a clear message when it is missing.
*/

-- =============================================================
-- 0. PRECONDITIONS
-- =============================================================

DO $$
BEGIN
  IF to_regprocedure('public.qbo_create_ar_invoice(uuid,uuid,date,date,integer,jsonb,text)') IS NULL
     OR to_regprocedure('public.qbo_replace_ar_invoice(uuid,uuid,date,date,integer,jsonb)') IS NULL
     OR to_regprocedure('public.qbo_void_ar_invoice(uuid,uuid)') IS NULL
     OR to_regprocedure('public.qbo_record_ar_payment(uuid,uuid,integer,text,date,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NetSuite sync needs the QuickBooks sync migration (20271011000000_quickbooks_sync.sql) applied first.';
  END IF;
END $$;

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_netsuite()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_netsuite() TO authenticated;

-- =============================================================
-- 2. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ns_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,                       -- account owner id: one NetSuite account per Vireek account
  account_id text NOT NULL CHECK (account_id ~ '^[A-Z0-9]{3,24}(_(SB|RP)[0-9]{1,2})?$'),
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox', 'release_preview')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  company_name text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,        -- mapping + conflict rules (validated server-side)
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,         -- per-entity pull / push watermarks
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ns_connections_live_account
  ON public.ns_connections (account_id) WHERE status <> 'disconnected';

DROP TRIGGER IF EXISTS trg_ns_touch_connections ON public.ns_connections;
CREATE TRIGGER trg_ns_touch_connections BEFORE UPDATE ON public.ns_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.ns_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ns_connections_select" ON public.ns_connections;
CREATE POLICY "ns_connections_select" ON public.ns_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_netsuite());

-- =============================================================
-- 3. SECRETS (service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ns_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.ns_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  credentials_enc text NOT NULL,                      -- AES-GCM(JSON{consumerKey, consumerSecret, tokenId, tokenSecret})
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ns_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ns_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.

COMMENT ON TABLE public.ns_connection_secrets IS
  'Encrypted NetSuite token-based-auth credentials. Service role only: no RLS policies and no grants for anon/authenticated.';

-- =============================================================
-- 4. RECORD LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ns_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.ns_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('customer', 'item', 'invoice', 'payment')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,                          -- NetSuite internal id (payments: "<paymentId>:<invoiceId>")
  base jsonb NOT NULL DEFAULT '{}'::jsonb,            -- normalised values both sides held after the last sync
  conflict jsonb,                                     -- open manual conflict: { fields, sig, reason }
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);

CREATE INDEX IF NOT EXISTS idx_ns_links_conflict
  ON public.ns_record_links (connection_id) WHERE conflict IS NOT NULL;

ALTER TABLE public.ns_record_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ns_links_select" ON public.ns_record_links;
CREATE POLICY "ns_links_select" ON public.ns_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_netsuite());

-- =============================================================
-- 5. RUNS + LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ns_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.ns_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ns_runs_conn_started ON public.ns_sync_runs (connection_id, started_at DESC);

ALTER TABLE public.ns_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ns_runs_select" ON public.ns_sync_runs;
CREATE POLICY "ns_runs_select" ON public.ns_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_netsuite());

CREATE TABLE IF NOT EXISTS public.ns_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.ns_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.ns_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('customer', 'item', 'invoice', 'payment')),
  direction text NOT NULL CHECK (direction IN ('to_ns', 'from_ns', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'voided', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ns_log_conn_created ON public.ns_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ns_log_conn_action ON public.ns_sync_log (connection_id, action, created_at DESC);

ALTER TABLE public.ns_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ns_log_select" ON public.ns_sync_log;
CREATE POLICY "ns_log_select" ON public.ns_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_netsuite());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ns_sync_runs') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.ns_sync_runs;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ns_connections') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.ns_connections;
    END IF;
  END IF;
END $$;

-- =============================================================
-- 6. LEDGER FUNCTIONS (service_role only)
--    Thin wrappers over the qbo_* functions: they assume the owner's identity, call the ORIGINAL general-
--    ledger functions (balanced entries, closed periods) and then re-label the journal text that THIS call
--    wrote ("QuickBooks sync" -> "NetSuite sync"). Re-labelling only touches rows created / voided in the
--    current transaction and can never fail the call.
-- =============================================================

CREATE OR REPLACE FUNCTION public.ns_relabel_ledger(p_owner uuid, p_source_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE journal_entries
       SET memo = replace(memo, 'QuickBooks sync', 'NetSuite sync')
     WHERE user_id = p_owner AND source_id = p_source_id AND created_at >= now() AND memo LIKE '%QuickBooks sync%';
    UPDATE journal_entries
       SET void_reason = replace(void_reason, 'QuickBooks sync', 'NetSuite sync')
     WHERE user_id = p_owner AND source_id = p_source_id AND voided_at >= now() AND void_reason LIKE '%QuickBooks sync%';
  EXCEPTION WHEN OTHERS THEN
    NULL; -- cosmetic only
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.ns_create_ar_invoice(
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
  v_id uuid;
BEGIN
  v_id := public.qbo_create_ar_invoice(p_owner, p_customer_id, p_issue_date, p_due_date, p_tax_cents, p_lines, p_invoice_number);
  PERFORM public.ns_relabel_ledger(p_owner, v_id);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ns_replace_ar_invoice(
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
BEGIN
  PERFORM public.qbo_replace_ar_invoice(p_owner, p_invoice_id, p_issue_date, p_due_date, p_tax_cents, p_lines);
  PERFORM public.ns_relabel_ledger(p_owner, p_invoice_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ns_void_ar_invoice(p_owner uuid, p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.qbo_void_ar_invoice(p_owner, p_invoice_id);
  PERFORM public.ns_relabel_ledger(p_owner, p_invoice_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ns_record_ar_payment(
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
  v_id uuid;
BEGIN
  v_id := public.qbo_record_ar_payment(p_owner, p_invoice_id, p_amount_cents, p_method, p_date, p_deposit_account_id);
  PERFORM public.ns_relabel_ledger(p_owner, p_invoice_id);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ns_relabel_ledger(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_void_ar_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_record_ar_payment(uuid, uuid, integer, text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ns_relabel_ledger(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ns_create_ar_invoice(uuid, uuid, date, date, integer, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ns_replace_ar_invoice(uuid, uuid, date, date, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ns_void_ar_invoice(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ns_record_ar_payment(uuid, uuid, integer, text, date, uuid) TO service_role;

-- ## Scheduled sync (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.
--
--   select cron.schedule('ns-sync-every-15-min', '*/15 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/ns-sync-run',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $$);
