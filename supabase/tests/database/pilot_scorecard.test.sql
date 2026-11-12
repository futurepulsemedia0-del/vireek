-- Weekly scorecard + wrong-call feedback loop (pgTAP). NOT RUN by the author: run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

select has_function('public', 'scrub_pii', array['text'], 'scrub_pii exists');
select has_function('public', 'get_weekly_scorecard', array['date'], 'get_weekly_scorecard exists');
select has_function('public', 'report_wrong_call', array['uuid','text','text','boolean'], 'report_wrong_call exists');

select is(public.scrub_pii('mail bob@x.com'), 'mail [email]', 'email masked');
select is(public.scrub_pii('call 512-555-0142 now'), 'call [phone] now', 'phone masked');
select is(public.scrub_pii('ssn 123-45-6789'), 'ssn [ssn]', 'ssn masked');
select is(public.scrub_pii(''), null, 'empty -> null');

select is(has_table_privilege('authenticated', 'public.call_eval_candidates', 'INSERT'), false, 'no direct INSERT for authenticated');
select is(has_function_privilege('anon', 'public.get_weekly_scorecard(date)', 'EXECUTE'), false, 'anon cannot run the scorecard');

select * from finish();
rollback;
