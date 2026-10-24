/*
  # AI Transparency Compliance

  Registry + switches + notice flow + provenance for AI features.

  1. ai_transparency_catalog   : canonical classification of every AI feature (read-only for clients).
                                 interactive_ai | synthetic_audio | emotion_recognition (text vs voice_audio) | other_ai
  2. ai_transparency_settings  : per-account switch, notice acknowledgement and legal-review status.
  3. ai_transparency_events    : append-only change log (written only by the RPCs below).
  4. ai_provenance_records     : machine-readable provenance sidecar for generated audio / stored recordings.
  RPCs: get_ai_transparency_registry, set_ai_transparency_feature, set_ai_transparency_legal_review,
        export_ai_transparency_registry, register_ai_provenance (members), record_ai_provenance (service role),
        ai_transparency_feature_state (service role), my_ai_transparency_feature_state (members).

  A feature whose emotion_basis is voice_audio can NEVER be switched on without the owner acknowledging the
  current notice version; the RPC enforces this server-side, and the runtime gate treats it as off until then.

  NOT LEGAL ADVICE. Rules vary by jurisdiction and need legal review.
  Depends on public.ai_gov_can_manage() and public.get_account_owner_id() (earlier migrations).
*/

-- =============================================================
-- 1. CATALOG
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ai_transparency_catalog (
  feature_key text PRIMARY KEY CHECK (feature_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  label text NOT NULL,
  description text NOT NULL,
  categories text[] NOT NULL,
  emotion_basis text,
  modality text NOT NULL CHECK (modality IN ('text', 'voice', 'audio_file', 'multimodal')),
  provider text NOT NULL,
  surface text NOT NULL,
  default_enabled boolean NOT NULL,
  requires_notice boolean NOT NULL DEFAULT false,
  notice_version integer NOT NULL DEFAULT 1 CHECK (notice_version >= 1),
  enforcement text NOT NULL CHECK (enforcement IN ('runtime', 'registry')),
  shipped boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  CONSTRAINT ai_tc_categories_valid CHECK (
    cardinality(categories) >= 1
    AND categories <@ ARRAY['interactive_ai', 'synthetic_audio', 'emotion_recognition', 'other_ai']::text[]
  ),
  CONSTRAINT ai_tc_emotion_basis CHECK (
    (('emotion_recognition' = ANY (categories)) = (emotion_basis IS NOT NULL))
    AND (emotion_basis IS NULL OR emotion_basis IN ('text', 'voice_audio'))
  ),
  CONSTRAINT ai_tc_notice CHECK (requires_notice = COALESCE(emotion_basis = 'voice_audio', false)),
  CONSTRAINT ai_tc_notice_default_off CHECK (NOT (requires_notice AND default_enabled))
);

ALTER TABLE public.ai_transparency_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_ai_transparency_catalog" ON public.ai_transparency_catalog;
CREATE POLICY "select_ai_transparency_catalog" ON public.ai_transparency_catalog
  FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_transparency_catalog FROM anon, authenticated;

-- Seed. Keep identical to AI_FEATURE_CATALOG in supabase/functions/_shared/ai-transparency/engine.ts (a unit test enforces it).
INSERT INTO public.ai_transparency_catalog
  (feature_key, label, description, categories, emotion_basis, modality, provider, surface, default_enabled, requires_notice, notice_version, enforcement, shipped, sort_order)
VALUES
  ('ai_voice_receptionist', 'AI voice receptionist', 'The AI phone assistant answers and speaks with callers in a synthetic voice. Callers must be able to tell they are talking to an AI.', ARRAY['interactive_ai','synthetic_audio'], NULL, 'voice', 'Vapi', 'Phone calls', true, false, 1, 'registry', true, 10),
  ('ai_chat_assistants', 'AI chat assistants', 'Website chat, live-chat widget, homeowner assistant and in-dashboard assistants that reply to people in text.', ARRAY['interactive_ai'], NULL, 'text', 'LLM provider', 'Website and dashboard chat', true, false, 1, 'registry', true, 20),
  ('ai_messaging_auto_reply', 'AI messaging auto-reply', 'AI-drafted or AI-sent replies to SMS and WhatsApp conversations.', ARRAY['interactive_ai'], NULL, 'text', 'LLM provider', 'SMS and WhatsApp', true, false, 1, 'registry', true, 30),
  ('ai_voice_cloning', 'Custom cloned voice', 'Creates a synthetic copy of a voice from an uploaded sample so the AI assistant can speak in it. Only use voices you have the right to clone.', ARRAY['synthetic_audio'], NULL, 'audio_file', 'ElevenLabs', 'Settings, Clone Your Own Voice', true, false, 1, 'runtime', true, 40),
  ('ai_voicemail_drops_ai_voice', 'AI-voiced voicemail drops', 'Voicemail drop recordings that were produced with an AI or cloned voice and are played to recipients.', ARRAY['synthetic_audio'], NULL, 'audio_file', 'Uploaded audio', 'Voicemail Drops', true, false, 1, 'runtime', true, 50),
  ('ai_call_sentiment_text', 'Call sentiment (from transcript text)', 'After a call, an AI reads the transcript text and labels the caller sentiment positive, neutral or negative. No voice audio is analysed.', ARRAY['emotion_recognition'], 'text', 'text', 'LLM provider', 'Call intelligence', true, false, 1, 'runtime', true, 60),
  ('ai_live_call_sentiment_text', 'Live call sentiment (from transcript text)', 'During a live call, the running transcript text of the caller is scored for sentiment on the Live Calls board. No voice audio is analysed.', ARRAY['emotion_recognition'], 'text', 'text', 'Rules on transcript text', 'Live Calls', true, false, 1, 'runtime', true, 70),
  ('ai_voice_emotion_signals', 'Emotion from voice audio', 'Infers emotional state from how a person sounds (tone, pitch, pace), not from the words. No shipped Vireek feature does this today; the entry exists so any such feature must be registered, off by default and notice-gated.', ARRAY['emotion_recognition'], 'voice_audio', 'voice', 'Not in use', 'Reserved', false, true, 1, 'runtime', false, 80),
  ('ai_conversation_intel', 'Conversation Intelligence (recorded audio analysis)', 'Transcribes a consented in-home recording and extracts commitments, objections, safety items and coaching. It is instructed not to infer emotion from the voice.', ARRAY['other_ai'], NULL, 'audio_file', 'Gemini', 'Conversations', true, false, 1, 'registry', true, 90)
ON CONFLICT (feature_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  categories = EXCLUDED.categories,
  emotion_basis = EXCLUDED.emotion_basis,
  modality = EXCLUDED.modality,
  provider = EXCLUDED.provider,
  surface = EXCLUDED.surface,
  default_enabled = EXCLUDED.default_enabled,
  requires_notice = EXCLUDED.requires_notice,
  notice_version = EXCLUDED.notice_version,
  enforcement = EXCLUDED.enforcement,
  shipped = EXCLUDED.shipped,
  sort_order = EXCLUDED.sort_order;

-- =============================================================
-- 2. PER-ACCOUNT SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ai_transparency_settings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.ai_transparency_catalog(feature_key) ON UPDATE CASCADE,
  enabled boolean NOT NULL,
  notice_version_ack integer CHECK (notice_version_ack IS NULL OR notice_version_ack >= 1),
  notice_ack_by uuid,
  notice_ack_at timestamptz,
  legal_review_status text NOT NULL DEFAULT 'not_reviewed' CHECK (legal_review_status IN ('not_reviewed', 'in_review', 'reviewed')),
  legal_reviewed_at timestamptz,
  legal_review_notes text CHECK (legal_review_notes IS NULL OR length(legal_review_notes) <= 2000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

ALTER TABLE public.ai_transparency_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_transparency_settings" ON public.ai_transparency_settings;
CREATE POLICY "select_own_ai_transparency_settings" ON public.ai_transparency_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_transparency_settings FROM anon, authenticated;

-- =============================================================
-- 3. EVENTS (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ai_transparency_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_key text,
  event_type text NOT NULL CHECK (event_type IN ('feature_enabled', 'feature_disabled', 'notice_acknowledged', 'legal_review_updated', 'registry_exported')),
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_transparency_events_user_created_idx
  ON public.ai_transparency_events (user_id, created_at DESC);

ALTER TABLE public.ai_transparency_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_transparency_events" ON public.ai_transparency_events;
CREATE POLICY "select_own_ai_transparency_events" ON public.ai_transparency_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_transparency_events FROM anon, authenticated;

-- =============================================================
-- 4. PROVENANCE RECORDS (sidecar)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ai_provenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('generated_audio', 'stored_recording', 'voice_clone')),
  subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 500),
  feature_key text NOT NULL REFERENCES public.ai_transparency_catalog(feature_key) ON UPDATE CASCADE,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  ai_generated_audio boolean NOT NULL,
  ai_processed boolean NOT NULL DEFAULT false,
  embedded boolean NOT NULL DEFAULT false,
  embed_method text CHECK (embed_method IS NULL OR embed_method IN ('id3v2.4', 'none')),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject_type, subject_ref)
);

