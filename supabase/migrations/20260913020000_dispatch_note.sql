/*
# AI technician suggestion note on jobs

## Why
team_members.skills / service_area / max_jobs_per_day / dispatch_enabled
already exist (20260912040000_dispatch_fields.sql), and
src/lib/dispatch.ts already ranks technicians by skill match + remaining
capacity — but only client-side, when a human dispatcher opens the
Dispatch Board. Sarah (the phone AI) has no access to any of this during
the call itself, so a booked job carries no hint of which technician
fits until a human happens to open that board.

## What this does
Adds ONE nullable text column, `dispatch_note`, to `jobs` — purely
informational. It is deliberately NOT `assigned_technician_id`: that
column means "a human has committed this job to a technician" and drives
the Dispatch Board's `unassignedJobs` filter (see DispatchBoardPage.tsx).
Writing to it from the webhook would silently remove jobs from that
human-review queue. `dispatch_note` instead holds a short suggestion
string (e.g. "Suggested technician: Mike — skill match: HVAC, 2/6 jobs
that day") that a human dispatcher can read as context — the Dispatch
Board's own live suggestion ranking remains the actual source of truth
for who gets assigned.

Defaults to NULL — no existing job or behavior changes.
*/

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS dispatch_note text;
