-- Add an estimated-duration column to jobs
-- Used by the new Dispatch Calendar (src/pages/CalendarPage.tsx) to show how
-- long a job is expected to take. Defaults to 60 minutes so existing rows
-- and any client that doesn't set it still behave sensibly.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 60;

-- No RLS changes needed: duration_minutes is covered by the existing
-- select/update policies on the jobs table (same row, same owner/team
-- scoping already enforced via public.get_account_owner_id()).
