/*
  # Booking Settings — public booking controls

  ## What this adds
  Owner-controlled settings for the public /book/:slug flow, stored on the
  existing `business_profile` row (so the existing get_account_owner_id()
  RLS policies already cover team members — no new policy needed):
  - booking_hours            custom booking hours (NULL = follow business_hours)
  - booking_buffer_*         quiet time before / after each booking
  - booking_hidden_services  services hidden from the public page
  - booking_deposit_*        deposit amount (cents) + policy text
  - booking_intake_questions up to 8 questions asked at booking time
  - booking_branding         accent colour, logo, headline, intro, confirmation

  ## Why new functions instead of editing the old ones
  get_business_for_booking / get_booking_window_slots / create_public_booking
  are left untouched on purpose (create_public_booking has evolved — referral
  attribution, customer matching — and replacing it blind could silently drop
  that behaviour). The new functions sit beside them:
  - get_booking_public_settings       PII-free settings for the page
  - get_booking_busy_window           busy start + duration (needed for buffers)
  - create_public_booking_with_settings  validates service / intake / buffers,
    then CALLS the existing create_public_booking for the real insert.

  Additive and idempotent — safe to run twice.
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS booking_hours jsonb,
  ADD COLUMN IF NOT EXISTS booking_buffer_before_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS booking_buffer_after_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS booking_hidden_services text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS booking_deposit_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS booking_deposit_policy text,
  ADD COLUMN IF NOT EXISTS booking_intake_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS booking_branding jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS booking_intake jsonb,
  ADD COLUMN IF NOT EXISTS booking_deposit_due_cents integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_booking_settings_ranges') THEN
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_booking_settings_ranges CHECK (
      booking_buffer_before_minutes BETWEEN 0 AND 240
      AND booking_buffer_after_minutes BETWEEN 0 AND 240
      AND booking_deposit_cents BETWEEN 0 AND 1000000
      AND jsonb_typeof(booking_intake_questions) = 'array'
      AND jsonb_array_length(booking_intake_questions) <= 8
      AND jsonb_typeof(booking_branding) = 'object'
      AND (booking_hours IS NULL OR jsonb_typeof(booking_hours) = 'object')
    );
  END IF;

  -- Columns that already existed: NOT VALID = enforced for new writes only,
  -- so any out-of-range legacy value cannot make this migration fail.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_booking_core_ranges') THEN
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_booking_core_ranges CHECK (
      booking_default_duration_minutes BETWEEN 15 AND 480
      AND booking_lead_time_hours BETWEEN 0 AND 720
      AND booking_window_days BETWEEN 1 AND 365
    ) NOT VALID;
  END IF;
END $$;

-- Public, PII-free settings for the booking page. Returns NULL unless the
-- slug exists AND booking is enabled, so a disabled page leaks nothing.
CREATE OR REPLACE FUNCTION public.get_booking_public_settings(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'hours', coalesce(bp.booking_hours, bp.business_hours),
    'buffer_before', bp.booking_buffer_before_minutes,
    'buffer_after', bp.booking_buffer_after_minutes,
    'hidden_services', to_jsonb(bp.booking_hidden_services),
    'deposit_cents', bp.booking_deposit_cents,
    'deposit_policy', bp.booking_deposit_policy,
    'intake_questions', bp.booking_intake_questions,
    'branding', bp.booking_branding
  )
  FROM business_profile bp
  WHERE bp.booking_slug = p_slug AND bp.booking_enabled
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_public_settings(text) TO anon, authenticated;

-- Busy start + duration (buffers need real durations, not just start times).
CREATE OR REPLACE FUNCTION public.get_booking_busy_window(p_slug text, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (scheduled_datetime timestamptz, duration_minutes integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.scheduled_datetime, j.duration_minutes
  FROM jobs j
  JOIN business_profile bp ON bp.user_id = j.user_id
  WHERE bp.booking_slug = p_slug
    AND bp.booking_enabled
    AND j.scheduled_datetime >= p_start
    AND j.scheduled_datetime < p_end
    AND j.job_status IN ('scheduled', 'en_route', 'in_progress');
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_busy_window(text, timestamptz, timestamptz) TO anon, authenticated;

-- The write path for the public page once settings exist. Validates what the
-- owner configured, then delegates the actual insert to the existing
-- create_public_booking (lead time, customer matching, referral attribution
-- and the jobs_no_double_booking constraint all still apply).
CREATE OR REPLACE FUNCTION public.create_public_booking_with_settings(
  p_slug text, p_customer_name text, p_customer_phone text, p_customer_email text,
  p_service_type text, p_scheduled_datetime timestamptz, p_notes text, p_channel text,
  p_ref_code text DEFAULT NULL,
  p_intake_answers jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  q jsonb;
  v_ans text;
  v_intake jsonb := '[]'::jsonb;
  v_lines text := '';
  v_job_id uuid;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE booking_slug = p_slug;
  IF NOT FOUND OR NOT bp.booking_enabled THEN
    RAISE EXCEPTION 'booking_not_available';
  END IF;

  IF p_service_type IS NOT NULL AND p_service_type = ANY (bp.booking_hidden_services) THEN
    RAISE EXCEPTION 'service_unavailable';
  END IF;

  IF jsonb_typeof(coalesce(p_intake_answers, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'intake_invalid';
  END IF;

  FOR q IN SELECT value FROM jsonb_array_elements(bp.booking_intake_questions) LOOP
    v_ans := left(btrim(coalesce(p_intake_answers ->> (q ->> 'id'), '')), 1000);
    IF v_ans = '' THEN
      IF coalesce((q ->> 'required')::boolean, false) THEN
        RAISE EXCEPTION 'intake_required';
      END IF;
      CONTINUE;
    END IF;
    IF q ->> 'type' = 'select' AND NOT coalesce((q -> 'options') ? v_ans, false) THEN
      RAISE EXCEPTION 'intake_invalid';
    END IF;
    IF q ->> 'type' = 'yesno' AND v_ans NOT IN ('yes', 'no') THEN
      RAISE EXCEPTION 'intake_invalid';
    END IF;
    v_intake := v_intake || jsonb_build_array(
      jsonb_build_object('id', q ->> 'id', 'label', q ->> 'label', 'answer', v_ans)
    );
    v_lines := v_lines || E'\n- ' || (q ->> 'label') || ': ' || v_ans;
  END LOOP;

  -- Buffers: same rule as the client slot engine (src/lib/bookingPolicy.ts).
  IF EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.user_id = bp.user_id
      AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
      AND j.scheduled_datetime IS NOT NULL
      AND j.scheduled_datetime < p_scheduled_datetime
        + make_interval(mins => bp.booking_default_duration_minutes + bp.booking_buffer_after_minutes)
      AND j.scheduled_datetime + make_interval(mins => coalesce(j.duration_minutes, 60))
        > p_scheduled_datetime - make_interval(mins => bp.booking_buffer_before_minutes)
  ) THEN
    RAISE EXCEPTION 'slot_taken';
  END IF;

  v_job_id := public.create_public_booking(
    p_slug => p_slug,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    p_service_type => p_service_type,
    p_scheduled_datetime => p_scheduled_datetime,
    p_notes => nullif(btrim(
      coalesce(p_notes, '') || CASE WHEN v_lines <> '' THEN E'\n\nIntake answers:' || v_lines ELSE '' END
    ), ''),
    p_channel => p_channel,
    p_ref_code => p_ref_code
  );

  UPDATE jobs
  SET booking_intake = CASE WHEN jsonb_array_length(v_intake) > 0 THEN v_intake END,
      booking_deposit_due_cents = nullif(bp.booking_deposit_cents, 0)
  WHERE id = v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'deposit_due_cents', bp.booking_deposit_cents);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_public_booking_with_settings(
  text, text, text, text, text, timestamptz, text, text, text, jsonb
) TO anon, authenticated;
