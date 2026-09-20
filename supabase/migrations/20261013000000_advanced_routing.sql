/*
  # Advanced Routing

  ## What this adds
  - Geocoding storage: `jobs.latitude/longitude/geocoded_at` (job site) and
    `team_members.home_address/home_latitude/home_longitude` (technician's
    home base) +
    `current_latitude/current_longitude/location_updated_at` (last known
    live position, updated by the technician's own device — see
    `src/lib/routing.ts` `reportTechnicianLocation()`). Geocoding itself
    happens in the new `geocode-address` edge function (Nominatim/OSM,
    free and keyless — same choice already made for
    `weather-surge-check`'s zip lookup); this migration only adds
    somewhere to store the result.
  - `haversine_miles()`: a small, pure, IMMUTABLE SQL function for
    straight-line distance. Used for ranking/proximity everywhere in this
    feature. Actual road-network ETAs (which respect real streets, one-way
    roads, etc.) are computed in the `optimize-route` edge function via
    OSRM's public router, with Google's Distance Matrix used instead when
    a `GOOGLE_MAPS_API_KEY` secret is set (real-time traffic). Haversine
    is deliberately NOT used for ETAs shown to the user — only for
    ranking "who's closest" where a straight-line estimate is good enough
    and a network call isn't worth the latency.
  - `territories` (simple circular zones — center point + radius, not
    polygons; this product doesn't need GIS-grade territory shapes,
    just "which technicians are responsible for which general area") and
    `team_members.territory_id`.
  - Proximity is folded into the EXISTING assignment scoring
    (`pick_best_technician`, `assign_technician_to_job`) as a small
    additive bonus (0-20 points, tapering out past 20 miles) rather than
    a separate code path. When a job or technician has no geocoded
    location yet, the bonus is 0 and ranking is byte-for-byte identical
    to before this migration — this is a pure extension, not a
    replacement of the skill/service-area/capacity logic.
  - `find_nearest_technicians()`: a new RPC for the Emergency Dispatch
    panel — given a point, ranks *available* technicians by distance
    (not by the fuller assignment score, since an emergency dispatcher
    wants "who's closest right now", not "who's the best long-term fit").

  ## Security
  RLS on `territories` scoped with `public.get_account_owner_id()`,
  matching every other tenant-scoped table in this project.
*/

-- =============================================================
-- GEO COLUMNS
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS home_address text,
  ADD COLUMN IF NOT EXISTS home_latitude double precision,
  ADD COLUMN IF NOT EXISTS home_longitude double precision,
  ADD COLUMN IF NOT EXISTS home_geocoded_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_latitude double precision,
  ADD COLUMN IF NOT EXISTS current_longitude double precision,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS territory_id uuid;

CREATE INDEX IF NOT EXISTS idx_jobs_latitude_longitude ON jobs(latitude, longitude) WHERE latitude IS NOT NULL;

-- =============================================================
-- TERRITORIES
-- =============================================================

CREATE TABLE IF NOT EXISTS territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#3b82f6',
  center_latitude double precision NOT NULL,
  center_longitude double precision NOT NULL,
  radius_miles numeric(6,2) NOT NULL DEFAULT 15,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_territories_user_id ON territories(user_id);

ALTER TABLE territories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_territories" ON territories
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_territories" ON territories
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_territories" ON territories
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_territories" ON territories
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

ALTER TABLE team_members
  ADD CONSTRAINT team_members_territory_id_fkey
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE SET NULL;

-- =============================================================
-- haversine_miles -- straight-line distance, for ranking only
-- =============================================================

CREATE OR REPLACE FUNCTION public.haversine_miles(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 3958.8 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2
  ));
$$;

-- =============================================================
-- pick_best_technician -- same signature, + proximity bonus
-- =============================================================

