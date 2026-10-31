/*
# BI Connectors (read-only BI access, scheduled S3 / SFTP exports)

## What this migration adds
- `bi_access_tokens`   hashed, scoped, expiring, revocable READ-ONLY tokens for Power BI / Excel / Tableau
                       (OData), Airbyte / scripts (JSON, CSV). Only the SHA-256 of a token is stored.
- `bi_request_log`     one row per BI request: audit trail + per-token per-minute rate limiting
- `bi_export_targets`  scheduled file exports to S3 (or any S3-compatible store) and SFTP
- `bi_secrets`         ENCRYPTED export credentials. Service role only.
- `bi_export_state`    incremental watermark per target and dataset
- `bi_export_runs`     one row per export run (live progress, counters, error, manifest key)
- `bi_begin_request()` atomic rate limiter + audit insert (service role only)
- `bi_claim_due_exports()` scheduler claim (service role only)

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()).
2. Clients can only READ these tables, and only when they hold can_manage_data_platform().
   Every write goes through edge functions (service role) that re-check the permission.
3. Token hashes are not selectable by clients (column-level grant), credentials live in `bi_secrets`
   (RLS on, no policies, no grants) and are AES-GCM encrypted by the edge functions.
4. Reuses the Data Platform catalog, so transcripts, recordings, notes and signatures can never leave.

Requires the Data Platform migration (20271102000000_data_platform.sql).
*/

