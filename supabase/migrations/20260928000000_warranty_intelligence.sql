/*
  # Warranty Intelligence & Auto-Alerts

  Turns the warranty_expires_at date already tracked per unit on `equipment`
  (set from CustomerDetailPage.tsx's "Add equipment" form) into a proactive
  signal instead of a field nobody reads until a customer calls back angry.

  ## What this does
  - Adds `warranty_alert_stage` ('expiring_soon' | 'expired' | null) and
    `warranty_alert_sent_at` (timestamptz) to `equipment`, so the scheduled
    check-warranty-alerts edge function can tell what it has already
    notified about and never send the same alert twice for the same unit.
  - `reset_equipment_warranty_alert_stage()` / trigger: whenever
    warranty_expires_at is changed (extended after a paid renewal, corrected
    after a typo, etc.), the stage is cleared so the next scheduled run
    re-evaluates the unit from scratch instead of staying silent forever
    because it already "used up" its expiring_soon alert on the old date.
  - `notify_warranty_alert` boolean (default true) on `profiles`, following
    the exact pattern of notify_usage_alert / notify_job_update etc. from
    20260831090000_notifications_and_audit_log.sql.
  - `equipment_id` on `notifications` (nullable, ON DELETE CASCADE) so a
    warranty notification can deep-link to — and clean up after — the unit
    it's about, same idea as action_url but queryable.
  - Index on `equipment(warranty_expires_at)` scoped to active units with a
    date set, since that's the entire working set the scheduled function
    scans every run.

  ## What this does NOT do
  Like check-usage-alert (see 20260831090000_notifications_and_audit_log.sql
  / IMPLEMENTATION_NOTES.md), there is no DB event to hang a trigger on here
  — a warranty doesn't "expire" via any INSERT/UPDATE, it just becomes true
  as a date passes. This has to be driven by a scheduled job. The actual
  detection + notification insert lives in
  supabase/functions/check-warranty-alerts/index.ts, meant to run once a
  day. If/when pg_cron is enabled on this project, wire it up with:

    select cron.schedule(
      'check-warranty-alerts-daily',
      '0 13 * * *', -- 13:00 UTC, roughly early morning US time
      $$
      select net.http_post(
        url := '<your-project-ref>.supabase.co/functions/v1/check-warranty-alerts',
        headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
      );
      $$
    );

  Until pg_cron is enabled, trigger it from any external scheduler (a GitHub
  Actions cron workflow, Supabase's own Scheduled Functions UI, etc.) that
  can hit the function's URL once a day.
*/

ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS warranty_alert_stage text,
  ADD COLUMN IF NOT EXISTS warranty_alert_sent_at timestamptz;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_warranty_alert boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS equipment_id uuid REFERENCES equipment(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_equipment_warranty_expires_at
  ON equipment(warranty_expires_at)
  WHERE warranty_expires_at IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_notifications_equipment_id
  ON notifications(equipment_id)
  WHERE equipment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reset_equipment_warranty_alert_stage()
RETURNS trigger AS $$
BEGIN
  IF NEW.warranty_expires_at IS DISTINCT FROM OLD.warranty_expires_at THEN
    NEW.warranty_alert_stage := NULL;
    NEW.warranty_alert_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reset_equipment_warranty_alert_stage ON equipment;
CREATE TRIGGER trg_reset_equipment_warranty_alert_stage
  BEFORE UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION reset_equipment_warranty_alert_stage();
