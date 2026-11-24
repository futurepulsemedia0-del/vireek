-- READ-ONLY pre-flight for 20290312000000_commercial_a2c_v2.sql. Paste each result block back. No writes.
-- P1: objects the migration depends on (every row must say present = true)
SELECT 'table ' || t AS object, to_regclass('public.' || t) IS NOT NULL AS present FROM unnest(ARRAY[
 'invoices','customers','jobs','job_photos','commercial_billing_profiles','commercial_approvals','commercial_invoice_tracking',
 'commercial_invoice_events','commercial_followups','commercial_demand_drafts','revenue_recovery_events','kill_switches',
 'kill_switch_org_stops','feature_flags']) t
UNION ALL
SELECT 'function ' || f, to_regprocedure('public.' || f) IS NOT NULL FROM unnest(ARRAY[
 'get_account_owner_id()','commercial_can_bill()','commercial_evaluate(invoices)','commercial_evaluate_v1(invoices)',
 'commercial_apply_stage(uuid,text,text,boolean)','commercial_log_event(uuid,uuid,text,text,text,text,jsonb,text)',
 'commercial_sync_recovery_event(uuid,text,text)','commercial_precheck_core(uuid)','commercial_assert_refs()',
 'commercial_touch_updated_at()','commercial_balance_cents(uuid)','log_audit_event(uuid,text,text,text)','flag_evaluate(text,uuid)'])  f
ORDER BY 1;
-- P2: tenant key must be uuid user_id everywhere (zip contract). Any business_id row here = STOP.
SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema='public' AND column_name IN ('user_id','business_id')
   AND table_name IN ('invoices','customers','jobs','commercial_billing_profiles','commercial_approvals',
                      'commercial_invoice_tracking','commercial_invoice_events','revenue_recovery_events') ORDER BY 1,2;
-- P3: constraints the migration rewrites (must show 'stage = ANY' and 'event_type = ANY' CHECKs)
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE contype='c' AND conrelid IN ('public.commercial_invoice_tracking'::regclass,'public.commercial_invoice_events'::regclass);
-- P4: collisions with names this migration creates (all must be empty on a first run)
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
 ('commercial_billing_rule_versions','commercial_change_order_requests','commercial_invoice_documents','commercial_invoice_packets',
  'commercial_fix_tasks','commercial_stage_transitions');
-- P5: current send-gate trigger + rows that would be affected
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='public.invoices'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT stage, count(*) FROM commercial_invoice_tracking GROUP BY 1 ORDER BY 1;
SELECT count(*) AS profiles FROM commercial_billing_profiles;
-- P6: revenue ledger CHECKs extended by v1 (must already contain 'invoice_rejected' and 'invoices')
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.revenue_recovery_events'::regclass AND contype='c';
-- P7: flag + kill switch rows (expect NO commercial_a2c_v2 flag yet: that means OFF)
SELECT key FROM feature_flags WHERE key LIKE 'commercial%';
SELECT key, stopped FROM kill_switches WHERE key LIKE 'commercial%';
-- P8: migration history (confirms v1 is applied)
SELECT version, name FROM supabase_migrations.schema_migrations WHERE name ILIKE '%commercial_approval%' OR name ILIKE '%invoicing%' ORDER BY 1;
