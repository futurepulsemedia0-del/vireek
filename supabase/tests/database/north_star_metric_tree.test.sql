-- North Star metric tree (pgTAP). NOT RUN by the author: run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select has_view('public', 'north_star_calls_v', 'calls view exists');
select has_view('public', 'north_star_jobs_v', 'jobs view exists');
select has_view('public', 'north_star_weekly_account_v', 'account weekly view exists');
select has_view('public', 'north_star_weekly_v', 'platform weekly view exists');
select has_function('public', 'staff_north_star_tree', array['integer'], 'RPC exists');

-- Tenant boundary: cross-tenant views are not readable by clients; the RPC is not callable by anon.
select is(has_table_privilege('authenticated', 'public.north_star_weekly_v', 'SELECT'), false, 'authenticated cannot read the platform view');
select is(has_table_privilege('authenticated', 'public.north_star_weekly_account_v', 'SELECT'), false, 'authenticated cannot read the per-account view');
select is(has_table_privilege('anon', 'public.north_star_calls_v', 'SELECT'), false, 'anon cannot read the calls view');
select is(has_function_privilege('anon', 'public.staff_north_star_tree(integer)', 'EXECUTE'), false, 'anon cannot run the RPC');

-- Behaviour: a non-staff signed-in user (auth.uid() reads the claim) and an unauthenticated caller are rejected.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
select throws_ok($$select public.staff_north_star_tree(12)$$, '42501', 'forbidden', 'non-staff is rejected');

select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.staff_north_star_tree(12)$$, '42501', 'forbidden', 'unauthenticated is rejected');
select lives_ok($$select count(*) from public.north_star_weekly_v$$, 'platform view executes (owner role)');

select * from finish();
rollback;
