-- Visual AI Estimating: upload a photo of the problem, get an AI-drafted
-- line-item estimate to start a Quote from. Built as an extension of the
-- existing quotes/leads workflow (not a parallel system).

-- 1) Private storage for uploaded estimate photos, same folder-scoped
--    pattern already used by voice-samples.
INSERT INTO storage.buckets (id, name, public)
VALUES ('estimate-photos', 'estimate-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "users_manage_own_estimate_photos" ON storage.objects;
CREATE POLICY "users_manage_own_estimate_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'estimate-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'estimate-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 2) Provenance fields on quotes — purely additive, defaulted, so nothing
--    that already reads/writes `quotes` is affected.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_detected_issue text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric,
  ADD COLUMN IF NOT EXISTS source_photo_paths text[];

COMMENT ON COLUMN quotes.ai_generated IS 'True if line_items originated from Visual AI Estimating (still human-reviewed before send).';

-- 3) Rate limit — service-role only from the start (see the lesson learned
--    fixing ai_assistant_rate_limit: never grant the authenticated role a
--    write path on its own counter, or it can reset itself via the REST API).
CREATE TABLE IF NOT EXISTS visual_estimate_rate_limit (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE visual_estimate_rate_limit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the visual-estimate Edge Function's
-- service-role client may read/write this table.
