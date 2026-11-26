-- READ-ONLY pre-flight for the portal migration. Run each block in the Supabase SQL editor and compare with the migration's assumptions.
-- 1) Required objects (every row must say true)
SELECT n AS object, to_regclass('public.' || n) IS NOT NULL AS present FROM unnest(ARRAY['invoices','customers','tasks','profiles','commercial_invoice_tracking','audit_log']) n
UNION ALL SELECT f, to_regprocedure('public.' || f) IS NOT NULL FROM unnest(ARRAY['get_account_owner_id()','commercial_can_bill()','commercial_apply_stage(uuid,text,text,boolean)','log_audit_event(uuid,text,text,text)']) f ORDER BY 1;
-- 2) Name collisions (every row must say false BEFORE the first run)
SELECT n AS object, to_regclass('public.' || n) IS NOT NULL AS already_exists FROM unnest(ARRAY['portal_global_settings','portal_account_settings','customer_portal_profiles','portal_profile_versions','portal_consents','portal_credentials','portal_credential_access_log','portal_submissions','portal_submission_events','portal_evidence','portal_email_deliveries','portal_worker_runs','portal_remittances','portal_remittance_lines']) n ORDER BY 1;
-- 3) Tenant-key + id types the migration relies on (expect: user_id uuid on invoices/customers/tasks; id uuid)
SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name IN ('invoices','customers','tasks','commercial_invoice_tracking') AND column_name IN ('id','user_id','invoice_number','job_id','customer_id','description','title') ORDER BY 1, 2;
-- 4) Do invoices/customers have business_id (TEXT) in the LIVE db? If yes, STOP and send me this output.
SELECT table_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id' ORDER BY 1;
-- 5) Task triggers that could reject the system-created fix task
SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.tasks'::regclass AND NOT tgisinternal;
-- 6) Extensions / storage
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net','pgcrypto','pgtap');
SELECT id, public FROM storage.buckets WHERE id = 'portal-evidence';
