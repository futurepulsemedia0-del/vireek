/*
  # Connector health + circuit breaker (kernel layer, connector-agnostic)

  One row per (tenant, connector, connection). Connectors report each run through
  connector_record_result(); the scheduler may ask connector_breaker_open() to skip a connection that
  keeps failing; the UI reads list_connector_health(). Additive; existing connectors are untouched
  until they call the RPC (QuickBooks hook in qbo-sync-run).
  Rollback: DROP FUNCTION list_connector_health, connector_breaker_open, connector_record_result; DROP TABLE connector_sync_state;
*/
CREATE TABLE IF NOT EXISTS connector_sync_state (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector text NOT NULL CHECK (connector ~ '^[a-z0-9_]{2,40}$'),
  connection_id text NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 80),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_status text CHECK (last_status IN ('success', 'partial', 'failed')),
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  breaker_open_until timestamptz,
  drift_rate numeric(6,5) NOT NULL DEFAULT 0 CHECK (drift_rate >= 0 AND drift_rate <= 1),
  drift_checked_at timestamptz,
  expected_every_seconds integer NOT NULL DEFAULT 900 CHECK (expected_every_seconds BETWEEN 30 AND 604800),
  last_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, connector, connection_id)
);
ALTER TABLE connector_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_connector_state" ON connector_sync_state;
CREATE POLICY "select_own_connector_state" ON connector_sync_state FOR SELECT TO authenticated
  USING (user_id = (select public.get_account_owner_id()));

CREATE OR REPLACE FUNCTION public.connector_record_result(
  p_user_id uuid, p_connector text, p_connection_id text, p_status text, p_error text,
  p_stats jsonb DEFAULT '{}'::jsonb, p_drift_rate numeric DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('success', 'partial', 'failed') THEN RAISE EXCEPTION 'bad status'; END IF;
  INSERT INTO connector_sync_state AS s (user_id, connector, connection_id, last_run_at, last_success_at, last_status, last_error,
                                         consecutive_failures, last_stats, drift_rate, drift_checked_at)
  VALUES (p_user_id, p_connector, p_connection_id, now(),
          CASE WHEN p_status <> 'failed' THEN now() END, p_status, left(p_error, 400),
          CASE WHEN p_status = 'failed' THEN 1 ELSE 0 END, coalesce(p_stats, '{}'::jsonb),
          coalesce(p_drift_rate, 0), CASE WHEN p_drift_rate IS NOT NULL THEN now() END)
  ON CONFLICT (user_id, connector, connection_id) DO UPDATE SET
    last_run_at = now(),
    last_success_at = CASE WHEN p_status <> 'failed' THEN now() ELSE s.last_success_at END,
    last_status = p_status,
    last_error = left(p_error, 400),
    consecutive_failures = CASE WHEN p_status = 'failed' THEN s.consecutive_failures + 1 ELSE 0 END,
    -- 5 consecutive failures open the breaker; cooldown doubles up to 6 h (15 min, 30, 60 ... )
    breaker_open_until = CASE
      WHEN p_status = 'failed' AND s.consecutive_failures + 1 >= 5
        THEN now() + make_interval(mins => least(15 * (2 ^ least(s.consecutive_failures + 1 - 5, 5))::int, 360))
      WHEN p_status <> 'failed' THEN NULL ELSE s.breaker_open_until END,
    last_stats = coalesce(p_stats, '{}'::jsonb),
    drift_rate = coalesce(p_drift_rate, s.drift_rate),
    drift_checked_at = CASE WHEN p_drift_rate IS NOT NULL THEN now() ELSE s.drift_checked_at END;
END;
$$;

CREATE OR REPLACE FUNCTION public.connector_breaker_open(p_user_id uuid, p_connector text, p_connection_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT breaker_open_until > now() FROM connector_sync_state
                    WHERE user_id = p_user_id AND connector = p_connector AND connection_id = p_connection_id), false);
$$;

CREATE OR REPLACE FUNCTION public.list_connector_health()
RETURNS TABLE (connector text, connection_id text, health text, last_success_at timestamptz, last_error text,
               consecutive_failures integer, breaker_open_until timestamptz, drift_rate numeric, last_stats jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT s.connector, s.connection_id,
    CASE
      WHEN s.last_success_at IS NULL THEN CASE WHEN s.consecutive_failures > 0 THEN 'failing' ELSE 'never_synced' END
      WHEN s.breaker_open_until > now() OR s.consecutive_failures >= 5 THEN 'failing'
      WHEN now() - s.last_success_at > make_interval(secs => s.expected_every_seconds * 3) THEN 'stale'
      WHEN s.consecutive_failures > 0 OR s.drift_rate > 0.01 THEN 'degraded'
      ELSE 'healthy'
    END,
    s.last_success_at, s.last_error, s.consecutive_failures, s.breaker_open_until, s.drift_rate, s.last_stats
  FROM connector_sync_state s
  WHERE s.user_id = public.get_account_owner_id()
  ORDER BY s.connector, s.connection_id;
$$;

REVOKE ALL ON FUNCTION public.connector_record_result(uuid, text, text, text, text, jsonb, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.connector_breaker_open(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_record_result(uuid, text, text, text, text, jsonb, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.connector_breaker_open(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.list_connector_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_connector_health() TO authenticated;
