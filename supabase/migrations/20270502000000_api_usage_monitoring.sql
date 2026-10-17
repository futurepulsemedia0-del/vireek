/*
  # API Usage monitoring for api-v1

  Touches no existing table. Requires: profiles, api_keys, notifications.

  ## Objects
  - api_request_logs            : one row per authenticated api-v1 request (written ONLY by the edge function, service role).
  - api_usage_alert_rules      : one row per account - thresholds for alerts (defaults apply until saved).
  - api_usage_alert_events     : history of fired alerts (written by the sweep).
  - api_v1_rate_limit_ok       : service_role - per-key fixed 60 s window limiter used by api-v1 (fail-open on errors).
  - get_api_usage_summary      : per-key volume / errors / latency / rate-limit hits.
  - get_api_usage_timeseries   : zero-filled buckets (hourly up to 7 d, daily beyond), optionally for one key.
  - api_usage_breaches         : thresholds currently breached (live view for the page and input for the sweep).
  - api_usage_sweep_alerts     : service_role - records new breaches + in-app notification, with cooldown. Schedule below.
  - api_request_log_prune      : service_role - retention (default 30 days). Schedule below.

  ## Definitions
  - error        = status >= 400, excluding 429 (rate-limit hits are tracked separately).
  - error rate   = errors / requests in the window (rate-limited requests included in the denominator).
  - latency      = measured inside api-v1 (auth + query), excludes rate-limited requests.
  - rate limited = status 429 (no extra column needed).

  ## Access
  Owner only: every policy is `user_id = auth.uid()` (the owner's profile id), same sensitivity as api_keys.

  ## Scheduling (run once, after deploying api-v1; same pattern as your other cron jobs)
    select cron.schedule('api-usage-sweep', '0-59/10 * * * *', $$ select public.api_usage_sweep_alerts(); $$);
    select cron.schedule('api-request-log-prune', '17 3 * * *', $$ select public.api_request_log_prune(30); $$);
*/

-- 1) Request log (api-v1 already writes api_request_logs; created here only if missing) -----
CREATE TABLE IF NOT EXISTS api_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method text,
  path text,
  resource text,
  status integer NOT NULL,
  latency_ms integer NOT NULL DEFAULT 0,
  error text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Fail loudly (instead of creating broken functions) if the live table has a different shape.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO missing
  FROM unnest(ARRAY['api_key_id', 'user_id', 'status', 'latency_ms', 'created_at']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_request_logs' AND column_name = c
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'api_request_logs is missing required columns: %', missing;
  END IF;
END $$;

-- Superseded draft table (never written by api-v1); safe to drop.
DROP TABLE IF EXISTS api_request_log;

CREATE INDEX IF NOT EXISTS idx_arls_user_created ON api_request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arls_key_created ON api_request_logs(api_key_id, created_at DESC);

ALTER TABLE api_request_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "arls_select_own" ON api_request_logs;
CREATE POLICY "arls_select_own" ON api_request_logs FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 2) Alert rules ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_usage_alert_rules (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  window_minutes integer NOT NULL DEFAULT 60,
  min_requests integer NOT NULL DEFAULT 20,
  error_rate_pct numeric(5,2) NOT NULL DEFAULT 10,
  p95_latency_ms integer NOT NULL DEFAULT 2000,
  rate_limit_hits integer NOT NULL DEFAULT 10,
  notify_in_app boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aar_window_check CHECK (window_minutes BETWEEN 15 AND 1440),
  CONSTRAINT aar_min_check CHECK (min_requests BETWEEN 1 AND 100000),
  CONSTRAINT aar_error_check CHECK (error_rate_pct BETWEEN 1 AND 100),
  CONSTRAINT aar_latency_check CHECK (p95_latency_ms BETWEEN 100 AND 60000),
  CONSTRAINT aar_rl_check CHECK (rate_limit_hits BETWEEN 1 AND 100000)
);
ALTER TABLE api_usage_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "aar_select" ON api_usage_alert_rules;
CREATE POLICY "aar_select" ON api_usage_alert_rules FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "aar_insert" ON api_usage_alert_rules;
CREATE POLICY "aar_insert" ON api_usage_alert_rules FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "aar_update" ON api_usage_alert_rules;
CREATE POLICY "aar_update" ON api_usage_alert_rules FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.api_usage_alert_rules_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_aar_touch ON api_usage_alert_rules;
CREATE TRIGGER trg_aar_touch BEFORE UPDATE ON api_usage_alert_rules FOR EACH ROW EXECUTE FUNCTION public.api_usage_alert_rules_touch();

