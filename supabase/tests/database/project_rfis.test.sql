-- Project RFIs: lifecycle, overdue sweep, change-order links, attachments, account isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
with i as (insert into public.install_projects (name, customer_name) values ('Rooftop units', 'Ada') returning id) select set_config('t.proj', id::text, true) from i;
with i as (insert into public.install_projects (name, customer_name) values ('Second job', 'Bob') returning id) select set_config('t.proj2', id::text, true) from i;

-- ---------- lifecycle ----------
with i as (insert into public.install_project_rfis (project_id, subject, question, party_name, status, due_date)
  values (current_setting('t.proj')::uuid, 'Curb height', 'Confirm curb height for RTU-2', 'Acme Architects', 'open', current_date + 5) returning id) select set_config('t.r1', id::text, true) from i;
select is((select rfi_number from public.install_project_rfis where id = current_setting('t.r1')::uuid), 'RFI-001', 'the first RFI in a project is RFI-001');
select ok((select sent_at is not null from public.install_project_rfis where id = current_setting('t.r1')::uuid), 'opening an RFI stamps sent_at');

with i as (insert into public.install_project_rfis (project_id, subject, question, party_name)
  values (current_setting('t.proj')::uuid, 'Duct routing', 'Can we route under the beam?', 'GC') returning id) select set_config('t.r2', id::text, true) from i;
select is((select rfi_number from public.install_project_rfis where id = current_setting('t.r2')::uuid), 'RFI-002', 'numbers increase per project');
select is((select status from public.install_project_rfis where id = current_setting('t.r2')::uuid), 'draft', 'a new RFI defaults to draft');

select throws_ok($$ insert into public.install_project_rfis (project_id, subject, question, party_name, status) values (current_setting('t.proj')::uuid, 'x', 'y', 'z', 'answered') $$, 'P0001', 'invalid_rfi_status', 'an RFI cannot be created already answered');
select throws_ok($$ update public.install_project_rfis set status = 'closed' where id = current_setting('t.r1')::uuid $$, 'P0001', 'invalid_rfi_transition', 'open cannot jump straight to closed');
select throws_ok($$ update public.install_project_rfis set status = 'answered' where id = current_setting('t.r1')::uuid $$, 'P0001', 'answer_required', 'answering needs an answer');
select lives_ok($$ update public.install_project_rfis set status = 'answered', answer = '  Curb is 14 in.  ' where id = current_setting('t.r1')::uuid $$, 'an open RFI can be answered');
select is((select answer from public.install_project_rfis where id = current_setting('t.r1')::uuid), 'Curb is 14 in.', 'the answer is trimmed');
select ok((select answered_at is not null and answered_by = '00000000-0000-0000-0000-0000000000a1' from public.install_project_rfis where id = current_setting('t.r1')::uuid), 'answering stamps answered_at and answered_by');
select is((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and title like 'RFI answered: RFI-001%' and action_url like '%tab=rfis&rfi=%'), 1::bigint, 'answering notifies the account through the existing notifications table');
select throws_ok($$ update public.install_project_rfis set subject = 'Changed' where id = current_setting('t.r1')::uuid $$, 'P0001', 'rfi_locked', 'the question is frozen once answered');
select lives_ok($$ update public.install_project_rfis set status = 'closed' where id = current_setting('t.r1')::uuid $$, 'an answered RFI can be closed');
select throws_ok($$ update public.install_project_rfis set answer = 'Edited' where id = current_setting('t.r1')::uuid $$, 'P0001', 'rfi_locked', 'a closed RFI is read-only');
select lives_ok($$ update public.install_project_rfis set status = 'open' where id = current_setting('t.r1')::uuid $$, 'a closed RFI can be reopened');
select ok((select answered_at is null and closed_at is null from public.install_project_rfis where id = current_setting('t.r1')::uuid), 'reopening clears the answered and closed stamps');

