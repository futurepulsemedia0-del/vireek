/*
  # Company Brain — Tribal Knowledge OS

  ## Why
  Does NOT create a parallel knowledge system. Extends the existing
  Advanced Knowledge Base (20260921000000_advanced_knowledge_base.sql):
  same knowledge_articles table, same audience='team' (already
  "internal — never spoken", exactly what tribal/back-office knowledge
  needs), same versioning, same embedding + search pipeline the phone
  assistant and KnowledgeBasePage.tsx already use.

  Two new ways an article gets INTO that table:
    - source = 'voice_note'    -> a technician's field voice note,
      transcribed and drafted into an article by Gemini
      (tribal-knowledge-voice-capture edge function).
    - source = 'manual_upload' -> a manufacturer manual/spec sheet PDF,
      split into one or more procedure articles by Gemini
      (tribal-knowledge-manual-ingest edge function).

  Both land as status='draft', audience='team' — a human still
  reviews and publishes, exactly like every other article source.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy tribal-knowledge-voice-capture --no-verify-jwt
    3. supabase functions deploy tribal-knowledge-manual-ingest --no-verify-jwt
    4. Apply the code edits (src/lib/knowledge.ts, src/pages/KnowledgeBasePage.tsx).
    5. Secrets: reuses GEMINI_API_KEY / GEMINI_MODEL, already set for field-estimate.
*/

-- 1) Two new article sources + who contributed it -----------------------

ALTER TABLE knowledge_articles
  DROP CONSTRAINT IF EXISTS knowledge_articles_source_check;

ALTER TABLE knowledge_articles
  ADD CONSTRAINT knowledge_articles_source_check
  CHECK (source IN ('manual', 'faq_import', 'gap', 'price_book', 'voice_note', 'manual_upload'));

ALTER TABLE knowledge_articles
  ADD COLUMN IF NOT EXISTS contributed_by uuid REFERENCES team_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN knowledge_articles.contributed_by IS
  'Technician/team member whose voice note or manual upload produced this article. Null for owner-authored or imported articles.';

-- 2) Manual-upload tracking ----------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_manual_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  file_name text NOT NULL,
  storage_path text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done', 'failed')),
  articles_created integer NOT NULL DEFAULT 0,
  error_message text,
  uploaded_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_knowledge_manual_uploads_user
  ON knowledge_manual_uploads(user_id, created_at DESC);

ALTER TABLE knowledge_manual_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_knowledge_manual_uploads" ON knowledge_manual_uploads;
CREATE POLICY "select_own_knowledge_manual_uploads" ON knowledge_manual_uploads
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — only the manual-ingest Edge Function
-- (service role) writes rows, same posture as revenue_recovery_events etc.

-- 3) Storage bucket for voice notes + manual PDFs -------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tribal-knowledge-media',
  'tribal-knowledge-media',
  false,
  10485760, -- 10 MB
  ARRAY[
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp4',
    'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_tribal_knowledge_media" ON storage.objects;
CREATE POLICY "users_manage_own_tribal_knowledge_media"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'tribal-knowledge-media' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'tribal-knowledge-media' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 4) Atomic per-user hourly quota (shared by both capture functions) -----

CREATE TABLE IF NOT EXISTS tribal_knowledge_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE tribal_knowledge_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the two capture Edge Functions
-- (service role) may touch this table.

CREATE OR REPLACE FUNCTION public.consume_tribal_knowledge_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO tribal_knowledge_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_tribal_knowledge_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_tribal_knowledge_quota(uuid, integer, integer) TO service_role;
