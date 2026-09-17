/*
  # Rework Intelligence

  Detects, at the moment a new job is created, whether it's actually a
  repeat visit for a problem that was supposedly already fixed — i.e. the
  same customer, same service_type, with an earlier COMPLETED job that's
  either still within its warranty window (`warranty_expires_at`, when a
  warranty was recorded) or was completed within the last 45 days (when it
  wasn't). This is deliberately computed server-side, once, in a trigger —
  jobs get created from many different places (JobsPage, lead conversion,
  the AI dispatcher, outbound flows), and detecting this in application
  code would mean duplicating the logic at every one of those call sites
  and inevitably missing one. A trigger can't be missed.

  ## What this does
  - Adds `is_rework` (boolean, default false) and `rework_of_job_id`
    (uuid, references the earlier job) to `jobs`.
  - `set_job_rework_flag()` / `trg_set_job_rework_flag`: BEFORE INSERT,
    looks for the customer's most recent completed job with the same
    service_type that's still "fresh" per the rule above. If found, flags
    the new job as a rework and links it back to that job.
  - Customer matching prefers `customer_id` (the normalized customers
    table) and falls back to `customer_phone` for jobs created before a
    customer record existed — same fallback pattern already used
    elsewhere for phone-based lookups (see caller_intelligence).
  - This never blocks or fails job creation: if there's no match, the job
    is inserted normally with is_rework = false.

  Consumed by `src/components/ReworkIntelligence.tsx` (aggregated into a
  leaderboard by service type and technician on the Analytics page) — this
  migration only sets the flag, it doesn't do any reporting itself.
*/

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS is_rework boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rework_of_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_rework_of_job_id ON jobs(rework_of_job_id) WHERE rework_of_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id_service_status ON jobs(customer_id, service_type, job_status) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_customer_phone_service_status ON jobs(customer_phone, service_type, job_status) WHERE customer_phone IS NOT NULL;

CREATE OR REPLACE FUNCTION set_job_rework_flag()
RETURNS trigger AS $$
DECLARE
  matched_job jobs%ROWTYPE;
BEGIN
  IF NEW.service_type IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO matched_job
  FROM jobs
  WHERE user_id = NEW.user_id
    AND job_status = 'completed'
    AND service_type = NEW.service_type
    AND (
      (NEW.customer_id IS NOT NULL AND customer_id = NEW.customer_id)
      OR (NEW.customer_phone IS NOT NULL AND customer_phone = NEW.customer_phone)
    )
    AND (
      (warranty_expires_at IS NOT NULL AND warranty_expires_at >= CURRENT_DATE)
      OR (completed_at IS NOT NULL AND completed_at >= now() - interval '45 days')
    )
  ORDER BY completed_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    NEW.is_rework := true;
    NEW.rework_of_job_id := matched_job.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_job_rework_flag ON jobs;
CREATE TRIGGER trg_set_job_rework_flag
  BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_job_rework_flag();
