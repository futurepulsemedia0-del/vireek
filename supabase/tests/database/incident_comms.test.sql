-- Incident comms: approval gate, content binding, four-eyes, severity/audience rules, staleness,
-- idempotent publishing, append-only trail, RLS and staff-only RPCs (pgTAP).  Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 's1@test.dev'),
  ('00000000-0000-0000-0000-0000000000a2', 's2@test.dev'),
  ('00000000-0000-0000-0000-0000000000a3', 'cust@test.dev');
insert into profiles (id, email, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 's1@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000a2', 's2@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000a3', 'cust@test.dev', 'owner', false);
insert into status_incidents (id, title, impact, component_id, summary)
  values ('11111111-1111-1111-1111-111111111111', 'Voice AI degraded', 'major', 'voice', 'x');
select set_config('request.jwt.claim.sub', '', true);

-- ---- 1. creating drafts: severity/audience rules live in the database --------------------------------
select lives_ok($$select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'investigating', 'sev1', 'status_page_and_subscribers', 'We are investigating. Next update by 14:30 UTC.', 'Voice AI degraded', 'Hello', now() + interval '30 minutes')$$, 'SEV1 may email subscribers');
select throws_ok($$select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'investigating', 'sev3', 'status_page_and_subscribers', 'x', 's', 'b', null)$$, '23514', null::text, 'SEV3 cannot email subscribers');
select throws_ok($$select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'investigating', 'sev1', 'status_page_and_subscribers', 'x', null, null, null)$$, '23514', null::text, 'an email audience needs a subject and a body');
select throws_ok($$select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'investigating', 'sev1', 'status_page', '   ', null, null, null)$$, '23514', null::text, 'an empty status post is refused');
select throws_ok($$select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'investigating', 'sev1', 'status_page', 'x', null, null, null)$$, 'P0002', null::text, 'an unknown incident is refused');
select is((select count(*)::int from incident_comms_drafts), 1, 'only the valid draft exists');
select is((select state from incident_comms_drafts), 'draft', 'new drafts start in draft');

-- ---- 2. nothing can be sent or approved out of order -----------------------------------------------------
select throws_ok($$select public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts))$$, 'P0001', null::text, 'a draft cannot be sent');
select throws_ok($$select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), 'x')$$, 'P0001', null::text, 'a draft that was not submitted cannot be approved');
select lives_ok($$select public.incident_comms_submit('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts))$$, 'draft is submitted');
select throws_ok($$select public.incident_comms_submit('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts))$$, 'P0001', null::text, 'a submitted draft cannot be submitted again');
select throws_ok($$select public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts))$$, 'P0001', null::text, 'a pending draft cannot be sent');

-- ---- 3. four-eyes + content binding ------------------------------------------------------------------------
select throws_ok($$select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts), (select public.incident_comms_hash(d) from incident_comms_drafts d))$$, '42501', null::text, 'the drafter cannot approve a SEV1 draft');
select throws_ok($$select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), 'stale-hash')$$, 'P0001', null::text, 'approval of text the approver did not see is refused');
select lives_ok($$select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), (select public.incident_comms_hash(d) from incident_comms_drafts d))$$, 'a second person approves');
select is((select state from incident_comms_drafts), 'approved', 'draft is approved');

-- editing after approval drops the approval
select public.incident_comms_update_draft('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts), 'We are investigating a problem. Next update by 14:30 UTC.', 'Voice AI degraded', 'Hello');
select is((select state from incident_comms_drafts), 'draft', 'any edit resets an approval');
select is((select approved_hash from incident_comms_drafts), null, 'the stored approval is cleared');
select throws_ok($$select public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts))$$, 'P0001', null::text, 'an edited draft cannot be sent without a new approval');

-- the setting can relax four-eyes (and is audited when changed by staff)
update incident_comms_settings set require_second_approver_major = false;
select public.incident_comms_submit('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts));
select lives_ok($$select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts), (select public.incident_comms_hash(d) from incident_comms_drafts d))$$, 'with the setting off the same person may approve');
update incident_comms_settings set require_second_approver_major = true;

-- ---- 4. sending: ordering, idempotency, completion ------------------------------------------------------------
select is((public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts)) ->> 'status_posted')::boolean, false, 'claim reports nothing posted yet');
select throws_ok($$select public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts))$$, 'P0001', null::text, 'a draft being sent cannot be claimed twice');
select throws_ok($$select public.incident_comms_finish('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), true)$$, 'P0001', null::text, 'cannot finish before the status post is published');
select is(public.incident_comms_publish_status('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts)), true, 'status post published');
select is(public.incident_comms_publish_status('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts)), false, 'publishing twice is a no-op');
select is((select count(*)::int from status_incident_updates), 1, 'exactly one public update exists');
select throws_ok($$select public.incident_comms_finish('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), true)$$, 'P0001', null::text, 'cannot finish before the email step is recorded');
select lives_ok($$select public.incident_comms_mark_emailed('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), '{"sent":3,"failed":1,"total":4}'::jsonb)$$, 'email step recorded');
select lives_ok($$select public.incident_comms_finish('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts), true)$$, 'send finishes');
select is((select state from incident_comms_drafts), 'sent', 'draft is sent');
select is((select status from status_incidents where id = '11111111-1111-1111-1111-111111111111'), 'investigating', 'incident status followed the phase');
select throws_ok($$update incident_comms_drafts set status_post_text = 'changed after send'$$, 'P0001', null::text, 'a sent draft is locked');

-- ---- 5. staleness: a lapsed promise cannot be sent --------------------------------------------------------------
select public.incident_comms_create_draft('00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'monitoring', 'sev2', 'status_page', 'Fix applied. Next update by 13:00 UTC.', null, null, now() - interval '5 minutes');
select public.incident_comms_submit('00000000-0000-0000-0000-0000000000a1', (select id from incident_comms_drafts where phase = 'monitoring'));
select public.incident_comms_approve('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts where phase = 'monitoring'), (select public.incident_comms_hash(d) from incident_comms_drafts d where phase = 'monitoring'));
select throws_ok($$select public.incident_comms_claim_send('00000000-0000-0000-0000-0000000000a2', (select id from incident_comms_drafts where phase = 'monitoring'))$$, 'P0001', null::text, 'a draft whose promised update time passed cannot be sent');

-- ---- 6. trail, RLS, grants ------------------------------------------------------------------------------------------
select cmp_ok((select count(*)::int from incident_comms_events), '>=', 10, 'every step is in the trail');
select throws_ok($$update incident_comms_events set action = 'sent'$$, '42501', null::text, 'the trail is append-only');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
set local role authenticated;
select is((select count(*)::int from incident_comms_drafts), 0, 'a customer sees no drafts');
select throws_ok($$select public.staff_incident_comms_overview()$$, '42501', null::text, 'a customer cannot call the staff overview');
select throws_ok($$select public.incident_comms_submit(auth.uid(), gen_random_uuid())$$, '42501', null::text, 'mutating RPCs are service-role only');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select cmp_ok(jsonb_array_length(public.staff_incident_comms_overview() -> 'drafts'), '>=', 2, 'staff see the drafts');

select * from finish();
rollback;
