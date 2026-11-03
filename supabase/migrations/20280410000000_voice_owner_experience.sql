/*
  # Voice-first owner experience: audio Morning Brief + "Call your Vireek"

  Tables (all RLS on):
    voice_preferences      per-user brief settings (owner or billing-enabled team member)
    voice_briefs           one generated brief per user/day/language/voice (script, evidence, audio path, cost)
    voice_callers          verified phone numbers + PIN hashes. SERVICE ROLE ONLY (no policies).
    voice_enroll_otps      SMS codes used to verify a phone number. SERVICE ROLE ONLY.
    voice_call_sessions    one row per inbound call (auth level, state, cost)
    voice_call_events      APPEND-ONLY audit trail of every spoken request, answer, auth step and action
    voice_pending_actions  confirm-before-act queue (read-back then spoken "yes")
    voice_rate_limits      generic atomic limiter (service role only)

  Order: run once, after 20271231130000_voice_ai_hardening.sql. Re-runnable (IF NOT EXISTS / OR REPLACE).
  Rollback: see the DROP block at the very bottom (commented out).
*/

-- ---------------------------------------------------------------- preferences
CREATE TABLE IF NOT EXISTS public.voice_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  brief_enabled boolean NOT NULL DEFAULT false,            -- opt-in: it sends AI-generated audio
  send_hour smallint NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text,                                           -- NULL = use briefing_preferences / business time zone
  quiet_start smallint NOT NULL DEFAULT 21 CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end smallint NOT NULL DEFAULT 7 CHECK (quiet_end BETWEEN 0 AND 23),
  skip_when_quiet boolean NOT NULL DEFAULT true,           -- skip the brief when nothing notable happened
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en','es','fr')),
  voice_choice text NOT NULL DEFAULT 'sarah' CHECK (voice_choice IN ('sarah','custom')),
  speed numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (speed BETWEEN 0.70 AND 1.20),
  channel_push boolean NOT NULL DEFAULT true,
  channel_whatsapp boolean NOT NULL DEFAULT false,
  channel_email boolean NOT NULL DEFAULT false,
  channel_in_app boolean NOT NULL DEFAULT true,
  whatsapp_number text CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  daily_cost_cap_cents integer NOT NULL DEFAULT 50 CHECK (daily_cost_cap_cents BETWEEN 0 AND 5000),
  last_brief_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_prefs_enabled ON public.voice_preferences (brief_enabled) WHERE brief_enabled;
CREATE INDEX IF NOT EXISTS idx_voice_prefs_owner ON public.voice_preferences (account_owner_id);

ALTER TABLE public.voice_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_prefs_select ON public.voice_preferences;
CREATE POLICY voice_prefs_select ON public.voice_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- A user may only create their OWN row, and only for an account they own or are an active member of.
DROP POLICY IF EXISTS voice_prefs_insert ON public.voice_preferences;
CREATE POLICY voice_prefs_insert ON public.voice_preferences FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      account_owner_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.user_id = auth.uid()
          AND tm.account_owner_id = voice_preferences.account_owner_id
          AND tm.invite_status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS voice_prefs_update ON public.voice_preferences;
CREATE POLICY voice_prefs_update ON public.voice_preferences FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Users change settings only; account_owner_id and last_brief_on are not user-writable.
REVOKE ALL ON public.voice_preferences FROM anon, authenticated;
GRANT SELECT ON public.voice_preferences TO authenticated;
GRANT INSERT (user_id, account_owner_id, brief_enabled, send_hour, timezone, quiet_start, quiet_end, skip_when_quiet,
              language, voice_choice, speed, channel_push, channel_whatsapp, channel_email, channel_in_app,
              whatsapp_number, daily_cost_cap_cents)
  ON public.voice_preferences TO authenticated;
GRANT UPDATE (brief_enabled, send_hour, timezone, quiet_start, quiet_end, skip_when_quiet, language, voice_choice,
              speed, channel_push, channel_whatsapp, channel_email, channel_in_app, whatsapp_number,
              daily_cost_cap_cents, updated_at)
  ON public.voice_preferences TO authenticated;

