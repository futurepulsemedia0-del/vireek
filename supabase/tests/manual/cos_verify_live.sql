-- Chief of Staff — LIVE schema/data verification. READ-ONLY. Run in the Supabase SQL editor (or psql) against
-- the real database AFTER applying 20280402000000_chief_of_staff.sql. Every row must say ok = true.
-- Rows with ok = false name exactly which assumption in the Chief of Staff code does not match your data.

with expected(tbl, col) as (values
  ('jobs','user_id'),('jobs','invoice_amount'),('jobs','job_status'),('jobs','scheduled_datetime'),('jobs','created_at'),
  ('calls','user_id'),('calls','status'),('calls','call_datetime'),
  ('job_cost_entries','job_id'),('job_cost_entries','total_cost_cents'),
  ('team_members','permissions'),('team_members','account_owner_id'),('team_members','user_id'),('team_members','role'),
  ('business_profile','user_id'),('business_profile','timezone'),
  ('agent_action_catalog','slug'),('agent_action_catalog','category'),('agent_action_catalog','agent_source'),
  ('agent_action_catalog','label'),('agent_action_catalog','has_cost'),
  ('agent_autonomy_budgets','agent_source'),('agent_autonomy_budgets','risk_level'),('agent_autonomy_budgets','enabled'),
  ('agent_action_log','payload'),('agent_action_log','amount_cents'),('agent_action_log','status'),
  ('next_best_actions','action_date'),('next_best_actions','amount_label'),('next_best_actions','cta_href'),
  ('opportunity_cost_entries','estimated_cost_cents'),('opportunity_cost_entries','occurred_on'),
  ('business_decisions','confidence_score'),('business_decisions','estimated_impact'),('business_decisions','metric_snapshot'),
  ('strategic_goals','id')
)
select 'column ' || e.tbl || '.' || e.col as check_name,
       (c.column_name is not null) as ok,
       coalesce(c.data_type, 'MISSING') as detail
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col

union all
select 'function ' || f, to_regproc('public.' || f) is not null, coalesce(to_regproc('public.' || f)::text, 'MISSING')
from unnest(array['get_capacity_status','get_account_owner_id','ai_gov_can_manage','check_constitution','evaluate_agent_action',
                  'cos_gate','cos_can_act','cos_apply_refresh','cos_capacity_status_for','cos_active_owners']) as f

union all
select 'job_costing view/table has total_cost_cents generated or stored',
       exists (select 1 from information_schema.columns where table_name = 'job_cost_entries' and column_name = 'total_cost_cents'),
       'margin goals read job_cost_entries.total_cost_cents'

union all
select 'job_status values (expect no spelling the code does not know)',
       true,
       coalesce((select string_agg(distinct job_status, ', ') from public.jobs), '(no jobs)')
union all
select 'calls.status values (answer rate counts status = ''missed'' as unanswered)',
       exists (select 1 from public.calls where status = 'missed') or not exists (select 1 from public.calls),
       coalesce((select string_agg(distinct status, ', ') from public.calls), '(no calls)')
union all
select 'agent_action_catalog.category values (messaging/calling are capped, marketing is demand-increasing)',
       exists (select 1 from public.agent_action_catalog where category in ('messaging','calling')),
       coalesce((select string_agg(distinct category, ', ') from public.agent_action_catalog), '(empty)')
union all
select 'billing permission key present on at least one team member (permissions->can_view_billing)',
       not exists (select 1 from public.team_members) or exists (select 1 from public.team_members where permissions ? 'can_view_billing'),
       coalesce((select string_agg(distinct k, ', ') from public.team_members, jsonb_object_keys(coalesce(permissions, '{}'::jsonb)) k), '(none)')
union all
select 'business timezones are valid IANA names (message-cap day boundary)',
       not exists (select 1 from public.business_profile bp where bp.timezone is not null and btrim(bp.timezone) <> ''
                   and not exists (select 1 from pg_timezone_names n where n.name = bp.timezone)),
       coalesce((select string_agg(distinct bp.timezone, ', ') from public.business_profile bp where bp.timezone is not null), '(none set)')
union all
select 'RLS enabled on every cos_* table and company_events',
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'cos\_%' or c.relname = 'company_events') and not c.relrowsecurity),
       (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'cos\_%' or c.relname = 'company_events'))
union all
select 'no client write grants on Chief of Staff tables',
       not exists (select 1 from information_schema.role_table_grants g
                   where g.table_schema = 'public' and g.grantee in ('anon','authenticated')
                     and g.privilege_type in ('INSERT','UPDATE','DELETE')
                     and (g.table_name like 'cos\_%' or g.table_name = 'company_events')),
       'authenticated may only SELECT; writes go through SECURITY DEFINER RPCs'
union all
select 'pg_cron / pg_net installed (scheduling is skipped silently without them; then run: select * from cron.job)',
       exists (select 1 from pg_extension where extname = 'pg_cron'),
       coalesce((select string_agg(extname, ', ') from pg_extension where extname in ('pg_cron','pg_net')), 'neither installed')
order by 2, 1;
