-- Integrations safety pack (migration 20290304000000): pgTAP. Run with: supabase test db
-- NOT RUN by the author (no database available when written) - run before release.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

select has_function('public', 'can_manage_integrations', array[]::text[], 'can_manage_integrations() exists');
select ok(has_function_privilege('authenticated', 'public.can_manage_integrations()', 'EXECUTE'), 'authenticated may call can_manage_integrations');
select ok(not has_function_privilege('anon', 'public.can_manage_integrations()', 'EXECUTE'), 'anon may NOT call can_manage_integrations');

select is((select enabled from public.feature_flags where key = 'servicetitan_app_key_onboarding'), false, 'ServiceTitan App-Key flag is seeded OFF');
select is((select rollout_pct from public.feature_flags where key = 'servicetitan_app_key_onboarding'), 0, 'rollout is 0');
select is(public.flag_evaluate('servicetitan_app_key_onboarding', gen_random_uuid()), false, 'flag evaluates OFF for an arbitrary tenant');

select ok(not has_function_privilege('authenticated', 'public.oauth_state_consume(text,text)', 'EXECUTE'), 'authenticated may NOT consume OAuth nonces');
select ok(has_function_privilege('service_role', 'public.oauth_state_consume(text,text)', 'EXECUTE'), 'service_role may consume OAuth nonces');

select is(public.oauth_state_consume('0123456789abcdef01234567', 'jobber'), true, 'first consumption of a nonce succeeds');
select is(public.oauth_state_consume('0123456789abcdef01234567', 'jobber'), false, 'replay of the same nonce is rejected');
select is(public.oauth_state_consume('not-a-nonce', 'jobber'), false, 'malformed nonce is rejected');

select has_table('public', 'integration_drift_reports', 'drift reports table exists (migration 20290304000100)');
select ok(not has_table_privilege('anon', 'public.integration_drift_reports', 'SELECT'), 'anon may NOT read drift reports');
select ok(not has_table_privilege('authenticated', 'public.integration_drift_reports', 'INSERT'), 'authenticated may NOT write drift reports');
select ok(not has_function_privilege('anon', 'public.get_integration_health()', 'EXECUTE'), 'anon may NOT call get_integration_health');

select * from finish();
rollback;
