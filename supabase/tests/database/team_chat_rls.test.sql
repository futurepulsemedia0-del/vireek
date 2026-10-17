-- Team chat: RLS / RPC / trigger / storage tests (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (can_view_all_jobs), T1/T2 technicians, X = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'tech2@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_all_jobs": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech1@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": false}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'tech2@acme.test', 'Tina Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{"can_view_all_jobs": false}');

insert into public.jobs (id, user_id, customer_name, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Job One', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'Job Two', '00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'Job Three', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Other Co Job', null);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------- job channel access --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.j1', public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e1')::text, true);
select ok(current_setting('t.j1')::uuid is not null, 'owner can open the channel of a job');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e1'), current_setting('t.j1')::uuid,
  'manager opening the same job gets the SAME channel (idempotent)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e1'), current_setting('t.j1')::uuid,
  'assigned technician gets the same channel');
select throws_ok($$ select public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e2') $$, '42501', null,
  'technician cannot open a channel for a job assigned to someone else');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ select public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e1') $$, '42501', null,
  'the other technician cannot open job 1');
select set_config('t.j2', public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e2')::text, true);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e1') $$, '42501', null,
  'another account cannot open our job channel');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.chat_open_job_channel('00000000-0000-0000-0000-0000000000f1') $$, '42501', null,
  'we cannot open a job channel in another account');

-- --------------------------------------------------------- channel visibility --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.chat_channels)::int, 1, 'technician sees only the channel of his own job');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.chat_channels)::int, 2, 'manager sees every job channel in the account');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.chat_channels)::int, 0, 'other account sees nothing');
reset role;
select is((select count(*) from public.chat_channels)::int, 2, 'sanity: exactly two channels exist');
set local role anon;
select is((select count(*) from public.chat_channels)::int, 0, 'anon sees no channels');
reset role;

-- ------------------------------------------------------------------ messages --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.chat_messages (channel_id, sender_id, kind, body, created_at) values
  (current_setting('t.j1')::uuid, '00000000-0000-0000-0000-0000000000a1', 'text', '  Parts are at the shop  ', now() - interval '10 minutes'),
  (current_setting('t.j1')::uuid, '00000000-0000-0000-0000-0000000000a1', 'text', 'Call me when you arrive', now() - interval '9 minutes');
select is((select body from public.chat_messages order by created_at limit 1), 'Parts are at the shop', 'body is trimmed by the trigger');
select is((select last_message_preview from public.chat_channels where id = current_setting('t.j1')::uuid),
  'Call me when you arrive', 'channel preview/last message are maintained by trigger');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$ insert into public.chat_messages (channel_id, kind, body, client_id)
  values (current_setting('t.j1')::uuid, 'text', 'On my way', '11111111-1111-1111-1111-111111111111') $$,
  'assigned technician can post');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body, client_id)
  values (current_setting('t.j1')::uuid, 'text', 'On my way', '11111111-1111-1111-1111-111111111111') $$,
  '23505', null, 'a retried client_id is rejected (idempotent sends)');
select throws_ok($$ insert into public.chat_messages (channel_id, sender_id, kind, body)
  values (current_setting('t.j1')::uuid, '00000000-0000-0000-0000-0000000000a1', 'text', 'spoofed') $$,
  '42501', null, 'cannot post as someone else');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body)
  values (current_setting('t.j1')::uuid, 'system', 'fake system message') $$,
  '42501', null, 'clients cannot post system messages');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body) values (current_setting('t.j1')::uuid, 'text', '   ') $$,
  '23514', null, 'blank text is rejected');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body)
  values (current_setting('t.j1')::uuid, 'text', repeat('x', 4001)) $$, '23514', null, 'over-long text is rejected');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body) values (current_setting('t.j1')::uuid, 'text', 'intruder') $$,
  '42501', null, 'unrelated technician cannot post into someone else''s job channel');
select is((select count(*) from public.chat_messages where channel_id = current_setting('t.j1')::uuid)::int, 0,
  'unrelated technician cannot read those messages');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.chat_messages)::int, 0, 'other account cannot read any messages');

