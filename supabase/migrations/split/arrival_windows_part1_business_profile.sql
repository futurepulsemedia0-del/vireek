-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Settings (business_profile)
-- ---------------------------------------------------------------------------
ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS arrival_windows_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arrival_window_options_minutes integer[] NOT NULL DEFAULT '{60,120,180,240}',
  ADD COLUMN IF NOT EXISTS arrival_window_narrow_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS arrival_window_grace_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_window_notify_customer boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_arrival_window_ranges') THEN
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_arrival_window_ranges CHECK (
      arrival_window_narrow_minutes BETWEEN 60 AND 240
      AND arrival_window_narrow_minutes % 15 = 0
      AND arrival_window_grace_minutes BETWEEN 0 AND 60
      AND cardinality(arrival_window_options_minutes) BETWEEN 1 AND 4
      AND arrival_window_options_minutes <@ ARRAY[60, 120, 180, 240]
    );
  END IF;
END $$;
