-- Business change calendar: constraints, staff-only access, lifecycle, maker-checker, locking after notice,
-- append-only audit, reminder selection and exactly-once claiming (pgTAP). Run with:  supabase test db
-- Uses no_plan() so adding a case cannot break a hard-coded count.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'cust@test.dev'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff1@test.dev'),
  ('00000000-0000-0000-0000-0000000000b2', 'staff2@test.dev');
insert into profiles (id, email, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'cust@test.dev', 'owner', false),
  ('00000000-0000-0000-0000-0000000000b1', 'staff1@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000b2', 'staff2@test.dev', 'owner', true);
-- A fresh database has no other staff; make sure of it so the "solo" test below is exact (rolled back at the end).
update profiles set is_staff = false where is_staff and id not in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2');
delete from change_calendar_reminder_log;

-- ---- 1. reminder_kind: same cases as src/lib/changeCalendar.test.ts (today = 2027-03-10) ------------
select is(public.change_calendar_reminder_kind(s, n::date, e::date, sent, '2027-03-10'::date), want, name)
from (values
  ('draft, notice far away', 'draft', '2027-04-20', '2027-06-01', false, null::text),
  ('draft, notice in 7 days', 'draft', '2027-03-17', '2027-06-01', false, 'approval_needed'),
  ('pending, notice in 8 days', 'pending_approval', '2027-03-18', '2027-06-01', false, null),
  ('pending, notice today', 'pending_approval', '2027-03-10', '2027-06-01', false, 'unapproved_past_notice'),
  ('draft, notice passed', 'draft', '2027-03-01', '2027-06-01', false, 'unapproved_past_notice'),
  ('approved, notice passed, unsent', 'approved', '2027-03-09', '2027-06-01', false, 'notice_overdue'),
  ('approved, notice today, unsent', 'approved', '2027-03-10', '2027-06-01', false, 'notice_1d'),
  ('approved, notice tomorrow, unsent', 'approved', '2027-03-11', '2027-06-01', false, 'notice_1d'),
  ('approved, notice in 2 days, unsent', 'approved', '2027-03-12', '2027-06-01', false, 'notice_7d'),
  ('approved, notice in 7 days, unsent', 'approved', '2027-03-17', '2027-06-01', false, 'notice_7d'),
  ('approved, notice in 8 days, unsent', 'approved', '2027-03-18', '2027-06-01', false, null),
  ('approved, sent, effective in 7 days', 'approved', '2027-02-01', '2027-03-17', true, 'effective_7d'),
  ('approved, sent, effective in 8 days', 'approved', '2027-02-01', '2027-03-18', true, null),
  ('approved, sent, effective passed', 'approved', '2027-02-01', '2027-03-09', true, 'completion_due'),
  ('approved, unsent, effective passed too: notice first', 'approved', '2027-02-01', '2027-03-09', false, 'notice_overdue'),
  ('rejected is quiet', 'rejected', '2027-03-01', '2027-03-05', false, null),
  ('completed is quiet', 'completed', '2027-03-01', '2027-03-05', true, null),
  ('cancelled is quiet', 'cancelled', '2027-03-01', '2027-03-05', false, null)
) as t(name, s, n, e, sent, want);

-- ---- 2. table constraints (as the table owner, bypassing RLS) -------------------------------------
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, created_by)
  values ('bogus', 'Bad category', '00000000-0000-0000-0000-0000000000b1', '2027-04-01', '2027-05-01', '00000000-0000-0000-0000-0000000000b1')$$, '23514', null, 'unknown category rejected');
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, created_by)
  values ('pricing', 'Dates reversed', '00000000-0000-0000-0000-0000000000b1', '2027-05-01', '2027-04-01', '00000000-0000-0000-0000-0000000000b1')$$, '23514', null, 'effective before notice rejected');
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, min_notice_days, created_by)
  values ('pricing', 'Too little notice', '00000000-0000-0000-0000-0000000000b1', '2027-04-01', '2027-04-10', 30, '00000000-0000-0000-0000-0000000000b1')$$, '23514', null, 'declared minimum notice is enforced');
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, reference_url, created_by)
  values ('pricing', 'Bad link', '00000000-0000-0000-0000-0000000000b1', '2027-04-01', '2027-05-01', 'javascript:alert(1)', '00000000-0000-0000-0000-0000000000b1')$$, '23514', null, 'non-https reference link rejected');
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, status, created_by)
  values ('pricing', 'Approved without approver', '00000000-0000-0000-0000-0000000000b1', '2027-04-01', '2027-05-01', 'approved', '00000000-0000-0000-0000-0000000000b1')$$, '23514', null, 'approved needs decided_by / decided_at');

-- ---- 3. access control ----------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select throws_ok($$select public.staff_change_calendar_upsert('{"category":"pricing","title":"Customer attempt","owner_id":"00000000-0000-0000-0000-0000000000b1","notice_date":"2027-04-01","effective_date":"2027-05-01"}'::jsonb)$$,
  '42501', null, 'a customer cannot create an entry');
