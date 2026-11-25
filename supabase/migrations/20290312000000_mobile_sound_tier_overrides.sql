-- Per-person "sound off" override for notification sound tiers (see docs/notifications/sound-tiers.md).
-- Empty array = every tier uses its default sound. Honoured server-side by send-push-notification:
-- iOS omits `sound`, Android uses the quiet channel, web sends `silent: true`.
-- Existing RLS policies on user_mobile_surface_prefs already restrict rows to their owner; no new policy needed.

ALTER TABLE public.user_mobile_surface_prefs
  ADD COLUMN IF NOT EXISTS sound_off_tiers text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.user_mobile_surface_prefs
  DROP CONSTRAINT IF EXISTS user_mobile_surface_prefs_sound_off_tiers_check;
ALTER TABLE public.user_mobile_surface_prefs
  ADD CONSTRAINT user_mobile_surface_prefs_sound_off_tiers_check
  CHECK (sound_off_tiers <@ ARRAY['emergency', 'alert', 'normal', 'message', 'quiet']::text[]);

-- Rollback: ALTER TABLE public.user_mobile_surface_prefs DROP CONSTRAINT IF EXISTS user_mobile_surface_prefs_sound_off_tiers_check;
--           ALTER TABLE public.user_mobile_surface_prefs DROP COLUMN IF EXISTS sound_off_tiers;
