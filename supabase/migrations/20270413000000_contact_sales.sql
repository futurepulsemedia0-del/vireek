/*
  # Contact sales: enterprise inquiries + calendar booking

  Extends sales_inquiries (20260827080510) and reuses demo_bookings (20260911090000).

  ## Changes
  - sales_inquiries: + job_title, team_size, locations_count, message, source, segment, priority,
    demo_booking_id, utm_*  (all additive).
  - The public INSERT policy on sales_inquiries is DROPPED. Inquiries now arrive only through the
    contact-sales Edge Function (service role), which rate-limits and validates. Nothing in the app wrote
    to this table directly before. If you added a page that does, remove the DROP POLICY line below.
  - sales_inquiry_rate_limit + consume_sales_rate_limit(): atomic per-IP counter (hashed IPs only).
  - submit_sales_inquiry(): validates, classifies, inserts the inquiry and (optionally) books a demo slot in ONE
    transaction. If the slot is taken the whole call rolls back with 'SLOT_TAKEN'.

  ## Security
  - Both RPCs are executable by service_role only. anon / authenticated cannot call them or read the
    rate-limit table.
  - Staff keep reading/updating inquiries through the existing admin policies.
*/

-- 1) Columns ----------------------------------------------------------------------------------
ALTER TABLE sales_inquiries
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS team_size text,
  ADD COLUMN IF NOT EXISTS locations_count text,
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS segment text CHECK (segment IN ('enterprise', 'mid_market', 'smb')),
  ADD COLUMN IF NOT EXISTS priority text CHECK (priority IN ('high', 'normal', 'low')),
  ADD COLUMN IF NOT EXISTS demo_booking_id uuid REFERENCES demo_bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text;

CREATE INDEX IF NOT EXISTS idx_sales_inquiries_email ON sales_inquiries (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_inquiries_priority ON sales_inquiries (priority, created_at DESC);

-- Close the open door: inquiries come in through the Edge Function only.
DROP POLICY IF EXISTS "public_insert_sales_inquiries" ON sales_inquiries;

-- 2) Rate limiting -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_inquiry_rate_limit (
  ip_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE sales_inquiry_rate_limit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the service role (Edge Function) touches this table.

CREATE OR REPLACE FUNCTION public.consume_sales_rate_limit(
  p_ip_hash text,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- One atomic statement: no read-then-write race between concurrent submissions.
  INSERT INTO sales_inquiry_rate_limit AS r (ip_hash, window_start, request_count)
  VALUES (p_ip_hash, now(), 1)
  ON CONFLICT (ip_hash) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds)
                        THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds)
                         THEN 1 ELSE r.request_count + 1 END
  RETURNING request_count INTO v_count;

  IF random() < 0.02 THEN
    DELETE FROM sales_inquiry_rate_limit WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN v_count <= p_max;
END;
$$;

-- 3) Submit (inquiry + optional booking, one transaction) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_sales_inquiry(
  p_full_name text,
  p_email text,
  p_company_name text,
  p_team_size text,
  p_locations text,
  p_job_title text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_message text DEFAULT NULL,
  p_best_time text DEFAULT NULL,
  p_sms_consent boolean DEFAULT false,
  p_source text DEFAULT NULL,
  p_utm_source text DEFAULT NULL,
  p_utm_medium text DEFAULT NULL,
  p_utm_campaign text DEFAULT NULL,
  p_slot_start timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_full_name, ''));
  v_company text := btrim(coalesce(p_company_name, ''));
  v_phone text := NULLIF(btrim(coalesce(p_phone, '')), '');
  v_message text := NULLIF(btrim(coalesce(p_message, '')), '');
  v_segment text;
  v_priority text;
  v_id uuid;
  v_existing uuid;
  v_booking demo_bookings%ROWTYPE;
