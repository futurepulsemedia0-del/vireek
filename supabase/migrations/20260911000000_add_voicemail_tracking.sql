-- Adds voicemail tracking on top of the existing `calls` table.
-- Safe/idempotent: only adds columns + index, does not touch existing data or RLS policies.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS is_voicemail boolean NOT NULL DEFAULT false;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS voicemail_listened_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_calls_is_voicemail
  ON calls(is_voicemail)
  WHERE is_voicemail = true;

-- Existing RLS policies on `calls` (select_own_calls / insert_own_calls / update_own_calls)
-- already cover these new columns automatically since RLS is row-level, not column-level.
-- No new policy needed.
