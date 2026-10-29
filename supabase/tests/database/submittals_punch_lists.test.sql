-- Submittals + Punch Lists: revisions, workflow guards, close rules, RLS (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (reviewer), T technician (assignee only), X owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@sp.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@sp.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@sp.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-sp.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@sp.test', 'Mia Manager', 'manager',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_billing": false}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@sp.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_billing": false}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.install_projects (id, name, customer_name, project_number)
values ('00000000-0000-0000-0000-0000000000f1', 'Rooftop units', 'Acme Corp', 'PRJ-SP1');

-- ------------------------------------------------------------ permissions --
select ok(public.can_review_install_items(), 'owner is a reviewer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select ok(public.can_review_install_items(), 'manager is a reviewer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select ok(not public.can_review_install_items(), 'technician is not a reviewer');
select throws_ok(
  $$insert into public.install_submittals (project_id, spec_section, title) values ('00000000-0000-0000-0000-0000000000f1', '23 05 00', 'Nope')$$,
  '42501', null, 'a technician cannot create a submittal');

-- -------------------------------------------------------------- submittals --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.install_submittals (id, project_id, spec_section, title, status, current_revision)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', '23 05 00', 'RTU-1 product data', 'approved', 9);
select is((select seq from public.install_submittals where id = '00000000-0000-0000-0000-0000000000e1'), 1, 'first submittal gets seq 1');
select is((select status from public.install_submittals where id = '00000000-0000-0000-0000-0000000000e1'), 'draft', 'a new submittal is always a draft');
select is((select current_revision from public.install_submittals where id = '00000000-0000-0000-0000-0000000000e1'), 0, 'a new submittal starts at Rev 0');
select is((select count(*)::int from public.install_submittal_revisions where submittal_id = '00000000-0000-0000-0000-0000000000e1'), 1, 'Rev 0 row was created');
select throws_ok(
  $$insert into public.install_submittals (project_id, spec_section, title) values ('00000000-0000-0000-0000-0000000000f1', 'abc', 'Bad')$$,
  '23514', null, 'an invalid spec section is rejected');
select throws_ok(
  $$update public.install_submittals set status = 'approved' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'flow_only', 'status cannot be changed with a plain update');

select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'submit')$$, 'reviewer_required', 'submit needs a reviewer');
update public.install_submittals set reviewer_name = 'Pat Engineer' where id = '00000000-0000-0000-0000-0000000000e1';
select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'submit')$$, 'attachment_required', 'submit needs a package file');

select set_config('t.rev0', (select id::text from public.install_submittal_revisions where submittal_id = '00000000-0000-0000-0000-0000000000e1' and revision_number = 0), true);
insert into public.install_project_attachments (submittal_revision_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
values (current_setting('t.rev0')::uuid, '00000000-0000-0000-0000-0000000000f1', 'package',
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000f1/pkg.pdf', 'pkg.pdf', 'application/pdf', 100);
select throws_ok(
  $$insert into public.install_project_attachments (submittal_revision_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
    values (current_setting('t.rev0')::uuid, '00000000-0000-0000-0000-0000000000f1', 'package', '../evil/x.pdf', 'x.pdf', 'application/pdf', 100)$$,
  'invalid_path', 'a path outside the tenant folder is rejected');

select is(public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'submit'), 'submitted', 'submit moves the draft to submitted');
select throws_ok(
  $$insert into public.install_project_attachments (submittal_revision_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
    values (current_setting('t.rev0')::uuid, '00000000-0000-0000-0000-0000000000f1', 'package',
    '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000f1/late.pdf', 'late.pdf', 'application/pdf', 100)$$,
  'revision_locked', 'the package is frozen once submitted');
select throws_ok($$update public.install_submittals set title = 'Renamed' where id = '00000000-0000-0000-0000-0000000000e1'$$, 'submittal_locked', 'the title is locked after submit');
select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'revise_resubmit')$$, 'note_required', 'a decision other than approve needs a note');
select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'new_revision')$$, 'invalid_transition', 'no new revision while it is with the reviewer');
select is(public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'revise_resubmit', 'Wrong model number'), 'revise_resubmit', 'revise & resubmit with a note');
select is(public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'new_revision'), 'draft', 'a new revision returns to draft');
select is((select current_revision from public.install_submittals where id = '00000000-0000-0000-0000-0000000000e1'), 1, 'current revision is now Rev 1');
select is((select decision from public.install_submittal_revisions where submittal_id = '00000000-0000-0000-0000-0000000000e1' and revision_number = 0), 'revise_resubmit', 'Rev 0 keeps its decision');
select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'submit')$$, 'attachment_required', 'Rev 1 cannot be submitted without its own file');
select is((select count(*)::int from public.install_item_events where item_type = 'submittal' and item_id = '00000000-0000-0000-0000-0000000000e1'), 3, 'three workflow steps were logged');

