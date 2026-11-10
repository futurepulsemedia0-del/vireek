-- NOT RUN. Read-only catalog queries. Run on a LOCAL/ephemeral DB after applying all migrations.
-- Q1: SECURITY DEFINER functions in public that anon can execute, with a crude guard heuristic.
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       pg_get_functiondef(p.oid) ~* 'auth\.uid\(\)|auth\.jwt|get_account_owner_id|service_role|_require_|can_manage' AS has_guard_hint
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY has_guard_hint, fn::text;

-- Q2: same for authenticated, restricted to functions taking a tenant-id style argument.
SELECT p.oid::regprocedure AS fn
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND pg_get_function_arguments(p.oid) ~* '\mp_(user|user_id|owner|owner_id|tenant)\M'
  AND pg_get_functiondef(p.oid) !~* 'auth\.uid\(\)|get_account_owner_id|_require_'
ORDER BY 1::text;

-- Q3: public tables/views without RLS or with PUBLIC/anon table grants.
SELECT c.relname, c.relkind, c.relrowsecurity, has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
  AND (NOT c.relrowsecurity OR has_table_privilege('anon', c.oid, 'SELECT'))
ORDER BY 1;

-- Q4: views without security_invoker.
SELECT c.oid::regclass AS view_name, c.reloptions
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'v' AND n.nspname IN ('public','perf')
  AND coalesce(c.reloptions::text,'') NOT LIKE '%security_invoker%';
