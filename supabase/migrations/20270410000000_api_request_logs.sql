-- Per-key API request logs for the public api-v1 edge function.
--
-- Written ONLY by api-v1 (service role bypasses RLS). Authenticated users
-- get SELECT on their own account's rows and nothing else: there is
-- deliberately no INSERT/UPDATE/DELETE policy, so logs can't be forged or
-- edited from the browser. The raw API key is never logged — rows reference
-- api_keys.id only. No IP address is stored.

CREATE TABLE IF NOT EXISTS api_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (char_length(method) <= 10),
  path text NOT NULL CHECK (char_length(path) <= 300),
  resource text CHECK (resource IS NULL OR resource IN ('calls', 'leads', 'jobs')),
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_request_logs_key_created
  ON api_request_logs (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_user_created
  ON api_request_logs (user_id, created_at DESC);

ALTER TABLE api_request_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_api_request_logs" ON api_request_logs;
CREATE POLICY "select_own_api_request_logs"
ON api_request_logs FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

COMMENT ON TABLE api_request_logs IS 'One row per authenticated api-v1 request, per API key. 30-day retention. Never contains the raw key.';

-- 30-day retention.
CREATE OR REPLACE FUNCTION public.purge_api_request_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM api_request_logs WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_api_request_logs() FROM PUBLIC, anon, authenticated;

-- Nightly purge. A no-op (not an error) if pg_cron isn't enabled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-purge-api-request-logs');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-purge-api-request-logs', '15 3 * * *', 'select public.purge_api_request_logs()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
