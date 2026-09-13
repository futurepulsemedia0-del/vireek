/*
  # Customer self-reschedule

  Lets a customer reschedule their own scheduled job from a private,
  token-based link — no login, no exposure of other customers' data.
  Same security pattern as demo_bookings: RLS stays closed, and all
  public access goes through narrow SECURITY DEFINER functions.
*/

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS reschedule_token uuid NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN IF NOT EXISTS rescheduled_by_customer_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_reschedule_token ON jobs(reschedule_token);

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS allow_customer_self_reschedule boolean NOT NULL DEFAULT false;

-- Public, token-gated lookup. Returns only what's needed to show the page —
-- no phone/email, no other jobs, no other customers.
CREATE OR REPLACE FUNCTION public.get_job_for_reschedule(p_token uuid)
RETURNS TABLE (
  job_id uuid,
  customer_name text,
  service_type text,
  scheduled_datetime timestamptz,
  duration_minutes integer,
  job_status text,
  business_name text,
  allow_reschedule boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    j.id,
    j.customer_name,
    j.service_type,
    j.scheduled_datetime,
    j.duration_minutes,
    j.job_status,
    p.company_name,
    COALESCE(bp.allow_customer_self_reschedule, false)
  FROM jobs j
  JOIN profiles p ON p.id = j.user_id
  LEFT JOIN business_profile bp ON bp.user_id = j.user_id
  WHERE j.reschedule_token = p_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_job_for_reschedule(uuid) TO anon, authenticated;

-- PII-free: only the already-booked timestamps for that business, for slot-picking.
CREATE OR REPLACE FUNCTION public.get_business_booked_slots(p_token uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (scheduled_datetime timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j2.scheduled_datetime
  FROM jobs j2
  WHERE j2.user_id = (SELECT j.user_id FROM jobs j WHERE j.reschedule_token = p_token)
    AND j2.scheduled_datetime >= p_start
    AND j2.scheduled_datetime < p_end
    AND j2.job_status IN ('scheduled', 'en_route', 'in_progress');
$$;

GRANT EXECUTE ON FUNCTION public.get_business_booked_slots(uuid, timestamptz, timestamptz) TO anon, authenticated;

-- The only write path a customer gets: token-scoped, opt-in-gated, status-checked.
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.reschedule_job_by_token(uuid, timestamptz) TO anon, authenticated;
