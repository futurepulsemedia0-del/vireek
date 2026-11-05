-- Read-only, tenant-free, PII-free views + a NOLOGIN role for BI/Grafana dashboards over voice observability.
-- Depends on 20280402000000_voice_observability.sql. Nothing here grants access to timelines, tenant ids or call ids.
-- To use: an admin sets a password and enables login manually (never commit a password):
--   ALTER ROLE grafana_voice_ro LOGIN PASSWORD '<from your secret manager>';   -- then connect Grafana via the read replica / pooler
-- Rollback: DROP VIEW public.obs_grafana_calls, public.obs_grafana_alerts; REVOKE USAGE ON SCHEMA public FROM grafana_voice_ro; DROP ROLE grafana_voice_ro;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_voice_ro') THEN
    CREATE ROLE grafana_voice_ro NOLOGIN NOINHERIT;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not create role grafana_voice_ro (insufficient privilege); create it manually and grant SELECT on the two views';
END;
$$;

CREATE OR REPLACE VIEW public.obs_grafana_calls AS
SELECT
  coalesce(t.started_at, t.created_at) AS ts,
  coalesce(t.region, 'unknown') AS region,
  coalesce(t.dial_code, 'unknown') AS dial_code,
  coalesce(t.asr_provider, 'unknown') AS asr_provider,
  coalesce(t.llm_provider, 'unknown') AS llm_provider,
  coalesce(t.tts_provider, 'unknown') AS tts_provider,
  coalesce(t.telephony_provider, 'unknown') AS telephony_provider,
  t.answered, t.completed, t.booking_attempted, t.booked,
  t.turn_ms, t.ttfw_ms, t.llm_ttfb_p95_ms, t.tts_ttfb_p95_ms, t.asr_p95_ms,
  t.asr_conf_avg, t.interruptions, t.tool_total, t.tool_failed, t.tool_retried,
  t.jitter_ms, t.packet_loss_pct, t.mos,
  cardinality(t.flags) AS flag_count
FROM public.call_traces t
WHERE NOT t.is_synthetic;

CREATE OR REPLACE VIEW public.obs_grafana_alerts AS
SELECT l.created_at AS ts, l.severity, l.channel, l.kind, l.delivered
FROM public.observability_alert_log l;

REVOKE ALL ON public.obs_grafana_calls, public.obs_grafana_alerts FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_voice_ro') THEN
    GRANT USAGE ON SCHEMA public TO grafana_voice_ro;
    GRANT SELECT ON public.obs_grafana_calls, public.obs_grafana_alerts TO grafana_voice_ro;
  END IF;
END;
$$;