-- ------------------------------------------------------------- punch items --
insert into public.install_punch_items (id, project_id, title, location, assignee_id, status, reopen_count)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Scuffed drywall', 'Kitchen', '00000000-0000-0000-0000-0000000000c3', 'closed', 5);
select is((select status from public.install_punch_items where id = '00000000-0000-0000-0000-0000000000d1'), 'open', 'a new punch item is always open');
select is((select reopen_count from public.install_punch_items where id = '00000000-0000-0000-0000-0000000000d1'), 0, 'reopen_count starts at 0');
select throws_ok(
  $$update public.install_punch_items set status = 'closed' where id = '00000000-0000-0000-0000-0000000000d1'$$,
  'flow_only', 'an item cannot be closed with a plain update');
select throws_ok(
  $$insert into public.install_punch_items (project_id, title, location, assignee_id) values ('00000000-0000-0000-0000-0000000000f1', 'x', 'y', '00000000-0000-0000-0000-0000000000b1')$$,
  'invalid_technician', 'the assignee must belong to the account');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'start'), 'in_progress', 'the assignee can start work');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'mark_fixed')$$, 'after_photo_required', 'marking fixed needs an After photo');
select set_config('t.d1', '00000000-0000-0000-0000-0000000000d1', true);
insert into public.install_project_attachments (punch_item_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
values (current_setting('t.d1')::uuid, '00000000-0000-0000-0000-0000000000f1', 'after',
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000f1/after.jpg', 'after.jpg', 'image/jpeg', 100);
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'mark_fixed', 'Patched and painted'), 'ready_for_review', 'the assignee marks it fixed');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'verify')$$, 'not_authorized', 'the assignee cannot verify');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'close')$$, 'not_authorized', 'the assignee cannot close');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'close')$$, 'invalid_transition', 'close needs a verified item');
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'verify'), 'verified', 'a reviewer verifies');
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'close'), 'closed', 'a verified item can be closed');
select throws_ok($$update public.install_punch_items set title = 'Changed' where id = '00000000-0000-0000-0000-0000000000d1'$$, 'item_closed', 'a closed item is frozen');
select throws_ok(
  $$insert into public.install_project_attachments (punch_item_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
    values (current_setting('t.d1')::uuid, '00000000-0000-0000-0000-0000000000f1', 'general',
    '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000f1/more.jpg', 'more.jpg', 'image/jpeg', 100)$$,
  'item_closed', 'no files can be added to a closed item');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'reopen')$$, 'note_required', 'reopening needs a note');
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'reopen', 'Customer found it again'), 'open', 'a closed item can be reopened');
select is((select reopen_count from public.install_punch_items where id = '00000000-0000-0000-0000-0000000000d1'), 1, 'reopen_count was incremented');
select is((select fixed_by from public.install_punch_items where id = '00000000-0000-0000-0000-0000000000d1'), null, 'fix data was cleared on reopen');

-- four-eyes rule: the manager marks an item fixed and therefore cannot verify it
insert into public.install_punch_items (id, project_id, title, location)
values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f1', 'Loose cover', 'Roof');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select set_config('t.d2', '00000000-0000-0000-0000-0000000000d2', true);
insert into public.install_project_attachments (punch_item_id, project_id, purpose, storage_path, file_name, mime_type, size_bytes)
values (current_setting('t.d2')::uuid, '00000000-0000-0000-0000-0000000000f1', 'after',
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000f1/after2.jpg', 'after2.jpg', 'image/jpeg', 100);
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d2', 'mark_fixed'), 'ready_for_review', 'a reviewer can mark an item fixed');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d2', 'verify_close')$$, 'verifier_must_differ', 'the person who fixed it cannot verify it');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.install_punch_transition('00000000-0000-0000-0000-0000000000d2', 'verify_close'), 'closed', 'the owner can verify and close in one step');

-- ----------------------------------------------------------- tenant isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.install_submittals), 0, 'another account sees no submittals');
select is((select count(*)::int from public.install_punch_items), 0, 'another account sees no punch items');
select is((select count(*)::int from public.install_project_attachments), 0, 'another account sees no attachments');
select is((select count(*)::int from public.install_item_events), 0, 'another account sees no history');
select throws_ok($$select public.install_submittal_transition('00000000-0000-0000-0000-0000000000e1', 'void', 'attack')$$, 'submittal_not_found', 'another account cannot act on a foreign submittal');
select throws_ok($$select public.install_punch_transition('00000000-0000-0000-0000-0000000000d1', 'reopen', 'attack')$$, 'punch_not_found', 'another account cannot act on a foreign punch item');

select * from finish();
rollback;
