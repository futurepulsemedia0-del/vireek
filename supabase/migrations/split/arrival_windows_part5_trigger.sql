-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_jobs_arrival_window_sync ON jobs;
CREATE TRIGGER trg_jobs_arrival_window_sync
  BEFORE UPDATE OF assigned_technician_id, scheduled_datetime, job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_arrival_window_sync();
