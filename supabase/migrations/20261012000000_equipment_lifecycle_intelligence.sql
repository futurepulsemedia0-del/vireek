/*
  # Equipment Lifecycle Intelligence

  Stores the output of the analyze-equipment-lifecycle scheduled function:
  a risk assessment per unit combining age vs expected lifespan, overdue
  service, and repair frequency (via job_equipment). Same idiom as
  equipment_maintenance_alerts already drafted (unused) in lib/supabase.ts.
*/

CREATE TABLE IF NOT EXISTS equipment_maintenance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  predicted_issue text NOT NULL,
  recommended_action text,
  predicted_service_due date,
  is_dismissed boolean NOT NULL DEFAULT false,
  metric_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_alerts_equipment_id ON equipment_maintenance_alerts(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_alerts_user_id ON equipment_maintenance_alerts(user_id) WHERE is_dismissed = false;

ALTER TABLE equipment_maintenance_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_equipment_alerts" ON equipment_maintenance_alerts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_equipment_alerts" ON equipment_maintenance_alerts FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
