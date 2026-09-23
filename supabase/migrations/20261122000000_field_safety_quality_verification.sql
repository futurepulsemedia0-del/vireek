-- Field Safety + Quality Verification via Computer Vision: technician
-- uploads job photos, an AI vision pass checks for incomplete evidence,
-- poor photo quality, unreadable serial/model numbers, and visible safety
-- hazards *before* the job is allowed to be marked complete. Built as an
-- extension of the existing job workflow, same idiom as visual-estimate
-- (private per-user storage bucket + service-role-only rate limit table).

-- 1) Private storage for uploaded evidence photos, same folder-scoped
--    pattern as estimate-photos / voice-samples.
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-evidence-photos', 'job-evidence-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "users_manage_own_job_evidence_photos" ON storage.objects;
CREATE POLICY "users_manage_own_job_evidence_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'job-evidence-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'job-evidence-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 2) One row per verification pass run against a job's uploaded photos.
CREATE TABLE IF NOT EXISTS job_evidence_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  photo_paths text[] NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'needs_attention', 'fail')),
  evidence_completeness numeric,
  quality_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_serials text[],
  ai_summary text,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_evidence_checks_job_id ON job_evidence_checks(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_evidence_checks_user_id ON job_evidence_checks(user_id) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_job_evidence_checks_verdict ON job_evidence_checks(verdict) WHERE resolved = false;

ALTER TABLE job_evidence_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_evidence_checks" ON job_evidence_checks;
CREATE POLICY "select_own_job_evidence_checks" ON job_evidence_checks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_job_evidence_checks" ON job_evidence_checks;
CREATE POLICY "update_own_job_evidence_checks" ON job_evidence_checks FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

-- INSERT is intentionally NOT granted to authenticated — only the
-- verify-job-evidence Edge Function's service-role client writes rows,
-- the same way analyze-equipment-lifecycle owns equipment_maintenance_alerts.
-- This keeps a technician from forging a "pass" verdict via the REST API.

-- 3) A lightweight flag jobs can be gated on: is there at least one
--    unresolved fail/needs_attention check against this job.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS evidence_verified_at timestamptz;

COMMENT ON COLUMN jobs.evidence_verified_at IS 'Set when the job''s most recent evidence check verdict was pass. Null/stale means field evidence has not cleared verification.';

-- 4) Rate limit — service-role only, same lesson-learned pattern as
--    visual_estimate_rate_limit: never give authenticated a write path on
--    its own counter.
CREATE TABLE IF NOT EXISTS job_evidence_rate_limit (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE job_evidence_rate_limit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the verify-job-evidence Edge Function's
-- service-role client may read/write this table.
