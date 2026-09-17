/*
  # Double-Booking Protection — enforced by Postgres, not app code

  ## Why
  Nothing today stops two jobs from being saved with overlapping times for
  the same technician (or, for solo operators who never assign a
  technician, for the business itself):
  - toolBookAppointment (vapi-webhook) inserts a job with no time-conflict
    check at all.
  - assignBestTechnician (_shared/dispatch/assign.ts) only counts SAME-DAY
    job *count* per technician for capacity — it never checks whether the
    technician is already booked at that exact hour.
  - DispatchBoardPage.tsx's drag-and-drop assignment and CalendarPage.tsx's
    manual reschedule/drag-to-reschedule both write straight to `jobs`
    with no overlap check either.

  An application-level "check then insert" is never actually safe against
  two simultaneous requests (two callers booking the same slot at the same
  moment, or the AI and a human dispatcher racing each other) — only a
  real database constraint closes that race. Hence this migration, not
  more application code.

  ## What this does
  Uses a GiST EXCLUDE constraint (Postgres's mechanism for "no two rows
  may have overlapping ranges for the same key") instead of a trigger, so
  the guarantee holds no matter what writes the row — this app's code,
  a future integration, or someone in the Supabase SQL editor.

  - `booking_range`: a generated tstzrange from `scheduled_datetime` to
    `scheduled_datetime + duration_minutes` (duration_minutes already
    exists, added in 20260905140000_add_job_duration_minutes.sql, NOT
    NULL DEFAULT 60).
  - `booking_resource`: the thing that can't be in two places at once —
    the assigned technician if one is set, otherwise the business as a
    whole (`business:<user_id>`). This is what makes the constraint cover
    BOTH cases the requester asked for ("Technician یا Time Slot"):
    solo operators who never assign a technician still get a hard stop on
    double-booking their one shared calendar, and multi-tech businesses
    get true per-technician protection instead of a blanket one.
  - The EXCLUDE constraint only applies to jobs that actually occupy time
    (scheduled_datetime IS NOT NULL) and are still "live"
    ('scheduled' | 'en_route' | 'in_progress' — the same status list
    assign.ts and the customer-reschedule slot lookup already use).
    Cancelled/completed jobs free up their slot automatically.

  ## Before running this in an environment with existing data
  If any two currently-stored jobs already overlap for the same
  technician/business, `ADD CONSTRAINT` below will fail (Postgres refuses
  to add a constraint the existing data violates) — safer than silently
  ignoring a conflict that's already there. Run this first to find them:

    SELECT a.id, b.id, a.customer_name, b.customer_name,
           a.scheduled_datetime, b.scheduled_datetime
    FROM jobs a JOIN jobs b ON a.id < b.id
    WHERE a.user_id = b.user_id
      AND COALESCE(a.assigned_technician_id::text, 'business:' || a.user_id::text)
        = COALESCE(b.assigned_technician_id::text, 'business:' || b.user_id::text)
      AND a.job_status IN ('scheduled','en_route','in_progress')
      AND b.job_status IN ('scheduled','en_route','in_progress')
      AND tstzrange(a.scheduled_datetime, a.scheduled_datetime + (a.duration_minutes || ' minutes')::interval, '[)')
       && tstzrange(b.scheduled_datetime, b.scheduled_datetime + (b.duration_minutes || ' minutes')::interval, '[)');

  Resolve those manually (reschedule/cancel one of each pair), then run
  this migration.
*/

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS booking_range tstzrange
    GENERATED ALWAYS AS (
      CASE WHEN scheduled_datetime IS NOT NULL
        THEN tstzrange(
          scheduled_datetime,
          scheduled_datetime + (COALESCE(duration_minutes, 60) || ' minutes')::interval,
          '[)'
        )
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS booking_resource text
    GENERATED ALWAYS AS (
      COALESCE(assigned_technician_id::text, 'business:' || user_id::text)
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_jobs_booking_range ON jobs USING gist (booking_resource, booking_range);

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_no_double_booking;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_no_double_booking
  EXCLUDE USING gist (
    booking_resource WITH =,
    booking_range WITH &&
  )
  WHERE (job_status IN ('scheduled', 'en_route', 'in_progress') AND booking_range IS NOT NULL);

-- ---------------------------------------------------------------------
-- The one existing write path this constraint can reach that ISN'T
-- ordinary app code: the public, token-gated customer self-reschedule
-- RPC (20260912050000_customer_self_reschedule.sql). Without this, a
-- customer rescheduling into an already-booked slot would surface a raw
-- Postgres exclusion-violation error on a public, unauthenticated page
-- instead of the clean `false` this function already returns for "not
-- allowed". Re-declaring the whole function so the UPDATE is wrapped —
-- everything else about it is unchanged.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reschedule_job_by_token(p_token uuid, p_new_datetime timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_status text;
  v_allowed boolean;
BEGIN
  SELECT j.user_id, j.job_status, COALESCE(bp.allow_customer_self_reschedule, false)
  INTO v_user_id, v_status, v_allowed
  FROM jobs j
  LEFT JOIN business_profile bp ON bp.user_id = j.user_id
  WHERE j.reschedule_token = p_token;

  IF v_user_id IS NULL OR NOT v_allowed OR v_status <> 'scheduled' THEN
    RETURN false;
  END IF;

  UPDATE jobs
  SET scheduled_datetime = p_new_datetime,
      rescheduled_by_customer_at = now()
  WHERE reschedule_token = p_token;

  RETURN true;
EXCEPTION
  WHEN exclusion_violation THEN
    -- The requested slot overlaps another live job for the same
    -- technician/business — treat it the same as "not allowed" rather
    -- than leaking a database error to a public page.
    RETURN false;
END;
$$;