CREATE OR REPLACE FUNCTION public.pick_best_technician(
  p_user_id uuid,
  p_service_type text,
  p_address text,
  p_scheduled_datetime timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_best_id uuid;
BEGIN
  IF p_scheduled_datetime IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM team_members
  WHERE account_owner_id = p_user_id AND role = 'technician' AND dispatch_enabled = true
  ORDER BY id
  FOR UPDATE;

  SELECT c.id INTO v_best_id
  FROM (
    SELECT
      tm.id,
      tm.max_jobs_per_day,
      tm.skills,
      tm.service_area,
      (
        SELECT count(*) FROM jobs j
        WHERE j.assigned_technician_id = tm.id
          AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
          AND date_trunc('day', j.scheduled_datetime) = date_trunc('day', p_scheduled_datetime)
      ) AS today_load,
      COALESCE(tm.current_latitude, tm.home_latitude) AS tech_lat,
      COALESCE(tm.current_longitude, tm.home_longitude) AS tech_lon
    FROM team_members tm
    WHERE tm.account_owner_id = p_user_id AND tm.role = 'technician' AND tm.dispatch_enabled = true
  ) c
  LEFT JOIN LATERAL (
    SELECT j.latitude, j.longitude FROM jobs j
    WHERE j.address = p_address AND j.latitude IS NOT NULL
    ORDER BY j.geocoded_at DESC NULLS LAST
    LIMIT 1
  ) job_loc ON true
  WHERE c.today_load < c.max_jobs_per_day
  ORDER BY
    (
      (c.max_jobs_per_day - c.today_load) * 2
      + CASE WHEN p_service_type IS NOT NULL AND p_service_type = ANY(c.skills) THEN 10 ELSE 0 END
      + CASE WHEN c.service_area IS NOT NULL AND p_address IS NOT NULL AND p_address ILIKE '%' || c.service_area || '%' THEN 5 ELSE 0 END
      + CASE WHEN c.tech_lat IS NOT NULL AND job_loc.latitude IS NOT NULL
          THEN GREATEST(0, 20 - public.haversine_miles(c.tech_lat, c.tech_lon, job_loc.latitude, job_loc.longitude))
          ELSE 0
        END
    ) DESC
  LIMIT 1;

  RETURN v_best_id;
END;
$$;

-- =============================================================
-- assign_technician_to_job -- same signature, + proximity bonus
-- =============================================================

CREATE OR REPLACE FUNCTION public.assign_technician_to_job(p_job_id uuid, p_technician_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  v_day date;
  v_tech record;
  v_load integer;
  v_capacity integer;
  v_best_id uuid;
  v_best_name text;
  v_best_load integer;
  v_best_capacity integer;
  v_best_score numeric := -1;
  v_score numeric;
  v_any_tech boolean := false;
  v_result jsonb;
BEGIN
  SELECT id, user_id, service_type, address, scheduled_datetime, job_status, latitude, longitude
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;

  IF v_job.user_id <> public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  v_day := COALESCE(v_job.scheduled_datetime, now())::date;

  IF p_technician_id IS NOT NULL THEN
    SELECT id, member_name, max_jobs_per_day
    INTO v_tech
    FROM team_members
    WHERE id = p_technician_id AND account_owner_id = v_job.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'reason', 'Technician not found.');
    END IF;

    v_capacity := COALESCE(v_tech.max_jobs_per_day, 6);
    SELECT count(*) INTO v_load FROM jobs
    WHERE assigned_technician_id = p_technician_id
      AND job_status IN ('scheduled', 'en_route', 'in_progress')
      AND scheduled_datetime::date = v_day
      AND id <> p_job_id;

    IF v_load >= v_capacity THEN
      v_result := jsonb_build_object(
        'status', 'at_capacity', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
        'day_load', v_load, 'capacity', v_capacity,
        'reason', format('%s already has %s of %s jobs for that day.', v_tech.member_name, v_load, v_capacity)
      );
      INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
      VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'at_capacity', v_load, v_capacity);
      RETURN v_result;
    END IF;

    UPDATE jobs SET assigned_technician_id = p_technician_id WHERE id = p_job_id;
    INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
    VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'assigned', v_load + 1, v_capacity);

    RETURN jsonb_build_object(
      'status', 'assigned', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
      'day_load', v_load + 1, 'capacity', v_capacity
    );
  END IF;

  FOR v_tech IN
    SELECT id, member_name, skills, service_area, max_jobs_per_day,
           COALESCE(current_latitude, home_latitude) AS tech_lat,
           COALESCE(current_longitude, home_longitude) AS tech_lon
    FROM team_members
    WHERE account_owner_id = v_job.user_id AND role = 'technician' AND invite_status = 'active' AND dispatch_enabled = true
    ORDER BY id
    FOR UPDATE
  LOOP
    v_any_tech := true;
    v_capacity := COALESCE(v_tech.max_jobs_per_day, 6);
    SELECT count(*) INTO v_load FROM jobs
    WHERE assigned_technician_id = v_tech.id
      AND job_status IN ('scheduled', 'en_route', 'in_progress')
      AND scheduled_datetime::date = v_day
      AND id <> p_job_id;

    CONTINUE WHEN v_load >= v_capacity;

    v_score := (v_capacity - v_load) * 2;
    IF v_job.service_type IS NOT NULL AND v_job.service_type = ANY(v_tech.skills) THEN v_score := v_score + 10; END IF;
    IF v_tech.service_area IS NOT NULL AND v_job.address IS NOT NULL AND v_job.address ILIKE '%' || v_tech.service_area || '%' THEN
      v_score := v_score + 5;
    END IF;

    IF v_tech.tech_lat IS NOT NULL AND v_job.latitude IS NOT NULL THEN
      v_score := v_score + GREATEST(0, 20 - public.haversine_miles(v_tech.tech_lat, v_tech.tech_lon, v_job.latitude, v_job.longitude));
    END IF;

    IF v_score > v_best_score THEN
      v_best_score := v_score;
      v_best_id := v_tech.id;
      v_best_name := v_tech.member_name;
      v_best_load := v_load;
      v_best_capacity := v_capacity;
    END IF;
  END LOOP;

  IF NOT v_any_tech THEN
    INSERT INTO technician_capacity_events (user_id, job_id, outcome)
    VALUES (v_job.user_id, p_job_id, 'no_technician_available');
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'No dispatch-enabled technicians on the team.');
  END IF;

  IF v_best_id IS NULL THEN
    INSERT INTO technician_capacity_events (user_id, job_id, outcome)
    VALUES (v_job.user_id, p_job_id, 'no_technician_available');
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'Every technician is at capacity for that day.');
  END IF;

  UPDATE jobs SET assigned_technician_id = v_best_id WHERE id = p_job_id;
  INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
  VALUES (v_job.user_id, p_job_id, v_best_id, v_best_name, 'assigned', v_best_load + 1, v_best_capacity);

  RETURN jsonb_build_object(
    'status', 'assigned', 'technician_id', v_best_id, 'technician_name', v_best_name,
    'day_load', v_best_load + 1, 'capacity', v_best_capacity,
    'reason', 'Assigned by AI Dispatcher -- best skill/service-area/capacity/proximity match.'
  );