-- 3) Alert events --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_usage_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value numeric NOT NULL,
  threshold numeric NOT NULL,
  window_minutes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aae_kind_check CHECK (kind IN ('error_rate', 'latency', 'rate_limit'))
);
CREATE INDEX IF NOT EXISTS idx_aae_user_created ON api_usage_alert_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aae_cooldown ON api_usage_alert_events(key_id, kind, created_at DESC);
ALTER TABLE api_usage_alert_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "aae_select_own" ON api_usage_alert_events;
CREATE POLICY "aae_select_own" ON api_usage_alert_events FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 4) Rate limiter (api-v1, service role) ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_v1_rate_limit_ok(p_key_id uuid, p_limit integer DEFAULT 120)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) < greatest(coalesce(p_limit, 120), 1)
  FROM api_request_logs
  WHERE api_key_id = p_key_id AND created_at > now() - interval '60 seconds' AND status <> 429;
$$;
REVOKE ALL ON FUNCTION public.api_v1_rate_limit_ok(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v1_rate_limit_ok(uuid, integer) TO service_role;

-- 5) Read RPCs (SECURITY INVOKER: RLS applies; explicit owner guard on top) ----------------
CREATE OR REPLACE FUNCTION public.api_usage_guard(p_owner uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_owner IS NULL OR NOT (current_user IN ('postgres', 'service_role', 'supabase_admin') OR p_owner = auth.uid()) THEN
    RAISE EXCEPTION 'API_USAGE_FORBIDDEN';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.get_api_usage_summary(p_owner uuid, p_hours integer DEFAULT 24)
RETURNS TABLE (key_id uuid, requests bigint, ok bigint, client_errors bigint, server_errors bigint, rate_limited bigint, p50_ms integer, p95_ms integer, last_request_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 720);
BEGIN
  PERFORM public.api_usage_guard(p_owner);
  RETURN QUERY
  SELECT l.api_key_id,
         count(*),
         count(*) FILTER (WHERE l.status < 400),
         count(*) FILTER (WHERE l.status BETWEEN 400 AND 499 AND l.status <> 429),
         count(*) FILTER (WHERE l.status >= 500),
         count(*) FILTER (WHERE l.status = 429),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status <> 429))::integer,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status <> 429))::integer,
         max(l.created_at)
  FROM api_request_logs l
  WHERE l.user_id = p_owner AND l.created_at >= now() - make_interval(hours => v_hours)
  GROUP BY l.api_key_id;
END; $$;

CREATE OR REPLACE FUNCTION public.get_api_usage_timeseries(p_owner uuid, p_hours integer DEFAULT 24, p_key_id uuid DEFAULT NULL)
RETURNS TABLE (bucket timestamptz, requests bigint, errors bigint, rate_limited bigint, p95_ms integer)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 720);
  v_unit text := CASE WHEN least(greatest(coalesce(p_hours, 24), 1), 720) <= 168 THEN 'hour' ELSE 'day' END;
BEGIN
  PERFORM public.api_usage_guard(p_owner);
  RETURN QUERY
  WITH s AS (
    SELECT generate_series(date_trunc(v_unit, now() - make_interval(hours => v_hours)), date_trunc(v_unit, now()), ('1 ' || v_unit)::interval) AS b
  ), l AS (
    SELECT date_trunc(v_unit, r.created_at) AS b,
           count(*) AS n,
           count(*) FILTER (WHERE r.status >= 400 AND r.status <> 429) AS e,
           count(*) FILTER (WHERE r.status = 429) AS rl,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.status <> 429) AS p
    FROM api_request_logs r
    WHERE r.user_id = p_owner AND r.created_at >= now() - make_interval(hours => v_hours) AND (p_key_id IS NULL OR r.api_key_id = p_key_id)
    GROUP BY 1
  )
  SELECT s.b, coalesce(l.n, 0), coalesce(l.e, 0), coalesce(l.rl, 0), round(l.p)::integer
  FROM s LEFT JOIN l ON l.b = s.b
  ORDER BY s.b;
END; $$;

