-- Product feedback system: redaction, RLS / tenant isolation, survey fatigue caps, consent gating of
-- follow-up emails, closed-loop tasks, help loop, GDPR export / erase, retention (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(85);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'new@fresh.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000b1', 'starter', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '60 days', true),
  ('00000000-0000-0000-0000-0000000000d1', 'starter', now(), false);
insert into public.team_members (account_owner_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'technician');
insert into storage.objects (bucket_id, name) values
  ('feedback-screenshots', '00000000-0000-0000-0000-0000000000a1/shot1.png'),
  ('feedback-screenshots', '00000000-0000-0000-0000-0000000000b1/other.png');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------- redaction (server side) ----------
select is(public.feedback_redact('mail me at jo.smith@acme.com now'), 'mail me at [email] now', 'emails are redacted');
select is(public.feedback_redact('call 555-123-4567 or (555) 987 6543'), 'call [phone] or [phone]', 'US phone numbers are redacted');
select is(public.feedback_redact('card 4111 1111 1111 1111 declined'), 'card [number] declined', 'card numbers are redacted');
select is(public.feedback_redact('ssn 123-45-6789'), 'ssn [id]', 'SSN-shaped ids are redacted');
select is(public.feedback_redact('see https://app.vireek.com/dashboard/jobs?token=abc123&x=1#top'), 'see https://app.vireek.com/dashboard/jobs', 'URL query strings and fragments are stripped');
select is(public.feedback_redact('key sk_live_abcdefghijklmnop1234 leaked'), 'key [secret] leaked', 'API-key-shaped secrets are redacted');
select is(public.feedback_redact('from 192.168.1.20'), 'from [ip]', 'IPv4 addresses are redacted');
select is(public.feedback_redact('The dispatch board loads slowly on Mondays.'), 'The dispatch board loads slowly on Mondays.', 'ordinary text is untouched');
select is(public.feedback_clean_route('/dashboard/jobs/6f1c2c1e-1111-4222-8333-444455556666/edit?x=1#a'), '/dashboard/jobs/:id/edit', 'routes drop query, hash and ids');
select is(public.feedback_clean_context('{"route":"/dashboard","error_id":"nope","evil":"x","browser":"Chrome 130"}'::jsonb),
  '{"route": "/dashboard", "browser": "Chrome 130"}'::jsonb, 'context is whitelisted and a malformed error id is dropped');

