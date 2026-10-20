-- SOP & Training Library: RLS / RPC / grading / versioning tests (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (admin, can_manage_team), T1/T2 technicians, X = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'tech2@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_manage_team": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech1@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_manage_team": false}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'tech2@acme.test', 'Tina Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{"can_manage_team": false}');

insert into public.job_templates (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'AC tune-up'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', 'Other Co template');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.payload(p_assign jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'title', 'Refrigerant handling',
    'summary', 'EPA 608 basics',
    'category', 'Safety',
    'body_md', '# Recover refrigerant before opening a circuit.',
    'pass_score_pct', 50,
    'quiz', jsonb_build_array(
      jsonb_build_object('prompt', 'Vent R-410A to atmosphere?', 'options', jsonb_build_array('Yes', 'No'), 'correct_index', 1),
      jsonb_build_object('prompt', 'Recover first?', 'options', jsonb_build_array('Yes', 'No'), 'correct_index', 0)),
    'template_ids', jsonb_build_array('00000000-0000-0000-0000-0000000000d1'),
    'checklist_links', jsonb_build_array(jsonb_build_object(
      'template_id', '00000000-0000-0000-0000-0000000000d1', 'item_label', '  Recover Refrigerant ')),
    'assignments', p_assign
  ) || p_extra
$$;

-- ------------------------------------------------------------- permissions --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok(
  $$select public.save_sop(null, pg_temp.payload('[]'::jsonb))$$,
  'not_permitted', 'technician cannot create an SOP');
select throws_ok($$select * from public.sop_completion_report(null)$$,
  'not_permitted', 'technician cannot read the completion report');

-- --------------------------------------------------------- owner authoring --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.sop', public.save_sop(null, pg_temp.payload('[]'::jsonb))::text, true);
select ok(current_setting('t.sop')::uuid is not null, 'owner can save a draft');

select throws_ok(
  format($$select public.publish_sop(%L)$$, current_setting('t.sop')),
  'assignment_required', 'cannot publish without an assignment');

select throws_ok(
  $$select public.save_sop(null, pg_temp.payload('[]'::jsonb, '{"quiz":[{"prompt":"x","options":["a","b"],"correct_index":5}]}'))$$,
  'invalid_quiz', 'quiz correct_index must point at an option');

select throws_ok(
  $$select public.save_sop(null, pg_temp.payload('[]'::jsonb, '{"template_ids":["00000000-0000-0000-0000-0000000000d2"]}'))$$,
  'invalid_template', 'cannot link another account''s job template');

select throws_ok(
  $$select public.save_sop(null, pg_temp.payload('[]'::jsonb, '{"file_path":"someone-else/x/file.pdf"}'))$$,
  'file_outside_account', 'file must live in the account folder');

select public.save_sop(current_setting('t.sop')::uuid, pg_temp.payload(
  '[{"target_type":"role","target_role":"technician","due_at":"2099-01-01T00:00:00Z"}]'::jsonb));
select is((select count(*)::int from public.sop_assignments), 1, 'assignment saved');
select is((select item_key from public.sop_checklist_links), 'recover refrigerant', 'checklist link normalised');

select is(public.publish_sop(current_setting('t.sop')::uuid, 'first release'), 1, 'publish -> version 1');
select is((select count(*)::int from public.sop_versions), 1, 'immutable snapshot written');

-- ------------------------------------------------------------------ learner --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.my_sop_training()), 1, 'technician sees the assigned SOP');
select is((select status from public.my_sop_training()), 'not_started', 'status starts at not_started');
select is((select count(*)::int from public.sop_documents), 0, 'learner cannot read the working-copy table');
select is((select count(*)::int from public.sop_version_quiz), 0, 'learner cannot read quiz answers');
select ok(
  not (public.get_sop_reader(current_setting('t.sop')::uuid)::text like '%correct_index%'),
  'reader payload never contains answers');

select throws_ok(
  format($$select public.acknowledge_sop(%L, 'Tom Tech')$$, current_setting('t.sop')),
  'quiz_not_passed', 'cannot acknowledge before passing the quiz');

select is((public.submit_sop_quiz(current_setting('t.sop')::uuid, '[0, 1]'::jsonb) ->> 'passed')::boolean, false,
  'wrong answers fail');
select is(public.submit_sop_quiz(current_setting('t.sop')::uuid, '[0, 1]'::jsonb) -> 'wrong', '[0, 1]'::jsonb,
  'failed attempt reports which questions were wrong, not the answers');
select is((public.submit_sop_quiz(current_setting('t.sop')::uuid, '[1, 0]'::jsonb) ->> 'score_pct')::int, 100,
  'correct answers score 100');

select throws_ok(
  format($$select public.acknowledge_sop(%L, 'T')$$, current_setting('t.sop')),
  'name_required', 'typed name is required');
select ok(public.acknowledge_sop(current_setting('t.sop')::uuid, 'Tom Tech') is not null, 'acknowledge returns a timestamp');
select ok(public.acknowledge_sop(current_setting('t.sop')::uuid, 'Tom Tech') is not null, 'acknowledge is idempotent');
select is((select status from public.my_sop_training()), 'completed', 'status completed');

select is((select count(*)::int from public.sops_for_job_template('00000000-0000-0000-0000-0000000000d1')), 1,
  'job template shows its linked SOP');
select is((select linked_items[1] from public.sops_for_job_template('00000000-0000-0000-0000-0000000000d1')),
  'Recover Refrigerant', 'checklist link is exposed with its display label');

select is((select count(*)::int from public.sop_acknowledgements), 0, 'learner cannot read the ack table directly');
update public.sop_acknowledgements set ack_name = 'forged';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.sop_acknowledgements where ack_name = 'forged'), 0, 'acknowledgements cannot be rewritten');
select is((select count(*)::int from public.sop_acknowledgements), 1, 'exactly one ack row (idempotent)');

-- ------------------------------------------------------------ manager report --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.sop_completion_report(current_setting('t.sop')::uuid)), 2,
  'manager sees both technicians');
select is((select count(*)::int from public.sop_completion_report(current_setting('t.sop')::uuid) where status = 'completed'), 1,
  'one technician completed');

-- ------------------------------------------------------ re-publish => re-ack --
select public.save_sop(current_setting('t.sop')::uuid, pg_temp.payload(
  '[{"target_type":"role","target_role":"technician","due_at":"2099-01-01T00:00:00Z"},
    {"target_type":"member","target_member_id":"00000000-0000-0000-0000-0000000000c4","due_at":"2000-01-01T00:00:00Z"}]'::jsonb,
  '{"body_md":"# Updated procedure"}'));
select is(public.publish_sop(current_setting('t.sop')::uuid, 'procedure changed'), 2, 'publish -> version 2');
select is((select count(*)::int from public.sop_completion_report(current_setting('t.sop')::uuid) where status = 'needs_reack'), 1,
  'previous acknowledger must re-acknowledge the new version');
select is((select status from public.sop_completion_report(current_setting('t.sop')::uuid) where team_member_id = '00000000-0000-0000-0000-0000000000c4'),
  'overdue', 'past due date => overdue');

-- ------------------------------------------------------------- tenant isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok(
  format($$select public.get_sop_reader(%L)$$, current_setting('t.sop')),
  'sop_not_found', 'another account cannot read the SOP');
select is((select count(*)::int from public.sop_versions), 0, 'another account sees no versions');

-- -------------------------------------------------------------------- archive --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.archive_sop(current_setting('t.sop')::uuid, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.my_sop_training()), 0, 'archived SOP disappears from training');

select * from finish();
rollback;
