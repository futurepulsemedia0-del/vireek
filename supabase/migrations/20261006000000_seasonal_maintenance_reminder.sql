/*
  # seasonal-maintenance-reminder automation support

  find_seasonal_maintenance_candidates(): finds customers whose last
  completed job of a given service_type was ~12 months ago (350-380 day
  window), have had no newer job of that same type since, and haven't
  already been reminded in the last ~300 days. Only considers businesses
  that installed this automation (join on automation_installs).

  seasonal_maintenance_reminders: idempotency ledger so the same customer
  isn't texted every time the sweep runs.
*/

CREATE TABLE IF NOT EXISTS seasonal_maintenance_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_phone text NOT NULL,
  service_type text NOT NULL,
  last_reminded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_phone, service_type)
);

ALTER TABLE seasonal_maintenance_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_seasonal_reminders" ON seasonal_maintenance_reminders;
CREATE POLICY "select_own_seasonal_reminders"
ON seasonal_maintenance_reminders FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION find_seasonal_maintenance_candidates()
RETURNS TABLE(user_id uuid, customer_name text, customer_phone text, service_type text, job_id uuid) AS $$
  SELECT DISTINCT ON (j.user_id, j.customer_phone, j.service_type)
    j.user_id, j.customer_name, j.customer_phone, j.service_type, j.id
  FROM jobs j
  JOIN automation_installs ai
    ON ai.user_id = j.user_id
   AND ai.template_slug = 'seasonal-maintenance-reminder'
   AND ai.status = 'active'
  WHERE j.job_status = 'completed'
    AND j.customer_phone IS NOT NULL
    AND j.service_type IS NOT NULL
    AND j.completed_at BETWEEN now() - interval '380 days' AND now() - interval '350 days'
    AND NOT EXISTS (
      SELECT 1 FROM jobs j2
      WHERE j2.user_id = j.user_id AND j2.customer_phone = j.customer_phone
        AND j2.service_type = j.service_type AND j2.completed_at > j.completed_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM seasonal_maintenance_reminders r
      WHERE r.user_id = j.user_id AND r.customer_phone = j.customer_phone
        AND r.service_type = j.service_type AND r.last_reminded_at > now() - interval '300 days'
    )
  ORDER BY j.user_id, j.customer_phone, j.service_type, j.completed_at DESC;
$$ LANGUAGE sql STABLE;
