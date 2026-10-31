-- LOCAL-ONLY workarounds so the RLS tests can run on a bare Postgres where the migration baseline does not replay
-- (see README.md). Each statement is copied from the migration named in its comment — the intended end state, not new behaviour.
-- Remove this file's contents as the underlying migrations start applying cleanly.

-- 20261212000000_technician_mobile_os.sql (fails on replay: public.get_my_team_member_id() missing)
CREATE OR REPLACE FUNCTION public.get_account_owner_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT account_owner_id FROM team_members WHERE user_id = auth.uid() LIMIT 1),
    (SELECT id FROM profiles WHERE id = auth.uid())
  );
$$;

-- 20261105000000_membership_lifecycle_os.sql + 20261126000000_revenue_leakage_auditor_gaps.sql (both fail on replay)
ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN ('missed_call','voicemail','not_booked','declined_quote','expired_quote','cancelled_job',
    'quote_financing_stalled','quote_accepted_unbooked','job_completed_unbilled','invoice_overdue',
    'membership_cancelled','membership_churned','job_parts_unbilled','payment_failed'));
ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls','quotes','jobs','payment_requests','memberships'));
ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_estimated_value_basis_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_estimated_value_basis_check
  CHECK (estimated_value_basis IN ('quote_amount','job_invoice','price_book_match','avg_job_value','membership_plan','manual','none'));
