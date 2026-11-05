/*
  Voice resilience: provider outcomes + circuit-breaker state, degradation ladder, per-org overrides,
  fallback call accounting, carrier-forwarding wizard checks, reconcile runs, game-day runs.

  Access model: every table is RLS-enabled. Platform tables (outcomes, health, ladder, providers, reconcile,
  gameday) have NO client policies (service role only). Tenant tables expose SELECT scoped by
  get_account_owner_id(); writes go through edge functions (service role).

  Rollback: DROP the tables created here (all new; no existing table is altered except voice_webhook_events:
  ADD COLUMN next_attempt_at, which is harmless to leave).
*/

-- ---------------------------------------------------------------- providers + breaker state
CREATE TABLE IF NOT EXISTS public.voice_providers (
  provider_id text NOT NULL,
  capability  text NOT NULL CHECK (capability IN ('voice_engine','carrier','asr','tts','sms')),
  priority    integer NOT NULL DEFAULT 10,
  enabled     boolean NOT NULL DEFAULT true,
  note        text,
  PRIMARY KEY (provider_id, capability)
);
ALTER TABLE public.voice_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_providers FROM anon, authenticated;

-- Secondary entries ship DISABLED: enabling needs a vendor account + secrets (see docs/runbooks/voice-resilience.md).
INSERT INTO public.voice_providers (provider_id, capability, priority, enabled, note) VALUES
  ('vapi',   'voice_engine', 10, true,  'primary AI engine'),
  ('twilio', 'carrier',      10, true,  'primary carrier'),
  ('twilio', 'sms',          10, true,  'primary SMS'),
  ('telnyx', 'sms',          20, false, 'secondary SMS: needs Telnyx account + messaging profile + registration')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.voice_provider_outcomes (
  id          bigserial PRIMARY KEY,
  provider_id text NOT NULL,
  capability  text NOT NULL,
  ok          boolean NOT NULL,
  latency_ms  integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code  text,
  user_id     uuid,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vpo_provider_at ON public.voice_provider_outcomes (provider_id, capability, at DESC);
ALTER TABLE public.voice_provider_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_provider_outcomes FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.voice_provider_health (
  provider_id        text NOT NULL,
  capability         text NOT NULL,
  state              text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  opened_at          timestamptz,
  half_open_at       timestamptz,
  consecutive_opens  integer NOT NULL DEFAULT 0,
  score              integer NOT NULL DEFAULT 100 CHECK (score BETWEEN 0 AND 100),
  stats              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, capability)
);
ALTER TABLE public.voice_provider_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_provider_health FROM anon, authenticated;

-- Manual platform switch (staff, time-boxed).
CREATE TABLE IF NOT EXISTS public.voice_platform_switch (
  capability   text PRIMARY KEY,
  force_provider_id text NOT NULL,
  until        timestamptz NOT NULL,
  set_by       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_platform_switch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_platform_switch FROM anon, authenticated;

-- ---------------------------------------------------------------- ladder
CREATE TABLE IF NOT EXISTS public.voice_ladder_state (
  scope       text PRIMARY KEY DEFAULT 'platform',
  level       integer NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 4),
  since       timestamptz NOT NULL DEFAULT now(),
  pending     integer CHECK (pending BETWEEN 0 AND 4),
  pending_since timestamptz,
  recent      jsonb NOT NULL DEFAULT '[]'::jsonb,
  pin_level   integer CHECK (pin_level BETWEEN 0 AND 4),
  pin_until   timestamptz,
  pin_by      text,
  components  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.voice_ladder_state (scope) VALUES ('platform') ON CONFLICT DO NOTHING;
ALTER TABLE public.voice_ladder_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_ladder_state FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.voice_ladder_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL,
  from_level integer NOT NULL,
  to_level   integer NOT NULL,
  reason     text NOT NULL,
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  at         timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vle_at ON public.voice_ladder_events (at DESC);
ALTER TABLE public.voice_ladder_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_ladder_events FROM anon, authenticated;

-- ---------------------------------------------------------------- per-org settings / overrides
CREATE TABLE IF NOT EXISTS public.voice_org_resilience (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  forced_level          integer CHECK (forced_level BETWEEN 0 AND 4),
  forced_until          timestamptz,
  reduced_assistant_id  text,
  static_message        text CHECK (static_message IS NULL OR length(static_message) <= 500),
  language              text NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  forward_numbers       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(forward_numbers) <= 5),
  provider_overrides    jsonb NOT NULL DEFAULT '[]'::jsonb,
  front_door_enabled    boolean NOT NULL DEFAULT false,
  alert_sms             boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_org_resilience ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_org_resilience_select ON public.voice_org_resilience;
CREATE POLICY voice_org_resilience_select ON public.voice_org_resilience
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.voice_org_resilience FROM anon, authenticated;
GRANT SELECT ON public.voice_org_resilience TO authenticated;

-- ---------------------------------------------------------------- fallback accounting (no silent drops)
CREATE TABLE IF NOT EXISTS public.voice_fallback_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  call_sid     text NOT NULL,
  level        integer NOT NULL CHECK (level BETWEEN 0 AND 4),
  outcome      text NOT NULL DEFAULT 'entered'
               CHECK (outcome IN ('entered','voicemail','forwarded','static','emergency_forwarded','abandoned')),
  is_emergency boolean NOT NULL DEFAULT false,
  caller_phone text,
  recording_url text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_sid)
);
CREATE INDEX IF NOT EXISTS idx_vfc_user_created ON public.voice_fallback_calls (user_id, created_at DESC);
ALTER TABLE public.voice_fallback_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_fallback_calls_select ON public.voice_fallback_calls;
CREATE POLICY voice_fallback_calls_select ON public.voice_fallback_calls
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.voice_fallback_calls FROM anon, authenticated;
GRANT SELECT ON public.voice_fallback_calls TO authenticated;

