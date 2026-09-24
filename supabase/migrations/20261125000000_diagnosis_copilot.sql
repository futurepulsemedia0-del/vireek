/*
  # AI Diagnosis-to-Resolution Copilot (diagnosis-copilot)

  Technician symptoms + meter/gauge readings + optional equipment photos become
  ranked probable causes, an ordered diagnostic test plan, likely parts needed,
  safety warnings and a step-by-step repair path.

  Purely additive - touches nothing that already exists.

  1. diagnosis_sessions       one row per AI diagnosis run (audit trail / history),
                               optionally linked to a job and/or an equipment record.
  2. diagnosis-copilot-photos PRIVATE bucket for equipment photos, owner
                               folder-scoped, size + mime limited.
  3. consume_diagnosis_copilot_quota()
                               atomic per-user hourly quota, callable ONLY by
                               the service role (no client write path) - same
                               pattern as consume_field_estimate_quota().

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) History / audit table ------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnosis_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  equipment_label text,
  symptoms text NOT NULL,
  meter_readings text,
  photo_paths text[] NOT NULL DEFAULT '{}',
  ai_result jsonb NOT NULL,
  severity text NOT NULL DEFAULT 'low',
  confidence numeric,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnosis_sessions_severity_check') THEN
    ALTER TABLE diagnosis_sessions
      ADD CONSTRAINT diagnosis_sessions_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'emergency'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_diagnosis_sessions_user_created
  ON diagnosis_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnosis_sessions_job
  ON diagnosis_sessions(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE diagnosis_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_diagnosis_sessions" ON diagnosis_sessions;
CREATE POLICY "users_read_own_diagnosis_sessions"
ON diagnosis_sessions
FOR SELECT
TO authenticated
USING (user_id = auth.uid());
-- Intentionally no INSERT/UPDATE/DELETE policy for authenticated: only the
-- diagnosis-copilot Edge Function (service role) writes to this table, so a
-- forged severity/confidence can never be written by the client directly.

-- 2) Private photo bucket ---------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'diagnosis-copilot-photos',
  'diagnosis-copilot-photos',
  false,
  8388608, -- 8 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_diagnosis_copilot_photos" ON storage.objects;
CREATE POLICY "users_manage_own_diagnosis_copilot_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'diagnosis-copilot-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'diagnosis-copilot-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 3) Atomic quota (service-role only) ---------------------------------------
CREATE TABLE IF NOT EXISTS diagnosis_copilot_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE diagnosis_copilot_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only this migration's RPC (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_diagnosis_copilot_quota(
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
  INSERT INTO diagnosis_copilot_usage AS u (user_id, window_start, request_count)
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

REVOKE ALL ON FUNCTION public.consume_diagnosis_copilot_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_diagnosis_copilot_quota(uuid, integer, integer) TO service_role;
