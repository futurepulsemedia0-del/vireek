/*
  # Dispatch x Technician Passport — skill/equipment confidence fit

  dispatch_passport_fit(p_job_ids) returns, for each (job, dispatch-enabled technician):
    - the technician's recency-weighted skill confidence for the job's service type
    - the technician's confidence for the job's primary equipment (make + type)
  Reuses identity_confidence_rows() from the Technician Identity Graph migration, so the
  number dispatch sees is exactly the number on the passport.

  Read-only, SECURITY DEFINER, scoped to the caller's account. Technician-role users
  (who are not managers) get no rows. Max 200 jobs per call.
*/

CREATE OR REPLACE FUNCTION public.dispatch_passport_fit(p_job_ids uuid[])
RETURNS TABLE (
  job_id uuid,
  technician_id uuid,
  service_key text,
  service_confidence integer,
  service_jobs integer,
  equipment_key text,
  equipment_confidence integer,
  equipment_jobs integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ctx AS (
    SELECT
      public.get_account_owner_id() AS owner_id,
      (
        auth.uid() IS NOT NULL
        AND (
          public.identity_is_manager()
          OR NOT EXISTS (
            SELECT 1 FROM team_members m WHERE m.user_id = auth.uid() AND m.role = 'technician'
          )
        )
      ) AS allowed
  ),
  job_keys AS (
    SELECT
      j.id AS jid,
      nullif(btrim(j.service_type), '') AS skey,
      (
        SELECT btrim(e.make) || ' ' || coalesce(nullif(btrim(e.equipment_type), ''), 'equipment')
        FROM job_equipment je
        JOIN equipment e ON e.id = je.equipment_id
        WHERE je.job_id = j.id AND nullif(btrim(e.make), '') IS NOT NULL
        ORDER BY je.created_at, je.equipment_id
        LIMIT 1
      ) AS ekey
    FROM jobs j
    JOIN ctx c ON c.allowed AND c.owner_id IS NOT NULL AND j.user_id = c.owner_id
    WHERE j.id = ANY (p_job_ids[1:200])
  ),
  techs AS (
    SELECT tm.id AS tid, c.owner_id
    FROM team_members tm
    JOIN ctx c ON c.allowed AND c.owner_id IS NOT NULL AND tm.account_owner_id = c.owner_id
    WHERE tm.role = 'technician' AND coalesce(tm.dispatch_enabled, true)
  ),
  svc AS (
    SELECT t.tid, r.skill_key, r.confidence, r.job_count
    FROM techs t
    CROSS JOIN LATERAL public.identity_confidence_rows(t.owner_id, t.tid, 'service_type') r
  ),
  eqp AS (
    SELECT t.tid, r.skill_key, r.confidence, r.job_count
    FROM techs t
    CROSS JOIN LATERAL public.identity_confidence_rows(t.owner_id, t.tid, 'equipment') r
  )
  SELECT
    k.jid,
    t.tid,
    k.skey,
    svc.confidence,
    svc.job_count,
    k.ekey,
    eqp.confidence,
    eqp.job_count
  FROM job_keys k
  CROSS JOIN techs t
  LEFT JOIN svc ON svc.tid = t.tid AND svc.skill_key = k.skey
  LEFT JOIN eqp ON eqp.tid = t.tid AND eqp.skill_key = k.ekey;
$$;

REVOKE ALL ON FUNCTION public.dispatch_passport_fit(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_passport_fit(uuid[]) TO authenticated;
