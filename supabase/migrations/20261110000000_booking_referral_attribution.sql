/*
  # Customer Experience OS — Phase 4: Referral Attribution at Booking

  ## Why
  Phase 3 gave customers their own shareable referral link and a public
  `/r/:code` landing that forwards a friend into `/book/:slug?ref=CODE`.
  But `create_public_booking()` (20261011000000_online_booking_engine.sql)
  never created or linked a `customers` row at all — every self-booked
  job had `customer_id = NULL`. That's the actual reason the existing
  auto-conversion trigger (`marketing_handle_job_status_change`, which
  reads `customers.referred_by_code`) could never fire for a booking-flow
  customer: there was no `customers` row to read `referred_by_code` off.
  This migration closes that gap — nothing about the trigger itself
  changes.

  ## What this does
  1. `create_public_booking` gets a new `p_ref_code text DEFAULT NULL`
     parameter (dropped and recreated rather than CREATE OR REPLACE,
     because adding a parameter is a different signature in Postgres —
     replacing in place would leave two ambiguous overloads).
  2. On each booking, it now finds-or-creates a `customers` row for the
     account (matched by phone, then email — same as the rest of the
     app's convention), and sets `jobs.customer_id` to it.
  3. `referred_by_code` is set ONLY on a brand-new customer, and ONLY if
     not already set — first-touch attribution, existing customers are
     never re-attributed by a later referral click.
  4. Booking behavior for everyone else is unchanged: no ref code, no
     existing customer match required, same slot-locking/lead-time/
     double-booking checks as before.
*/

DROP FUNCTION IF EXISTS public.create_public_booking(text, text, text, text, text, timestamptz, text, text);

CREATE OR REPLACE FUNCTION public.create_public_booking(
  p_slug text, p_customer_name text, p_customer_phone text, p_customer_email text,
  p_service_type text, p_scheduled_datetime timestamptz, p_notes text, p_channel text,
  p_ref_code text DEFAULT NULL
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
  v_customer_id uuid;
  v_clean_phone text := NULLIF(trim(coalesce(p_customer_phone, '')), '');
  v_clean_email text := NULLIF(trim(coalesce(p_customer_email, '')), '');
  v_clean_ref text := NULLIF(trim(coalesce(p_ref_code, '')), '');
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

  -- Find-or-create the customer this booking belongs to, same matching
  -- convention as the rest of the app (phone first, then email).
  IF v_clean_phone IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM customers WHERE user_id = v_user_id AND phone = v_clean_phone;
  END IF;
  IF v_customer_id IS NULL AND v_clean_email IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM customers WHERE user_id = v_user_id AND email = v_clean_email;
  END IF;

  IF v_customer_id IS NULL THEN
    BEGIN
      INSERT INTO customers (user_id, name, phone, email, source, lifecycle_stage, referred_by_code)
      VALUES (v_user_id, p_customer_name, v_clean_phone, v_clean_email, 'job', 'lead', v_clean_ref)
      RETURNING id INTO v_customer_id;
    EXCEPTION WHEN unique_violation THEN
      -- Lost a race with a concurrent booking from the same phone/email — reuse theirs.
      SELECT id INTO v_customer_id FROM customers
      WHERE user_id = v_user_id AND ((v_clean_phone IS NOT NULL AND phone = v_clean_phone) OR (v_clean_email IS NOT NULL AND email = v_clean_email))
      LIMIT 1;
    END;
  END IF;

  INSERT INTO jobs (user_id, lead_id, customer_id, customer_name, customer_phone, service_type, scheduled_datetime, duration_minutes, job_status, booking_channel)
  VALUES (v_user_id, v_new_lead_id, v_customer_id, p_customer_name, v_clean_phone, p_service_type, p_scheduled_datetime, v_duration, 'scheduled', coalesce(p_channel, 'web_booking'))
  RETURNING id INTO v_new_job_id;

  RETURN v_new_job_id;
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION 'slot_taken';
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_public_booking(text, text, text, text, text, timestamptz, text, text, text) TO anon, authenticated;