-- ---------------------------------------------------------------- briefs
CREATE TABLE IF NOT EXISTS public.voice_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_date date NOT NULL,
  language text NOT NULL,
  voice_key text NOT NULL,                                 -- 'sarah' | 'custom'
  status text NOT NULL CHECK (status IN ('generated','skipped','failed')),
  skip_reason text,
  script text,
  word_count integer,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,             -- [{key,label,value,href}] shown by "Why this?"
  script_hash text,                                        -- cache key: same script + voice + speed => reuse audio
  audio_path text,
  audio_seconds numeric(6,1),
  tts_chars integer NOT NULL DEFAULT 0,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  cache_hit boolean NOT NULL DEFAULT false,
  delivered jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date, language, voice_key)
);
CREATE INDEX IF NOT EXISTS idx_voice_briefs_owner_day ON public.voice_briefs (account_owner_id, created_at DESC);

ALTER TABLE public.voice_briefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_briefs_select ON public.voice_briefs;
CREATE POLICY voice_briefs_select ON public.voice_briefs FOR SELECT TO authenticated
  USING (user_id = auth.uid());
REVOKE ALL ON public.voice_briefs FROM anon, authenticated;
GRANT SELECT ON public.voice_briefs TO authenticated;      -- writes: service role only

-- ---------------------------------------------------------------- callers (service role only)
CREATE TABLE IF NOT EXISTS public.voice_callers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  pin_hash text,
  pin_salt text,
  pin_set_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_call_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One active number belongs to exactly one Vireek login; at most 3 active numbers per user (checked in code).
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_callers_phone_active ON public.voice_callers (phone_e164) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_callers_user ON public.voice_callers (user_id) WHERE revoked_at IS NULL;
ALTER TABLE public.voice_callers ENABLE ROW LEVEL SECURITY;      -- no policies: only service_role can touch it
REVOKE ALL ON public.voice_callers FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.voice_enroll_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_enroll_otps_user ON public.voice_enroll_otps (user_id, created_at DESC);
ALTER TABLE public.voice_enroll_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_enroll_otps FROM anon, authenticated;

-- ---------------------------------------------------------------- call sessions + audit
CREATE TABLE IF NOT EXISTS public.voice_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid text NOT NULL UNIQUE,
  account_owner_id uuid,                                   -- NULL until the caller is matched
  user_id uuid,
  from_masked text NOT NULL,                               -- e.g. +1•••••4417 (raw number is never stored here)
  auth_level smallint NOT NULL DEFAULT 0 CHECK (auth_level BETWEEN 0 AND 2),  -- 0 none, 1 caller-ID+PIN, 2 +SMS code
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  turns integer NOT NULL DEFAULT 0,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_owner ON public.voice_call_sessions (account_owner_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.voice_call_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL,
  account_owner_id uuid,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'call_started','unknown_caller','rate_limited','pin_ok','pin_failed','locked','otp_sent','otp_ok','otp_failed',
    'utterance','answer','denied','action_proposed','action_confirmed','action_cancelled','action_executed',
    'action_failed','injection_blocked','call_ended','error')),
  text_redacted text,                                      -- what was said / spoken back, digits+emails masked
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,               -- intent, topics, evidence refs, grounding, level, ids
  server_ms integer,                                       -- webhook processing time (not network/TTS start)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_events_session ON public.voice_call_events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_voice_events_owner ON public.voice_call_events (account_owner_id, created_at DESC);

ALTER TABLE public.voice_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_call_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_sessions_select ON public.voice_call_sessions;
CREATE POLICY voice_sessions_select ON public.voice_call_sessions FOR SELECT TO authenticated
  USING (account_owner_id = auth.uid() OR user_id = auth.uid());
DROP POLICY IF EXISTS voice_events_select ON public.voice_call_events;
CREATE POLICY voice_events_select ON public.voice_call_events FOR SELECT TO authenticated
  USING (account_owner_id = auth.uid() OR user_id = auth.uid());
REVOKE ALL ON public.voice_call_sessions, public.voice_call_events FROM anon, authenticated;
GRANT SELECT ON public.voice_call_sessions, public.voice_call_events TO authenticated;

-- The audit trail cannot be edited or deleted, not even by the service role, except through voice_purge_account().
CREATE OR REPLACE FUNCTION public.voice_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('vireek.voice_purge', true) = 'on' THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'voice_call_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_voice_events_immutable ON public.voice_call_events;
CREATE TRIGGER trg_voice_events_immutable BEFORE UPDATE OR DELETE ON public.voice_call_events
  FOR EACH ROW EXECUTE FUNCTION public.voice_events_immutable();

