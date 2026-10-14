/*
# CRM Sync (Salesforce, Pipedrive, Zoho CRM)

## What this migration does
Backend for two-way sync of contacts, leads and deals, plus the field-mapping
settings, conflict handling and sync log shown on /dashboard/crm-sync.

- `crm_connections`         one row per account + provider (status, settings, cursors)
- `crm_connection_secrets`  OAuth tokens, ENCRYPTED, service-role only
- `crm_record_links`        Vireek record <-> CRM record, with the last-synced base snapshot
- `crm_sync_runs`           one row per sync run (live progress + counters)
- `crm_sync_log`            per-record events (created / updated / conflict / error)
- `crm_deals`               Vireek-side home for synced deals / opportunities
- `has_account_permission(key)` + `can_manage_crm()` permission helpers
- `updated_at` on leads/customers/crm_deals with a touch trigger (change detection)

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id
   (`get_account_owner_id()`), the same convention as the rest of the app.
2. Tokens NEVER touch an RLS-readable table. They live in `crm_connection_secrets`
   (RLS on, zero policies, privileges revoked) and are AES-GCM encrypted by the edge
   function with CRM_TOKEN_ENCRYPTION_KEY. (The older `integrations` table keeps
   OAuth tokens inside a client-readable jsonb column; this feature deliberately
   does not repeat that.)
3. Clients can READ connections / runs / log / links when they hold
   `can_manage_crm()` (owner, or `can_edit_business_profile`). They can NEVER write
   them: connect, settings, sync, disconnect and conflict resolution all go through
   edge functions that re-check the permission and validate input.
4. `crm_deals` is an ordinary account table (members read/write via RLS).
*/

-- =============================================================
-- 1. PERMISSION HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.has_account_permission(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- Not a team member -> the account owner (has a profile row).
    WHEN NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid())
      THEN EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    -- Team member: a custom role that defines the flag wins, else the member's own flags.
    ELSE COALESCE((
      SELECT CASE
        WHEN cr.permissions ? p_key THEN (cr.permissions ->> p_key) = 'true'
        ELSE COALESCE((tm.permissions ->> p_key) = 'true', false)
      END
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false)
  END;
$$;
GRANT EXECUTE ON FUNCTION public.has_account_permission(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_crm()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.has_account_permission('can_edit_business_profile'); $$;
GRANT EXECUTE ON FUNCTION public.can_manage_crm() TO authenticated;

-- =============================================================
-- 2. updated_at (change detection for the Vireek -> CRM direction)
-- =============================================================

CREATE OR REPLACE FUNCTION public.crm_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.leads     ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_crm_touch_customers ON public.customers;
CREATE TRIGGER trg_crm_touch_customers BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_crm_touch_leads ON public.leads;
CREATE TRIGGER trg_crm_touch_leads BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_customers_user_updated ON public.customers (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_leads_user_updated     ON public.leads (user_id, updated_at, id);

-- =============================================================
-- 3. DEALS (Vireek-side mirror of CRM deals / opportunities)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  amount numeric(14, 2),
  currency text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  stage text,
  close_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_user_updated ON public.crm_deals (user_id, updated_at, id);

DROP TRIGGER IF EXISTS trg_crm_touch_deals ON public.crm_deals;
CREATE TRIGGER trg_crm_touch_deals BEFORE UPDATE ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.crm_deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_deals_select" ON public.crm_deals;
CREATE POLICY "crm_deals_select" ON public.crm_deals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "crm_deals_insert" ON public.crm_deals;
CREATE POLICY "crm_deals_insert" ON public.crm_deals FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "crm_deals_update" ON public.crm_deals;
CREATE POLICY "crm_deals_update" ON public.crm_deals FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "crm_deals_delete" ON public.crm_deals;
CREATE POLICY "crm_deals_delete" ON public.crm_deals FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                            -- account owner id
  provider text NOT NULL CHECK (provider IN ('salesforce', 'pipedrive', 'zoho')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  account_label text,                               -- e.g. acme.my.salesforce.com
  api_base text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,      -- field mappings + conflict rules (validated server-side)
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,       -- per-entity pull / push watermarks
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

DROP TRIGGER IF EXISTS trg_crm_touch_connections ON public.crm_connections;
CREATE TRIGGER trg_crm_touch_connections BEFORE UPDATE ON public.crm_connections
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.crm_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "crm_connections_select" ON public.crm_connections;
CREATE POLICY "crm_connections_select" ON public.crm_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm());

-- =============================================================
-- 5. SECRETS (service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.crm_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text,
  expires_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,         -- e.g. { "auth_base": "https://accounts.zoho.eu" }
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_connection_secrets FROM anon, authenticated;
-- Intentionally no policies: only the service role (edge functions) can touch this table.

-- =============================================================
-- 6. RECORD LINKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.crm_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('contact', 'lead', 'deal')),
  vireek_id uuid NOT NULL,
  external_id text NOT NULL,
  base jsonb NOT NULL DEFAULT '{}'::jsonb,          -- normalised values both sides held after the last sync
  conflict jsonb,                                   -- open manual conflict: { fields: [...], at }
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_links_conflict
  ON public.crm_record_links (connection_id) WHERE conflict IS NOT NULL;

ALTER TABLE public.crm_record_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "crm_links_select" ON public.crm_record_links;
CREATE POLICY "crm_links_select" ON public.crm_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm());

-- =============================================================
-- 7. RUNS + LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.crm_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_runs_conn_started ON public.crm_sync_runs (connection_id, started_at DESC);

ALTER TABLE public.crm_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "crm_runs_select" ON public.crm_sync_runs;
CREATE POLICY "crm_runs_select" ON public.crm_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm());

CREATE TABLE IF NOT EXISTS public.crm_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.crm_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.crm_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('contact', 'lead', 'deal')),
  direction text NOT NULL CHECK (direction IN ('to_crm', 'from_crm', 'both', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'conflict', 'skipped', 'error')),
  vireek_id uuid,
  external_id text,
  link_id uuid,
  message text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_log_conn_created ON public.crm_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_log_conn_action  ON public.crm_sync_log (connection_id, action, created_at DESC);

ALTER TABLE public.crm_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "crm_log_select" ON public.crm_sync_log;
CREATE POLICY "crm_log_select" ON public.crm_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crm_sync_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_sync_runs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crm_connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_connections;
  END IF;
END $$;

COMMENT ON TABLE public.crm_connection_secrets IS
  'Encrypted CRM OAuth tokens. Service role only: no RLS policies and no grants for anon/authenticated.';

/*
## Scheduled sync (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  select cron.schedule('crm-sync-every-15-min', '*/15 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/crm-sync-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','cron')
    ); $$);
*/