-- ---------- submit + RLS ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table r1 as select public.submit_product_feedback('bug', 'Invoice page crashes. Reach me at jo@acme.com', '{"route":"/dashboard/invoices?id=1","error_id":"INC-7K3Q-9XMD"}'::jsonb, false, true, '00000000-0000-0000-0000-0000000000a1/shot1.png') as j;
grant select on r1 to public;
select is((select j ->> 'ok' from r1), 'true', 'submit succeeds');
select matches((select j ->> 'tracking_code' from r1), '^FB-[A-Z0-9]{8}$', 'a tracking code is returned');
select is((select message from public.product_feedback limit 1), 'Invoice page crashes. Reach me at [email]', 'stored message is redacted server-side');
select is((select context ->> 'error_id' from public.product_feedback limit 1), 'INC-7K3Q-9XMD', 'a valid error id is kept');
select is((select plan || '/' || role from public.product_feedback limit 1), 'pro/owner', 'plan and role segments are captured server-side');
select is((select (public.submit_product_feedback('bug', 'Invoice page crashes. Reach me at jo@acme.com', '{}'::jsonb, false, true, null)) ->> 'duplicate'), 'true', 'an identical resubmission returns the same ticket');
select is((select count(*)::int from public.product_feedback), 1, 'and no second row was created');
select is((public.submit_product_feedback('nonsense', 'hello there', '{}'::jsonb, false, false, null)) ->> 'reason', 'invalid_category', 'unknown category is rejected');
select is((public.submit_product_feedback('idea', 'x', '{}'::jsonb, false, false, null)) ->> 'reason', 'message_too_short', 'tiny message is rejected');
select is((public.submit_product_feedback('idea', 'Please add dark mode', '{}'::jsonb, false, false, '00000000-0000-0000-0000-0000000000b1/other.png')) ->> 'reason', 'invalid_screenshot', 'cannot attach another user''s screenshot');
select is((public.submit_product_feedback('idea', 'Please add dark mode', '{}'::jsonb, false, false, '00000000-0000-0000-0000-0000000000a1/missing.png')) ->> 'reason', 'invalid_screenshot', 'cannot attach a file that was never uploaded');
select throws_ok($$ insert into public.product_feedback (tracking_code, category, message) values ('FB-AAAAAAAA', 'bug', 'forged') $$, '42501', null, 'clients cannot insert feedback directly');
select throws_ok($$ update public.product_feedback set status = 'shipped' $$, '42501', null, 'clients cannot change status');
select is(public.submit_product_feedback('idea', 'Anonymous idea one', '{}'::jsonb, true, false, null) ->> 'ok', 'true', 'anonymous submit works');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.product_feedback), 0, 'a teammate does not see another person''s feedback');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.product_feedback), 0, 'another account sees nothing');
select is((select count(*)::int from public.product_feedback_events), 0, 'another account sees no timeline events');
select throws_ok($$ select * from public.feedback_survey_responses $$, '42501', null, 'survey responses are not readable by clients');
select throws_ok($$ select public.staff_feedback_inbox() $$, '42501', null, 'non-staff cannot read the staff inbox');

-- rate limit: 10 per hour
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$ begin for i in 1..10 loop perform public.submit_product_feedback('idea', 'Idea number ' || i, '{}'::jsonb, false, false, null); end loop; end $$;
select is((public.submit_product_feedback('idea', 'Idea number eleven', '{}'::jsonb, false, false, null)) ->> 'reason', 'rate_limited', 'the 11th submission in an hour is rate limited');

-- ---------- staff: masking, update, notification ----------
reset role;
create temp table ids as select
  (select id from public.product_feedback where category = 'bug' limit 1) as bug_id,
  (select id from public.product_feedback where category = 'idea' and anonymous limit 1) as idea_id;
grant select on ids to public;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from jsonb_array_elements(public.staff_feedback_inbox('received', 'idea', 100, 0) -> 'items') i where i ->> 'anonymous' = 'true' and i -> 'account_owner_id' = 'null'::jsonb), 1,
  'anonymous feedback is masked for staff (no account id)');
select is((select count(*)::int from jsonb_array_elements(public.staff_feedback_inbox('received', 'bug', 100, 0) -> 'items') i where i ->> 'account_owner_id' = '00000000-0000-0000-0000-0000000000a1'), 1,
  'named feedback shows the account to staff');
select is((public.staff_feedback_update((select bug_id from ids), 'bogus')) ->> 'reason', 'invalid_status', 'invalid status is rejected');
select is((public.staff_feedback_update((select bug_id from ids), 'planned', 'Scheduled for next sprint')) ->> 'ok', 'true', 'staff can move feedback to planned');
reset role;
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and type = 'feedback_update'), 1, 'the submitter gets an in-app notification');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select jsonb_array_length(x -> 'events') from jsonb_array_elements(public.my_feedback_list()) x where x ->> 'category' = 'bug'), 2, 'the submitter can follow the status timeline');
select is((select x ->> 'status' from jsonb_array_elements(public.my_feedback_list()) x where x ->> 'category' = 'bug'), 'planned', 'and sees the current status');

