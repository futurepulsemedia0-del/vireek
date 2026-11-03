/*
  # Live interpreter (two-way call interpretation)

  Adds, purely additively (no existing table, policy or function is modified except
  new nullable columns on calls / customers):

  1. interpreter_settings   per business: on/off, enabled languages, default mode,
                            per-language greeting scripts, glossary overrides,
                            retention days, training opt-in (default OFF), bridge number.
  2. interpreter_sessions   one row per interpreted call (assistant / bridge / captions).
  3. interpreter_turns      every utterance: ORIGINAL text + English text, confidences,
                            critical-field check, latency, flags. Streamed to the
                            dashboard through Supabase Realtime for live captions.
  4. calls.*                interpreter_language, interpretation_mode, transcript_en
  5. customers.*            spoken_language (+source): the language the customer speaks,
                            including Portuguese and Vietnamese which the document-language
                            column preferred_language does not allow.
  6. record_spoken_language()  service_role, "fill only if empty" (a guess never overwrites
                            a staff/customer choice).
  7. interpreter_purge_expired()  data retention.

  ## Security
  - Sessions and turns are written ONLY by Edge Functions / the bridge worker (service role).
    `authenticated` gets SELECT only, scoped to the account owner AND can_view_live_calls().
  - Settings: owner (or a member with the same permission) may read and write their own row.
  - Transcript text is caller PII: retention is enforced by purge_after, set from
    interpreter_settings.retention_days (7..730, default 90).
  - No customer audio/text is eligible for model training unless BOTH
    interpreter_settings.training_opt_in and interpreter_sessions.training_consent are true.

  ## Rollback
  DROP TABLE interpreter_turns, interpreter_sessions, interpreter_settings CASCADE;
  DROP FUNCTION record_spoken_language, interpreter_purge_expired, interpreter_set_purge_after;
  ALTER TABLE calls DROP COLUMN interpreter_language, DROP COLUMN interpretation_mode, DROP COLUMN transcript_en;
  ALTER TABLE customers DROP COLUMN spoken_language, DROP COLUMN spoken_language_source;
*/

