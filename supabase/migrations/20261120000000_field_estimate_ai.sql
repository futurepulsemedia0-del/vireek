/*
  # AI Photo + Voice-Based Estimating (field-estimate)

  Technician photos, a short video and/or a voice note become a diagnosis,
  scope of work, parts list, labor and a Good / Better / Best quote draft.

  Purely additive - nothing that already reads or writes `quotes` changes.

  1. quotes.ai_report        full internal report (diagnosis, scope, parts,
                             safety flags, transcript). NEVER exposed to the
                             customer: get_quote_for_token() returns an
                             explicit column list that does not include it.
  2. field-estimate-media    PRIVATE bucket for voice notes / video, owner
                             folder-scoped, size + mime limited. The Edge
                             Function deletes the files after analysis.
  3. consume_field_estimate_quota()
                             atomic per-user hourly quota, callable ONLY by
                             the service role (no client write path).

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Quote provenance / report ---------------------------------------
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_detected_issue text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric,
  ADD COLUMN IF NOT EXISTS ai_report jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_ai_report_is_object') THEN
    ALTER TABLE quotes
      ADD CONSTRAINT quotes_ai_report_is_object
      CHECK (ai_report IS NULL OR jsonb_typeof(ai_report) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN quotes.ai_report IS
  'Internal AI field-estimate report (diagnosis, scope, parts, safety flags, transcript). Human-reviewed; never shown to customers.';

-- 2) Private media bucket ---------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'field-estimate-media',
  'field-estimate-media',
  false,
  41943040, -- 40 MB
  ARRAY[
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp4',
    'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/mpeg'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_field_estimate_media" ON storage.objects;
CREATE POLICY "users_manage_own_field_estimate_media"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'field-estimate-media' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'field-estimate-media' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 3) Atomic quota (service-role only) ----------------------------------
CREATE TABLE IF NOT EXISTS field_estimate_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE field_estimate_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the field-estimate Edge Function
-- (service role) may touch this table.

CREATE OR REPLACE FUNCTION public.consume_field_estimate_quota(
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
  INSERT INTO field_estimate_usage AS u (user_id, window_start, request_count)
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

REVOKE ALL ON FUNCTION public.consume_field_estimate_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_field_estimate_quota(uuid, integer, integer) TO service_role;