CREATE OR REPLACE FUNCTION public.api_usage_breaches(p_owner uuid)
RETURNS TABLE (key_id uuid, kind text, value numeric, threshold numeric, requests bigint, window_minutes integer)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r api_usage_alert_rules;
BEGIN
  PERFORM public.api_usage_guard(p_owner);
  SELECT * INTO r FROM api_usage_alert_rules WHERE user_id = p_owner;
  IF NOT FOUND THEN
    r.enabled := true; r.window_minutes := 60; r.min_requests := 20; r.error_rate_pct := 10; r.p95_latency_ms := 2000; r.rate_limit_hits := 10;
  END IF;
  IF NOT r.enabled THEN RETURN; END IF;

  RETURN QUERY
  WITH a AS (
    SELECT l.api_key_id AS key_id,
           count(*) AS n,
           count(*) FILTER (WHERE l.status >= 400 AND l.status <> 429) AS e,
           count(*) FILTER (WHERE l.status = 429) AS rl,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status <> 429) AS p95
    FROM api_request_logs l
    WHERE l.user_id = p_owner AND l.created_at >= now() - make_interval(mins => r.window_minutes)
    GROUP BY l.api_key_id
  )
  SELECT a.key_id, 'error_rate'::text, round(a.e * 100.0 / a.n, 1), r.error_rate_pct, a.n, r.window_minutes
    FROM a WHERE a.n >= r.min_requests AND a.e * 100.0 / a.n >= r.error_rate_pct
  UNION ALL
  SELECT a.key_id, 'latency'::text, round(a.p95)::numeric, r.p95_latency_ms::numeric, a.n, r.window_minutes
    FROM a WHERE a.n >= r.min_requests AND a.p95 >= r.p95_latency_ms
  UNION ALL
  SELECT a.key_id, 'rate_limit'::text, a.rl::numeric, r.rate_limit_hits::numeric, a.n, r.window_minutes
    FROM a WHERE a.rl >= r.rate_limit_hits;
END; $$;

REVOKE ALL ON FUNCTION public.api_usage_guard(uuid), public.get_api_usage_summary(uuid, integer), public.get_api_usage_timeseries(uuid, integer, uuid), public.api_usage_breaches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_usage_guard(uuid), public.get_api_usage_summary(uuid, integer), public.get_api_usage_timeseries(uuid, integer, uuid), public.api_usage_breaches(uuid) TO authenticated, service_role;

-- 6) Sweep + retention (service role / cron) -----------------------------------------------
CREATE OR REPLACE FUNCTION public.api_usage_sweep_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  b record;
  v_notify boolean;
  v_name text;
  v_title text;
  v_msg text;
  v_count integer := 0;
BEGIN
  FOR v_owner IN
    SELECT DISTINCT l.user_id FROM api_request_logs l
    LEFT JOIN api_usage_alert_rules r ON r.user_id = l.user_id
    WHERE l.created_at > now() - interval '24 hours' AND coalesce(r.enabled, true)
  LOOP
    SELECT coalesce((SELECT notify_in_app FROM api_usage_alert_rules WHERE user_id = v_owner), true) INTO v_notify;
    FOR b IN SELECT * FROM public.api_usage_breaches(v_owner) LOOP
      IF EXISTS (
        SELECT 1 FROM api_usage_alert_events e
        WHERE e.key_id = b.key_id AND e.kind = b.kind AND e.created_at > now() - make_interval(mins => greatest(b.window_minutes, 60))
      ) THEN CONTINUE; END IF;

      INSERT INTO api_usage_alert_events (user_id, key_id, kind, value, threshold, window_minutes)
      VALUES (v_owner, b.key_id, b.kind, b.value, b.threshold, b.window_minutes);
      v_count := v_count + 1;

      IF v_notify THEN
        SELECT name INTO v_name FROM api_keys WHERE id = b.key_id;
        v_title := CASE b.kind WHEN 'error_rate' THEN 'API error rate is high' WHEN 'latency' THEN 'API latency is high' ELSE 'API rate limit reached' END;
        v_msg := format('Key "%s": %s in the last %s min (threshold %s).', coalesce(v_name, 'unknown'),
          CASE b.kind WHEN 'error_rate' THEN b.value || '% of requests failed' WHEN 'latency' THEN 'p95 latency ' || b.value || ' ms' ELSE b.value || ' requests were rate limited' END,
          b.window_minutes,
          CASE b.kind WHEN 'error_rate' THEN b.threshold || '%' WHEN 'latency' THEN b.threshold || ' ms' ELSE b.threshold::text END);
        INSERT INTO notifications (user_id, type, title, message, action_url)
        VALUES (v_owner, 'api_usage_alert', v_title, v_msg, '/dashboard/settings/api-usage');
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.api_usage_sweep_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_usage_sweep_alerts() TO service_role;

CREATE OR REPLACE FUNCTION public.api_request_log_prune(p_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM api_request_logs WHERE created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 7));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM api_usage_alert_events WHERE created_at < now() - interval '90 days';
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.api_request_log_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_request_log_prune(integer) TO service_role;
