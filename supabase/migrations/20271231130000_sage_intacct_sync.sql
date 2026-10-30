/*
# Sage Intacct two-way sync  (NOT LIVE-VERIFIED: mock-tested only)

Backend for syncing customers, invoices, payments and GL accounts with Sage Intacct, with mapping
settings, conflict handling and a sync log shown on /dashboard/sage-intacct.

- `intacct_connections`         one row per account owner (company, optional entity, settings, cursors)
- `intacct_connection_secrets`  user credentials + cached API session, ENCRYPTED, service-role only
- `intacct_record_links`        Vireek record <-> Intacct record, with the last-synced base snapshot
- `intacct_sync_runs`           one row per sync run (live progress + counters)
- `intacct_sync_log`            per-record events (created / updated / conflict / skipped / error)
- `can_manage_intacct()`        permission helper (same rule as can_manage_quickbooks)
- `intacct_relabel_je()`        service-role helper: journal memos say "Sage Intacct sync", not "QuickBooks sync"

PREREQUISITE: the QuickBooks migration (20271011000000_quickbooks_sync.sql) must already be applied. This
migration reuses its helpers (crm_touch_updated_at, get_account_owner_id, has_account_permission) and the
edge function reuses its service-role ledger functions (qbo_create_ar_invoice, qbo_replace_ar_invoice,
qbo_void_ar_invoice, qbo_record_ar_payment) so invoices and payments go through the same balanced,
period-locked general-ledger rules. This file creates NEW objects only and is safe to re-run.

Security model (same as QuickBooks):
1. Every row carries user_id = ACCOUNT OWNER id.
2. Credentials never touch an RLS-readable table: RLS on, zero policies, privileges revoked; the edge
   functions encrypt with INTACCT_ENCRYPTION_KEY (AES-256-GCM).
3. Clients can READ connection / runs / log / links when can_manage_intacct(). They never write them.
4. One Intacct company (+ entity) can be linked to one Vireek account at a time.
*/

-- ---------------------------------------------------------------
-- 0. SHARED TRIGGER FUNCTION (identical to the one the CRM / QuickBooks migrations create)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------
-- 1. PERMISSION (plpgsql: body is resolved at call time, so this never fails to create)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_intacct()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
END;
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_intacct() TO authenticated;

-- ---------------------------------------------------------------
-- 2. CONNECTIONS
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intacct_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  company_id text NOT NULL CHECK (company_id ~ '^[A-Za-z0-9_.-]{1,40}$'),
  entity_id text CHECK (entity_id IS NULL OR entity_id ~ '^[A-Za-z0-9_.-]{1,40}$'),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  company_name text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_intacct_connections_live_company
  ON public.intacct_connections (company_id, (coalesce(entity_id, ''))) WHERE status <> 'disconnected';

DROP TRIGGER IF EXISTS trg_intacct_touch_connections ON public.intacct_connections;
CREATE TRIGGER trg_intacct_touch_connections BEFORE UPDATE ON public.intacct_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

-- ---------------------------------------------------------------
-- 3. SECRETS (service role only)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intacct_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.intacct_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  credentials_enc text NOT NULL,          -- AES-GCM({userId, password})
  session_enc text,                       -- AES-GCM(session id), cached between runs
  session_endpoint text,
  session_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.intacct_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intacct_connection_secrets FROM anon, authenticated;
COMMENT ON TABLE public.intacct_connection_secrets IS
  'Encrypted Sage Intacct credentials. Service role only: no RLS policies and no grants for anon/authenticated.';

-- ---------------------------------------------------------------
-- 4. RECORD LINKS
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intacct_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.intacct_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'invoice', 'payment')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,              -- Intacct RECORDNO (payments: "<paymentNo>:<invoiceNo>")
  base jsonb NOT NULL DEFAULT '{}'::jsonb,
  conflict jsonb,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);
CREATE INDEX IF NOT EXISTS idx_intacct_links_conflict
  ON public.intacct_record_links (connection_id) WHERE conflict IS NOT NULL;

-- ---------------------------------------------------------------
-- 5. RUNS + LOG
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intacct_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.intacct_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_intacct_runs_conn_started ON public.intacct_sync_runs (connection_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.intacct_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.intacct_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.intacct_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('account', 'customer', 'invoice', 'payment')),
  direction text NOT NULL CHECK (direction IN ('to_intacct', 'from_intacct', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'voided', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  request_id text,                        -- control id of the failing Intacct request, for support
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intacct_log_conn_created ON public.intacct_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intacct_log_conn_action ON public.intacct_sync_log (connection_id, action, created_at DESC);

-- ---------------------------------------------------------------
-- 6. RLS (read-only for people who can manage Intacct). Guarded so a missing helper can never abort the migration.
-- ---------------------------------------------------------------
ALTER TABLE public.intacct_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intacct_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intacct_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intacct_sync_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intacct_connections', 'intacct_record_links', 'intacct_sync_runs', 'intacct_sync_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_intacct())',
        t || '_select', t);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'Skipped policy on %: get_account_owner_id() is missing. Apply the QuickBooks migration first, then re-run this file.', t;
    END;
  END LOOP;
END $$;

-- Live progress in the UI.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'intacct_sync_runs') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.intacct_sync_runs;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'intacct_connections') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.intacct_connections;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------
-- 7. JOURNAL MEMO RELABEL (service role only). The reused qbo_* ledger functions write
--    "(QuickBooks sync)" into journal memos; for Intacct-sourced documents this makes them read
--    "(Sage Intacct sync)". Best effort: any failure is swallowed so a ledger write is never affected.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intacct_relabel_je(p_owner uuid, p_source_type text, p_source_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE journal_entries
     SET memo = replace(memo, '(QuickBooks sync)', '(Sage Intacct sync)')
   WHERE user_id = p_owner
     AND source_type = p_source_type
     AND source_id = p_source_id
     AND memo LIKE '%(QuickBooks sync)%';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'intacct_relabel_je skipped: %', SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION public.intacct_relabel_je(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intacct_relabel_je(uuid, text, uuid) TO service_role;

-- ## Scheduled sync (run once in the Supabase SQL editor; needs pg_cron + pg_net). Replace the placeholders.
--
--   select cron.schedule('intacct-sync-every-15-min', '*/15 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/intacct-sync-run',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','cron')
--     ); $$);
