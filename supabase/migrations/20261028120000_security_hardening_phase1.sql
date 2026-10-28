-- Phase 1 hardening. Run on a Supabase branch/staging first.

-- 1) notification_queue: close the open public policy (service_role bypasses RLS)
drop policy if exists tenant_isolation on public.notification_queue;
revoke all on public.notification_queue from anon;

-- 2) Tenant resolver is read-only: STABLE lets Postgres use indexes in RLS
alter function public.get_account_owner_id() stable;

-- 3) Fix SECURITY DEFINER functions missing search_path
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('close_enrollment_on_opt_out',
                        'sync_dnc_suppression_on_opt_out',
                        'sync_roadmap_votes_count')
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;

-- 4) Close anon access to mutating/exporting functions (authenticated + service_role keep access)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and p.proname = any (array[
        '_gl_assert_period_open','_gl_next_number','_invoice_recalc','_tc_apply_event','_tc_write_timesheets',
        'activate_weather_surge','add_commission_adjustment','add_job_note','advance_job_status',
        'apply_vip_customer_tags','assign_employee_commission_plan','claim_agent_task','complete_agent_task',
        'compute_market_intelligence','delete_budget','demand_os_enqueue_conversions','demand_os_link_leads',
        'demand_os_log_lsa_spend','end_autonomy_session','evaluate_agent_action','evaluate_reflexes',
        'expire_old_market_signals','expire_stale_quotes','export_customer_personal_data','extract_commitments',
        'fail_agent_task','generate_commission_records','mark_commission_statements_exported',
        'mark_commission_statements_paid','mine_vertical_intelligence','receive_inventory_purchase_order_line',
        'record_agent_action_outcome','record_coordination_outcome','record_knowledge_gap','record_weather_alert',
        'refresh_benchmark_cohorts','refresh_inventory_reserved_quantity','refresh_market_intelligence',
        'refresh_service_loop_global_priors','regional_erasure_preview','remove_commission_job_override',
        'resolve_expert_assist_request','resolve_expired_weather_surges','set_job_safety_flag',
        'sil_verify_due_outcomes','start_autonomy_session','submit_coordination_bid','sweep_job_hold_reminders',
        'sync_budget_alerts','transfer_inventory_stock','truth_refresh_credential','workflow_advance_run'
      ])
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

-- ROLLBACK (if a public page breaks): grant execute on function public.<name>(<args>) to anon;
-- and for item 2: alter function public.get_account_owner_id() volatile;
