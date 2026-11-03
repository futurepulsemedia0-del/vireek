/*
  # Cloned voice: explicit consent, per-account selection, server-only control

  ## Why
  The `clone-voice` function stored a cloned ElevenLabs voice on
  `business_profile`, but (a) nothing recorded WHO agreed to clone WHICH voice
  and WHEN, (b) no call path could use the clone, and (c) because the owner can
  UPDATE their own business_profile row through RLS, an owner could have written
  an arbitrary `custom_voice_id` / `custom_voice_status = 'ready'` by hand.

  ## What this does (purely additive)
  - `use_custom_voice`          boolean, default false. The owner's picker choice.
  - `custom_voice_consent_at`   timestamptz. Set by the server when cloning starts.
  - `custom_voice_consent_by`   uuid. auth user who confirmed consent (server-set).
  - CHECK: the clone can only be selected when consent is recorded.
  - Trigger: signed-in users (JWT with a subject) cannot write the server-managed
    columns (custom_voice_id/status/error, consent_at/by). The service role used by
    the edge functions is unaffected.

  RLS is unchanged: the existing per-account policies already scope the row.

  ## Rollback (manual, not run automatically)
    DROP TRIGGER IF EXISTS business_profile_protect_custom_voice ON business_profile;
    DROP FUNCTION IF EXISTS public.protect_custom_voice_columns();
    ALTER TABLE business_profile DROP CONSTRAINT IF EXISTS business_profile_custom_voice_requires_consent;
  (Leave the three columns in place; they are harmless.)
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS use_custom_voice boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_voice_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS custom_voice_consent_by uuid;

ALTER TABLE business_profile
  DROP CONSTRAINT IF EXISTS business_profile_custom_voice_requires_consent;
ALTER TABLE business_profile
  ADD CONSTRAINT business_profile_custom_voice_requires_consent
  CHECK (NOT use_custom_voice OR (custom_voice_consent_at IS NOT NULL AND custom_voice_consent_by IS NOT NULL));

CREATE OR REPLACE FUNCTION public.protect_custom_voice_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role / direct SQL have no JWT subject: allowed (edge functions).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.custom_voice_id IS NOT NULL
       OR NEW.custom_voice_status IS DISTINCT FROM 'none'
       OR NEW.custom_voice_error IS NOT NULL
       OR NEW.custom_voice_consent_at IS NOT NULL
       OR NEW.custom_voice_consent_by IS NOT NULL THEN
      RAISE EXCEPTION 'Custom voice fields are managed by the server.' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.custom_voice_id IS DISTINCT FROM OLD.custom_voice_id
     OR NEW.custom_voice_status IS DISTINCT FROM OLD.custom_voice_status
     OR NEW.custom_voice_error IS DISTINCT FROM OLD.custom_voice_error
     OR NEW.custom_voice_consent_at IS DISTINCT FROM OLD.custom_voice_consent_at
     OR NEW.custom_voice_consent_by IS DISTINCT FROM OLD.custom_voice_consent_by THEN
    RAISE EXCEPTION 'Custom voice fields are managed by the server.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_profile_protect_custom_voice ON business_profile;
CREATE TRIGGER business_profile_protect_custom_voice
  BEFORE INSERT OR UPDATE ON business_profile
  FOR EACH ROW EXECUTE FUNCTION public.protect_custom_voice_columns();