select throws_ok($$insert into change_calendar_entries (category, title, owner_id, notice_date, effective_date, created_by)
  values ('pricing', 'Direct write', '00000000-0000-0000-0000-0000000000a1', '2027-04-01', '2027-05-01', '00000000-0000-0000-0000-0000000000a1')$$, '42501', null, 'no direct INSERT for authenticated');
select is((select count(*)::int from change_calendar_entries), 0, 'a customer sees no rows');
select throws_ok($$select public.change_calendar_claim_reminders()$$, '42501', null, 'a customer cannot claim reminders');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_change_calendar_upsert('{"category":"pricing","title":"Unknown field","owner_id":"00000000-0000-0000-0000-0000000000b1","notice_date":"2027-04-01","effective_date":"2027-05-01","status":"approved"}'::jsonb)$$,
  '22023', null, 'unknown fields (e.g. status) are rejected');
select throws_ok($$select public.staff_change_calendar_upsert('{"category":"pricing","title":"Owner not staff","owner_id":"00000000-0000-0000-0000-0000000000a1","notice_date":"2027-04-01","effective_date":"2027-05-01"}'::jsonb)$$,
  '22023', null, 'the owner must be a staff account');
select throws_ok($$update change_calendar_entries set status = 'approved'$$, '42501', null, 'staff cannot UPDATE the table directly either');
select throws_ok($$select public.change_calendar_claim_reminders()$$, '42501', null, 'staff cannot call the service-role claim function');

-- ---- 4. lifecycle with two staff (maker-checker) ---------------------------------------------------
select lives_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('category','pricing','title','T1 starter price','audience','all_customers',
  'owner_id','00000000-0000-0000-0000-0000000000b1','notice_date',(current_date + 10)::text,'effective_date',(current_date + 40)::text,'min_notice_days',30))$$, 'staff creates an entry');
select lives_ok($$select public.staff_change_calendar_submit((select id from change_calendar_entries where title = 'T1 starter price'))$$, 'submit');
select lives_ok($$select public.staff_change_calendar_submit((select id from change_calendar_entries where title = 'T1 starter price'))$$, 'submit twice is a no-op');
select throws_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T1 starter price'), true, null)$$,
  '42501', null, 'requester cannot approve their own change when another staff member exists');
select throws_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T1 starter price'), false, ' ')$$,
  '22023', null, 'a rejection needs a reason');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
set local role authenticated;
select is((select count(*)::int from change_calendar_entries), 1, 'staff can read the register');
select lives_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T1 starter price'), true, 'ok')$$, 'second staff approves');
select lives_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T1 starter price'), true, 'ok')$$, 'approving again is a no-op');
select throws_ok($$select public.staff_change_calendar_complete((select id from change_calendar_entries where title = 'T1 starter price'))$$, '55000', null, 'cannot complete before the effective date');
select lives_ok($$select public.staff_change_calendar_mark_notice_sent((select id from change_calendar_entries where title = 'T1 starter price'))$$, 'record the notice');
select throws_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('id',(select id from change_calendar_entries where title = 'T1 starter price'),'category','pricing','title','T1 changed title',
  'audience','all_customers','owner_id','00000000-0000-0000-0000-0000000000b1','notice_date',(current_date + 10)::text,'effective_date',(current_date + 40)::text,'min_notice_days',30))$$,
  '55000', null, 'content is locked once the notice is recorded');
select lives_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('id',(select id from change_calendar_entries where title = 'T1 starter price'),'category','pricing','title','T1 starter price',
  'audience','all_customers','owner_id','00000000-0000-0000-0000-0000000000b2','notice_date',(current_date + 10)::text,'effective_date',(current_date + 40)::text,'min_notice_days',30,'reference_url','https://example.com/p'))$$,
  'owner and reference link can still change after notice');
reset role;

select is((select status from change_calendar_entries where title = 'T1 starter price'), 'approved', 'a non-material edit keeps the approval');
select is((select array_agg(action order by id) from change_calendar_events where entry_id = (select id from change_calendar_entries where title = 'T1 starter price')),
  array['created','submitted','approved','notice_sent','updated'], 'audit trail has every step in order');

-- ---- 5. editing an approved entry voids the approval; reject / cancel rules ------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('category','terms','title','T2 terms v3','owner_id','00000000-0000-0000-0000-0000000000b1',
  'notice_date',(current_date + 20)::text,'effective_date',(current_date + 60)::text))$$, 'create T2');
select lives_ok($$select public.staff_change_calendar_submit((select id from change_calendar_entries where title = 'T2 terms v3'))$$, 'submit T2');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
set local role authenticated;
select lives_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T2 terms v3'), true, null)$$, 'approve T2');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('id',(select id from change_calendar_entries where title = 'T2 terms v3'),'category','terms','title','T2 terms v3',
  'owner_id','00000000-0000-0000-0000-0000000000b1','notice_date',(current_date + 25)::text,'effective_date',(current_date + 60)::text))$$, 'material edit of an approved entry');
