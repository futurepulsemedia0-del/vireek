/*
  # Equipment Passport -> Lifecycle risk signals

  One read-only, service-role-only function that turns the multi-contractor passport history into
  numeric signals per equipment row. analyze-equipment-lifecycle uses it so a unit's risk reflects
  EVERY verified company that has worked on it, not just the current account's jobs.

  - Only equipment with an ACTIVE + VERIFIED passport link is returned.
  - Counts only; no company names, no customer data, no prices leave this function.
  - Not callable by anon/authenticated (REVOKE below).
*/

CREATE OR REPLACE FUNCTION public.lifecycle_passport_signals(p_equipment_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH l AS (
  SELECT equipment_id, passport_id, user_id AS owner_id
  FROM public.equipment_passport_links
  WHERE equipment_id = ANY (p_equipment_ids)
    AND equipment_id IS NOT NULL AND status = 'active' AND verified
),
ev AS (
  SELECT
    l.equipment_id,
    l.owner_id,
    e.event_type,
    e.occurred_at,
    e.contributor_user_id,
    e.summary,
    coalesce(e.source_job_id::text, e.id::text) AS visit_key,
    (e.event_type IN ('service_visit', 'inspection', 'repair', 'part_replaced')) AS is_service,
    (e.event_type = 'repair'
      OR (e.event_type = 'service_visit'
          AND coalesce(e.summary->>'service_type', '') !~* '(maint|tune.?up|inspect|clean|check.?up|seasonal|annual|filter|preventi)')) AS is_repair,
    CASE WHEN e.summary->'outcome' ? 'first_time_fix' THEN (e.summary->'outcome'->>'first_time_fix')::boolean END AS first_time_fix
  FROM l
  JOIN public.equipment_passport_events e ON e.passport_id = l.passport_id
),
agg AS (
  SELECT
    equipment_id,
    min(owner_id::text)::uuid AS owner_id,
    count(*) AS total_events,
    count(DISTINCT visit_key) FILTER (WHERE is_repair AND occurred_at >= now() - interval '12 months') AS repair_12m,
    count(DISTINCT visit_key) FILTER (WHERE is_repair AND occurred_at >= now() - interval '6 months') AS repair_6m,
    count(DISTINCT visit_key) FILTER (WHERE is_repair AND occurred_at >= now() - interval '12 months'
                                        AND occurred_at < now() - interval '6 months') AS repair_prev_6m,
    count(DISTINCT visit_key) FILTER (WHERE first_time_fix = false AND occurred_at >= now() - interval '12 months') AS callbacks_12m,
    count(DISTINCT contributor_user_id) FILTER (WHERE is_service AND occurred_at >= now() - interval '24 months') AS contractors_24m,
    count(*) FILTER (WHERE event_type = 'warranty_event' AND occurred_at >= now() - interval '24 months') AS warranty_claims_24m,
    max(occurred_at) FILTER (WHERE is_service) AS last_service_at,
    (array_agg(contributor_user_id ORDER BY occurred_at DESC) FILTER (WHERE is_service))[1] AS last_service_by
  FROM ev
  GROUP BY equipment_id
),
parts AS (
  SELECT ev.equipment_id,
         lower(btrim(p->>'name')) AS part,
         count(DISTINCT ev.visit_key) AS n
  FROM ev
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(ev.summary->'parts') = 'array' THEN ev.summary->'parts' ELSE '[]'::jsonb END
  ) p
  WHERE ev.event_type = 'service_visit'
    AND ev.occurred_at >= now() - interval '24 months'
    AND coalesce(btrim(p->>'name'), '') <> ''
  GROUP BY ev.equipment_id, lower(btrim(p->>'name'))
  HAVING count(DISTINCT ev.visit_key) >= 2
),
top_part AS (
  SELECT DISTINCT ON (equipment_id) equipment_id, part, n
  FROM parts
  ORDER BY equipment_id, n DESC, part
)
SELECT coalesce(jsonb_object_agg(a.equipment_id::text, jsonb_build_object(
  'total_events', a.total_events,
  'repair_12m', a.repair_12m,
  'repair_6m', a.repair_6m,
  'repair_prev_6m', a.repair_prev_6m,
  'callbacks_12m', a.callbacks_12m,
  'contractors_24m', a.contractors_24m,
  'warranty_claims_24m', a.warranty_claims_24m,
  'last_service_at', a.last_service_at,
  'last_service_by_other', (a.last_service_by IS NOT NULL AND a.last_service_by IS DISTINCT FROM a.owner_id),
  'repeat_part', t.part,
  'repeat_part_count', t.n
)), '{}'::jsonb)
FROM agg a
LEFT JOIN top_part t ON t.equipment_id = a.equipment_id;
$$;

REVOKE ALL ON FUNCTION public.lifecycle_passport_signals(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_passport_signals(uuid[]) TO service_role;
