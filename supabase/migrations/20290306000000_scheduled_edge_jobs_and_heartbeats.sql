/*
  # Scheduled edge jobs, job heartbeats and a dead-man switch

  ## What this does
  1. Schedules (pg_cron) six edge functions that were deployed but never scheduled anywhere:
       c2c-sweep, webhook-outbox-worker, learning-policy-monitor, agent-readiness-cron,
       growth-weekly-digest, automation-vip-customer-tag.
     Four other functions were reviewed and deliberately NOT scheduled (see docs/governance/cron-exemptions.json
     and docs/runbooks/scheduled-jobs.md): failure-genome-refresh, compliance-evaluate,
     provider-credentials-backfill, google-redirect-feed.
  2. public.job_heartbeats: one row per scheduled job with its expected interval, the last dispatch, the last
     observed HTTP result and consecutive failures. "Success" means the edge function answered 2xx (read from
     pg_net's response table) - NOT merely that cron fired.
  3. public.job_heartbeat_alerts + public.job_heartbeat_evaluate(): every 5 minutes opens an alert for a job that
     missed its window (last success + interval + grace) or keeps failing, resolves it on recovery, and notifies
     Slack and/or PagerDuty (SEV1/SEV2 only) through pg_net.
  4. Dead-man switch: every evaluation pings an EXTERNAL URL. If pg_cron, pg_net or this database stops, the
     pings stop and the external service alerts. An in-database alert cannot report that the database is down.

  ## Secrets (never inline in cron commands)
  Cron commands only contain a job name: `select public.cron_dispatch('c2c-sweep')`. The URL and the secrets are
  resolved at RUN time by public.cron_secret_value(name): Supabase Vault first (vault.decrypted_secrets.name = name),
  then the existing `app.settings.<name>` database setting (the pattern already used by synthetic_cron_tick).
  Names to provision (values come from the matching edge-function secrets; see docs/runbooks/scheduled-jobs.md):
    edge_function_base_url            e.g. https://<ref>.supabase.co/functions/v1        (already used elsewhere)
    push_dispatch_secret              == PUSH_DISPATCH_SECRET     (already set)          -> webhook-outbox-worker
    service_role_key                  == SUPABASE_SERVICE_ROLE_KEY (already used by bank-sync) -> learning-policy-monitor
    cron_secret                       == CRON_SECRET (>= 16 chars)                       -> c2c-sweep
    agent_readiness_cron_secret       == AGENT_READINESS_CRON_SECRET                     -> agent-readiness-cron
    growth_cron_secret                == GROWTH_CRON_SECRET (>= 16 chars)                -> growth-weekly-digest
    vip_tag_cron_secret               == VIP_TAG_CRON_SECRET                             -> automation-vip-customer-tag
    job_alert_slack_webhook_url       optional, Slack incoming webhook
    job_alert_pagerduty_routing_key   optional, PagerDuty Events API v2 routing key
    job_deadman_ping_url              optional but strongly recommended, external dead-man URL
  A job whose secret is missing records the failure in job_heartbeats (last_error = 'secret_not_configured:<name>')
  and therefore alerts; it never silently does nothing.

  ## Safety
  - Idempotent: tables IF NOT EXISTS, functions OR REPLACE, registry rows upserted (runtime state is preserved),
    cron jobs unscheduled-then-scheduled by name. Safe to re-run.
  - If pg_cron or pg_net is absent the migration still succeeds: jobs are registered but not scheduled (NOTICE).
  - All new tables have RLS enabled with no policies and are revoked from anon/authenticated. Only service_role and
    SECURITY DEFINER functions touch them. Staff read through public.job_heartbeats_overview().
  - Overlap: the target functions are idempotent by design (row locks / claimed weeks / unique indexes) so no
    overlap guard is added.

  ## Rollback
    select cron.unschedule(jobname) from cron.job where jobname in (
      'vireek-c2c-sweep','vireek-webhook-outbox-worker','vireek-learning-policy-monitor',
      'vireek-agent-readiness-cron','vireek-growth-weekly-digest','vireek-automation-vip-customer-tag',
      'vireek-job-heartbeat-evaluate');
    -- then, only if the heartbeat history is no longer needed:
    drop table if exists public.job_heartbeat_alerts, public.job_heartbeats cascade;
    drop function if exists public.cron_dispatch(text), public.cron_secret_value(text),
      public.job_heartbeat_reconcile(), public.job_heartbeat_evaluate(), public.job_heartbeat_beat(text, boolean, text),
      public.job_heartbeats_overview();

  [VERIFY] on the real project: pg_net's response table name/columns (net._http_response: id, status_code,
  timed_out, error_msg, created), its response retention, and that `ALTER DATABASE ... SET app.settings.*` is
  permitted on your plan. Not executed in the authoring environment (no Postgres available).
*/