BEGIN
  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Please enter your full name.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_email) > 254 OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_company) < 2 OR char_length(v_company) > 120 THEN
    RAISE EXCEPTION 'Please enter your company name.' USING ERRCODE = '22023';
  END IF;
  IF p_team_size NOT IN ('1-5', '6-15', '16-50', '51-200', '200+') THEN
    RAISE EXCEPTION 'Please choose your team size.' USING ERRCODE = '22023';
  END IF;
  IF p_locations NOT IN ('1', '2-5', '6-20', '21+') THEN
    RAISE EXCEPTION 'Please choose your number of locations.' USING ERRCODE = '22023';
  END IF;
  IF p_best_time IS NOT NULL AND p_best_time <> ''
     AND p_best_time NOT IN ('Morning 8-12', 'Afternoon 12-5', 'Evening 5-8') THEN
    RAISE EXCEPTION 'Please choose a valid time to call.' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NOT NULL AND char_length(v_phone) > 40 THEN
    RAISE EXCEPTION 'That phone number is too long.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_sms_consent, false) AND v_phone IS NULL THEN
    RAISE EXCEPTION 'Add a phone number to receive texts.' USING ERRCODE = '22023';
  END IF;
  IF char_length(coalesce(v_message, '')) > 1500 THEN
    RAISE EXCEPTION 'Please keep your message under 1,500 characters.' USING ERRCODE = '22023';
  END IF;

  v_segment := CASE
    WHEN p_team_size IN ('51-200', '200+') OR p_locations IN ('6-20', '21+') THEN 'enterprise'
    WHEN p_team_size = '16-50' OR p_locations = '2-5' THEN 'mid_market'
    ELSE 'smb'
  END;
  v_priority := CASE v_segment WHEN 'enterprise' THEN 'high' WHEN 'mid_market' THEN 'normal' ELSE 'low' END;

  -- Double-submit guard: same email within 10 minutes reuses the existing inquiry.
  SELECT id INTO v_existing
  FROM sales_inquiries
  WHERE lower(email) = v_email AND created_at > now() - interval '10 minutes'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing IS NOT NULL AND p_slot_start IS NULL THEN
    RETURN jsonb_build_object('inquiry_id', v_existing, 'duplicate', true, 'segment', v_segment,
                              'priority', v_priority, 'booking', NULL);
  END IF;

  IF v_existing IS NULL THEN
    IF (SELECT count(*) FROM sales_inquiries
        WHERE lower(email) = v_email AND created_at > now() - interval '24 hours') >= 3 THEN
      RAISE EXCEPTION 'We already have your requests. Our team will be in touch shortly.' USING ERRCODE = '54000';
    END IF;

    INSERT INTO sales_inquiries (
      full_name, email, company_name, phone, best_time_to_call, sms_consent,
      job_title, team_size, locations_count, message, source, segment, priority,
      utm_source, utm_medium, utm_campaign
    ) VALUES (
      v_name, v_email, v_company, v_phone, NULLIF(btrim(coalesce(p_best_time, '')), ''), coalesce(p_sms_consent, false),
      NULLIF(btrim(coalesce(p_job_title, '')), ''), p_team_size, p_locations, v_message,
      NULLIF(btrim(coalesce(p_source, '')), ''), v_segment, v_priority,
      NULLIF(left(btrim(coalesce(p_utm_source, '')), 100), ''),
      NULLIF(left(btrim(coalesce(p_utm_medium, '')), 100), ''),
      NULLIF(left(btrim(coalesce(p_utm_campaign, '')), 100), '')
    )
    RETURNING id INTO v_id;
  ELSE
    v_id := v_existing;
  END IF;

  IF p_slot_start IS NOT NULL THEN
    IF extract(second FROM p_slot_start) <> 0
       OR p_slot_start < now() + interval '1 hour'
       OR p_slot_start > now() + interval '90 days' THEN
      RAISE EXCEPTION 'That time is no longer available. Please pick another.' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1 FROM demo_bookings
      WHERE status = 'scheduled'
        AND tstzrange(slot_start, slot_end) && tstzrange(p_slot_start, p_slot_start + interval '30 minutes')
    ) THEN
      RAISE EXCEPTION 'SLOT_TAKEN' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      INSERT INTO demo_bookings (full_name, work_email, company_name, phone, team_size, message, slot_start, slot_end)
      VALUES (v_name, v_email, v_company, v_phone, p_team_size, v_message,
              p_slot_start, p_slot_start + interval '30 minutes')
      RETURNING * INTO v_booking;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'SLOT_TAKEN' USING ERRCODE = 'P0001';
    END;

    UPDATE sales_inquiries SET demo_booking_id = v_booking.id WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object(
    'inquiry_id', v_id,
    'duplicate', false,
    'segment', v_segment,
    'priority', v_priority,
    'booking', CASE WHEN p_slot_start IS NULL THEN NULL
                    ELSE jsonb_build_object('slot_start', v_booking.slot_start, 'slot_end', v_booking.slot_end) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_sales_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_sales_rate_limit(text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.submit_sales_inquiry(
  text, text, text, text, text, text, text, text, text, boolean, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_sales_inquiry(
  text, text, text, text, text, text, text, text, text, boolean, text, text, text, text, timestamptz
) TO service_role;