-- ---------- surveys: fatigue ----------
select is((public.survey_claim('csat', 'support_ticket', 't1')) ->> 'ok', 'true', 'first CSAT is offered');
select is((public.survey_claim('ces', 'import_wizard', 'i1')) ->> 'reason', 'global_gap', 'a second survey within 7 days is blocked');
select is((public.survey_respond('csat', 'support_ticket', 't1', 2, 'slow reply, call 555-123-4567', true)) ->> 'low', 'true', 'low CSAT is flagged');
select is((public.survey_respond('csat', 'support_ticket', 't1', 5, null, false)) ->> 'reason', 'already_answered', 'one answer per subject');
select is((public.survey_respond('csat', 'support_ticket', 'never-offered', 4, null, false)) ->> 'reason', 'not_offered', 'a response without an offered survey is refused');
select is((public.survey_respond('csat', 'support_ticket', 't1', 9, null, false)) ->> 'reason', 'invalid_score', 'out-of-range score is refused');
reset role;
select is((select comment from public.feedback_survey_responses limit 1), 'slow reply, call [phone]', 'survey comments are redacted');
select is((select count(*)::int from public.feedback_followups where source_type = 'survey' and reason like 'Low CSAT (2)%'), 1, 'a low CSAT opens a team follow-up task');
update public.feedback_survey_events set created_at = now() - interval '8 days';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.survey_claim('csat', 'support_ticket', 't2')) ->> 'reason', 'cooldown', 'same trigger is on a 14-day cooldown');
select is((public.survey_claim('ces', 'import_wizard', 'i1')) ->> 'ok', 'true', 'a different survey is allowed after the 7-day gap');
select is((public.survey_respond('ces', 'import_wizard', 'i1', 2, null, false)) ->> 'low', 'true', 'low CES is flagged');
reset role;
update public.feedback_survey_events set created_at = now() - interval '8 days';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.survey_claim('csat', 'job_complete', 'j1')) ->> 'reason', 'monthly_cap', 'no more than 2 surveys per 30 days');
reset role;
update public.feedback_survey_events set created_at = now() - interval '40 days';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.survey_dismiss('csat', 'call_review', 'c1', 'snoozed', 30)) ->> 'ok', 'true', 'snooze is recorded');
select is((public.survey_claim('csat', 'call_review', 'c1')) ->> 'reason', 'snoozed', 'a snoozed person is not asked');
select is((public.set_feedback_privacy(true, null)) ->> 'never_ask', 'true', 'never-ask can be set');
select is((public.survey_claim('csat', 'call_review', 'c2')) ->> 'reason', 'never_ask', 'never-ask is honoured');
select is((public.set_feedback_privacy(false, null)) ->> 'never_ask', 'false', 'surveys can be turned back on');
select is((public.get_feedback_privacy()) ->> 'snoozed_until', null, 'turning surveys back on clears the snooze');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select is((public.survey_claim('csat', 'support_ticket', 'n1')) ->> 'reason', 'new_account', 'brand-new accounts are never surveyed');
reset role;
select is(has_function_privilege('anon', 'public.survey_claim(text,text,text)', 'execute'), false, 'anonymous visitors cannot call survey_claim');

-- ---------- closed loop ----------
insert into public.nps_responses (account_owner_id, user_id, score) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 4),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 9);
select is((select count(*)::int from public.feedback_followups where source_type = 'nps'), 1, 'only the detractor NPS opens a task');
create temp table fids as select
  (select id from public.feedback_followups where source_type = 'nps') as nps_id,
  (select id from public.feedback_followups where source_type = 'survey' and reason like 'Low CSAT%') as survey_id;
grant select on fids to public;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((public.staff_followup_update((select nps_id from fids), null, null, 'Hi, sorry about that')) ->> 'reason', 'no_contact_consent', 'no follow-up email without the person''s consent');
select is((public.staff_followup_update((select survey_id from fids), 'in_progress', 'calling', 'Thanks for telling us, we fixed this.')) ->> 'ok', 'true', 'with consent a follow-up email can be queued');
reset role;
select is((select email_status from public.feedback_followups where id = (select survey_id from fids)), 'queued', 'and it is queued for the dispatcher');

