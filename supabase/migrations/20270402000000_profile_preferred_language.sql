/*
  # Per-user UI language preference

  - profiles.preferred_language: nullable, restricted to the 9 supported UI languages.
  - No new RLS needed: "update_own_profile" already lets a user update their own row.
*/

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_language text;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_preferred_language_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_preferred_language_check
  CHECK (
    preferred_language IS NULL
    OR preferred_language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja')
  );
