-- Weekly technician schedule: read-only RPC. No new tables, additive only.
-- Day bucketing is done client-side in the technician's local timezone, so the
-- RPC takes an explicit [p_from, p_to) window instead of a server-side date.

CREATE OR REPLACE FUNCTION public.get_technician_week_schedule(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  id uuid,
  customer_name text,
  address text,
  service_type text,
  scheduled_datetime timestamptz,
  job_status text,
  expected_duration_minutes integer,
  safety_flag boolean,
  latitude double precision,
  longitude double precision,
  route_sequence integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.id, j.customer_name, j.address, j.service_type, j.scheduled_datetime,
         j.job_status, j.expected_duration_minutes, j.safety_flag,
         j.latitude, j.longitude, j.route_sequence
  FROM jobs j
  WHERE j.assigned_technician_id = public.get_my_team_member_id()
    AND j.scheduled_datetime >= p_from
    AND j.scheduled_datetime <  p_to
    AND p_to - p_from <= interval '15 days'
    AND j.job_status IN ('scheduled', 'en_route', 'in_progress', 'completed')
  ORDER BY j.scheduled_datetime ASC, j.id ASC;
$$;

REVOKE ALL ON FUNCTION public.get_technician_week_schedule(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_week_schedule(timestamptz, timestamptz) TO authenticated;