-- ---------------------------------------------------------------- pending actions (confirm before act)
CREATE TABLE IF NOT EXISTS public.voice_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.voice_call_sessions(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('send_sms')),
  payload jsonb NOT NULL,                                  -- {customer_id, to, body}; never read by the LLM
  readback text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','executed','cancelled','expired','failed')),
  expires_at timestamptz NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One open proposal per call: a second request replaces the first (code cancels it before inserting).
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_pending_open ON public.voice_pending_actions (session_id) WHERE status IN ('pending','confirmed');
ALTER TABLE public.voice_pending_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_pending_actions FROM anon, authenticated;

-- ---------------------------------------------------------------- rate limits + spend
CREATE TABLE IF NOT EXISTS public.voice_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.voice_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.voice_consume_rate_limit(p_key text, p_max integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO voice_rate_limits AS r (key, window_start, request_count) VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.request_count + 1 END
  RETURNING r.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;
REVOKE ALL ON FUNCTION public.voice_consume_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_consume_rate_limit(text, integer, integer) TO service_role;

-- Money spent on voice for one account since `p_since` (briefs + calls), in cents. Used for the daily cap.
CREATE OR REPLACE FUNCTION public.voice_spend_since(p_owner uuid, p_since timestamptz)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT sum(cost_cents) FROM voice_briefs WHERE account_owner_id = p_owner AND created_at >= p_since), 0)
       + COALESCE((SELECT sum(cost_cents) FROM voice_call_sessions WHERE account_owner_id = p_owner AND started_at >= p_since), 0);
$$;
REVOKE ALL ON FUNCTION public.voice_spend_since(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_spend_since(uuid, timestamptz) TO service_role;

-- Account deletion / DSAR erasure hook. Call from the existing deletion pipeline.
CREATE OR REPLACE FUNCTION public.voice_purge_account(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('vireek.voice_purge', 'on', true);
  DELETE FROM voice_call_events WHERE account_owner_id = p_owner;
  DELETE FROM voice_call_sessions WHERE account_owner_id = p_owner;
  DELETE FROM voice_briefs WHERE account_owner_id = p_owner;
  DELETE FROM voice_callers WHERE account_owner_id = p_owner;
  DELETE FROM voice_preferences WHERE account_owner_id = p_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.voice_purge_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_purge_account(uuid) TO service_role;

-- ---------------------------------------------------------------- audio storage (private)
INSERT INTO storage.buckets (id, name, public) VALUES ('voice-briefs', 'voice-briefs', false) ON CONFLICT (id) DO NOTHING;
-- Path layout: {account_owner_id}/{user_id}/{date}-{hash}.mp3 ; a user can read only their own folder.
DROP POLICY IF EXISTS voice_briefs_audio_read ON storage.objects;
CREATE POLICY voice_briefs_audio_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voice-briefs' AND (storage.foldername(name))[2] = auth.uid()::text);

-- ---------------------------------------------------------------- cron (hourly, like daily-briefing)
CREATE OR REPLACE FUNCTION public.dispatch_voice_briefs() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.briefing_cron_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'voice briefs not dispatched: app.settings.edge_function_base_url / briefing_cron_secret not set';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base_url || '/voice-brief',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-briefing-secret', v_secret),
    body := '{"mode":"cron"}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_voice_briefs() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-voice-briefs', '10 * * * *', 'select public.dispatch_voice_briefs()');
  ELSE
    RAISE NOTICE 'pg_cron/pg_net not enabled: call the voice-brief function hourly (mode=cron) from an external scheduler.';
  END IF;
END $$;

/* ROLLBACK (manual, destructive):
   SELECT cron.unschedule('vireek-voice-briefs');
   DROP FUNCTION IF EXISTS public.dispatch_voice_briefs(), public.voice_purge_account(uuid),
     public.voice_spend_since(uuid, timestamptz), public.voice_consume_rate_limit(text, integer, integer);
   DROP TABLE IF EXISTS public.voice_pending_actions, public.voice_call_events, public.voice_call_sessions,
     public.voice_enroll_otps, public.voice_callers, public.voice_briefs, public.voice_preferences, public.voice_rate_limits;
   DROP FUNCTION IF EXISTS public.voice_events_immutable();
   DELETE FROM storage.buckets WHERE id = 'voice-briefs';   -- empty the bucket first
*/
