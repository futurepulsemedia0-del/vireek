/*
  # Dispatch fields on team_members

  Adds what the AI Dispatcher needs to rank technicians for a job:
  skills, a free-text service area, daily job capacity, and an
  on/off switch per technician.
*/

ALTER TABLE team_members
ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS service_area text,
ADD COLUMN IF NOT EXISTS max_jobs_per_day integer NOT NULL DEFAULT 6,
ADD COLUMN IF NOT EXISTS dispatch_enabled boolean NOT NULL DEFAULT true;
