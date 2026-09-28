/*
  # Fix: Trust Passport returned no technicians

  team_members.user_id is the TECHNICIAN's own auth user (added by the invite
  flow), while team_members.account_owner_id is the business owner. The original
  function filtered on `tm.user_id = owner.id`, which only ever matches the owner's
  own row, so a normal team returned an empty passport list.

  Same signature and return columns as before, so CREATE OR REPLACE is safe.
  The only change is: tm.user_id = owner.id  ->  tm.account_owner_id = owner.id
*/

CREATE OR REPLACE FUNCTION public.get_technician_trust_passport(
  p_technician_id uuid DEFAULT NULL,
  p_window_days integer DEFAULT 90
)
RETURNS TABLE (
  technician_id uuid,
  technician_name text,
  certifications text[],
  jobs_completed integer,
  first_time_fix_rate numeric,
  callback_rate numeric,
  customer_rating_avg numeric,
  customer_rating_count integer,
  safety_compliance_rate numeric,
  avg_margin_pct numeric,
  verified_skill_count integer,
  unresolved_complaint_count integer,
  generated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH owner AS (
    SELECT public.get_account_owner_id() AS id
  ),
  window_bounds AS (
    SELECT now() - make_interval(days => p_window_days) AS since
  ),
  techs AS (
    SELECT tm.id, tm.member_name
    FROM team_members tm, owner
    WHERE tm.account_owner_id = owner.id
      AND tm.role = 'technician'
      AND (p_technician_id IS NULL OR tm.id = p_technician_id)
  ),
  rework_originals AS (
    SELECT DISTINCT j.rework_of_job_id AS job_id
    FROM jobs j, owner
    WHERE j.user_id = owner.id AND j.is_rework = true AND j.rework_of_job_id IS NOT NULL
  ),
  completed AS (
    SELECT j.*
    FROM jobs j, owner, window_bounds
    WHERE j.user_id = owner.id
      AND j.job_status = 'completed'
      AND j.assigned_technician_id IS NOT NULL
      AND coalesce(j.completed_at, j.scheduled_datetime) >= window_bounds.since
  ),
  cert_agg AS (
    SELECT technician_id, array_agg(DISTINCT credential_type ORDER BY credential_type) AS certs
    FROM technician_credentials
    WHERE status = 'active'
    GROUP BY technician_id
  ),
  job_stats AS (
    SELECT
      c.assigned_technician_id AS technician_id,
      count(*) AS jobs_completed,
      count(*) FILTER (WHERE ro.job_id IS NOT NULL) AS reworked_count
    FROM completed c
    LEFT JOIN rework_originals ro ON ro.job_id = c.id
    GROUP BY c.assigned_technician_id
  ),
  safety_stats AS (
    SELECT
      c.assigned_technician_id AS technician_id,
      count(*) FILTER (WHERE coalesce(qr.require_safety_evidence, false)) AS safety_required,
      count(*) FILTER (WHERE coalesce(qr.require_safety_evidence, false) AND c.evidence_verified_at IS NOT NULL) AS safety_met
    FROM completed c
    LEFT JOIN job_quality_requirements qr
      ON qr.user_id = c.user_id AND qr.service_type = c.service_type
    GROUP BY c.assigned_technician_id
  ),
  review_stats AS (
    SELECT
      c.assigned_technician_id AS technician_id,
      avg(r.rating)::numeric AS rating_avg,
      count(r.rating) AS rating_count
    FROM completed c
    JOIN review_requests r ON r.job_id = c.id AND r.rating IS NOT NULL
    GROUP BY c.assigned_technician_id
  ),
  margin_stats AS (
    SELECT
      jp.assigned_technician_id AS technician_id,
      avg(jp.margin_pct)::numeric AS avg_margin_pct
    FROM job_profitability jp, owner, window_bounds
    WHERE jp.user_id = owner.id
      AND jp.job_status = 'completed'
      AND jp.assigned_technician_id IS NOT NULL
      AND jp.scheduled_datetime >= window_bounds.since
    GROUP BY jp.assigned_technician_id
  ),
  service_type_history AS (
    SELECT j.assigned_technician_id AS technician_id, j.service_type,
      count(*) AS completed_count,
      count(*) FILTER (WHERE ro.job_id IS NOT NULL) AS reworked_count
    FROM jobs j
    CROSS JOIN owner
    LEFT JOIN rework_originals ro ON ro.job_id = j.id
    WHERE j.user_id = owner.id
      AND j.job_status = 'completed'
      AND j.assigned_technician_id IS NOT NULL
      AND j.service_type IS NOT NULL
      AND coalesce(j.completed_at, j.scheduled_datetime) >= now() - interval '365 days'
    GROUP BY j.assigned_technician_id, j.service_type
  ),
  verified_skills AS (
    SELECT technician_id, count(*) AS verified_skill_count
    FROM service_type_history
    WHERE completed_count >= 5
      AND (100.0 * (completed_count - reworked_count) / completed_count) >= 85
    GROUP BY technician_id
  ),
  complaint_stats AS (
    SELECT j.assigned_technician_id AS technician_id, count(*) AS unresolved_count
    FROM service_recovery_signals s
    JOIN jobs j ON j.id = s.job_id
    WHERE s.status NOT IN ('resolved', 'ignored')
      AND j.assigned_technician_id IS NOT NULL
    GROUP BY j.assigned_technician_id
  )
  SELECT
    t.id,
    t.member_name,
    coalesce(ca.certs, '{}'),
    coalesce(js.jobs_completed, 0)::integer,
    CASE WHEN js.jobs_completed > 0 THEN round(100 - (100.0 * js.reworked_count / js.jobs_completed), 1) END,
    CASE WHEN js.jobs_completed > 0 THEN round(100.0 * js.reworked_count / js.jobs_completed, 1) END,
    round(rs.rating_avg, 2),
    coalesce(rs.rating_count, 0)::integer,
    CASE WHEN ss.safety_required > 0 THEN round(100.0 * ss.safety_met / ss.safety_required, 1) END,
    round(ms.avg_margin_pct, 1),
    coalesce(vs.verified_skill_count, 0)::integer,
    coalesce(cs.unresolved_count, 0)::integer,
    now()
  FROM techs t
  LEFT JOIN cert_agg ca ON ca.technician_id = t.id
  LEFT JOIN job_stats js ON js.technician_id = t.id
  LEFT JOIN safety_stats ss ON ss.technician_id = t.id
  LEFT JOIN review_stats rs ON rs.technician_id = t.id
  LEFT JOIN margin_stats ms ON ms.technician_id = t.id
  LEFT JOIN verified_skills vs ON vs.technician_id = t.id
  LEFT JOIN complaint_stats cs ON cs.technician_id = t.id
  ORDER BY t.member_name;
$$;

REVOKE ALL ON FUNCTION public.get_technician_trust_passport(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_trust_passport(uuid, integer) TO authenticated;