-- ---------- help loop ----------
select is(public.log_help_search_miss('How to export   invoices'), true, 'a no-result search is logged');
select is(public.log_help_search_miss('how to export invoices'), true, 'the same query (normalised) is counted again');
select is((select miss_count from public.help_search_gaps where query_norm = 'how to export invoices'), 2, 'counters aggregate per query per day');
select is(public.log_help_search_miss('my email is a@b.com'), false, 'a query containing PII is dropped, not stored');
select is(public.log_help_search_miss('x'), false, 'one-character queries are ignored');
insert into public.help_article_feedback (article_slug, visitor_id, helpful) values ('call-forwarding', 'visitor-12345', false), ('call-forwarding', 'visitor-67890', true);
select is((public.set_help_feedback_reason('call-forwarding', 'visitor-12345', 'outdated')) ->> 'success', 'true', 'a reason can be attached to a not-helpful vote');
select is((public.set_help_feedback_reason('call-forwarding', 'visitor-67890', 'outdated')) ->> 'success', 'false', 'but not to a helpful vote');
select is((select reason from public.help_article_feedback where visitor_id = 'visitor-12345'), 'outdated', 'the reason is stored');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select (public.staff_help_gap_report(30) -> 'no_result_queries' -> 0 ->> 'query')), 'how to export invoices', 'the gap report ranks missing-article searches');

-- ---------- you asked, we built ----------
select is((public.staff_publish_you_asked('Dark mode is here', 'Switch themes from Settings.', '/dashboard/settings', null, array[(select idea_id from ids)])) ->> 'notified', '1', 'publishing notifies the people who asked');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select jsonb_array_length(public.list_you_asked_we_built(5))), 1, 'every signed-in user can read published entries');
select throws_ok($$ select public.staff_publish_you_asked('x y z', 'hello', null, null, array[]::uuid[]) $$, '42501', null, 'only staff can publish');

-- ---------- privacy: export, erase, retention ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select jsonb_array_length(public.export_my_feedback_data() -> 'feedback')), 2, 'export contains only the caller''s own feedback (2 items), none of the other account''s');
select is((select (public.export_my_feedback_data() -> 'feedback' -> 0) ? 'user_id'), false, 'export omits internal identifiers');
select is((public.delete_my_feedback_data()) -> 'screenshot_paths' ->> 0, '00000000-0000-0000-0000-0000000000a1/shot1.png', 'erase returns the screenshot paths to remove');
select is((select count(*)::int from public.product_feedback), 0, 'erase removes the feedback');
reset role;
select is((select count(*)::int from public.feedback_survey_responses where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'erase removes survey answers');
select is((select count(*)::int from public.feedback_followups where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'erase removes linked follow-up tasks');
select is((select count(*)::int from public.product_feedback where user_id = '00000000-0000-0000-0000-0000000000b1'), 10, 'other accounts are untouched by the erase');

update public.product_feedback set created_at = now() - interval '800 days', screenshot_path = '00000000-0000-0000-0000-0000000000b1/other.png' where tracking_code = (select tracking_code from public.product_feedback limit 1);
select is(cardinality(public.feedback_retention_screenshots(90)), 1, 'retention finds expired screenshots');
select is((public.feedback_retention_apply(90)) ->> 'feedback_anonymized', '1', 'retention removes the identity link after 730 days');
select is((select count(*)::int from public.product_feedback where anonymized_at is not null and user_id is null and account_owner_id is null and screenshot_path is null), 1, 'the anonymised row keeps no owner and no screenshot');
select is(has_function_privilege('authenticated', 'public.feedback_retention_apply(integer)', 'execute'), false, 'clients cannot run retention');
select is(has_function_privilege('authenticated', 'public.feedback_theme_apply_ai(jsonb)', 'execute'), false, 'clients cannot inject AI themes');

select * from finish();
rollback;
