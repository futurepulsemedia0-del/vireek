/*
# Data Platform (warehouse sync, semantic metrics, partner embeds, reverse ETL)

## What this migration adds
- `dp_destinations`   one row per connected destination (BigQuery / Snowflake / Postgres replica /
                      Google Sheets / Mailchimp / Klaviyo): config, settings, schedule, status
- `dp_secrets`        ENCRYPTED credentials and embed signing secrets. Service role only.
- `dp_sync_state`     incremental watermark + schema fingerprint per destination and dataset
- `dp_runs`           one row per sync run (live progress, counters, error)
- `metric_snapshots`  daily value of every semantic metric (computed by the metrics layer)
- `dp_embeds`         partner embeds (config only; the signing secret lives in dp_secrets)
- `dp_embed_requests` request log used for per-embed rate limiting
- `can_manage_data_platform()` permission helper (owner, or team member holding can_export_data)
- `updated_at` + touch trigger + (user_id, updated_at, id) index on the synced tables, so every
  dataset can be loaded incrementally

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Credentials never touch an RLS-readable table: `dp_secrets` has RLS on, zero policies and revoked
   privileges. Values are AES-GCM encrypted by the edge functions (DATA_PLATFORM_ENCRYPTION_KEY) and
   bound to their row.
3. Clients can READ destinations / runs / embeds when they hold can_manage_data_platform(); they can
   NEVER write them. Connecting, syncing, rotating and revoking go through edge functions that
   re-check the permission and validate every input.
4. Metric snapshots are readable by the owner or a member with can_view_billing (same rule as Reports).
*/

-- =============================================================
-- 1. Permission helper
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_data_platform()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.has_account_permission('can_export_data'); $$;
GRANT EXECUTE ON FUNCTION public.can_manage_data_platform() TO authenticated;

-- =============================================================
-- 2. Incremental-load support on the synced tables
-- =============================================================
CREATE OR REPLACE FUNCTION public.dp_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'calls', 'quotes', 'revenue_recovery_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_dp_touch_%s ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_dp_touch_%s BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.dp_touch_updated_at()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['customers', 'leads', 'calls', 'jobs', 'quotes', 'job_cost_entries', 'revenue_recovery_events'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_dp_%s_cursor ON public.%I (user_id, updated_at, id)', t, t);
  END LOOP;
END $$;

