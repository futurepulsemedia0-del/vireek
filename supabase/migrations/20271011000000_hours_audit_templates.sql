/*
  # Hours-Leak Audit — saved column-mapping templates (Phase A)

  The audit itself runs entirely in the browser and stores nothing. The only thing
  persisted — and only when the owner chooses to save it — is a mapping template:
  which column of their export means "technician", "start", "end"... plus the
  assumptions they set (paid hours/day, hourly cost, time zone). No job rows,
  customer names or addresses are ever written here.

  Owner / managers only (same gate as the time clock: owner or can_view_billing).
*/

CREATE TABLE IF NOT EXISTS hours_audit_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                               -- account owner
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object' AND octet_length(mapping::text) <= 4000),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hours_audit_templates_name ON hours_audit_templates (user_id, lower(btrim(name)));

ALTER TABLE hours_audit_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hours_audit_templates_all ON hours_audit_templates;
CREATE POLICY hours_audit_templates_all ON hours_audit_templates FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.time_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_is_manager());