DO $$
BEGIN
  IF to_regprocedure('public.can_manage_data_platform()') IS NULL THEN
    RAISE EXCEPTION 'BI Connectors needs the Data Platform migration (20271102000000_data_platform.sql) applied first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.bi_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1. Access tokens
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bi_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                    -- account owner id
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (char_length(token_hint) BETWEEN 4 AND 24),
  datasets text[] NOT NULL CHECK (cardinality(datasets) BETWEEN 1 AND 32),
  pii_mode text NOT NULL DEFAULT 'hashed' CHECK (pii_mode IN ('hashed', 'full', 'omit')),
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_access_tokens_hash ON public.bi_access_tokens (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_access_tokens_user_name ON public.bi_access_tokens (user_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bi_access_tokens_user ON public.bi_access_tokens (user_id, created_at DESC);

ALTER TABLE public.bi_access_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_access_tokens_select" ON public.bi_access_tokens;
CREATE POLICY "bi_access_tokens_select" ON public.bi_access_tokens FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
-- Browsers may read everything EXCEPT token_hash.
REVOKE ALL ON public.bi_access_tokens FROM anon, authenticated;
GRANT SELECT (id, user_id, name, token_hint, datasets, pii_mode, rate_limit_per_minute, expires_at, status, last_used_at, created_by, created_at, revoked_at)
  ON public.bi_access_tokens TO authenticated;

-- =============================================================
-- 2. Request log (audit + rate limit)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bi_request_log (
  id bigserial PRIMARY KEY,
  token_id uuid NOT NULL REFERENCES public.bi_access_tokens (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  dataset text,
  rows integer,
  status integer
);
CREATE INDEX IF NOT EXISTS idx_bi_request_log_token_at ON public.bi_request_log (token_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_bi_request_log_user_at ON public.bi_request_log (user_id, at DESC);

ALTER TABLE public.bi_request_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_request_log_select" ON public.bi_request_log;
CREATE POLICY "bi_request_log_select" ON public.bi_request_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
REVOKE INSERT, UPDATE, DELETE ON public.bi_request_log FROM anon, authenticated;
REVOKE ALL ON public.bi_request_log FROM anon;

-- Atomic: says whether the request is within the per-minute limit and records it (audit row).
-- Returns the log row id, or NULL when the token is unknown or over its limit.
CREATE OR REPLACE FUNCTION public.bi_begin_request(p_token_id uuid, p_limit integer, p_dataset text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
  v_user uuid;
  v_id bigint;
BEGIN
  SELECT user_id INTO v_user FROM public.bi_access_tokens WHERE id = p_token_id;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_token_id::text, 0));
  SELECT count(*) INTO n FROM public.bi_request_log WHERE token_id = p_token_id AND at > now() - interval '1 minute';
  IF n >= greatest(p_limit, 1) THEN RETURN NULL; END IF;
  INSERT INTO public.bi_request_log (token_id, user_id, dataset) VALUES (p_token_id, v_user, left(coalesce(p_dataset, ''), 40)) RETURNING id INTO v_id;
  UPDATE public.bi_access_tokens SET last_used_at = now()
    WHERE id = p_token_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.bi_begin_request(uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 3. Export targets (S3 / SFTP)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bi_export_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('s3', 'sftp')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND pg_column_size(settings) <= 4096),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  auto_sync boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes IN (60, 360, 1440, 10080)),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_export_targets_user_name ON public.bi_export_targets (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_bi_export_targets_due ON public.bi_export_targets (next_run_at) WHERE auto_sync;

DROP TRIGGER IF EXISTS trg_bi_touch_export_targets ON public.bi_export_targets;
CREATE TRIGGER trg_bi_touch_export_targets BEFORE UPDATE ON public.bi_export_targets
  FOR EACH ROW EXECUTE FUNCTION public.bi_touch_updated_at();

ALTER TABLE public.bi_export_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_targets_select" ON public.bi_export_targets;
CREATE POLICY "bi_export_targets_select" ON public.bi_export_targets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
REVOKE INSERT, UPDATE, DELETE ON public.bi_export_targets FROM anon, authenticated;
REVOKE ALL ON public.bi_export_targets FROM anon;

-- =============================================================
-- 4. Secrets (service role only). Removed automatically with their target.
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bi_secrets (
  ref_id uuid PRIMARY KEY REFERENCES public.bi_export_targets (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  secret_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bi_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bi_secrets FROM anon, authenticated;
-- Intentionally no policies.

-- =============================================================
-- 5. Incremental state and runs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bi_export_state (
  target_id uuid NOT NULL REFERENCES public.bi_export_targets (id) ON DELETE CASCADE,
  dataset text NOT NULL,
  user_id uuid NOT NULL,
  watermark text,
  rows_total bigint NOT NULL DEFAULT 0,
  last_exported_at timestamptz,
  PRIMARY KEY (target_id, dataset)
);
ALTER TABLE public.bi_export_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_state_select" ON public.bi_export_state;
CREATE POLICY "bi_export_state_select" ON public.bi_export_state FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
REVOKE INSERT, UPDATE, DELETE ON public.bi_export_state FROM anon, authenticated;
REVOKE ALL ON public.bi_export_state FROM anon;

CREATE TABLE IF NOT EXISTS public.bi_export_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  target_id uuid NOT NULL REFERENCES public.bi_export_targets (id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  mode text NOT NULL CHECK (mode IN ('incremental', 'snapshot', 'full')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  manifest_key text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bi_export_runs_target_started ON public.bi_export_runs (target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bi_export_runs_user_started ON public.bi_export_runs (user_id, started_at DESC);
ALTER TABLE public.bi_export_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bi_export_runs_select" ON public.bi_export_runs;
CREATE POLICY "bi_export_runs_select" ON public.bi_export_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_data_platform());
REVOKE INSERT, UPDATE, DELETE ON public.bi_export_runs FROM anon, authenticated;
REVOKE ALL ON public.bi_export_runs FROM anon;

-- =============================================================
-- 6. Scheduler claim (service role only): due targets, locked for 10 minutes
-- =============================================================
CREATE OR REPLACE FUNCTION public.bi_claim_due_exports(p_limit integer)
RETURNS SETOF public.bi_export_targets
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.bi_export_targets t
  SET locked_until = now() + interval '10 minutes'
  WHERE t.id IN (
    SELECT id FROM public.bi_export_targets
    WHERE auto_sync AND next_run_at <= now() AND (locked_until IS NULL OR locked_until < now()) AND consecutive_failures < 8
    ORDER BY next_run_at
    LIMIT greatest(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING t.*;
$$;
REVOKE ALL ON FUNCTION public.bi_claim_due_exports(integer) FROM PUBLIC, anon, authenticated;

-- Live progress in the UI (RLS still applies to realtime events).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bi_export_runs') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.bi_export_runs;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bi_export_targets') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.bi_export_targets;
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.bi_access_tokens IS 'Read-only BI access tokens. Only the SHA-256 of a token is stored; clients cannot select token_hash.';
COMMENT ON TABLE public.bi_secrets IS 'Encrypted BI export credentials. Service role only: no RLS policies and no grants for anon/authenticated.';
COMMENT ON TABLE public.bi_request_log IS 'Audit trail and rate-limit ledger for the BI gateway. Pruned after 30 days by bi-export-run (cron).';

/*
## Scheduling (Supabase SQL editor; pg_cron + pg_net enabled). Replace the placeholders.

  select cron.schedule('bi-export-tick', '*/15 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/bi-export-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','cron')
    ); $$);
*/
