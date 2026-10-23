/*
# Property-management integrations (Buildium, Propertyware, Rentvine, AppFolio, Yardi)

## What this migration does
Backend for /dashboard/property-management: two-way sync of work orders with the
property manager's system, plus their units and tenant contacts, with a retry queue and a
sync log. It REUSES the commercial work orders feature (work_orders / work_order_visits):
provider work orders are written into those tables, so every rule that feature enforces in
the database (approval gate, NTE cap, billing rules) still applies to synced data.

- `pm_connections`         one row per account + provider + provider account (status, settings, cursors)
- `pm_connection_secrets`  provider credentials, ENCRYPTED (AES-GCM), service-role only
- `pm_record_links`        Vireek work order / invoice <-> provider record, with the last-synced snapshot
- `pm_units`               units read from the provider
- `pm_tenant_contacts`     tenant contacts read from the provider (personal data, see below)
- `pm_sync_runs`           one row per sync run (live progress + counters)
- `pm_sync_log`            per-record events (created / updated / pushed / dry_run / conflict / error)
- `pm_sync_queue`          outbox + retry queue for everything we write TO the provider
- `can_manage_pm_integrations()`  permission helper (owner, or can_edit_business_profile)
- triggers on work_orders / work_order_visits that enqueue pushes (never block the write)

## Requires
`has_account_permission()` (20270503000000_crm_sync) and `set_updated_at()` +
the work_orders tables (20270410000000_commercial_work_orders).

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Credentials never touch an RLS-readable table: `pm_connection_secrets` has RLS on, zero
   policies and no grants. Only the edge function (service role) reads or writes it.
3. Clients can READ everything below with `can_manage_pm_integrations()` and can NEVER write
   it. Connect, settings, sync, retry, cancel and disconnect all go through the edge
   function, which re-checks the permission and validates input.
4. Tenant contacts are personal data. They are deleted when a connection is disconnected,
   and never copied anywhere except onto the work order's own site-contact fields.
*/

-- =============================================================
-- 1. PERMISSION HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_pm_integrations()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.has_account_permission('can_edit_business_profile'); $$;
GRANT EXECUTE ON FUNCTION public.can_manage_pm_integrations() TO authenticated;

-- =============================================================
-- 2. CONNECTIONS + SECRETS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pm_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                              -- account owner id
  provider text NOT NULL CHECK (provider IN ('buildium', 'propertyware', 'rentvine', 'appfolio', 'yardi')),
  account_label text NOT NULL CHECK (char_length(account_label) BETWEEN 1 AND 120),  -- e.g. acme.rentvine.com
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  api_base text,
  customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,  -- the property manager as a Vireek customer
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,        -- mapping, status maps, push switches (validated server-side)
  cursors jsonb NOT NULL DEFAULT '{}'::jsonb,         -- per-entity watermarks / resume positions
  auto_sync boolean NOT NULL DEFAULT true,
  connected_by uuid,
  last_synced_at timestamptz,
  last_error text,
  sync_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, account_label)
);
CREATE INDEX IF NOT EXISTS idx_pm_connections_user ON public.pm_connections (user_id);

DROP TRIGGER IF EXISTS trg_touch_pm_connections ON public.pm_connections;
CREATE TRIGGER trg_touch_pm_connections BEFORE UPDATE ON public.pm_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.pm_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  credentials_enc text NOT NULL,                      -- AES-GCM(JSON of the credential fields)
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 3. LINKS, UNITS, TENANT CONTACTS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pm_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('work_order', 'invoice')),
  vireek_id uuid NOT NULL,                            -- work_orders.id, or work_order_visits.id for invoices
  external_id text NOT NULL,
  base jsonb NOT NULL DEFAULT '{}'::jsonb,            -- values both sides held after the last sync
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,            -- property / unit ids and the provider's own number
  ignored boolean NOT NULL DEFAULT false,             -- the Vireek record was deleted: stop syncing it
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity, external_id),
  UNIQUE (connection_id, entity, vireek_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_links_vireek ON public.pm_record_links (vireek_id, entity);

CREATE TABLE IF NOT EXISTS public.pm_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  external_property_id text,
  property_name text,
  unit_number text,
  address text,
  city text,
  state text,
  postal_code text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_units_conn_property ON public.pm_units (connection_id, property_name);

CREATE TABLE IF NOT EXISTS public.pm_tenant_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  external_unit_id text,
  name text,
  email text,
  phone text,
  status text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_tenants_unit ON public.pm_tenant_contacts (connection_id, external_unit_id);

-- =============================================================
-- 4. RUNS + LOG
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pm_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pm_runs_conn_started ON public.pm_sync_runs (connection_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.pm_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.pm_sync_runs (id) ON DELETE SET NULL,
  entity text NOT NULL CHECK (entity IN ('work_order', 'invoice', 'unit', 'tenant', 'queue', 'connection')),
  direction text NOT NULL CHECK (direction IN ('to_pm', 'from_pm', 'none')),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'linked', 'pushed', 'dry_run', 'skipped', 'conflict', 'retry', 'error')),
  vireek_id uuid,
  external_id text,
  message text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pm_log_conn_created ON public.pm_sync_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_log_conn_action ON public.pm_sync_log (connection_id, action, created_at DESC);