reset role;
select is((select status from change_calendar_entries where title = 'T2 terms v3'), 'draft', 'material edit returns it to draft');
select is((select decided_by from change_calendar_entries where title = 'T2 terms v3'), null, 'approval is cleared');
select ok(exists (select 1 from change_calendar_events where action = 'reset_to_draft' and entry_id = (select id from change_calendar_entries where title = 'T2 terms v3')), 'reset is audited');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_change_calendar_cancel((select id from change_calendar_entries where title = 'T2 terms v3'), '')$$, '22023', null, 'a cancellation needs a reason');
select lives_ok($$select public.staff_change_calendar_cancel((select id from change_calendar_entries where title = 'T2 terms v3'), 'superseded by T3')$$, 'cancel with a reason');
select lives_ok($$select public.staff_change_calendar_cancel((select id from change_calendar_entries where title = 'T2 terms v3'), 'superseded by T3')$$, 'cancelling twice is a no-op');
select throws_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('id',(select id from change_calendar_entries where title = 'T2 terms v3'),'category','terms','title','T2 reopened',
  'owner_id','00000000-0000-0000-0000-0000000000b1','notice_date',(current_date + 25)::text,'effective_date',(current_date + 60)::text))$$, '55000', null, 'a cancelled entry is final');
reset role;

-- ---- 6. completion rules and solo-staff exception --------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_change_calendar_upsert(jsonb_build_object('category','policy','title','T3 live today','audience','all_customers','owner_id','00000000-0000-0000-0000-0000000000b1',
  'notice_date',(current_date - 10)::text,'effective_date',current_date::text))$$, 'create T3 (effective today)');
select lives_ok($$select public.staff_change_calendar_submit((select id from change_calendar_entries where title = 'T3 live today'))$$, 'submit T3');
reset role;
update profiles set is_staff = false where id = '00000000-0000-0000-0000-0000000000b2';   -- exactly one staff account remains
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_change_calendar_decide((select id from change_calendar_entries where title = 'T3 live today'), true, null)$$, 'a sole staff member may approve their own change');
reset role;
select ok(exists (select 1 from change_calendar_events where action = 'approved' and note like 'solo_self_approval%'
  and entry_id = (select id from change_calendar_entries where title = 'T3 live today')), 'the solo self-approval is written to the audit trail');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_change_calendar_complete((select id from change_calendar_entries where title = 'T3 live today'))$$, '55000', null, 'cannot complete before the notice is recorded');
select lives_ok($$select public.staff_change_calendar_mark_notice_sent((select id from change_calendar_entries where title = 'T3 live today'))$$, 'record T3 notice');
select lives_ok($$select public.staff_change_calendar_complete((select id from change_calendar_entries where title = 'T3 live today'))$$, 'complete T3');
reset role;
select is((select status from change_calendar_entries where title = 'T3 live today'), 'completed', 'T3 is completed');

-- ---- 7. audit trail is append-only; entries are never deleted ---------------------------------------
select throws_ok($$update change_calendar_events set note = 'x'$$, '55000', null, 'events cannot be updated');
select throws_ok($$delete from change_calendar_events$$, '55000', null, 'events cannot be deleted');
select throws_ok($$truncate change_calendar_events$$, '55000', null, 'events cannot be truncated');
select throws_ok($$delete from change_calendar_entries$$, '55000', null, 'entries are never deleted');

-- ---- 8. reminders: selection, exactly-once claim, release, reset on date change --------------------
insert into change_calendar_entries (category, title, owner_id, status, notice_date, effective_date, created_by, decided_by, decided_at)
values ('sla', 'R1 overdue notice', '00000000-0000-0000-0000-0000000000b1', 'approved', current_date - 2, current_date + 30,
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', now());
select is((select jsonb_array_length(public.change_calendar_claim_reminders(current_date, 100))), 1, 'claim returns the due reminder');
select is((select jsonb_array_length(public.change_calendar_claim_reminders(current_date, 100))), 0, 'a fresh claim is not handed out twice');
select is((select count(*)::int from change_calendar_reminder_log where kind = 'notice_overdue' and sent_at is null), 1, 'claim is recorded, not yet sent');
select lives_ok($$select public.change_calendar_release_reminder((select id from change_calendar_entries where title = 'R1 overdue notice'), 'notice_overdue')$$, 'release after a failed send');
select is((select jsonb_array_length(public.change_calendar_claim_reminders(current_date, 100))), 1, 'a released reminder is claimed again');
select lives_ok($$select public.change_calendar_complete_reminder((select id from change_calendar_entries where title = 'R1 overdue notice'), 'notice_overdue')$$, 'mark sent');
update change_calendar_reminder_log set claimed_at = now() - interval '1 hour';
select is((select jsonb_array_length(public.change_calendar_claim_reminders(current_date, 100))), 0, 'a sent reminder is never claimed again');
select is((select (public.change_calendar_claim_reminders(current_date + 400, 100) -> 0 ->> 'kind')), 'completion_due', 'a later day yields completion_due for an approved entry whose notice was recorded');

select * from finish();
rollback;
