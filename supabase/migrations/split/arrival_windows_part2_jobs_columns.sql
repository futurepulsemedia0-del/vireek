-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 2. Job columns
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS arrival_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_end timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_original_start timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_original_end timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_narrowed_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_confirmed_at timestamptz,
  -- Columns this feature reads. They normally already exist (technician mobile OS / telematics migrations);
  -- IF NOT EXISTS makes this migration safe to run on a database where those were never applied.
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS telematics_arrived_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_arrival_window_shape') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_arrival_window_shape CHECK (
      (arrival_window_start IS NULL AND arrival_window_end IS NULL)
      OR (
        arrival_window_start IS NOT NULL AND arrival_window_end IS NOT NULL
        AND arrival_window_end - arrival_window_start BETWEEN interval '60 minutes' AND interval '240 minutes'
      )
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_arrival_window_report
  ON jobs (user_id, arrival_window_end)
  WHERE arrival_window_start IS NOT NULL;
