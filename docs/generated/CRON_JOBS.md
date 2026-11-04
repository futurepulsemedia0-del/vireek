# Scheduled jobs (pg_cron) catalog (generated)

> Generated from `cron.schedule(...)` calls in migrations. **78** distinct job names. A migration may only *document* a schedule without installing it (some say scheduling is an operational choice) — check `select * from cron.job;` in each environment. Times are UTC. Failure handling: see `cron.job_run_details` and RUNBOOK §9.

| Job | Schedule | Action (first 90 chars) | Defined in |
|---|---|---|---|
| `escalation-tick-every-2-min` | `*/2 * * * *` | `select net.http_post( url := '<your-project-ref>.supabase.co/functions/v1/escalation-tick'` | `20261002000000_on_call_rotation_escalation.sql` |
| `vireek-auto-replenishment` | `15 * * * *` | `select public.run_replenishment_all()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '` | `20261110000000_truck_stock_replenishment.sql` |
| `vireek-refresh-benchmark-cohorts` | `30 3 * * *` | `select public.refresh_benchmark_cohorts()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTI` | `20261205000000_deep_privacy_preserving_benchmarking.sql` |
| `service-twin-scan` | `*/5 * * * *` | `select public.service_twin_scan()'); ELSE RAISE NOTICE 'pg_cron not installed: Service Twi` | `20261231000000_service_digital_twin.sql` |
| `vireek-revenue-protection-scan` | `*/10 * * * *` | `select public.arp_scan_all()'); ELSE RAISE NOTICE 'pg_cron not enabled — call select publi` | `20270106000000_autonomous_revenue_protection.sql` |
| `vireek-ai-security-anomaly-scan` | `7 * * * *` | `select public.ai_security_run_anomaly_scan()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE N` | `20270110000000_ai_security_center.sql` |
| `pio-agent-hourly` | `7 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/property-inte` | `20270110000000_property_intelligence_os.sql` |
| `pio-prune-daily` | `40 3 * * *` | `select public.pio_prune_telemetry()'); */` | `20270110000000_property_intelligence_os.sql` |
| `vireek-failure-genome-nightly` | `40 3 * * *` | `select public.run_failure_genome_nightly()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOT` | `20270202000000_failure_genome.sql` |
| `vireek-field-intelligence` | `20 4 * * *` | `select public.fie_run_all()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Could not ` | `20270205000000_field_intelligence_engine.sql` |
| `vireek-oin-nightly` | `15 4 * * *` | `select public.oin_mature_cases(); select public.oin_refresh_network_stats();'); END IF; EX` | `20270205000000_outcome_intelligence_network.sql` |
| `vireek-refresh-evidence-release` | `15 4 * * 1` | `select public.refresh_evidence_release()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20270215000000_evidence_marketplace.sql` |
| `vireek-refresh-failure-atlas` | `45 3 * * *` | `select public.refresh_failure_atlas()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '` | `20270215000000_failure_atlas.sql` |
| `telematics-sync-every-minute` | `* * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/telematics-sy` | `20270215000000_real_telematics_os.sql` |
| `telematics-chain-every-15-min` | `*/15 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/compute-telem` | `20270215000000_real_telematics_os.sql` |
| `telematics-breadcrumb-retention` | `40 3 * * *` | `delete from vehicle_position_log where recorded_at < now() - interval '90 days'; $$); */` | `20270215000000_real_telematics_os.sql` |
| `vireek-sde-refresh-exchange` | `10 4 * * *` | `select public.sde_refresh_exchange()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'p` | `20270215000000_service_data_exchange.sql` |
| `vireek-failure-atlas-refresh` | `40 3 * * *` | `select public.refresh_failure_atlas(36)'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE` | `20270301000000_global_failure_atlas.sql` |
| `vireek-refresh-outcome-benchmarks` | `45 3 * * *` | `select public.refresh_outcome_benchmarks()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOT` | `20270301000000_outcome_benchmark_network.sql` |
| `skill-market-refresh` | `17 * * * *` | `select public.skill_market_refresh_stale(50)'); END IF; EXCEPTION WHEN OTHERS THEN NULL; E` | `20270301000000_skill_liquidity_network.sql` |
| `vireek-oem-reliability-refresh` | `10 4 * * *` | `select public.refresh_oem_model_reliability(36)'); END IF; EXCEPTION WHEN OTHERS THEN RAIS` | `20270401000000_oem_intelligence_graph.sql` |
| `vireek-pfn-resolve` | `50 3 * * *` | `select public.pfn_resolve_forecasts()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '` | `20270401000000_predictive_failure_network.sql` |
| `verification-network-sweep` | `0-59/10 * * * *` | `select net.http_post( url := '<project-ref>.supabase.co/functions/v1/verification-network'` | `20270401000000_verification_network.sql` |
| `email-campaign-dispatcher` | `0-59/5 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/email-campaig` | `20270402000000_email_campaigns.sql` |
| `trash-purge-daily` | `15 3 * * *` | `select public.purge_expired_trash()'); ELSE RAISE NOTICE 'pg_cron not enabled — schedule s` | `20270402000000_trash_soft_delete.sql` |
| `merge-finalize-daily` | `25 3 * * *` | `select public.finalize_expired_merges()'); ELSE RAISE NOTICE 'pg_cron not enabled — schedu` | `20270403000000_duplicate_detection_merge.sql` |
| `recurring-jobs-hourly` | `7 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/recurring-job` | `20270403000000_recurring_jobs.sql` |
| `reputation-sync` | `0 */2 * * *` | `select net.http_post( url := '<project-ref>.supabase.co/functions/v1/reputation-sync', hea` | `20270404000000_reputation_management.sql` |
| `vireek-purge-api-request-logs` | `15 3 * * *` | `select public.purge_api_request_logs()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE ` | `20270410000000_api_request_logs.sql` |
| `document-expiry-alerts` | `0 7 * * *` | `SELECT public.generate_document_expiry_notifications(NULL) $$ ); */` | `20270410000000_documents_vault.sql` |
| `outcome-clearing-sweep` | `*/15 * * * *` | `select public.outcome_clearing_sweep(200); $$); */ -- ====================================` | `20270415000000_outcome_clearinghouse.sql` |
| `scheduled-reports-tick` | `*/10 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/scheduled-rep` | `20270416000000_scheduled_reports.sql` |
| `microsoft-calendar-sync` | `0-59/5 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/microsoft-cal` | `20270420000000_microsoft_calendar_sync.sql` |
| `executive-report-hourly` | `5 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/executive-rep` | `20270501000000_executive_monthly_reports.sql` |
| `api-usage-sweep` | `0-59/10 * * * *` | `select public.api_usage_sweep_alerts(); $$); select cron.schedule('api-request-log-prune',` | `20270502000000_api_usage_monitoring.sql` |
| `crm-sync-every-15-min` | `*/15 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/crm-sync-run'` | `20270503000000_crm_sync.sql` |
| `vireek-dispute-deadline-reminders` | `17 * * * *` | `select public.notify_dispute_deadlines()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20270510000000_stripe_disputes.sql` |
| `payment-plan-runner` | `7 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/payment-plan-` | `20270515000000_payment_plans.sql` |
| `vireek-job-hold-reminders` | `*/10 * * * *` | `select public.sweep_job_hold_reminders()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20270610000000_job_workflow_statuses.sql` |
| `purge-soft-deleted` | `15 3 * * *` | `SELECT public.purge_soft_deleted(interval '30 days') $$); -- =============================` | `20270701000000_undo_soft_delete.sql` |
| `qbo-sync-every-15-min` | `*/15 * * * *` | `-- select net.http_post( -- url := 'https://<project-ref>.supabase.co/functions/v1/qbo-syn` | `20271011000000_quickbooks_sync.sql` |
| `money-recovered-hourly` | `10 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/money-recover` | `20271018000000_money_recovered_statements.sql` |
| `vireek-recall-match-queue` | `*/5 * * * *` | `select public.process_recall_match_queue(25)'); PERFORM cron.schedule('vireek-recall-resca` | `20271018000000_recall_safety_matching.sql` |
| `vireek-late-po-sweep` | `40 * * * *` | `select public.sweep_late_po_deliveries()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20271020000000_job_parts_ordering.sql` |
| `vireek-lead-assignment-sweep` | `* * * * *` | `select public.lead_assignment_sweep()'); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_cron ` | `20271021000000_lead_assignment_rules.sql` |
| `vireek-pn-close-expired-programs` | `20 * * * *` | `select public.pn_close_expired_programs()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTI` | `20271021000000_procurement_network.sql` |
| `conversation-intel-purge` | `17 * * * *` | `select net.http_post(url := '<SUPABASE_URL>/functions/v1/conversation-intel-purge', header` | `20271102000000_conversation_intelligence.sql` |
| `vireek-lifecycle-touch-tick` | `20 * * * *` | `select public.dispatch_lifecycle_touch_tick()'); ELSE RAISE NOTICE 'pg_cron/pg_net not ena` | `20271102000000_customer_lifecycle_touches.sql` |
| `data-platform-tick` | `*/15 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/data-platform` | `20271102000000_data_platform.sql` |
| `speed-to-lead-sweep` | `* * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/speed-to-lead` | `20271102000000_speed_to_lead.sql` |
| `pay-flag-stuck-transfers` | `*/5 * * * *` | `SELECT public.pay_flag_stuck_transfers()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20271102000000_vireek_pay_core.sql` |
| `vireek-truck-ops-scan` | `40 * * * *` | `select public.run_truck_ops_scan_all()'); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'truck o` | `20271105000000_truck_replenishment_transfers.sql` |
| `protection-plans-daily` | `15 3 * * *` | `select public._pp_lifecycle_all()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'prot` | `20271110000000_service_protection_plans.sql` |
| `vireek-insights-generate-draft` | `0 4 5 1,4,7,10 *` | `select public.insights_generate_previous_quarter()'); BEGIN PERFORM cron.unschedule('viree` | `20271110000000_vireek_insights.sql` |
| `pay-by-bank-reconcile` | `5,35 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/pay-by-bank-r` | `20271115000000_pay_by_bank.sql` |
| `value-scoreboard-hourly` | `25 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/value-scorebo` | `20271121000000_value_scoreboard.sql` |
| `vireek-closeout-tick` | `10 5 * * *` | `select public.closeout_engine_tick()'); IF EXISTS (SELECT 1 FROM pg_extension WHERE extnam` | `20271201000000_install_closeout.sql` |
| `vireek-closeout-deadline-engine` | `10 6 * * *` | `select public.closeout_run_deadline_engine()'); ELSE RAISE NOTICE 'pg_cron not enabled: sc` | `20271201000000_install_closeout_autopilot.sql` |
| `tool-crib-alerts` | `*/15 * * * *` | `SELECT public.scan_all_crib_tool_alerts()'); */` | `20271201000000_tool_crib.sql` |
| `statements-tick` | `0-59/10 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/statements-ru` | `20271206000000_customer_statements.sql` |
| `acct-sync-every-15-min` | `*/15 * * * *` | `-- select net.http_post( -- url := 'https://<project-ref>.supabase.co/functions/v1/acct-sy` | `20271210000000_accounting_connectors.sql` |
| `listings-sync` | `15 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/listings-sync` | `20271210000000_listing_sync.sql` |
| `third-party-intake-sweep` | `* * * * *` | `select net.http_post( url := 'https://<PROJECT_REF>.supabase.co/functions/v1/third-party-i` | `20271210000000_third_party_work_order_intake.sql` |
| `browser-extension-events-prune` | `23 3 * * *` | `select public.browser_extension_events_prune(180); $$); */ CREATE TABLE IF NOT EXISTS publ` | `20271215000000_browser_extension.sql` |
| `intacct-sync-every-15-min` | `*/15 * * * *` | `-- select net.http_post( -- url := 'https://<project-ref>.supabase.co/functions/v1/intacct` | `20271231130000_sage_intacct_sync.sql` |
| `vireek-punchout-expire` | `25 * * * *` | `select public.punchout_expire_sessions()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTIC` | `20280101000000_supplier_punchout.sql` |
| `xero-sync-every-15-min` | `*/15 * * * *` | `-- select net.http_post( -- url := 'https://<project-ref>.supabase.co/functions/v1/xero-sy` | `20280101000000_xero_sync.sql` |
| `dni-purge-sessions` | `40 3 * * *` | `SELECT public.dni_purge_sessions(interval ''90 days'')'); END IF; EXCEPTION WHEN OTHERS TH` | `20280102093000_dynamic_number_insertion.sql` |
| `bi-export-tick` | `*/15 * * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/bi-export-run` | `20280120000000_bi_export.sql` |
| `loyalty-expire-due` | `15 3 * * *` | `SELECT public.loyalty_expire_due()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_` | `20280105000000_loyalty_points.sql` |
| `lpts-expire-due` | `15 3 * * *` | `SELECT public.lpts_expire_due()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_cro` | `20280105000000_points_ledger.sql` |
| `vireek-rfi-overdue-sweep` | `5 * * * *` | `select public.rfi_run_overdue_sweep()'); END IF; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '` | `20280105000000_project_rfis.sql` |
| `ns-sync-every-15-min` | `*/15 * * * *` | `-- select net.http_post( -- url := 'https://<project-ref>.supabase.co/functions/v1/ns-sync` | `20280115000000_netsuite_sync.sql` |
| `vireek-warranty-detection` | `30 5 * * *` | `select public.dispatch_warranty_detection()'); ELSE RAISE NOTICE 'pg_cron/pg_net not enabl` | `20280210000000_warranty_claim_recovery_workflow.sql` |
| `commercial-collections-run` | `17 6 * * *` | `select net.http_post( url := 'https://<project-ref>.supabase.co/functions/v1/commercial-co` | `20280302000000_commercial_approval_to_cash.sql` |
| `audit-sweep` | `* * * * *` | `select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/audit-runner?a` | `20280415000000_missed_call_audit.sql` |
| `audit-housekeeping` | `17 * * * *` | `select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/audit-runner?a` | `20280415000000_missed_call_audit.sql` |
| `vireek-daily-briefing` | `5 * * * *` | `select public.dispatch_daily_briefing()'); ELSE RAISE NOTICE 'pg_cron/pg_net not enabled: ` | `<timestamp>_daily_briefing.sql` |
