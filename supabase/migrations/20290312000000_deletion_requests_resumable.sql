/*
  Resumable erasure requests.

  data-retention-sweep now finishes a full_account erasure by deleting the auth user. If that step (or a
  worker crash) interrupts a run, the request must be picked up again without human help and without the
  owner being able to "cancel" an erasure that already removed their data.

  Adds, to public.deletion_requests:
    processing_started_at  lease timestamp: set when a run claims the request; a 'processing' row whose lease
                           is older than the lease window is considered abandoned and is retried.
    attempts               how many runs have claimed the request.
    last_error             short machine code of the last failure (never a raw error message).

  Safe to re-run (IF NOT EXISTS). RLS is unchanged: the owner can still only SELECT their rows and cancel a
  'grace_period' request; these columns are written only by the service-role sweep.
  Deploy order: apply this migration BEFORE deploying the data-retention-sweep function that reads the columns.
  Rollback (only if the new sweep is also rolled back):
    ALTER TABLE public.deletion_requests DROP COLUMN IF EXISTS processing_started_at, DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS last_error;
    DROP INDEX IF EXISTS public.deletion_requests_stale_processing_idx;
  NOT EXECUTED in authoring: run on a staging copy first.
*/

ALTER TABLE public.deletion_requests
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS deletion_requests_stale_processing_idx
  ON public.deletion_requests (processing_started_at)
  WHERE status = 'processing';

COMMENT ON COLUMN public.deletion_requests.processing_started_at IS 'Lease start of the run that claimed this request; stale leases are retried by data-retention-sweep.';
COMMENT ON COLUMN public.deletion_requests.attempts IS 'Number of sweep runs that claimed this request.';
COMMENT ON COLUMN public.deletion_requests.last_error IS 'Short machine code of the last failure. Never a raw error message (the owner can read this row).';