-- ---------------------------------------------------------------- carrier forwarding wizard
CREATE TABLE IF NOT EXISTS public.voice_forward_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('forward_on','forward_off')),
  business_number text NOT NULL CHECK (business_number ~ '^\+[1-9][0-9]{6,14}$'),
  vireek_number   text NOT NULL CHECK (vireek_number ~ '^\+[1-9][0-9]{6,14}$'),
  probe_from      text NOT NULL CHECK (probe_from ~ '^\+[1-9][0-9]{6,14}$'),
  ring_seconds    integer NOT NULL DEFAULT 20 CHECK (ring_seconds BETWEEN 5 AND 30),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','passed','failed','answered_by_human','expired','error')),
  outbound_sid    text,
  outbound_status text,
  arrivals        jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vfchk_user ON public.voice_forward_checks (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vfchk_pending ON public.voice_forward_checks (vireek_number) WHERE status = 'pending';
ALTER TABLE public.voice_forward_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_forward_checks_select ON public.voice_forward_checks;
CREATE POLICY voice_forward_checks_select ON public.voice_forward_checks
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.voice_forward_checks FROM anon, authenticated;
GRANT SELECT ON public.voice_forward_checks TO authenticated;

-- ---------------------------------------------------------------- reconcile + game days
CREATE TABLE IF NOT EXISTS public.voice_reconcile_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   text NOT NULL,
  range_start   timestamptz NOT NULL,
  range_end     timestamptz NOT NULL,
  compared      integer NOT NULL DEFAULT 0,
  missing       integer NOT NULL DEFAULT 0,
  recovered     integer NOT NULL DEFAULT 0,
  unrecovered   integer NOT NULL DEFAULT 0,
  orphaned      integer NOT NULL DEFAULT 0,
  duration_mismatch integer NOT NULL DEFAULT 0,
  severity      text NOT NULL DEFAULT 'none' CHECK (severity IN ('none','warn','page')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_reconcile_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_reconcile_runs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.voice_gameday_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill       text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('staging','local')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  passed      boolean,
  detect_seconds   integer,
  mitigate_seconds integer,
  recover_seconds  integer,
  calls_lost  integer,
  notes       text
);
ALTER TABLE public.voice_gameday_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_gameday_runs FROM anon, authenticated;

-- Fault injection flags. Honored ONLY when the edge function env VOICE_CHAOS_ENABLED=true (never set in production).
CREATE TABLE IF NOT EXISTS public.voice_chaos_flags (
  fault      text PRIMARY KEY CHECK (fault IN ('engine_down','engine_slow','carrier_down','sms_down','tts_fail','keys_expired','db_slow','tools_down')),
  active     boolean NOT NULL DEFAULT false,
  until      timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_chaos_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_chaos_flags FROM anon, authenticated;

-- ---------------------------------------------------------------- durable retry for the webhook ledger
ALTER TABLE public.voice_webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_vwe_retry ON public.voice_webhook_events (next_attempt_at) WHERE status = 'failed';

-- ---------------------------------------------------------------- SQL helpers (service role only)
CREATE OR REPLACE FUNCTION public.voice_recent_outcomes(p_window_seconds integer DEFAULT 300)
RETURNS TABLE (provider_id text, capability text, ok boolean, latency_ms integer, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT provider_id, capability, ok, latency_ms, at
  FROM public.voice_provider_outcomes
  WHERE at > now() - make_interval(secs => LEAST(GREATEST(p_window_seconds, 10), 3600))
  ORDER BY at;
$$;
REVOKE ALL ON FUNCTION public.voice_recent_outcomes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_recent_outcomes(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.voice_purge_outcomes(p_keep_hours integer DEFAULT 48)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.voice_provider_outcomes WHERE at < now() - make_interval(hours => GREATEST(p_keep_hours, 1));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.voice_purge_outcomes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_purge_outcomes(integer) TO service_role;

/*
  SLIs (call-answer rate, completion rate) over a window, platform-wide.
  answered = engine calls with a stored row + fallback calls that reached a defined outcome.
  Time-to-first-word is NOT derivable from our tables (needs engine turn latency: see voice_call_latency p50/p95 and
  synthetic_probe_runs.answer_latency_ms), so it is reported from those sources, not invented here.
*/
CREATE OR REPLACE FUNCTION public.voice_resilience_slis(p_hours integer DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => LEAST(GREATEST(p_hours,1),720));
  v_fb_total int; v_fb_ok int; v_probe_total int; v_probe_ok int; v_ttfw numeric; v_unrecovered int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE outcome <> 'abandoned') INTO v_fb_total, v_fb_ok
  FROM public.voice_fallback_calls WHERE created_at >= v_since;
  SELECT count(*), count(*) FILTER (WHERE answered IS TRUE) INTO v_probe_total, v_probe_ok
  FROM public.synthetic_probe_runs WHERE started_at >= v_since AND status <> 'error';
  SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY answer_latency_ms) INTO v_ttfw
  FROM public.synthetic_probe_runs WHERE started_at >= v_since AND answer_latency_ms IS NOT NULL;
  SELECT COALESCE(sum(unrecovered),0) INTO v_unrecovered FROM public.voice_reconcile_runs WHERE created_at >= v_since;
  RETURN jsonb_build_object(
    'window_hours', p_hours,
    'probe_answer_rate', CASE WHEN v_probe_total > 0 THEN round(v_probe_ok::numeric / v_probe_total, 4) END,
    'probe_samples', v_probe_total,
    'time_to_first_word_p95_ms', v_ttfw,
    'fallback_calls', v_fb_total,
    'fallback_handled_rate', CASE WHEN v_fb_total > 0 THEN round(v_fb_ok::numeric / v_fb_total, 4) END,
    'unrecovered_missing_calls', v_unrecovered
  );
END $$;
REVOKE ALL ON FUNCTION public.voice_resilience_slis(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_resilience_slis(integer) TO service_role;

-- ---------------------------------------------------------------- cron (same transport as synthetic_cron_tick)
CREATE OR REPLACE FUNCTION public.voice_cron_tick(p_function text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_secret text;
BEGIN
  IF p_function NOT IN ('voice-health-tick', 'voice-reconcile') THEN
    RAISE EXCEPTION 'function % is not allowed', p_function USING ERRCODE = '22023';
  END IF;
  v_base := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF coalesce(v_base, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base || '/' || p_function,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
    body := p_body
  );
END $$;
REVOKE ALL ON FUNCTION public.voice_cron_tick(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_cron_tick(text, jsonb) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-voice-health-tick', '* * * * *', $c$select public.voice_cron_tick('voice-health-tick', '{}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-voice-reconcile', '*/15 * * * *', $c$select public.voice_cron_tick('voice-reconcile', '{"hours":6}'::jsonb)$c$);
    PERFORM cron.schedule('vireek-voice-outcomes-purge', '20 3 * * *', $c$select public.voice_purge_outcomes(48)$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: schedule voice_cron_tick(...) with your external cron (see docs/runbooks/voice-resilience.md)';
  END IF;
END $$;