END;
$$;

-- =============================================================
-- find_nearest_technicians -- ranking for the Emergency Dispatch panel
-- =============================================================

CREATE OR REPLACE FUNCTION public.find_nearest_technicians(
  p_latitude double precision,
  p_longitude double precision,
  p_service_type text DEFAULT NULL,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  technician_id uuid,
  technician_name text,
  distance_miles double precision,
  today_load integer,
  max_jobs_per_day integer,
  has_skill boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
BEGIN
  RETURN QUERY
  SELECT
    tm.id,
    tm.member_name,
    public.haversine_miles(
      COALESCE(tm.current_latitude, tm.home_latitude),
      COALESCE(tm.current_longitude, tm.home_longitude),
      p_latitude, p_longitude
    ),
    (
      SELECT count(*)::integer FROM jobs j
      WHERE j.assigned_technician_id = tm.id
        AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
        AND j.scheduled_datetime::date = current_date
    ),
    tm.max_jobs_per_day,
    (p_service_type IS NOT NULL AND p_service_type = ANY(tm.skills))
  FROM team_members tm
  WHERE tm.account_owner_id = v_user_id
    AND tm.role = 'technician'
    AND tm.invite_status = 'active'
    AND tm.dispatch_enabled = true
    AND COALESCE(tm.current_latitude, tm.home_latitude) IS NOT NULL
  ORDER BY 3 ASC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_nearest_technicians(double precision, double precision, text, integer) TO authenticated;
