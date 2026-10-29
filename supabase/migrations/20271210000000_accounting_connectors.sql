/*
# Accounting connectors: Xero, Zoho Books, NetSuite (two-way sync)

Backend for the two-way sync of accounts, customers, items, invoices and payments with Xero,
Zoho Books and Oracle NetSuite, shown on /dashboard/accounting/<provider>. Same model as the
QuickBooks sync, one set of tables for all three providers (column `provider`).

- `acct_connections`        one row per account owner AND provider
- `acct_connection_secrets` OAuth / M2M tokens, ENCRYPTED, service-role only
- `acct_record_links`       Vireek record <-> provider record, with the last-synced base snapshot
- `acct_sync_runs`          one row per sync run (live progress + counters)
- `acct_sync_log`           per-record events (created / updated / conflict / skipped / error)
- `can_manage_accounting()` same permission as QuickBooks (can_edit_business_profile AND can_view_billing)

Prerequisite: the QuickBooks migration (20271011000000_quickbooks_sync.sql). Invoices and payments are
written through ITS service-role ledger functions (qbo_create_ar_invoice, qbo_replace_ar_invoice,
qbo_void_ar_invoice, qbo_record_ar_payment), which enforce balanced entries and closed periods.

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Tokens never touch an RLS-readable table: `acct_connection_secrets` has RLS on, zero policies and
   revoked privileges; the edge functions encrypt with ACCT_TOKEN_ENCRYPTION_KEY (AES-256-GCM).
3. Clients can READ connection / runs / log / links when can_manage_accounting(). They can NEVER write
   them: connect, settings, sync, disconnect and conflict resolution go through edge functions.
4. One provider organisation can be linked to one Vireek account at a time (partial unique index).
*/

DO $$
BEGIN
  IF to_regprocedure('public.qbo_create_ar_invoice(uuid,uuid,date,date,integer,jsonb,text)') IS NULL
     OR to_regprocedure('public.qbo_record_ar_payment(uuid,uuid,integer,text,date,uuid)') IS NULL THEN
    RAISE WARNING 'Accounting connectors: run the QuickBooks migration (20271011000000_quickbooks_sync.sql) first; invoice and payment sync needs its ledger functions.';
  END IF;
END $$;

-- =============================================================
-- 1. PERMISSION
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_accounting()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_accounting() TO authenticated;

-- =============================================================
-- 2. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.acct_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                              -- account owner id
  provider text NOT NULL CHECK (provider IN ('xero', 'zoho_books', 'netsuite')),
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_-]{3,64}$'),  -- Xero tenantId, Zoho organization_id, NetSuite account id
  region text CHECK (region IS NULL OR region ~ '^[a-z.]{2,10}$'),      -- Zoho data centre
  config jsonb NOT NULL DEFAULT '{}'::jsonb,          -- non-secret connection details (NetSuite client / certificate ids, Xero connection id)
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  company_name text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,        -- mapping + conflict rules (validated server-side)
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,         -- per-entity pull / push watermarks
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  refresh_token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_connections_live_tenant
  ON public.acct_connections (provider, tenant_id) WHERE status <> 'disconnected';

DROP TRIGGER IF EXISTS trg_acct_touch_connections ON public.acct_connections;
CREATE TRIGGER trg_acct_touch_connections BEFORE UPDATE ON public.acct_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.acct_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "acct_connections_select" ON public.acct_connections;
CREATE POLICY "acct_connections_select" ON public.acct_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_accounting());

-- =============================================================
-- 3. SECRETS (service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.acct_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.acct_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text,                             -- NULL for NetSuite (client credentials has no refresh token)
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acct_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acct_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.

COMMENT ON TABLE public.acct_connection_secrets IS
  'Encrypted accounting-provider tokens. Service role only: no RLS policies and no grants for anon/authenticated.';

-- =============================================================
-- 4. RECORD LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.acct_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.acct_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'item', 'invoice', 'payment')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,                          -- provider id (payments: "<paymentId>:<invoiceId>")
  sync_token text,                                    -- provider change marker at the last sync
  base jsonb NOT NULL DEFAULT '{}'::jsonb,            -- normalised values both sides held after the last sync
  conflict jsonb,                                     -- open manual conflict: { fields, sig, reason }
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);

CREATE INDEX IF NOT EXISTS idx_acct_links_conflict
  ON public.acct_record_links (connection_id) WHERE conflict IS NOT NULL;

ALTER TABLE public.acct_record_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "acct_links_select" ON public.acct_record_links;
CREATE POLICY "acct_links_select" ON public.acct_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_accounting());

-- =============================================================
-- 5. RUNS + LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.acct_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.acct_connections (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('xero', 'zoho_books', 'netsuite')),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'webhook')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_acct_runs_conn_started ON public.acct_sync_runs (connection_id, started_at DESC);

ALTER TABLE public.acct_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "acct_runs_select" ON public.acct_sync_runs;
CREATE POLICY "acct_runs_select" ON public.acct_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_accounting());

CREATE TABLE IF NOT EXISTS public.acct_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.acct_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.acct_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'item', 'invoice', 'payment')),
  direction text NOT NULL CHECK (direction IN ('to_ext', 'from_ext', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'voided', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  request_ref text,                                   -- provider correlation id for failed API calls (support)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acct_log_conn_created ON public.acct_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acct_log_conn_action ON public.acct_sync_log (connection_id, action, created_at DESC);

ALTER TABLE public.acct_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "acct_log_select" ON public.acct_sync_log;
CREATE POLICY "acct_log_select" ON public.acct_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_accounting());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'acct_sync_runs') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.acct_sync_runs;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'acct_connections') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.acct_connections;
    END IF;
  END IF;
END $$;

-- ## Scheduled sync (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.
--
--   select cron.schedule('acct-sync-every-15-min', '*/15 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/acct-sync-run',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $$);
