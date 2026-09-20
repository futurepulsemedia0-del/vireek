/*
  # Online Booking Engine
  One shared, public, no-login booking flow every channel points at:
  /book/:booking_slug. Voice booking (vapi-webhook) already writes to the
  same `jobs` table, protected by the same jobs_no_double_booking
  constraint — so every channel, voice included, converges on one source
  of truth. Same security pattern as customer_self_reschedule: RLS stays
  closed to anon, all public access goes through SECURITY DEFINER functions.
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS booking_slug text UNIQUE,
  ADD COLUMN IF NOT EXISTS booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS booking_default_duration_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS booking_lead_time_hours integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS booking_window_days integer NOT NULL DEFAULT 14;

ALTER TABLE business_profile
  ADD CONSTRAINT business_profile_booking_slug_format
  CHECK (booking_slug IS NULL OR booking_slug ~ '^[a-z0-9-]{3,60}$');

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS booking_channel text;

-- PII-free: what the public booking page needs to render itself.
CREATE OR REPLACE FUNCTION public.get_business_for_booking(p_slug text)
RETURNS TABLE (
  business_name text,
  services_offered text[],
  business_hours jsonb,
  holidays jsonb,
  default_duration_minutes integer,
  lead_time_hours integer,
  window_days integer,
  booking_enabled boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.company_name, bp.services_offered, bp.business_hours, bp.holidays,
    bp.booking_default_duration_minutes, bp.booking_lead_time_hours,
    bp.booking_window_days, bp.booking_enabled
  FROM business_profile bp
  JOIN profiles p ON p.id = bp.user_id
  WHERE bp.booking_slug = p_slug
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_business_for_booking(text) TO anon, authenticated;

-- PII-free: just the already-booked timestamps, for slot-picking client-side.
CREATE OR REPLACE FUNCTION public.get_booking_window_slots(p_slug text, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (scheduled_datetime timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.scheduled_datetime
  FROM jobs j
  JOIN business_profile bp ON bp.user_id = j.user_id
  WHERE bp.booking_slug = p_slug
    AND j.scheduled_datetime >= p_start
    AND j.scheduled_datetime < p_end
    AND j.job_status IN ('scheduled', 'en_route', 'in_progress');
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_window_slots(text, timestamptz, timestamptz) TO anon, authenticated;

-- The only write path a stranger on the internet gets: slug-scoped,
-- opt-in-gated, and still protected by jobs_no_double_booking underneath.
CREATE OR REPLACE FUNCTION public.create_public_booking(
  p_slug text, p_customer_name text, p_customer_phone text, p_customer_email text,
  p_service_type text, p_scheduled_datetime timestamptz, p_notes text, p_channel text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_enabled boolean;
  v_lead_hours integer;
  v_duration integer;
  v_new_lead_id uuid;
  v_new_job_id uuid;
BEGIN
  SELECT bp.user_id, bp.booking_enabled, bp.booking_lead_time_hours, bp.booking_default_duration_minutes
  INTO v_user_id, v_enabled, v_lead_hours, v_duration
  FROM business_profile bp
  WHERE bp.booking_slug = p_slug;

  IF v_user_id IS NULL OR NOT v_enabled THEN
    RAISE EXCEPTION 'booking_not_available';
  END IF;

  IF p_scheduled_datetime < now() + make_interval(hours => v_lead_hours) THEN
    RAISE EXCEPTION 'too_soon';
  END IF;

  IF trim(coalesce(p_customer_name, '')) = '' THEN
    RAISE EXCEPTION 'missing_customer_name';
  END IF;

  INSERT INTO leads (user_id, name, phone, email, service_interested, notes)
  VALUES (v_user_id, p_customer_name, p_customer_phone, p_customer_email, p_service_type, p_notes)
  RETURNING id INTO v_new_lead_id;

  INSERT INTO jobs (user_id, lead_id, customer_name, service_type, scheduled_datetime, duration_minutes, job_status, booking_channel)
  VALUES (v_user_id, v_new_lead_id, p_customer_name, p_service_type, p_scheduled_datetime, v_duration, 'scheduled', coalesce(p_channel, 'web_booking'))
  RETURNING id INTO v_new_job_id;

  RETURN v_new_job_id;
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION 'slot_taken';
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_public_booking(text, text, text, text, text, timestamptz, text, text) TO anon, authenticated;
