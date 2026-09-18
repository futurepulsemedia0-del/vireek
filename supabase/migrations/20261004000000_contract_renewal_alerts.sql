/*
# Commercial Contract Renewal Alerts

## Why
20261002000000_commercial_contract_sla_management.sql deliberately left
`status` transitions to 'expiring_soon' / 'expired' manual — there is no
row-level DB event to hang a trigger on, a contract doesn't "expire" via
any INSERT/UPDATE, it just becomes true as `end_date` passes. This
follows the exact same pattern as
20260928000000_warranty_intelligence.sql to close that gap with a daily
scheduled check instead.

## What this does
- Adds `renewal_alert_stage` ('expiring_soon' | 'expired' | null) and
  `renewal_alert_sent_at` (timestamptz) to `commercial_contracts`, so the
  scheduled check-contract-renewals edge function knows what it has
  already notified about and never sends the same alert twice for the
  same contract.
- `reset_contract_renewal_alert_stage()` / trigger: whenever `end_date` is
  changed (renewed, corrected, extended), the stage is cleared so the
  next scheduled run re-evaluates the contract from scratch instead of
  staying silent because it already "used up" its alert on the old date —
  same idea as `reset_equipment_warranty_alert_stage()`.
- `notify_contract_renewal` boolean (default true) on `profiles`,
  following the exact pattern of `notify_warranty_alert` /
  `notify_usage_alert` etc.
- `contract_id` on `notifications` (nullable, ON DELETE CASCADE) so a
  renewal notification can deep-link to — and clean up after — the
  contract it's about, same idea as `equipment_id`.
- Index on `commercial_contracts(end_date)` scoped to contracts that are
  still live, since that's the entire working set the scheduled function
  scans every run.

## What this does NOT do
There is still no DB trigger flipping `status` on its own — that write
happens inside the edge function itself (supabase/functions/
check-contract-renewals/index.ts), which is allowed to update `status`
directly because it runs with the service-role key. If/when pg_cron is
enabled on this project, wire it up with:

  select cron.schedule(
    'check-contract-renewals-daily',
    '0 13 * * *', -- 13:00 UTC, roughly early morning US time
    $$
    select net.http_post(
      url := '<your-project-ref>.supabase.co/functions/v1/check-contract-renewals',
      headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
    );
    $$
  );

Until pg_cron is enabled, trigger it from any external scheduler (a
GitHub Actions cron workflow, Supabase's own Scheduled Functions UI,
etc.) that can hit the function's URL once a day — same as
check-warranty-alerts today.
*/

ALTER TABLE commercial_contracts
  ADD COLUMN IF NOT EXISTS renewal_alert_stage text,
  ADD COLUMN IF NOT EXISTS renewal_alert_sent_at timestamptz;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_contract_renewal boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES commercial_contracts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_commercial_contracts_end_date_live
  ON commercial_contracts(end_date)
  WHERE end_date IS NOT NULL AND status IN ('active', 'expiring_soon');

CREATE INDEX IF NOT EXISTS idx_notifications_contract_id
  ON notifications(contract_id)
  WHERE contract_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reset_contract_renewal_alert_stage()
RETURNS trigger AS $$
BEGIN
  IF NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    NEW.renewal_alert_stage := NULL;
    NEW.renewal_alert_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reset_contract_renewal_alert_stage ON commercial_contracts;
CREATE TRIGGER trg_reset_contract_renewal_alert_stage
  BEFORE UPDATE ON commercial_contracts
  FOR EACH ROW EXECUTE FUNCTION reset_contract_renewal_alert_stage();
