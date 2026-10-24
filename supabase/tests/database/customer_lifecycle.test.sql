-- Customer lifecycle touches: date rule + privilege/RLS hardening (pgTAP). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- leap-day rule: Feb 29 is celebrated on Feb 28 in common years
select is(public.lifecycle_anniversary_date(2, 29, 2027), date '2027-02-28', 'Feb 29 -> Feb 28 in a common year');
select is(public.lifecycle_anniversary_date(2, 29, 2028), date '2028-02-29', 'Feb 29 stays in a leap year');
select is(public.lifecycle_anniversary_date(2, 29, 2100), date '2100-02-28', '2100 is not a leap year');
select is(public.lifecycle_anniversary_date(2, 29, 2000), date '2000-02-29', '2000 is a leap year');
select is(public.lifecycle_anniversary_date(10, 22, 2026), date '2026-10-22', 'ordinary date is unchanged');
select is(public.lifecycle_anniversary_date(NULL, 22, 2026), NULL::date, 'null month -> null');

-- no direct writes: dates + consent only via the validated RPC, the ledger only via the service role
select ok(not has_table_privilege('authenticated', 'public.customer_lifecycle_profiles', 'INSERT'), 'authenticated cannot INSERT profiles directly');
select ok(not has_table_privilege('authenticated', 'public.customer_lifecycle_profiles', 'UPDATE'), 'authenticated cannot UPDATE profiles directly');
select ok(not has_table_privilege('authenticated', 'public.lifecycle_touch_log', 'INSERT'), 'authenticated cannot INSERT into the ledger');
select ok(not has_table_privilege('anon', 'public.lifecycle_touch_log', 'SELECT'), 'anon cannot read the ledger');

-- RLS is on everywhere
select ok((select relrowsecurity from pg_class where oid = 'public.customer_lifecycle_profiles'::regclass), 'RLS on profiles');
select ok((select relrowsecurity from pg_class where oid = 'public.customer_lifecycle_consent_events'::regclass), 'RLS on consent events');
select ok((select relrowsecurity from pg_class where oid = 'public.lifecycle_touch_settings'::regclass), 'RLS on settings');
select ok((select relrowsecurity from pg_class where oid = 'public.lifecycle_touch_log'::regclass), 'RLS on ledger');

-- function exposure
select ok(not has_function_privilege('authenticated', 'public.lifecycle_occurrences(uuid,date,date)', 'EXECUTE'), 'occurrences (any user id) is service-role only');
select ok(has_function_privilege('authenticated', 'public.get_lifecycle_calendar(date,date)', 'EXECUTE'), 'calendar is callable by staff');
select ok(not has_function_privilege('anon', 'public.set_customer_lifecycle_profile(uuid,integer,integer,date,text[],boolean,boolean,text)', 'EXECUTE'), 'anon cannot record consent');

select * from finish();
rollback;