-- ------------------------------------------------------------ attachments -----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$ insert into public.chat_messages (channel_id, kind, attachment_path, attachment_mime, attachment_bytes)
  values (current_setting('t.j1')::uuid, 'image',
   '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j1') || '/00000000-0000-0000-0000-0000000000a3_1.jpg', 'image/jpeg', 1000) $$,
  'image message with a correctly scoped path is accepted');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, attachment_path, voice_duration_ms)
  values (current_setting('t.j1')::uuid, 'voice',
   '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j2') || '/00000000-0000-0000-0000-0000000000a3_1.webm', 3000) $$,
  '22023', null, 'attachment pointing at ANOTHER channel folder is rejected');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, attachment_path, voice_duration_ms)
  values (current_setting('t.j1')::uuid, 'voice',
   '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j1') || '/00000000-0000-0000-0000-0000000000a1_1.webm', 3000) $$,
  '22023', null, 'attachment named after a different sender is rejected');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, attachment_path)
  values (current_setting('t.j1')::uuid, 'voice',
   '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j1') || '/00000000-0000-0000-0000-0000000000a3_1.webm') $$,
  '23514', null, 'voice note without a duration violates the shape check');

-- ----------------------------------------------------------- edit / delete ----
select lives_ok($$ update public.chat_messages set body = 'On my way (10 min)' where client_id = '11111111-1111-1111-1111-111111111111' $$,
  'sender can edit own text within the window');
select ok((select edited_at is not null from public.chat_messages where client_id = '11111111-1111-1111-1111-111111111111'),
  'edit stamps edited_at');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
update public.chat_messages set body = 'hijacked' where client_id = '11111111-1111-1111-1111-111111111111';
select is((select body from public.chat_messages where client_id = '11111111-1111-1111-1111-111111111111'), 'On my way (10 min)',
  'another participant cannot edit someone else''s message (RLS hides the row)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
update public.chat_messages set deleted_at = now() where client_id = '11111111-1111-1111-1111-111111111111';
select ok((select deleted_at is not null and body is null from public.chat_messages where client_id = '11111111-1111-1111-1111-111111111111'),
  'soft delete tombstones the message and clears the body');
delete from public.chat_messages where channel_id = current_setting('t.j1')::uuid;
select ok((select count(*) from public.chat_messages where channel_id = current_setting('t.j1')::uuid) >= 4,
  'there is no hard-delete path for clients (DELETE removes nothing)');

-- ------------------------------------------------ read receipts / unread -------
-- Job 3 belongs to T1 who has never opened it; the office writes first.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.j3', public.chat_open_job_channel('00000000-0000-0000-0000-0000000000e3')::text, true);
insert into public.chat_messages (channel_id, kind, body, created_at) values
  (current_setting('t.j3')::uuid, 'text', 'Gate code is 4412', now() - interval '5 minutes');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select unread from public.chat_unread_counts() where channel_id = current_setting('t.j3')::uuid), 1::bigint,
  'assigned technician who never opened the channel sees office messages as unread');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.chat_unread_counts() where channel_id = current_setting('t.j3')::uuid)::int, 0,
  'a manager who never followed the channel gets no unread noise');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select public.chat_mark_read(current_setting('t.j3')::uuid, now() - interval '5 minutes');
select is((select count(*) from public.chat_unread_counts() where channel_id = current_setting('t.j3')::uuid)::int, 0,
  'marking read clears the unread count');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select public.chat_mark_read(current_setting('t.j1')::uuid, now() - interval '9 minutes');
select is((select last_read_at from public.chat_members where channel_id = current_setting('t.j1')::uuid
           and user_id = '00000000-0000-0000-0000-0000000000a2'), now() - interval '9 minutes', 'mark_read stores the marker');
select public.chat_mark_read(current_setting('t.j1')::uuid, now() - interval '30 minutes');
select is((select last_read_at from public.chat_members where channel_id = current_setting('t.j1')::uuid
           and user_id = '00000000-0000-0000-0000-0000000000a2'), now() - interval '9 minutes', 'mark_read never moves the marker backwards');
select public.chat_mark_read(current_setting('t.j1')::uuid, now() + interval '2 hours');
select ok((select last_read_at <= now() from public.chat_members where channel_id = current_setting('t.j1')::uuid
           and user_id = '00000000-0000-0000-0000-0000000000a2'), 'a future marker is clamped to now()');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((select count(*) from public.chat_members where channel_id = current_setting('t.j1')::uuid) >= 3,
  'office can see who read the channel (read receipts)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ select public.chat_mark_read(current_setting('t.j1')::uuid) $$, '42501', null,
  'cannot mark read in a channel you cannot access');

-- ---------------------------------------------------------- direct messages ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.dm', public.chat_open_direct('00000000-0000-0000-0000-0000000000a3')::text, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.chat_open_direct('00000000-0000-0000-0000-0000000000a1'), current_setting('t.dm')::uuid,
  'a DM between two people is one channel from both sides');