-- =============================================================
-- 5. RETRY QUEUE (outbox for everything we write to the provider)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pm_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pm_connections (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('push_status', 'push_invoice')),
  subject_id uuid NOT NULL,                           -- work_orders.id (push_status) / work_order_visits.id (push_invoice)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  last_http_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- Many changes to one record while it waits collapse into ONE pending push (the worker always sends the latest state).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_queue_pending ON public.pm_sync_queue (connection_id, kind, subject_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pm_queue_due ON public.pm_sync_queue (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pm_queue_conn_status ON public.pm_sync_queue (connection_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_touch_pm_queue ON public.pm_sync_queue;
CREATE TRIGGER trg_touch_pm_queue BEFORE UPDATE ON public.pm_sync_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 6. ENQUEUE TRIGGERS (a failure here must never block the user's write)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pm_enqueue_status_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.pm_sync_queue AS q (user_id, connection_id, kind, subject_id)
    SELECT l.user_id, l.connection_id, 'push_status', NEW.id
      FROM public.pm_record_links l
      JOIN public.pm_connections c ON c.id = l.connection_id
     WHERE l.entity = 'work_order' AND l.vireek_id = NEW.id AND NOT l.ignored
       AND c.status = 'connected'
       AND COALESCE((c.settings #>> '{push,status}')::boolean, false)
    ON CONFLICT (connection_id, kind, subject_id) WHERE status = 'pending'
    DO UPDATE SET next_attempt_at = LEAST(q.next_attempt_at, now());
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pm_enqueue_status_push failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pm_enqueue_status_push ON public.work_orders;
CREATE TRIGGER trg_pm_enqueue_status_push AFTER UPDATE OF status ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.pm_enqueue_status_push();

CREATE OR REPLACE FUNCTION public.pm_enqueue_invoice_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.billing_status = 'invoiced' AND (TG_OP = 'INSERT' OR OLD.billing_status IS DISTINCT FROM 'invoiced') THEN
    INSERT INTO public.pm_sync_queue AS q (user_id, connection_id, kind, subject_id)
    SELECT l.user_id, l.connection_id, 'push_invoice', NEW.id
      FROM public.pm_record_links l
      JOIN public.pm_connections c ON c.id = l.connection_id
     WHERE l.entity = 'work_order' AND l.vireek_id = NEW.work_order_id AND NOT l.ignored
       AND c.status = 'connected'
       AND COALESCE((c.settings #>> '{push,invoices}')::boolean, false)
    ON CONFLICT (connection_id, kind, subject_id) WHERE status = 'pending'
    DO UPDATE SET next_attempt_at = LEAST(q.next_attempt_at, now());
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pm_enqueue_invoice_push failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pm_enqueue_invoice_push ON public.work_order_visits;
CREATE TRIGGER trg_pm_enqueue_invoice_push AFTER INSERT OR UPDATE OF billing_status ON public.work_order_visits
  FOR EACH ROW EXECUTE FUNCTION public.pm_enqueue_invoice_push();

-- =============================================================
-- 7. RLS (read-only for clients; every write goes through the edge function)
-- =============================================================
ALTER TABLE public.pm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_tenant_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_sync_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pm_connection_secrets FROM anon, authenticated;
REVOKE ALL ON public.pm_connections, public.pm_record_links, public.pm_units, public.pm_tenant_contacts,
  public.pm_sync_runs, public.pm_sync_log, public.pm_sync_queue FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.pm_connections, public.pm_record_links, public.pm_units, public.pm_tenant_contacts,
  public.pm_sync_runs, public.pm_sync_log, public.pm_sync_queue FROM authenticated;

DROP POLICY IF EXISTS "pm_connections_select" ON public.pm_connections;
CREATE POLICY "pm_connections_select" ON public.pm_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_links_select" ON public.pm_record_links;
CREATE POLICY "pm_links_select" ON public.pm_record_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_units_select" ON public.pm_units;
CREATE POLICY "pm_units_select" ON public.pm_units FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_tenants_select" ON public.pm_tenant_contacts;
CREATE POLICY "pm_tenants_select" ON public.pm_tenant_contacts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_runs_select" ON public.pm_sync_runs;
CREATE POLICY "pm_runs_select" ON public.pm_sync_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_log_select" ON public.pm_sync_log;
CREATE POLICY "pm_log_select" ON public.pm_sync_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

DROP POLICY IF EXISTS "pm_queue_select" ON public.pm_sync_queue;
CREATE POLICY "pm_queue_select" ON public.pm_sync_queue FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_pm_integrations());

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_sync_runs', 'pm_connections', 'pm_sync_queue'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE public.pm_connection_secrets IS
  'Encrypted property-management credentials. Service role only: no RLS policies and no grants for anon/authenticated.';
COMMENT ON TABLE public.pm_tenant_contacts IS
  'Tenant contact details read from the property manager system (personal data). Deleted on disconnect.';

/*
## Scheduled sync + queue drain (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  select cron.schedule('pm-sync-every-5-min', '*/5 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/pm-sync-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','cron')
    ); $$);
*/