CREATE INDEX IF NOT EXISTS ai_provenance_records_user_created_idx
  ON public.ai_provenance_records (user_id, created_at DESC);

ALTER TABLE public.ai_provenance_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_provenance_records" ON public.ai_provenance_records;
CREATE POLICY "select_own_ai_provenance_records" ON public.ai_provenance_records
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_provenance_records FROM anon, authenticated;

-- =============================================================
-- INTERNAL: effective state of one feature for one account
-- =============================================================
CREATE OR REPLACE FUNCTION public._ai_transparency_state(p_owner uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ai_transparency_catalog%ROWTYPE;
  s public.ai_transparency_settings%ROWTYPE;
  v_enabled boolean;
  v_notice_ok boolean;
BEGIN
  SELECT * INTO c FROM public.ai_transparency_catalog WHERE feature_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.ai_transparency_settings WHERE user_id = p_owner AND feature_key = p_key;
  v_enabled := COALESCE(s.enabled, c.default_enabled);
  v_notice_ok := (NOT c.requires_notice)
    OR (s.notice_version_ack IS NOT NULL AND s.notice_version_ack >= c.notice_version);
  RETURN jsonb_build_object(
    'feature_key', p_key,
    'enabled', v_enabled,
    'notice_ok', v_notice_ok,
    'allowed', (v_enabled AND v_notice_ok)
  );
END;
$$;

REVOKE ALL ON FUNCTION public._ai_transparency_state(uuid, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPC: effective state (edge functions / members)
-- =============================================================
CREATE OR REPLACE FUNCTION public.ai_transparency_feature_state(p_user_id uuid, p_feature_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_transparency_state(p_user_id, p_feature_key);
$$;

REVOKE ALL ON FUNCTION public.ai_transparency_feature_state(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_transparency_feature_state(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.my_ai_transparency_feature_state(p_feature_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public._ai_transparency_state(v_owner, p_feature_key);
END;
$$;

REVOKE ALL ON FUNCTION public.my_ai_transparency_feature_state(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_ai_transparency_feature_state(text) TO authenticated;

-- =============================================================
-- RPC: registry (catalog merged with this account's settings)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_ai_transparency_registry()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'feature_key', c.feature_key,
      'label', c.label,
      'description', c.description,
      'categories', to_jsonb(c.categories),
      'emotion_basis', c.emotion_basis,
      'modality', c.modality,
      'provider', c.provider,
      'surface', c.surface,
      'requires_notice', c.requires_notice,
      'notice_version', c.notice_version,
      'enforcement', c.enforcement,
      'shipped', c.shipped,
      'default_enabled', c.default_enabled,
      'enabled', COALESCE(s.enabled, c.default_enabled),
      'explicitly_set', (s.user_id IS NOT NULL),
      'notice_version_ack', s.notice_version_ack,
      'notice_ack_at', s.notice_ack_at,
      'notice_ok', ((NOT c.requires_notice) OR (s.notice_version_ack IS NOT NULL AND s.notice_version_ack >= c.notice_version)),
      'allowed', (COALESCE(s.enabled, c.default_enabled)
                  AND ((NOT c.requires_notice) OR (s.notice_version_ack IS NOT NULL AND s.notice_version_ack >= c.notice_version))),
      'legal_review_status', COALESCE(s.legal_review_status, 'not_reviewed'),
      'legal_reviewed_at', s.legal_reviewed_at,
      'legal_review_notes', s.legal_review_notes,
      'updated_at', s.updated_at
    ) ORDER BY c.sort_order, c.feature_key
  ), '[]'::jsonb)
  INTO v_rows
  FROM public.ai_transparency_catalog c
  LEFT JOIN public.ai_transparency_settings s
    ON s.feature_key = c.feature_key AND s.user_id = v_owner;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_transparency_registry() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ai_transparency_registry() TO authenticated;

-- =============================================================
-- RPC: switch a feature (voice emotion requires the notice acknowledgement)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_ai_transparency_feature(
  p_feature_key text,
  p_enabled boolean,
  p_acknowledge_notice boolean DEFAULT false,
  p_notice_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.ai_transparency_catalog%ROWTYPE;
  v_ack_version integer := NULL;
  v_ack_at timestamptz := NULL;
  v_ack_by uuid := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to change AI transparency settings';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled is required'; END IF;

  SELECT * INTO c FROM public.ai_transparency_catalog WHERE feature_key = p_feature_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown AI feature'; END IF;

  IF p_enabled AND c.requires_notice THEN
    IF COALESCE(p_acknowledge_notice, false) IS NOT TRUE OR p_notice_version IS DISTINCT FROM c.notice_version THEN
      RAISE EXCEPTION 'Enabling this feature requires acknowledging the current notice (version %)', c.notice_version;
    END IF;
    v_ack_version := c.notice_version;
    v_ack_at := now();
    v_ack_by := auth.uid();
  END IF;

  INSERT INTO public.ai_transparency_settings AS t
    (user_id, feature_key, enabled, notice_version_ack, notice_ack_by, notice_ack_at, updated_by)
  VALUES
    (v_owner, p_feature_key, p_enabled, v_ack_version, v_ack_by, v_ack_at, auth.uid())
  ON CONFLICT (user_id, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    notice_version_ack = COALESCE(EXCLUDED.notice_version_ack, t.notice_version_ack),
    notice_ack_by = COALESCE(EXCLUDED.notice_ack_by, t.notice_ack_by),
    notice_ack_at = COALESCE(EXCLUDED.notice_ack_at, t.notice_ack_at),
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  INSERT INTO public.ai_transparency_events (user_id, feature_key, event_type, actor_id, detail)
  VALUES (v_owner, p_feature_key,
          CASE WHEN p_enabled THEN 'feature_enabled' ELSE 'feature_disabled' END,
          auth.uid(),
          jsonb_build_object('notice_version', v_ack_version));

  IF v_ack_version IS NOT NULL THEN
    INSERT INTO public.ai_transparency_events (user_id, feature_key, event_type, actor_id, detail)
    VALUES (v_owner, p_feature_key, 'notice_acknowledged', auth.uid(),
            jsonb_build_object('notice_version', v_ack_version));
  END IF;

  RETURN public._ai_transparency_state(v_owner, p_feature_key);
END;
$$;

REVOKE ALL ON FUNCTION public.set_ai_transparency_feature(text, boolean, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ai_transparency_feature(text, boolean, boolean, integer) TO authenticated;

-- =============================================================
-- RPC: legal review status (a record the owner keeps; not a legal determination)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_ai_transparency_legal_review(
  p_feature_key text,
  p_status text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_default boolean;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to change AI transparency settings';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('not_reviewed', 'in_review', 'reviewed') THEN
    RAISE EXCEPTION 'Unknown legal review status';
  END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RAISE EXCEPTION 'Notes are too long'; END IF;

  SELECT default_enabled INTO v_default FROM public.ai_transparency_catalog WHERE feature_key = p_feature_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown AI feature'; END IF;

  INSERT INTO public.ai_transparency_settings AS t
    (user_id, feature_key, enabled, legal_review_status, legal_reviewed_at, legal_review_notes, updated_by)
  VALUES
    (v_owner, p_feature_key, v_default, p_status,
     CASE WHEN p_status = 'reviewed' THEN now() ELSE NULL END, v_notes, auth.uid())
  ON CONFLICT (user_id, feature_key) DO UPDATE SET
    legal_review_status = EXCLUDED.legal_review_status,
    legal_reviewed_at = EXCLUDED.legal_reviewed_at,
    legal_review_notes = EXCLUDED.legal_review_notes,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  INSERT INTO public.ai_transparency_events (user_id, feature_key, event_type, actor_id, detail)
  VALUES (v_owner, p_feature_key, 'legal_review_updated', auth.uid(), jsonb_build_object('status', p_status));

  RETURN public._ai_transparency_state(v_owner, p_feature_key);
END;
$$;

REVOKE ALL ON FUNCTION public.set_ai_transparency_legal_review(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ai_transparency_legal_review(text, text, text) TO authenticated;

-- =============================================================
-- INTERNAL + RPCs: provenance sidecar (idempotent per subject)
-- =============================================================
CREATE OR REPLACE FUNCTION public._ai_transparency_write_provenance(
  p_owner uuid,
  p_subject_type text,
  p_subject_ref text,
  p_feature_key text,
  p_provider text,
  p_ai_generated_audio boolean,
  p_ai_processed boolean,
  p_embedded boolean,
  p_embed_method text,
  p_content_sha256 text,
  p_manifest jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_owner IS NULL THEN RAISE EXCEPTION 'Owner is required'; END IF;
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('generated_audio', 'stored_recording', 'voice_clone') THEN
    RAISE EXCEPTION 'Unknown provenance subject type';
  END IF;
  IF p_subject_ref IS NULL OR length(p_subject_ref) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid subject reference'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_transparency_catalog WHERE feature_key = p_feature_key) THEN
    RAISE EXCEPTION 'Unknown AI feature';
  END IF;
  IF p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_ai_generated_audio IS NULL THEN RAISE EXCEPTION 'ai_generated_audio is required'; END IF;
  IF p_manifest IS NOT NULL AND jsonb_typeof(p_manifest) <> 'object' THEN RAISE EXCEPTION 'manifest must be a JSON object'; END IF;
  IF p_content_sha256 IS NOT NULL AND p_content_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid content hash'; END IF;
  IF p_embed_method IS NOT NULL AND p_embed_method NOT IN ('id3v2.4', 'none') THEN RAISE EXCEPTION 'Invalid embed method'; END IF;

  INSERT INTO public.ai_provenance_records AS r
    (user_id, subject_type, subject_ref, feature_key, provider, ai_generated_audio, ai_processed,
     embedded, embed_method, content_sha256, manifest)
  VALUES
    (p_owner, p_subject_type, p_subject_ref, p_feature_key, p_provider, p_ai_generated_audio,
     COALESCE(p_ai_processed, false), COALESCE(p_embedded, false), p_embed_method, p_content_sha256,
     COALESCE(p_manifest, '{}'::jsonb))
  ON CONFLICT (user_id, subject_type, subject_ref) DO UPDATE SET
    feature_key = EXCLUDED.feature_key,
    provider = EXCLUDED.provider,
    ai_generated_audio = EXCLUDED.ai_generated_audio,
    ai_processed = EXCLUDED.ai_processed,
    embedded = EXCLUDED.embedded,
    embed_method = EXCLUDED.embed_method,
    content_sha256 = EXCLUDED.content_sha256,
    manifest = EXCLUDED.manifest
  RETURNING r.id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._ai_transparency_write_provenance(uuid, text, text, text, text, boolean, boolean, boolean, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_ai_provenance(
  p_user_id uuid,
  p_subject_type text,
  p_subject_ref text,
  p_feature_key text,
  p_provider text,
  p_ai_generated_audio boolean,
  p_ai_processed boolean DEFAULT false,
  p_embedded boolean DEFAULT false,
  p_embed_method text DEFAULT NULL,
  p_content_sha256 text DEFAULT NULL,
  p_manifest jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_transparency_write_provenance(
    p_user_id, p_subject_type, p_subject_ref, p_feature_key, p_provider,
    p_ai_generated_audio, p_ai_processed, p_embedded, p_embed_method, p_content_sha256, p_manifest);
$$;

REVOKE ALL ON FUNCTION public.record_ai_provenance(uuid, text, text, text, text, boolean, boolean, boolean, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_provenance(uuid, text, text, text, text, boolean, boolean, boolean, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.register_ai_provenance(
  p_subject_type text,
  p_subject_ref text,
  p_feature_key text,
  p_provider text,
  p_ai_generated_audio boolean,
  p_ai_processed boolean DEFAULT false,
  p_embedded boolean DEFAULT false,
  p_embed_method text DEFAULT NULL,
  p_content_sha256 text DEFAULT NULL,
  p_manifest jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public._ai_transparency_write_provenance(
    v_owner, p_subject_type, p_subject_ref, p_feature_key, p_provider,
    p_ai_generated_audio, p_ai_processed, p_embedded, p_embed_method, p_content_sha256, p_manifest);
END;
$$;

REVOKE ALL ON FUNCTION public.register_ai_provenance(text, text, text, text, boolean, boolean, boolean, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_ai_provenance(text, text, text, text, boolean, boolean, boolean, text, text, jsonb) TO authenticated;

-- =============================================================
-- RPC: owner export (registry + change log + provenance)
-- =============================================================
CREATE OR REPLACE FUNCTION public.export_ai_transparency_registry(p_provenance_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer := LEAST(GREATEST(COALESCE(p_provenance_limit, 5000), 1), 20000);
  v_features jsonb;
  v_events jsonb;
  v_prov jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to export the AI transparency registry';
  END IF;

  v_features := public.get_ai_transparency_registry();

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb) INTO v_events
  FROM (
    SELECT feature_key, event_type, actor_id, detail, created_at
    FROM public.ai_transparency_events
    WHERE user_id = v_owner
    ORDER BY created_at DESC
    LIMIT 2000
  ) e;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC), '[]'::jsonb) INTO v_prov
  FROM (
    SELECT subject_type, subject_ref, feature_key, provider, ai_generated_audio, ai_processed,
           embedded, embed_method, content_sha256, manifest, created_at
    FROM public.ai_provenance_records
    WHERE user_id = v_owner
    ORDER BY created_at DESC
    LIMIT v_limit
  ) p;

  INSERT INTO public.ai_transparency_events (user_id, feature_key, event_type, actor_id, detail)
  VALUES (v_owner, NULL, 'registry_exported', auth.uid(), '{}'::jsonb);

  RETURN jsonb_build_object(
    'schema', 'vireek.ai-transparency-registry/1',
    'generated_at', now(),
    'account_owner_id', v_owner,
    'disclaimer', 'Rules vary by jurisdiction and need legal review. This export is a compliance aid, not legal advice.',
    'features', v_features,
    'events', v_events,
    'provenance', v_prov
  );
END;
$$;

REVOKE ALL ON FUNCTION public.export_ai_transparency_registry(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.export_ai_transparency_registry(integer) TO authenticated;
