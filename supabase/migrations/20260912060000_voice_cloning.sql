/*
  # Real voice cloning

  Adds fields to store a business's own cloned voice (via ElevenLabs),
  and a private storage bucket to hold the uploaded sample before cloning.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS custom_voice_id text,
ADD COLUMN IF NOT EXISTS custom_voice_status text NOT NULL DEFAULT 'none'
  CHECK (custom_voice_status IN ('none', 'processing', 'ready', 'failed')),
ADD COLUMN IF NOT EXISTS custom_voice_error text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-samples', 'voice-samples', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "users_manage_own_voice_samples" ON storage.objects;
CREATE POLICY "users_manage_own_voice_samples"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'voice-samples' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'voice-samples' AND (storage.foldername(name))[1] = auth.uid()::text);