-- 1. REGISTRY + STATE ----------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_heartbeats (
  job_name                  text PRIMARY KEY CHECK (job_name ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind                      text NOT NULL DEFAULT 'edge' CHECK (kind IN ('edge', 'sql')),
  function_name             text NOT NULL CHECK (function_name ~ '^[a-z0-9_.-]{2,80}$'),
  expected_interval_seconds integer NOT NULL CHECK (expected_interval_seconds BETWEEN 30 AND 2678400),
  grace_seconds             integer NOT NULL DEFAULT 180 CHECK (grace_seconds BETWEEN 0 AND 604800),
  timeout_ms                integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 300000),
  auth_header               text CHECK (auth_header IN ('authorization', 'x-cron-secret', 'x-push-dispatch-secret', 'x-growth-cron-secret')),
  secret_name               text CHECK (secret_name ~ '^[a-z][a-z0-9_]{2,62}$'),
  severity                  text NOT NULL DEFAULT 'SEV3' CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  enabled                   boolean NOT NULL DEFAULT true,
  registered_at             timestamptz NOT NULL DEFAULT now(),
  last_dispatched_at        timestamptz,
  last_request_id           bigint,
  last_result_at            timestamptz,
  last_success_at           timestamptz,
  last_failure_at           timestamptz,
  last_status_code          integer,
  last_error                text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  consecutive_failures      integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_heartbeats_edge_needs_auth
    CHECK ((kind = 'edge') = (auth_header IS NOT NULL AND secret_name IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.job_heartbeat_alerts (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name             text NOT NULL REFERENCES public.job_heartbeats (job_name) ON DELETE CASCADE,
  severity             text NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  reason               text NOT NULL CHECK (reason IN ('missed_window', 'repeated_failures')),
  detail               text CHECK (detail IS NULL OR char_length(detail) <= 300),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  notified_open_at     timestamptz,
  notified_resolve_at  timestamptz
);

-- At most ONE open alert per job: a still-failing job never opens a second alert (no alert storms).
CREATE UNIQUE INDEX IF NOT EXISTS job_heartbeat_alerts_one_open
  ON public.job_heartbeat_alerts (job_name) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS job_heartbeat_alerts_opened_idx
  ON public.job_heartbeat_alerts (opened_at DESC);

ALTER TABLE public.job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_heartbeat_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_heartbeats, public.job_heartbeat_alerts FROM PUBLIC, anon, authenticated;

-- Registry rows. Upsert refreshes the CONFIGURATION only; run state (last_*, consecutive_failures, enabled) survives.
INSERT INTO public.job_heartbeats
  (job_name, kind, function_name, expected_interval_seconds, grace_seconds, timeout_ms, auth_header, secret_name, severity)
VALUES
  -- every 5 min; completed job -> draft invoice (flag-gated per tenant inside the function)
  ('c2c-sweep',                    'edge', 'c2c-sweep',                    300,    300,   30000, 'x-cron-secret',          'cron_secret',                 'SEV2'),
  -- every minute; customer webhook delivery queue (dead-letter after retries)
  ('webhook-outbox-worker',        'edge', 'webhook-outbox-worker',        60,     180,   30000, 'x-push-dispatch-secret', 'push_dispatch_secret',        'SEV2'),
  -- daily 02:35 UTC; auto-apply low-risk learning changes AND auto-rollback of degraded ones
  ('learning-policy-monitor',      'edge', 'learning-policy-monitor',      86400,  7200, 120000, 'authorization',          'service_role_key',            'SEV3'),
  -- daily 05:10 UTC; re-scans accounts whose last scan is older than 6 days
  ('agent-readiness-cron',         'edge', 'agent-readiness-cron',         86400,  7200, 130000, 'x-cron-secret',          'agent_readiness_cron_secret', 'SEV3'),
  -- Mondays 07:00 UTC; at most one send per ISO week (the function claims the week first)
  ('growth-weekly-digest',         'edge', 'growth-weekly-digest',         604800, 21600, 60000, 'x-growth-cron-secret',   'growth_cron_secret',          'SEV3'),
  -- daily 03:50 UTC; set-based SQL sweep apply_vip_customer_tags()
  ('automation-vip-customer-tag',  'edge', 'automation-vip-customer-tag',  86400,  7200,  60000, 'x-cron-secret',          'vip_tag_cron_secret',         'SEV4')
ON CONFLICT (job_name) DO UPDATE SET
  kind = EXCLUDED.kind,
  function_name = EXCLUDED.function_name,
  expected_interval_seconds = EXCLUDED.expected_interval_seconds,
  grace_seconds = EXCLUDED.grace_seconds,
  timeout_ms = EXCLUDED.timeout_ms,
  auth_header = EXCLUDED.auth_header,
  secret_name = EXCLUDED.secret_name,
  severity = EXCLUDED.severity;

INSERT INTO public.job_heartbeats
  (job_name, kind, function_name, expected_interval_seconds, grace_seconds, severity)
VALUES
  ('job-heartbeat-evaluate', 'sql', 'public.job_heartbeat_evaluate', 300, 600, 'SEV2')
ON CONFLICT (job_name) DO UPDATE SET
  kind = EXCLUDED.kind,
  function_name = EXCLUDED.function_name,
  expected_interval_seconds = EXCLUDED.expected_interval_seconds,
  grace_seconds = EXCLUDED.grace_seconds,
  severity = EXCLUDED.severity;

-- 2. SECRET RESOLUTION ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cron_secret_value(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v text;
BEGIN
  IF p_name IS NULL OR p_name !~ '^[a-z][a-z0-9_]{2,62}$' THEN
    RAISE EXCEPTION 'invalid secret name' USING ERRCODE = '22023';
  END IF;

  -- 1) Supabase Vault, when the project has it (the name is bound as a parameter, never concatenated).
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    EXECUTE 'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 ORDER BY created_at DESC LIMIT 1'
      INTO v USING p_name;
  END IF;

  -- 2) Existing project pattern: ALTER DATABASE postgres SET app.settings.<name> = '...'
  IF coalesce(v, '') = '' THEN
    v := current_setting('app.settings.' || p_name, true);
  END IF;

  RETURN nullif(v, '');
END;
$$;
REVOKE ALL ON FUNCTION public.cron_secret_value(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_secret_value(text) TO service_role;

-- 3. DISPATCH (what pg_cron runs) ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cron_dispatch(p_job text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  j        public.job_heartbeats%ROWTYPE;
  v_base   text;
  v_secret text;
  v_req    bigint;
  v_err    text;
BEGIN
  SELECT * INTO j FROM public.job_heartbeats WHERE job_name = p_job AND kind = 'edge';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown edge job: %', p_job USING ERRCODE = '22023';
  END IF;
  IF NOT j.enabled THEN
    RETURN NULL;
  END IF;

  v_base   := rtrim(coalesce(public.cron_secret_value('edge_function_base_url'), public.cron_secret_value('functions_url'), ''), '/');
  v_secret := public.cron_secret_value(j.secret_name);

  IF v_base = '' THEN
    v_err := 'edge_function_base_url_not_configured';
  ELSIF v_secret IS NULL THEN
    v_err := 'secret_not_configured:' || j.secret_name;
  ELSIF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    v_err := 'pg_net_unavailable';
  END IF;

  IF v_err IS NOT NULL THEN
    UPDATE public.job_heartbeats
       SET last_dispatched_at = now(), last_request_id = NULL, last_result_at = now(), last_failure_at = now(),
           last_status_code = NULL, last_error = v_err, consecutive_failures = consecutive_failures + 1, updated_at = now()
     WHERE job_name = p_job;
    RETURN NULL;
  END IF;

  v_req := net.http_post(
    url := v_base || '/' || j.function_name,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      j.auth_header, CASE WHEN j.auth_header = 'authorization' THEN 'Bearer ' || v_secret ELSE v_secret END
    ),
    timeout_milliseconds := j.timeout_ms
  );

  UPDATE public.job_heartbeats
     SET last_dispatched_at = now(), last_request_id = v_req, updated_at = now()
   WHERE job_name = p_job;
  RETURN v_req;
END;
$$;
REVOKE ALL ON FUNCTION public.cron_dispatch(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_dispatch(text) TO service_role;

-- 4. HEARTBEAT WRITERS ---------------------------------------------------------------------------------------

-- Manual / SQL-job heartbeat. Edge jobs are recorded by job_heartbeat_reconcile() from the real HTTP result.
CREATE OR REPLACE FUNCTION public.job_heartbeat_beat(p_job text, p_ok boolean DEFAULT true, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.job_heartbeats
     SET last_dispatched_at = now(), last_result_at = now(),
         last_success_at = CASE WHEN p_ok THEN now() ELSE last_success_at END,
         last_failure_at = CASE WHEN p_ok THEN last_failure_at ELSE now() END,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error, 'failed'), 300) END,
         consecutive_failures = CASE WHEN p_ok THEN 0 ELSE consecutive_failures + 1 END,
         updated_at = now()
   WHERE job_name = p_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown job: %', p_job USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.job_heartbeat_beat(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_heartbeat_beat(text, boolean, text) TO service_role;

-- Turns pg_net responses into heartbeats. Returns how many jobs got a result.
CREATE OR REPLACE FUNCTION public.job_heartbeat_reconcile()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  n integer := 0;
BEGIN
  IF to_regclass('net._http_response') IS NULL THEN
    RETURN 0;
  END IF;

  WITH resp AS (
    SELECT h.job_name, r.status_code, r.timed_out, r.error_msg,
           (r.status_code BETWEEN 200 AND 299) AS ok
      FROM public.job_heartbeats h
      JOIN net._http_response r ON r.id = h.last_request_id
     WHERE h.kind = 'edge'
       AND h.last_request_id IS NOT NULL
       AND (h.last_result_at IS NULL OR h.last_result_at < h.last_dispatched_at)
  ), upd AS (
    UPDATE public.job_heartbeats h
       SET last_result_at = now(),
           last_status_code = resp.status_code,
           last_success_at = CASE WHEN resp.ok THEN now() ELSE h.last_success_at END,
           last_failure_at = CASE WHEN resp.ok THEN h.last_failure_at ELSE now() END,
           last_error = CASE WHEN resp.ok THEN NULL
                             ELSE left(coalesce(resp.error_msg,
                                                CASE WHEN resp.timed_out THEN 'timed_out'
                                                     ELSE 'http_' || coalesce(resp.status_code::text, 'unknown') END), 300) END,
           consecutive_failures = CASE WHEN resp.ok THEN 0 ELSE h.consecutive_failures + 1 END,
           updated_at = now()
      FROM resp
     WHERE h.job_name = resp.job_name
    RETURNING 1
  )
  SELECT count(*) INTO n FROM upd;

  -- Dispatched long ago and still no response row (pg_net down, or the row was already pruned): count as a failure.
  UPDATE public.job_heartbeats h
     SET last_result_at = now(), last_failure_at = now(), last_error = 'no_response',
         consecutive_failures = h.consecutive_failures + 1, updated_at = now()
   WHERE h.kind = 'edge'
     AND h.last_request_id IS NOT NULL
     AND (h.last_result_at IS NULL OR h.last_result_at < h.last_dispatched_at)
     AND h.last_dispatched_at < now() - make_interval(secs => (h.timeout_ms / 1000.0) + 120);

  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.job_heartbeat_reconcile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_heartbeat_reconcile() TO service_role;

-- 5. EVALUATION: alerts + notifications + dead-man ping ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_heartbeat_evaluate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_opened   integer := 0;
  v_resolved integer := 0;
  v_notified integer := 0;
  v_pinged   boolean := false;
  v_have_net boolean := to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NOT NULL;
  v_slack    text;
  v_pd       text;
  v_ping     text;
  v_text     text;
  v_hdr      jsonb := jsonb_build_object('Content-Type', 'application/json');
  a          record;
  v_sent     boolean;
BEGIN
  PERFORM public.job_heartbeat_reconcile();

  -- Open an alert for every job that is overdue or failing. The partial unique index makes this idempotent.
  WITH due AS (
    SELECT h.job_name, h.severity, h.last_error,
           CASE
             WHEN now() > coalesce(h.last_success_at, h.registered_at)
                          + make_interval(secs => h.expected_interval_seconds + h.grace_seconds) THEN 'missed_window'
             WHEN h.consecutive_failures >= CASE WHEN h.expected_interval_seconds >= 3600 THEN 1 ELSE 3 END THEN 'repeated_failures'
           END AS reason
      FROM public.job_heartbeats h
     WHERE h.enabled
  ), ins AS (
    INSERT INTO public.job_heartbeat_alerts (job_name, severity, reason, detail)
    SELECT d.job_name, d.severity, d.reason, left(coalesce(d.last_error, 'no successful run recorded in the expected window'), 300)
      FROM due d
     WHERE d.reason IS NOT NULL
    ON CONFLICT (job_name) WHERE resolved_at IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_opened FROM ins;

  -- Resolve alerts whose job is healthy again (or was disabled on purpose).
  WITH healthy AS (
    SELECT h.job_name
      FROM public.job_heartbeats h
     WHERE NOT h.enabled
        OR (now() <= coalesce(h.last_success_at, h.registered_at) + make_interval(secs => h.expected_interval_seconds + h.grace_seconds)
            AND h.consecutive_failures < CASE WHEN h.expected_interval_seconds >= 3600 THEN 1 ELSE 3 END)
  ), res AS (
    UPDATE public.job_heartbeat_alerts al
       SET resolved_at = now()
      FROM healthy
     WHERE al.job_name = healthy.job_name AND al.resolved_at IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM res;

  -- Notify. Fire-and-forget through pg_net; a failure for one alert never blocks the others or the dead-man ping.
  IF v_have_net THEN
    v_slack := public.cron_secret_value('job_alert_slack_webhook_url');
    v_pd    := public.cron_secret_value('job_alert_pagerduty_routing_key');

    FOR a IN
      SELECT al.id, al.job_name, al.severity, al.reason, al.detail, al.resolved_at, h.last_success_at
        FROM public.job_heartbeat_alerts al
        JOIN public.job_heartbeats h ON h.job_name = al.job_name
       WHERE (al.resolved_at IS NULL AND al.notified_open_at IS NULL)
          OR (al.resolved_at IS NOT NULL AND al.notified_open_at IS NOT NULL AND al.notified_resolve_at IS NULL)
       ORDER BY al.id
    LOOP
      BEGIN
        v_sent := false;
        v_text := CASE WHEN a.resolved_at IS NULL
                       THEN format('[%s] ALERT: scheduled job "%s" %s. Last success: %s. Detail: %s',
                                   a.severity, a.job_name,
                                   CASE a.reason WHEN 'missed_window' THEN 'missed its window' ELSE 'is failing' END,
                                   coalesce(to_char(a.last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), 'never'),
                                   coalesce(a.detail, '-'))
                       ELSE format('[%s] RESOLVED: scheduled job "%s" is healthy again.', a.severity, a.job_name)
                  END;

        IF coalesce(v_slack, '') <> '' THEN
          PERFORM net.http_post(url := v_slack, body := jsonb_build_object('text', v_text), headers := v_hdr, timeout_milliseconds := 10000);
          v_sent := true;
        END IF;

        IF coalesce(v_pd, '') <> '' AND a.severity IN ('SEV1', 'SEV2') THEN
          PERFORM net.http_post(
            url := 'https://events.pagerduty.com/v2/enqueue',
            body := jsonb_build_object(
              'routing_key', v_pd,
              'event_action', CASE WHEN a.resolved_at IS NULL THEN 'trigger' ELSE 'resolve' END,
              'dedup_key', 'vireek-job:' || a.job_name,
              'payload', jsonb_build_object(
                'summary', left(v_text, 1000),
                'source', 'vireek-pg_cron',
                'severity', CASE a.severity WHEN 'SEV1' THEN 'critical' ELSE 'error' END,
                'component', a.job_name)),
            headers := v_hdr, timeout_milliseconds := 10000);
          v_sent := true;
        END IF;

        IF v_sent THEN
          UPDATE public.job_heartbeat_alerts
             SET notified_open_at = CASE WHEN a.resolved_at IS NULL THEN now() ELSE notified_open_at END,
                 notified_resolve_at = CASE WHEN a.resolved_at IS NOT NULL THEN now() ELSE notified_resolve_at END
           WHERE id = a.id;
          v_notified := v_notified + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'job heartbeat notification failed for alert %: %', a.id, SQLERRM;
      END;
    END LOOP;

    -- Dead-man switch: an external service alerts when these pings STOP.
    v_ping := public.cron_secret_value('job_deadman_ping_url');
    IF coalesce(v_ping, '') <> '' THEN
      BEGIN
        PERFORM net.http_post(url := v_ping, body := '{}'::jsonb, headers := v_hdr, timeout_milliseconds := 10000);
        v_pinged := true;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'dead-man ping failed: %', SQLERRM;
      END;
    END IF;
  END IF;

  PERFORM public.job_heartbeat_beat('job-heartbeat-evaluate');

  RETURN jsonb_build_object('opened', v_opened, 'resolved', v_resolved, 'notified', v_notified, 'deadman_ping_sent', v_pinged);
END;
$$;
REVOKE ALL ON FUNCTION public.job_heartbeat_evaluate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_heartbeat_evaluate() TO service_role;

-- 6. STAFF READ ACCESS ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_heartbeats_overview()
RETURNS TABLE (
  job_name text, kind text, function_name text, enabled boolean, status text, severity text,
  expected_interval_seconds integer, due_at timestamptz, last_success_at timestamptz, last_failure_at timestamptz,
  last_status_code integer, last_error text, consecutive_failures integer, open_alert boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_vireek_staff(auth.uid()), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT h.job_name, h.kind, h.function_name, h.enabled,
         CASE
           WHEN NOT h.enabled THEN 'disabled'
           WHEN now() > coalesce(h.last_success_at, h.registered_at) + make_interval(secs => h.expected_interval_seconds + h.grace_seconds) THEN 'late'
           WHEN h.consecutive_failures > 0 THEN 'failing'
           WHEN h.last_success_at IS NULL THEN 'never_run'
           ELSE 'healthy'
         END,
         h.severity, h.expected_interval_seconds,
         coalesce(h.last_success_at, h.registered_at) + make_interval(secs => h.expected_interval_seconds + h.grace_seconds),
         h.last_success_at, h.last_failure_at, h.last_status_code, h.last_error, h.consecutive_failures,
         EXISTS (SELECT 1 FROM public.job_heartbeat_alerts al WHERE al.job_name = h.job_name AND al.resolved_at IS NULL)
    FROM public.job_heartbeats h
   ORDER BY h.job_name;
END;
$$;
REVOKE ALL ON FUNCTION public.job_heartbeats_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_heartbeats_overview() TO authenticated;

-- 7. SCHEDULES -----------------------------------------------------------------------------------------------
-- Names are `vireek-<job_name>`; every command contains only the job name (no URL, no secret).
-- Skipped with a NOTICE when pg_cron / pg_net are absent so the migration still replays everywhere.

CREATE OR REPLACE FUNCTION pg_temp.vireek_schedule(p_name text, p_schedule text, p_cmd text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_name) THEN
    PERFORM cron.unschedule(p_name);
  END IF;
  PERFORM cron.schedule(p_name, p_schedule, p_cmd);
END;
$$;

DO $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')) THEN
    RAISE NOTICE 'pg_cron and/or pg_net not installed: jobs are registered in job_heartbeats but NOT scheduled. See docs/runbooks/scheduled-jobs.md';
    RETURN;
  END IF;

  PERFORM pg_temp.vireek_schedule('vireek-c2c-sweep',                   '*/5 * * * *', $c$select public.cron_dispatch('c2c-sweep')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-webhook-outbox-worker',       '* * * * *',   $c$select public.cron_dispatch('webhook-outbox-worker')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-learning-policy-monitor',     '35 2 * * *',  $c$select public.cron_dispatch('learning-policy-monitor')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-agent-readiness-cron',        '10 5 * * *',  $c$select public.cron_dispatch('agent-readiness-cron')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-growth-weekly-digest',        '0 7 * * 1',   $c$select public.cron_dispatch('growth-weekly-digest')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-automation-vip-customer-tag', '50 3 * * *',  $c$select public.cron_dispatch('automation-vip-customer-tag')$c$);
  PERFORM pg_temp.vireek_schedule('vireek-job-heartbeat-evaluate',      '*/5 * * * *', $c$select public.job_heartbeat_evaluate()$c$);
END;
$$;
