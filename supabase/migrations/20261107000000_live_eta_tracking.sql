/*
  # Customer Experience OS — Phase 2: Live ETA / Technician Tracking

  ## Why
  Nothing in the schema currently lets a customer see "your technician is
  15 minutes away." This adds the minimum needed for that, reusing the
  token the codebase already issues per job (`jobs.reschedule_token`,
  from 20260912050000_customer_self_reschedule.sql) instead of minting a
  yet another token column — one durable per-job secret, two uses.

  ## What this adds
  1. `jobs.eta_minutes` / `eta_set_at` — a technician-set countdown
     ("15 min away"), set from the dashboard. Deliberately NOT computed
     from a maps/distance-matrix API — that needs a paid key, geocoded
     addresses and a new edge function, and a wrong auto-ETA is worse
     than an honest manual one. Staff sets it, same trust model as every
     other manual field in this app (invoice_amount, dispatch_note, etc).
  2. `jobs.technician_lat` / `technician_lng` / `location_updated_at` —
     optional live position, written by the technician's own browser
     (geolocation) while `job_status = 'en_route'`. All nullable; a
     technician who never shares location just means the tracking page
     shows ETA/status without a map, never an error.
  3. `business_profile.allow_live_tracking` — same opt-in pattern as
     `allow_customer_portal` / `allow_customer_self_reschedule`, defaults
     false. A business that never turns this on has zero new exposure.
  4. `get_job_tracking(p_token uuid)` — SECURITY DEFINER, matches on
     `reschedule_token` (already unique per job — see
     20260912050000_customer_self_reschedule.sql), returns only
     display-safe fields. No RLS grant on `jobs` itself is touched or
     opened to anon.

  Existing writes to `jobs` (job_status, eta fields, location fields) all
  go through the already-authenticated staff dashboard using the same
  `supabase.from('jobs').update(...)` pattern JobsPage.tsx already uses
  for job_status/invoice/technician — covered by jobs' existing RLS, no
  new write policy needed.
*/

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS eta_minutes integer,
  ADD COLUMN IF NOT EXISTS eta_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS technician_lat double precision,
  ADD COLUMN IF NOT EXISTS technician_lng double precision,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS allow_live_tracking boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.get_job_tracking(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_business_name text;
  v_tracking_enabled boolean;
  v_technician_name text;
  v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE reschedule_token = p_token;
  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_live_tracking, false)
  INTO v_business_name, v_tracking_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_job.user_id;

  IF NOT v_tracking_enabled THEN
    RETURN NULL;
  END IF;

  SELECT tm.member_name INTO v_technician_name
  FROM team_members tm WHERE tm.id = v_job.assigned_technician_id;

  SELECT jsonb_build_object(
    'business_name', v_business_name,
    'customer_name', v_job.customer_name,
    'service_type', v_job.service_type,
    'job_status', v_job.job_status,
    'scheduled_datetime', v_job.scheduled_datetime,
    'technician_name', v_technician_name,
    'eta_minutes', v_job.eta_minutes,
    'eta_set_at', v_job.eta_set_at,
    -- Live position is only ever surfaced while a technician is actually
    -- en route or on site — never for a scheduled/completed/cancelled job,
    -- even if a stale lat/lng is still sitting in the row from a prior visit.
    'technician_lat', CASE WHEN v_job.job_status IN ('en_route', 'in_progress') THEN v_job.technician_lat ELSE NULL END,
    'technician_lng', CASE WHEN v_job.job_status IN ('en_route', 'in_progress') THEN v_job.technician_lng ELSE NULL END,
    'location_updated_at', CASE WHEN v_job.job_status IN ('en_route', 'in_progress') THEN v_job.location_updated_at ELSE NULL END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_job_tracking(uuid) TO anon, authenticated;
