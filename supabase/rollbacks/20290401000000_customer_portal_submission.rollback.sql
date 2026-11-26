-- Rollback for 20290401000000_customer_portal_submission.sql
-- DESTRUCTIVE: deletes all portal profiles, submissions, events, remittances and stored (encrypted) portal credentials.
-- Take a backup first:  pg_dump -t 'portal_*' -t customer_portal_profiles ...   Evidence files in the portal-evidence bucket are NOT removed here.
-- Existing tables (invoices, tasks, commercial_*) are untouched; tasks created by portal_create_fix_task remain (they are ordinary tasks).
BEGIN;
DROP FUNCTION IF EXISTS public.portal_failure_reasons(integer);
DROP FUNCTION IF EXISTS public.portal_profile_stats(integer);
DROP FUNCTION IF EXISTS public.portal_dismiss_remittance_line(uuid);
DROP FUNCTION IF EXISTS public.portal_confirm_remittance(uuid);
DROP FUNCTION IF EXISTS public.portal_apply_email_event(text, text, text);
DROP FUNCTION IF EXISTS public.portal_record_poll(uuid, boolean, integer, boolean, text);
DROP FUNCTION IF EXISTS public.portal_claim_due_polls(integer);
DROP FUNCTION IF EXISTS public.portal_enqueue_submission(uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.portal_apply_transition(uuid, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.portal_create_fix_task(uuid);
DROP FUNCTION IF EXISTS public.portal_save_profile(uuid, uuid, text, text, text, text, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS public.portal_disconnect_profile(uuid);
DROP FUNCTION IF EXISTS public.portal_record_consent(uuid, text, text);
DROP FUNCTION IF EXISTS public.portal_set_account_settings(boolean, boolean, boolean, boolean, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.portal_credential_meta(uuid);
DROP TABLE IF EXISTS portal_remittance_lines, portal_remittances, portal_worker_runs, portal_email_deliveries, portal_evidence,
  portal_submission_events, portal_submissions, portal_credential_access_log, portal_credentials, portal_consents,
  portal_profile_versions, customer_portal_profiles, portal_account_settings, portal_global_settings CASCADE;
DROP FUNCTION IF EXISTS public.portal_consents_guard();
DROP FUNCTION IF EXISTS public.portal_may_act(uuid);
DROP FUNCTION IF EXISTS public.portal_append_only();
DROP FUNCTION IF EXISTS public.portal_touch_updated_at();
-- Optional, only when the bucket is empty:  DELETE FROM storage.buckets WHERE id = 'portal-evidence';
COMMIT;
