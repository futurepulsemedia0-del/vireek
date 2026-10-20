/*
  # "On my way" customer experience upgrade

  Adds: technician photo, arrival window, telematics-backed position, reschedule
  flag and post-job review token to get_job_tracking(); plus a token-gated,
  idempotent ensure_job_review_request().

  Position priority while en_route/in_progress: the freshest of
    (a) fleet telematics (vehicle_live_state of the vehicle assigned to the tech,
        fix < 10 min old) and (b) the technician's browser location on the job.
  Everything stays gated by business_profile.allow_live_tracking.
*/

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS photo_url text;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS arrival_window_minutes integer
    CHECK (arrival_window_minutes IS NULL OR arrival_window_minutes BETWEEN 15 AND 480);

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS arrival_window_minutes integer NOT NULL DEFAULT 60
    CHECK (arrival_window_minutes BETWEEN 15 AND 480);

-- Technician photos: public-read bucket, writes limited to the account's own folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('technician-photos', 'technician-photos', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "manage_own_technician_photos" ON storage.objects;
CREATE POLICY "manage_own_technician_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'technician-photos' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text)
WITH CHECK (bucket_id = 'technician-photos' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

CREATE OR REPLACE FUNCTION public.get_job_tracking(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_business_name text;
  v_enabled boolean;
  v_allow_reschedule boolean;
  v_default_window integer;
  v_tech_name text;
  v_tech_photo text;
  v_lat double precision;
  v_lng double precision;
  v_loc_at timestamptz;
  v_source text;
  v_t_lat double precision;
  v_t_lng double precision;
  v_t_at timestamptz;
  v_review_token uuid;
  v_review_status text;
  v_window integer;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE reschedule_token = p_token;
  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name,
         COALESCE(bp.allow_live_tracking, false),
         COALESCE(bp.allow_customer_self_reschedule, false),
         COALESCE(bp.arrival_window_minutes, 60)
  INTO v_business_name, v_enabled, v_allow_reschedule, v_default_window
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_job.user_id;

  IF v_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT tm.member_name, tm.photo_url INTO v_tech_name, v_tech_photo
  FROM team_members tm WHERE tm.id = v_job.assigned_technician_id;

  -- Live position is only ever surfaced while a technician is en route or on site.
  IF v_job.job_status IN ('en_route', 'in_progress') THEN
    IF v_job.technician_lat IS NOT NULL AND v_job.technician_lng IS NOT NULL THEN
      v_lat := v_job.technician_lat;
      v_lng := v_job.technician_lng;
      v_loc_at := v_job.location_updated_at;
      v_source := 'technician';
    END IF;

    IF v_job.assigned_technician_id IS NOT NULL THEN
      SELECT s.latitude, s.longitude, s.last_fix_at INTO v_t_lat, v_t_lng, v_t_at
      FROM vehicles v
      JOIN vehicle_live_state s ON s.vehicle_id = v.id
      WHERE v.user_id = v_job.user_id
        AND v.assigned_technician_id = v_job.assigned_technician_id
        AND v.status = 'active'
        AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.last_fix_at IS NOT NULL
        AND s.last_fix_at > now() - interval '10 minutes'
      ORDER BY s.last_fix_at DESC
      LIMIT 1;

      IF v_t_at IS NOT NULL AND (v_loc_at IS NULL OR v_t_at >= v_loc_at) THEN
        v_lat := v_t_lat;
        v_lng := v_t_lng;
        v_loc_at := v_t_at;
        v_source := 'telematics';
      END IF;
    END IF;
  END IF;

  IF v_job.job_status = 'completed' THEN
    SELECT rr.review_token, rr.status INTO v_review_token, v_review_status
    FROM review_requests rr
    WHERE rr.job_id = v_job.id
    ORDER BY rr.created_at DESC
    LIMIT 1;
  END IF;

  v_window := COALESCE(v_job.arrival_window_minutes, v_default_window);

  RETURN jsonb_build_object(
    'business_name', v_business_name,
    'customer_name', v_job.customer_name,
    'service_type', v_job.service_type,
    'job_status', v_job.job_status,
    'scheduled_datetime', v_job.scheduled_datetime,
    'technician_name', v_tech_name,
    'technician_photo_url', v_tech_photo,
    'eta_minutes', v_job.eta_minutes,
    'eta_set_at', v_job.eta_set_at,
    'technician_lat', v_lat,
    'technician_lng', v_lng,
    'location_updated_at', v_loc_at,
    'position_source', v_source,
    -- Destination is only needed (and only returned) while the tech is driving, to compute a live ETA.
    'site_lat', CASE WHEN v_job.job_status = 'en_route' THEN v_job.latitude ELSE NULL END,
    'site_lng', CASE WHEN v_job.job_status = 'en_route' THEN v_job.longitude ELSE NULL END,
    'arrival_window_start', v_job.scheduled_datetime,
    'arrival_window_end', v_job.scheduled_datetime + make_interval(mins => v_window),
    'arrived_at', v_job.telematics_arrived_at,
    'can_reschedule', (v_allow_reschedule AND v_job.job_status = 'scheduled'),
    'review_token', v_review_token,
    'review_status', v_review_status,
    'server_time', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_job_tracking(uuid) TO anon, authenticated;

-- Idempotent: returns the review token for a completed job, creating the request once.
CREATE OR REPLACE FUNCTION public.ensure_job_review_request(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_enabled boolean;
  v_review_token uuid;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE reschedule_token = p_token;
  IF v_job.id IS NULL OR v_job.job_status <> 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(bp.allow_live_tracking, false) INTO v_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_job.user_id;

  IF v_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_job.id::text, 0));

  SELECT rr.review_token INTO v_review_token
  FROM review_requests rr
  WHERE rr.job_id = v_job.id
  ORDER BY rr.created_at DESC
  LIMIT 1;

  IF v_review_token IS NULL THEN
    INSERT INTO review_requests (user_id, job_id, customer_name, customer_phone, status)
    VALUES (v_job.user_id, v_job.id, v_job.customer_name, v_job.customer_phone, 'sent')
    RETURNING review_token INTO v_review_token;
  END IF;

  RETURN v_review_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_job_review_request(uuid) TO anon, authenticated;
