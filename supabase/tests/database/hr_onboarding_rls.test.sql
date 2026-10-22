-- HR onboarding: owner-only RLS, RPCs, triggers and storage policy (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M admin team member (can_manage_team — still NOT allowed into HR), X = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a2';

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'admin@acme.test', 'Ada Admin', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_manage_team": true, "can_view_billing": true}');

insert into public.employees (id, user_id, full_name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Emma Employee');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------ owner: templates --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.hr_seed_starter_templates(), 2, 'owner can seed the two starter templates');
select is(public.hr_seed_starter_templates(), 0, 'seeding is idempotent: nothing is added when templates already exist');
select is((select count(*)::int from public.hr_onboarding_template_items i join public.hr_onboarding_templates t on t.id = i.template_id where t.name = 'Field technician'),
  18, 'Field technician template has 18 checklist lines');

-- ------------------------------------------------------ owner: onboarding --
select set_config('t.tpl', (select id::text from public.hr_onboarding_templates where name = 'Field technician'), true);
select set_config('t.onb',
  public.hr_start_onboarding('00000000-0000-0000-0000-0000000000e1', current_setting('t.tpl')::uuid, current_date)::text, true);
select ok(current_setting('t.onb')::uuid is not null, 'owner can start an onboarding');
select is((select count(*)::int from public.hr_onboarding_tasks where onboarding_id = current_setting('t.onb')::uuid), 18,
  'every template line became a task');
select is((select count(*)::int from public.hr_documents where onboarding_id = current_setting('t.onb')::uuid and status = 'requested'), 7,
  'template lines that need a document created 7 requested documents');
select is((select count(*)::int from public.hr_reviews where onboarding_id = current_setting('t.onb')::uuid), 3,
  '30/60/90-day reviews were scheduled');
select is((select due_date from public.hr_reviews where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_90'),
  current_date + 90, 'the 90-day review is due start + 90 days');
select is((select due_date from public.hr_onboarding_tasks where onboarding_id = current_setting('t.onb')::uuid and document_type = 'i9'),
  current_date + 3, 'task due dates follow the template offsets');
select throws_ok(
  $$ select public.hr_start_onboarding('00000000-0000-0000-0000-0000000000e1', current_setting('t.tpl')::uuid, current_date) $$,
  '23505', null, 'a second ACTIVE onboarding for the same employee is rejected');
select is((select status from public.hr_onboardings where id = current_setting('t.onb')::uuid), 'active', 'onboarding starts active');

-- Receiving a document completes its task.
update public.hr_documents set status = 'received'
 where onboarding_id = current_setting('t.onb')::uuid and doc_type = 'w4';
select is((select status from public.hr_onboarding_tasks where onboarding_id = current_setting('t.onb')::uuid and document_type = 'w4'),
  'done', 'receiving a document completes the matching task');
select ok((select completed_at is not null from public.hr_onboarding_tasks where onboarding_id = current_setting('t.onb')::uuid and document_type = 'w4'),
  'a completed task is stamped with completed_at');

-- Completing every required task completes the onboarding; re-opening one re-activates it.
update public.hr_onboarding_tasks set status = 'done' where onboarding_id = current_setting('t.onb')::uuid and required and status = 'pending';
select is((select status from public.hr_onboardings where id = current_setting('t.onb')::uuid), 'completed',
  'onboarding completes when the last required task is done');
update public.hr_onboarding_tasks set status = 'pending' where onboarding_id = current_setting('t.onb')::uuid and title = 'Issue tool kit & PPE';
select is((select status from public.hr_onboardings where id = current_setting('t.onb')::uuid), 'active',
  're-opening a required task re-activates the onboarding');
select ok((select completed_at is null from public.hr_onboardings where id = current_setting('t.onb')::uuid), 'a re-activated onboarding has no completed_at');

-- ------------------------------------------------------------ owner: reviews --
select throws_ok(
  $$ update public.hr_reviews set status = 'completed' where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_30' $$,
  '23514', null, 'a review cannot be completed without a rating and a review date');
select throws_ok(
  $$ update public.hr_reviews set ratings = '{"quality": 6}' where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_30' $$,
  '22023', null, 'ratings outside 1-5 are rejected');
update public.hr_reviews
   set status = 'completed', overall_rating = 4, reviewed_on = current_date, ratings = '{"quality": 4, "safety": 5}', strengths = 'Great with customers'
 where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_30';
select is((select status from public.hr_reviews where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_30'), 'completed',
  'a valid review can be completed');
select ok((select completed_at is not null and reviewer_id = '00000000-0000-0000-0000-0000000000a1' from public.hr_reviews
            where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_30'), 'completion stamps completed_at and the reviewer');

-- ------------------------------------------------------------ owner: reminders --
update public.hr_reviews set due_date = current_date + 3 where onboarding_id = current_setting('t.onb')::uuid and kind = 'day_60';
select is(public.hr_notify_due_reviews(), 1, 'one reminder for the review due within 7 days (the 30-day review is completed, the 90-day is far away)');
select is(public.hr_notify_due_reviews(), 0, 'reminders are sent only once');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and type = 'hr_review_due'), 1,
  'the reminder landed in the owner notifications');

-- ------------------------------------------------------------ owner: storage --
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('hr-documents', '00000000-0000-0000-0000-0000000000a1/e1/w4.pdf') $$,
  'owner can upload into their own folder of the private bucket');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('hr-documents', '00000000-0000-0000-0000-0000000000b1/e1/w4.pdf') $$,
  '42501', null, 'owner cannot upload into another account''s folder');

-- ------------------------------------------------------- admin team member --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.hr_onboarding_templates), 0, 'admin sees no templates');
select is((select count(*)::int from public.hr_onboardings), 0, 'admin sees no onboardings');
select is((select count(*)::int from public.hr_onboarding_tasks), 0, 'admin sees no tasks');
select is((select count(*)::int from public.hr_documents), 0, 'admin sees no HR documents');
select is((select count(*)::int from public.hr_reviews), 0, 'admin sees no performance reviews');
select throws_ok($$ insert into public.hr_onboarding_templates (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Sneaky') $$,
  '42501', null, 'admin cannot write into the owner''s HR data');
select throws_ok($$ select public.hr_start_onboarding('00000000-0000-0000-0000-0000000000e1', current_setting('t.tpl')::uuid, current_date) $$,
  '42501', null, 'admin cannot start an onboarding');
select throws_ok($$ select public.hr_seed_starter_templates() $$, '42501', null, 'admin cannot seed templates');
select throws_ok($$ select public.hr_notify_due_reviews() $$, '42501', null, 'admin cannot trigger HR reminders');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('hr-documents', '00000000-0000-0000-0000-0000000000a2/x.pdf') $$,
  '42501', null, 'admin cannot use the HR documents bucket at all');

-- ------------------------------------------------------- another account --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.hr_onboardings), 0, 'another account sees none of the onboardings');
select is((select count(*)::int from public.hr_documents) + (select count(*)::int from public.hr_reviews) + (select count(*)::int from public.hr_onboarding_tasks), 0,
  'another account sees none of the documents, reviews or tasks');
select is(public.hr_seed_starter_templates(), 2, 'another owner gets their own starter templates');
select throws_ok(
  $$ select public.hr_start_onboarding('00000000-0000-0000-0000-0000000000e1', (select id from public.hr_onboarding_templates limit 1), current_date) $$,
  'P0002', null, 'another owner cannot onboard someone else''s employee');
select throws_ok(
  $$ insert into public.hr_onboardings (user_id, employee_id, start_date) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', current_date) $$,
  '42501', null, 'RLS rejects attaching rows to an employee of another account');
select throws_ok($$ insert into public.hr_onboarding_templates (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Cross-tenant') $$,
  '42501', null, 'RLS rejects writing rows owned by another account');

select * from finish();
rollback;
