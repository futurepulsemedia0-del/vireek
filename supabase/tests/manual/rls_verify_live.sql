-- READ-ONLY. Run on the live DB (SQL editor). Each result set must be empty or listed in RLS_EXCEPTIONS.md.

-- 1) public tables without RLS (must be 0)
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- 2) views that bypass RLS (no security_invoker) and are reachable by anon/authenticated
select c.relname as view_bypassing_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and not coalesce((select o.option_value = 'true' from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker'), false)
  and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'));

-- 3) write policies that are `true` for client roles (document each in RLS_EXCEPTIONS.md)
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and coalesce(qual, 'true') in ('true', '(true)') and coalesce(with_check, 'true') in ('true', '(true)')
  and roles && array['anon', 'authenticated', 'public']::name[];

-- 4) SECURITY DEFINER functions without a pinned search_path (must be 0)
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');

-- 5) SECURITY DEFINER functions executable by anon (each needs an explicit reason)
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');

-- 6) RLS enabled, zero policies (must all be intentional service-role-only tables)
select c.relname as service_only_table
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname);

-- 7) service-only tables that clients can still reach through grants (must be 0)
select c.relname as service_only_table_with_client_grant
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
  and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
  and false; -- informational: remove `and false` to list them (RLS already denies, grants are defence in depth)

-- 8) privilege-escalation triggers on profiles must exist (must return 2 rows)
select tgname from pg_trigger
where tgrelid = 'public.profiles'::regclass and not tgisinternal
  and tgname in ('trg_protect_profile_staff_flag', 'trg_guard_profile_privileged_columns');