-- =============================================================
-- 3. Destinations
-- =============================================================
CREATE TABLE IF NOT EXISTS public.dp_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                   -- account owner id
  role text NOT NULL CHECK (role IN ('warehouse', 'reverse')),
  kind text NOT NULL CHECK (kind IN ('bigquery', 'snowflake', 'postgres', 'sheets', 'mailchimp', 'klaviyo')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND pg_column_size(settings) <= 4096),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  auto_sync boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 360 CHECK (interval_minutes IN (15, 60, 360, 1440)),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'warehouse' AND kind IN ('bigquery', 'snowflake', 'postgres')) OR (role = 'reverse' AND kind IN ('sheets', 'mailchimp', 'klaviyo')))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_destinations_user_name ON public.dp_destinations (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_dp_destinations_due ON public.dp_destinations (next_run_at) WHERE auto_sync;

DROP TRIGGER IF EXISTS trg_dp_touch_destinations ON public.dp_destinations;
CREATE TRIGGER trg_dp_touch_destinations BEFORE UPDATE ON public.dp_destinations
  FOR EACH ROW EXECUTE FUNCTION public.dp_touch_updated_at();

ALTER TABLE public.dp_destinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dp_destinations_select" ON public.dp_destinations;
CREATE POLICY "dp_destinations_select" ON public.dp_destinations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
-- Intentionally no insert / update / delete policies: edge functions (service role) only.

-- =============================================================
-- 4. Secrets (service role only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.dp_secrets (
  ref_id uuid PRIMARY KEY,                                  -- dp_destinations.id or dp_embeds.id
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('destination', 'embed')),
  secret_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dp_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dp_secrets FROM anon, authenticated;
-- Intentionally no policies.

-- =============================================================
-- 5. Sync state and runs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.dp_sync_state (
  destination_id uuid NOT NULL REFERENCES public.dp_destinations (id) ON DELETE CASCADE,
  dataset text NOT NULL,
  user_id uuid NOT NULL,
  watermark text,                                           -- raw updated_at string of the newest row loaded
  schema_hash text,
  rows_total bigint NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  last_full_refresh_at timestamptz,
  PRIMARY KEY (destination_id, dataset)
);
ALTER TABLE public.dp_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dp_sync_state_select" ON public.dp_sync_state;
CREATE POLICY "dp_sync_state_select" ON public.dp_sync_state FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE TABLE IF NOT EXISTS public.dp_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  destination_id uuid NOT NULL REFERENCES public.dp_destinations (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  mode text NOT NULL CHECK (mode IN ('incremental', 'full', 'reverse')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dp_runs_dest_started ON public.dp_runs (destination_id, started_at DESC);
ALTER TABLE public.dp_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dp_runs_select" ON public.dp_runs;
CREATE POLICY "dp_runs_select" ON public.dp_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

-- =============================================================
-- 6. Metric snapshots (semantic layer, one row per metric per day)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  metric_id text NOT NULL CHECK (char_length(metric_id) BETWEEN 1 AND 64),
  day date NOT NULL,
  value numeric,
  numerator numeric,
  denominator numeric,
  sample_size integer NOT NULL DEFAULT 0,
  definition_version integer NOT NULL DEFAULT 1,
  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, metric_id, day)
);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_cursor ON public.metric_snapshots (user_id, updated_at, id);
DROP TRIGGER IF EXISTS trg_dp_touch_metric_snapshots ON public.metric_snapshots;
CREATE TRIGGER trg_dp_touch_metric_snapshots BEFORE UPDATE ON public.metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.dp_touch_updated_at();

ALTER TABLE public.metric_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "metric_snapshots_select" ON public.metric_snapshots;
CREATE POLICY "metric_snapshots_select" ON public.metric_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

-- =============================================================
-- 7. Partner embeds
-- =============================================================
CREATE TABLE IF NOT EXISTS public.dp_embeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_embeds_user_name ON public.dp_embeds (user_id, lower(btrim(name)));
ALTER TABLE public.dp_embeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dp_embeds_select" ON public.dp_embeds;
CREATE POLICY "dp_embeds_select" ON public.dp_embeds FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());

CREATE TABLE IF NOT EXISTS public.dp_embed_requests (
  id bigserial PRIMARY KEY,
  embed_id uuid NOT NULL REFERENCES public.dp_embeds (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dp_embed_requests_recent ON public.dp_embed_requests (embed_id, at DESC);
ALTER TABLE public.dp_embed_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dp_embed_requests FROM anon, authenticated;

-- Atomic limiter: records the request and says whether it is within the per-minute limit.
CREATE OR REPLACE FUNCTION public.dp_embed_rate_ok(p_embed_id uuid, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_embed_id::text, 0));
  SELECT count(*) INTO n FROM dp_embed_requests WHERE embed_id = p_embed_id AND at > now() - interval '1 minute';
  IF n >= p_limit THEN RETURN false; END IF;
  INSERT INTO dp_embed_requests (embed_id) VALUES (p_embed_id);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.dp_embed_rate_ok(uuid, integer) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 8. Scheduler claim (service role only): due destinations, locked for 10 minutes
-- =============================================================
CREATE OR REPLACE FUNCTION public.dp_claim_due(p_limit integer)
RETURNS SETOF public.dp_destinations
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE dp_destinations d
  SET locked_until = now() + interval '10 minutes'
  WHERE d.id IN (
    SELECT id FROM dp_destinations
    WHERE auto_sync AND next_run_at <= now() AND (locked_until IS NULL OR locked_until < now()) AND consecutive_failures < 8
    ORDER BY next_run_at
    LIMIT greatest(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING d.*;
$$;
REVOKE ALL ON FUNCTION public.dp_claim_due(integer) FROM PUBLIC, anon, authenticated;

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'dp_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dp_runs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'dp_destinations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dp_destinations;
  END IF;
END $$;

COMMENT ON TABLE public.dp_secrets IS 'Encrypted Data Platform credentials and embed signing secrets. Service role only: no RLS policies and no grants for anon/authenticated.';
COMMENT ON TABLE public.metric_snapshots IS 'Daily value of every semantic metric, computed by supabase/functions/_shared/data-platform/metrics.ts.';

/*
## Scheduling (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  -- every 15 minutes: due warehouse syncs + reverse ETL + metric snapshots
  select cron.schedule('data-platform-tick', '*/15 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/data-platform-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','cron')
    ); $$);
*/