-- =============================================================
-- 1. interpreter_settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.interpreter_settings (
  user_id            uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  enabled_languages  text[]  NOT NULL DEFAULT ARRAY['es']::text[],
  default_mode       text    NOT NULL DEFAULT 'assistant',
  greetings          jsonb   NOT NULL DEFAULT '{}'::jsonb,
  glossary_overrides jsonb   NOT NULL DEFAULT '{}'::jsonb,
  bridge_number      text,
  retention_days     integer NOT NULL DEFAULT 90,
  training_opt_in    boolean NOT NULL DEFAULT false,
  recording_state    text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interpreter_settings_langs_check
    CHECK (enabled_languages <@ ARRAY['es','pt','vi','zh','ar','fa','hi','fr','de','ja']::text[] AND cardinality(enabled_languages) <= 10),
  CONSTRAINT interpreter_settings_mode_check
    CHECK (default_mode IN ('assistant', 'bridge_consecutive', 'bridge_simultaneous', 'captions')),
  CONSTRAINT interpreter_settings_greetings_check
    CHECK (jsonb_typeof(greetings) = 'object' AND pg_column_size(greetings) <= 8000),
  CONSTRAINT interpreter_settings_glossary_check
    CHECK (jsonb_typeof(glossary_overrides) = 'object' AND pg_column_size(glossary_overrides) <= 20000),
  CONSTRAINT interpreter_settings_retention_check CHECK (retention_days BETWEEN 7 AND 730),
  CONSTRAINT interpreter_settings_bridge_number_check CHECK (bridge_number IS NULL OR bridge_number ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT interpreter_settings_state_check CHECK (recording_state IS NULL OR recording_state ~ '^[A-Z]{2}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS interpreter_settings_bridge_number_uq
  ON public.interpreter_settings (bridge_number) WHERE bridge_number IS NOT NULL;

-- =============================================================
-- 2. interpreter_sessions
-- =============================================================
CREATE TABLE IF NOT EXISTS public.interpreter_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  call_id              uuid REFERENCES public.calls (id) ON DELETE SET NULL,
  vapi_call_id         text,
  mode                 text NOT NULL,
  caller_language      text NOT NULL,
  staff_language       text NOT NULL DEFAULT 'en',
  status               text NOT NULL DEFAULT 'pending',
  pairing_code         text,
  staff_destination    text,
  started_at           timestamptz,
  ended_at             timestamptz,
  p50_added_ms         integer,
  p95_added_ms         integer,
  degraded             boolean NOT NULL DEFAULT false,
  handoff_reason       text,
  disclosure_played_at timestamptz,
  training_consent     boolean NOT NULL DEFAULT false,
  purge_after          timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interpreter_sessions_mode_check CHECK (mode IN ('assistant', 'bridge_consecutive', 'bridge_simultaneous', 'captions')),
  CONSTRAINT interpreter_sessions_lang_check CHECK (caller_language IN ('en','es','pt','vi','zh','ar','fa','hi','fr','de','ja') AND staff_language IN ('en','es','pt','vi','zh','ar','fa','hi','fr','de','ja')),
  CONSTRAINT interpreter_sessions_status_check CHECK (status IN ('pending', 'active', 'ended', 'failed')),
  CONSTRAINT interpreter_sessions_code_check CHECK (pairing_code IS NULL OR pairing_code ~ '^[0-9]{6}$')
);
-- Globally unique while pending: the shared bridge number identifies the tenant, the code identifies the call.
CREATE UNIQUE INDEX IF NOT EXISTS interpreter_sessions_pending_code_uq
  ON public.interpreter_sessions (pairing_code) WHERE status = 'pending' AND pairing_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS interpreter_sessions_vapi_call_uq
  ON public.interpreter_sessions (user_id, vapi_call_id, mode) WHERE vapi_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interpreter_sessions_user_created_idx ON public.interpreter_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS interpreter_sessions_call_idx ON public.interpreter_sessions (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interpreter_sessions_purge_idx ON public.interpreter_sessions (purge_after);

-- purge_after follows the business's retention setting at creation time
CREATE OR REPLACE FUNCTION public.interpreter_set_purge_after()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_days integer;
BEGIN
  SELECT retention_days INTO v_days FROM public.interpreter_settings WHERE user_id = NEW.user_id;
  NEW.purge_after := now() + make_interval(days => COALESCE(v_days, 90));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS interpreter_sessions_purge_after ON public.interpreter_sessions;
CREATE TRIGGER interpreter_sessions_purge_after BEFORE INSERT ON public.interpreter_sessions
  FOR EACH ROW EXECUTE FUNCTION public.interpreter_set_purge_after();

-- =============================================================
-- 3. interpreter_turns
-- =============================================================
CREATE TABLE IF NOT EXISTS public.interpreter_turns (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES public.interpreter_sessions (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  speaker        text NOT NULL,
  from_lang      text NOT NULL,
  to_lang        text NOT NULL,
  original       text NOT NULL,
  translated     text,
  asr_confidence numeric(4, 3),
  mt_confidence  numeric(4, 3),
  action         text NOT NULL,
  reason         text,
  critical       jsonb NOT NULL DEFAULT '{}'::jsonb,
  emergency      text[] NOT NULL DEFAULT '{}',
  added_ms       integer,
  flags          text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interpreter_turns_speaker_check CHECK (speaker IN ('caller', 'staff')),
  CONSTRAINT interpreter_turns_text_check CHECK (char_length(original) <= 4000 AND (translated IS NULL OR char_length(translated) <= 8000)),
  CONSTRAINT interpreter_turns_unique_seq UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS interpreter_turns_user_idx ON public.interpreter_turns (user_id, created_at DESC);

-- =============================================================
-- 4. calls + customers columns
-- =============================================================
ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS interpreter_language text,
  ADD COLUMN IF NOT EXISTS interpretation_mode text,
  ADD COLUMN IF NOT EXISTS transcript_en text;
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_interpreter_language_check;
ALTER TABLE public.calls ADD CONSTRAINT calls_interpreter_language_check
  CHECK (interpreter_language IS NULL OR interpreter_language IN ('en','es','pt','vi','zh','ar','fa','hi','fr','de','ja'));
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_interpretation_mode_check;
ALTER TABLE public.calls ADD CONSTRAINT calls_interpretation_mode_check
  CHECK (interpretation_mode IS NULL OR interpretation_mode IN ('assistant', 'bridge_consecutive', 'bridge_simultaneous', 'captions'));

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS spoken_language text,
  ADD COLUMN IF NOT EXISTS spoken_language_source text;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_spoken_language_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_spoken_language_check
  CHECK (spoken_language IS NULL OR spoken_language IN ('en','es','pt','vi','zh','ar','fa','hi','fr','de','ja'));
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_spoken_language_source_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_spoken_language_source_check
  CHECK (spoken_language_source IS NULL OR spoken_language_source IN ('auto_detected', 'staff', 'customer'));

-- =============================================================
-- 5. record_spoken_language: fill ONLY if empty (service_role)
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_spoken_language(p_user_id uuid, p_phone text, p_language text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key text := public.phone_match_key(p_phone); v_n integer;
BEGIN
  IF v_key IS NULL OR p_language IS NULL THEN RETURN 0; END IF;
  UPDATE public.customers
     SET spoken_language = p_language, spoken_language_source = 'auto_detected'
   WHERE user_id = p_user_id AND spoken_language IS NULL AND public.phone_match_key(phone) = v_key;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.record_spoken_language(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_spoken_language(uuid, text, text) TO service_role;

-- =============================================================
-- 6. Retention
-- =============================================================
CREATE OR REPLACE FUNCTION public.interpreter_purge_expired()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  -- transcript_en on calls follows the same retention as the turns it came from
  UPDATE public.calls c SET transcript_en = NULL
   WHERE c.transcript_en IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.interpreter_sessions s WHERE s.call_id = c.id AND s.purge_after < now());
  DELETE FROM public.interpreter_sessions WHERE purge_after < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.interpreter_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.interpreter_purge_expired() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule('interpreter-purge-expired', '17 3 * * *', 'select public.interpreter_purge_expired()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'interpreter purge not scheduled (%): schedule public.interpreter_purge_expired() daily manually', SQLERRM;
END $$;

-- =============================================================
-- 7. RLS
-- =============================================================
ALTER TABLE public.interpreter_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_turns    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interpreter_settings_select ON public.interpreter_settings;
CREATE POLICY interpreter_settings_select ON public.interpreter_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls());
DROP POLICY IF EXISTS interpreter_settings_insert ON public.interpreter_settings;
CREATE POLICY interpreter_settings_insert ON public.interpreter_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_view_live_calls());
DROP POLICY IF EXISTS interpreter_settings_update ON public.interpreter_settings;
CREATE POLICY interpreter_settings_update ON public.interpreter_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_view_live_calls());

DROP POLICY IF EXISTS interpreter_sessions_select ON public.interpreter_sessions;
CREATE POLICY interpreter_sessions_select ON public.interpreter_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls());
DROP POLICY IF EXISTS interpreter_turns_select ON public.interpreter_turns;
CREATE POLICY interpreter_turns_select ON public.interpreter_turns FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls());

REVOKE ALL ON public.interpreter_settings, public.interpreter_sessions, public.interpreter_turns FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.interpreter_settings TO authenticated;
GRANT SELECT ON public.interpreter_sessions, public.interpreter_turns TO authenticated;
GRANT ALL ON public.interpreter_settings, public.interpreter_sessions, public.interpreter_turns TO service_role;

-- =============================================================
-- 8. Realtime (live captions)
-- =============================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.interpreter_turns;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.interpreter_sessions;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
