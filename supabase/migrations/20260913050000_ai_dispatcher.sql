/*
  # AI Dispatcher — automatic technician assignment

  team_members already had skills/service_area/max_jobs_per_day/
  dispatch_enabled (20260912040000_dispatch_fields.sql), and
  src/lib/dispatch.ts already scores technicians for the *manual* "click
  to assign" flow on the Dispatch Board. Its own comment says exactly
  what was still missing: "the same shape you'd port into an edge
  function later so Sarah can call it live during a booking call."

  This migration is that port — a SQL mirror of suggestTechnicians()'s
  scoring (same weights: +10 skill match, +5 service-area match, load
  vs. max_jobs_per_day) that runs automatically as a trigger the instant
  a job is inserted or rescheduled with no technician assigned. This
  covers every path a job can be created from (a live call via
  book_appointment, the dashboard, a future API) — not just the
  dashboard's manual button.

  Keep this function's scoring in sync with src/lib/dispatch.ts by hand
  if either changes — they intentionally use the same weights so the
  dashboard's "suggested" list and what actually got auto-assigned never
  disagree, but nothing enforces that automatically.

  If NO technician qualifies (everyone at capacity, no skill/area match,
  or no technicians configured), assigned_technician_id is simply left
  NULL — the job falls through to the Dispatch Board's "Unassigned jobs"
  list exactly as it does today, for a human to place manually.
*/

CREATE OR REPLACE FUNCTION pick_best_technician(
  p_user_id uuid,
  p_service_type text,
  p_address text,
  p_scheduled_datetime timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  WITH candidates AS (
    SELECT
      tm.id,
      tm.max_jobs_per_day,
      (
        SELECT count(*) FROM jobs j
        WHERE j.assigned_technician_id = tm.id
          AND j.job_status <> 'cancelled'
          AND date_trunc('day', j.scheduled_datetime) = date_trunc('day', p_scheduled_datetime)
      ) AS today_load
    FROM team_members tm
    WHERE tm.account_owner_id = p_user_id
      AND tm.role = 'technician'
      AND tm.dispatch_enabled = true
      AND p_scheduled_datetime IS NOT NULL
  )
  SELECT c.id
  FROM candidates c
  JOIN team_members tm ON tm.id = c.id
  WHERE c.today_load < c.max_jobs_per_day
  ORDER BY
    (
      (c.max_jobs_per_day - c.today_load) * 2
      + CASE WHEN p_service_type IS NOT NULL AND p_service_type = ANY(tm.skills) THEN 10 ELSE 0 END
      + CASE WHEN tm.service_area IS NOT NULL AND p_address IS NOT NULL AND p_address ILIKE '%' || tm.service_area || '%' THEN 5 ELSE 0 END
    ) DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auto_dispatch_technician()
RETURNS trigger AS $$
BEGIN
  IF NEW.assigned_technician_id IS NULL AND NEW.job_status = 'scheduled' AND NEW.scheduled_datetime IS NOT NULL THEN
    NEW.assigned_technician_id := pick_best_technician(NEW.user_id, NEW.service_type, NEW.address, NEW.scheduled_datetime);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_dispatch_technician ON jobs;
CREATE TRIGGER trg_auto_dispatch_technician
  BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION auto_dispatch_technician();
