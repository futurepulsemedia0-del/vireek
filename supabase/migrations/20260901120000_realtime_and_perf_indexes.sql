/*
# Realtime enablement + pagination indexes

## What this migration does
Prompt 11 (real-time updates) needs Postgres logical replication to actually
stream `calls` and `jobs` changes to Supabase Realtime clients, and prompt 14
(performance pass) needs indexes that match the new bounded/paginated
queries the frontend now issues. `notifications` already got this treatment
in the previous migration (20260831090000) — this extends the same pattern
to the two tables step 11 asks for.

## Realtime
- Adds `calls` and `jobs` to the `supabase_realtime` publication so
  `postgres_changes` subscriptions receive INSERT/UPDATE events for them.
  Wrapped in a DO block because `ALTER PUBLICATION ... ADD TABLE` throws
  `duplicate_object` if the table is already a member (e.g. if the project
  has "all tables" realtime enabled via the dashboard already) — we want
  this migration to be safe to run either way.
- Sets `REPLICA IDENTITY FULL` on `jobs` so UPDATE payloads include the full
  old row (needed for the Jobs board to know exactly which job/status
  changed, the same reason it was already set on `notifications`). `calls`
  only needs INSERT payloads for this feature, whose "new row" is already
  complete under the default replica identity, so it's left as-is.

## Indexes
Composite indexes for the new bounded, most-recent-first fetches used by
Calls (`/dashboard/calls`) and the Jobs board (`/dashboard/jobs`), so
"most recent N rows" and "load older" pagination stay index-only scans
instead of full sequential scans as these tables grow.
*/

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE calls;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    -- supabase_realtime publication doesn't exist yet on this project;
    -- nothing to do, the dashboard's Realtime toggle will create it.
    NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE jobs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE jobs REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_calls_user_datetime ON calls (user_id, call_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs (user_id, job_status);
