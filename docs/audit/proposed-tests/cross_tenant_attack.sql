-- NOT RUN. Template: two tenants, run inside a transaction on a LOCAL DB, then ROLLBACK.
-- Replace <TABLE>/<COLS> per table from Q3/Q1. Expected: tenant B sees/changes 0 rows of tenant A.
BEGIN;
-- seed two tenants A and B in auth.users / profiles / team_members with your real fixtures first.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'tenant_b_uid', 'role', 'authenticated')::text, true);
-- READ: expect 0
SELECT count(*) FROM public.customers WHERE user_id = :'tenant_a_uid';
-- UPDATE/DELETE: expect 0 rows affected
UPDATE public.customers SET name = 'x' WHERE user_id = :'tenant_a_uid';
DELETE FROM public.customers WHERE user_id = :'tenant_a_uid';
-- INSERT into A's scope: expect RLS violation
INSERT INTO public.customers (user_id, name) VALUES (:'tenant_a_uid', 'x');
-- RPC IDOR candidates (SEC-01): expect permission denied / no effect
RESET ROLE; SET LOCAL ROLE anon;
SELECT public.activate_weather_surge(:'tenant_a_uid'::uuid, 'test', 'test', 'test', now() + interval '1 hour');
ROLLBACK;