select throws_ok($$ select public.chat_open_direct('00000000-0000-0000-0000-0000000000b1') $$, '42501', null,
  'cannot DM a person from another account');
select throws_ok($$ select public.chat_open_direct('00000000-0000-0000-0000-0000000000a3') $$, '22023', null,
  'cannot DM yourself');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.chat_channels where kind = 'direct')::int, 0,
  'managers do NOT get access to other people''s DMs');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body) values (current_setting('t.dm')::uuid, 'text', 'x') $$,
  '42501', null, 'non-participants cannot post in a DM');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.chat_people())::int, 4, 'chat_people lists the 4 people of this account only');

-- ------------------------------------------------------------------ storage ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$ insert into storage.objects (bucket_id, name)
  values ('chat-media', '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j1') || '/00000000-0000-0000-0000-0000000000a3_up.jpg') $$,
  'participant can upload into the channel folder');
select throws_ok($$ insert into storage.objects (bucket_id, name)
  values ('chat-media', '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j2') || '/00000000-0000-0000-0000-0000000000a3_up.jpg') $$,
  '42501', null, 'cannot upload into a channel you cannot access');
select throws_ok($$ insert into storage.objects (bucket_id, name)
  values ('chat-media', '00000000-0000-0000-0000-0000000000a1/' || current_setting('t.j1') || '/00000000-0000-0000-0000-0000000000a1_up.jpg') $$,
  '42501', null, 'cannot upload a file named after someone else');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*) from storage.objects where bucket_id = 'chat-media')::int, 0, 'unrelated technician cannot read chat media');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from storage.objects where bucket_id = 'chat-media')::int, 1, 'office can read the media of the job channel');
delete from storage.objects where bucket_id = 'chat-media';
select is((select count(*) from storage.objects where bucket_id = 'chat-media')::int, 1, 'office cannot delete a file uploaded by the technician');

-- ------------------------------------------------------------ push audience ----
reset role;
-- job 2: T2 speaks first -> nobody in the office follows yet -> managers (O, M) are notified.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
insert into public.chat_messages (id, channel_id, kind, body) values
  ('00000000-0000-0000-0000-00000000aa01', current_setting('t.j2')::uuid, 'text', 'Customer not home');
reset role;
select set_eq($$ select user_id from public.chat_push_recipients('00000000-0000-0000-0000-00000000aa01') $$,
  $$ values ('00000000-0000-0000-0000-0000000000a1'::uuid), ('00000000-0000-0000-0000-0000000000a2'::uuid) $$,
  'first contact from the field notifies every manager');
-- office replies -> follower now exists.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.chat_messages (id, channel_id, kind, body) values
  ('00000000-0000-0000-0000-00000000aa02', current_setting('t.j2')::uuid, 'text', 'Reschedule for tomorrow');
reset role;
select set_eq($$ select user_id from public.chat_push_recipients('00000000-0000-0000-0000-00000000aa02') $$,
  $$ values ('00000000-0000-0000-0000-0000000000a4'::uuid) $$, 'office message notifies the assigned technician only');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
insert into public.chat_messages (id, channel_id, kind, body) values
  ('00000000-0000-0000-0000-00000000aa03', current_setting('t.j2')::uuid, 'text', 'Ok');
reset role;
select set_eq($$ select user_id from public.chat_push_recipients('00000000-0000-0000-0000-00000000aa03') $$,
  $$ values ('00000000-0000-0000-0000-0000000000a1'::uuid) $$, 'once someone follows, the next field message goes to followers only');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.chat_set_muted(current_setting('t.j2')::uuid, true);
reset role;
select is((select count(*) from public.chat_push_recipients('00000000-0000-0000-0000-00000000aa03'))::int, 0, 'muted followers are not notified');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ select * from public.chat_push_recipients('00000000-0000-0000-0000-00000000aa03') $$, '42501', null,
  'clients cannot enumerate push audiences');

-- ----------------------------------------------------- reassignment + limits --
reset role;
update public.jobs set assigned_technician_id = '00000000-0000-0000-0000-0000000000c4' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.chat_channels where kind = 'job')::int, 1, 'reassigning a job removes the old technician''s access (job 3 stays his)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*) from public.chat_channels where kind = 'job')::int, 2, 'and gives the new technician access (jobs 1 and 2)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ insert into public.chat_messages (channel_id, kind, body)
  select current_setting('t.dm')::uuid, 'text', 'spam ' || g from generate_series(1, 40) g $$, 'P0001', 'rate_limited',
  'burst guard stops floods (30 messages / 10 s)');

select * from finish();
rollback;