-- incoming RFIs ask the account for a response
select lives_ok($$ insert into public.install_project_rfis (project_id, subject, question, party_name, direction, status, due_date) values (current_setting('t.proj')::uuid, 'Panel location', 'Where will the disconnect go?', 'Inspector Lee', 'incoming', 'open', current_date + 2) $$, 'an incoming RFI can be logged');
select is((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and title like 'RFI needs your response:%'), 1::bigint, 'an incoming open RFI notifies the account');

-- ---------- overdue ----------
with i as (insert into public.install_project_rfis (project_id, subject, question, party_name, status, due_date)
  values (current_setting('t.proj')::uuid, 'Late one', 'Still waiting?', 'Vendor', 'open', current_date - 3) returning id) select set_config('t.r3', id::text, true) from i;
select is(public.rfi_refresh_overdue(), 1, 'the sweep flags only the overdue open RFI');
select is((select count(*) from public.notifications where title like 'RFI overdue: %'), 1::bigint, 'one overdue notification is created');
select is(public.rfi_refresh_overdue(), 0, 'an overdue RFI is notified once');
select lives_ok($$ update public.install_project_rfis set due_date = current_date - 1 where id = current_setting('t.r3')::uuid $$, 'the due date can be moved');
select is(public.rfi_refresh_overdue(), 1, 'moving the due date re-arms the overdue notification');

-- ---------- change orders ----------
with i as (insert into public.install_project_change_orders (project_id, title, amount_cents, schedule_days)
  values (current_setting('t.proj')::uuid, 'Add curb adapter', 184000, 3) returning id) select set_config('t.co', id::text, true) from i;
with i as (insert into public.install_project_change_orders (project_id, title)
  values (current_setting('t.proj2')::uuid, 'Other project CO') returning id) select set_config('t.co2', id::text, true) from i;
select lives_ok($$ update public.install_project_rfis set change_order_id = current_setting('t.co')::uuid, impacts_cost = true where id = current_setting('t.r3')::uuid $$, 'an RFI can link a change order of its own project');
select throws_ok($$ update public.install_project_rfis set change_order_id = current_setting('t.co2')::uuid where id = current_setting('t.r3')::uuid $$, 'P0001', 'invalid_change_order', 'a change order of another project cannot be linked');
select throws_ok($$ update public.install_project_change_orders set status = 'approved' where id = current_setting('t.co')::uuid $$, 'P0001', 'invalid_change_order_transition', 'a draft change order cannot be approved directly');

-- ---------- attachments ----------
select throws_ok($$ insert into public.install_project_rfi_attachments (project_id, rfi_id, file_name, storage_path, size_bytes) values (current_setting('t.proj')::uuid, current_setting('t.r3')::uuid, 'a.pdf', 'someone-else/a.pdf', 10) $$, 'P0001', 'invalid_attachment_path', 'an attachment must live under the RFI''s own folder');
select lives_ok($$ insert into public.install_project_rfi_attachments (project_id, rfi_id, file_name, storage_path, size_bytes)
  values (current_setting('t.proj')::uuid, current_setting('t.r3')::uuid, 'a.pdf', '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.proj') || '/' || current_setting('t.r3') || '/x-a.pdf', 10) $$, 'a correctly placed attachment is accepted');

-- ---------- deletion and isolation ----------
select lives_ok($$ delete from public.install_project_rfis where id = current_setting('t.r3')::uuid $$, 'deleting an open RFI is silently filtered by RLS');
select is((select count(*) from public.install_project_rfis where id = current_setting('t.r3')::uuid), 1::bigint, 'an open RFI cannot be deleted (void it first)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.install_project_rfis), 0::bigint, 'another account sees no RFIs');
select throws_ok($$ insert into public.install_project_rfis (project_id, subject, question, party_name) values (current_setting('t.proj')::uuid, 'x', 'y', 'z') $$, 'P0001', 'invalid_project', 'another account cannot write into this project');

select * from finish();
rollback;
