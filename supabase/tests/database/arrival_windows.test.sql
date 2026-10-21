-- Arrival windows: narrowing function, jobs trigger, outbox, on-time report (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@aw.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@aw.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-aw.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@aw.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": false}');

-- J1: booked as a 4 hour window (08:00-12:00 UTC), planned arrival 10:00, not yet assigned.
insert into public.jobs (id, user_id, customer_name, scheduled_datetime, job_status,
                         arrival_window_start, arrival_window_end, arrival_window_original_start, arrival_window_original_end) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Window One',
   '2030-01-15 10:00+00', 'scheduled', '2030-01-15 08:00+00', '2030-01-15 12:00+00', '2030-01-15 08:00+00', '2030-01-15 12:00+00');

-- J2: no window at all, goes straight from scheduled to completed.
insert into public.jobs (id, user_id, customer_name, scheduled_datetime, job_status) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'No Window', '2030-01-20 09:00+00', 'scheduled');

-- -------------------------------------------------- arrival_window_narrow() --
select is((select window_start from public.arrival_window_narrow('2030-01-15 08:00+00', '2030-01-15 12:00+00', '2030-01-15 10:00+00', 120)),
  '2030-01-15 09:00+00'::timestamptz, 'narrow: centres on the planned arrival');
select is((select window_end from public.arrival_window_narrow('2030-01-15 08:00+00', '2030-01-15 12:00+00', '2030-01-15 08:00+00', 120)),
  '2030-01-15 10:00+00'::timestamptz, 'narrow: clamps to the start of the window');
select is((select window_start from public.arrival_window_narrow('2030-01-15 08:00+00', '2030-01-15 12:00+00', '2030-01-15 11:30+00', 120)),
  '2030-01-15 10:00+00'::timestamptz, 'narrow: clamps to the end of the window');
select is((select window_end from public.arrival_window_narrow('2030-01-15 09:00+00', '2030-01-15 11:00+00', '2030-01-15 09:00+00', 240)),
  '2030-01-15 11:00+00'::timestamptz, 'narrow: never widens');

-- ----------------------------------------------------------------- trigger --
update public.jobs set assigned_technician_id = '00000000-0000-0000-0000-0000000000c3'
  where id = '00000000-0000-0000-0000-0000000000e1';

select is((select arrival_window_start from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  '2030-01-15 09:00+00'::timestamptz, 'dispatch: window start narrowed to 09:00');
select is((select arrival_window_end from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  '2030-01-15 11:00+00'::timestamptz, 'dispatch: window end narrowed to 11:00');
select isnt((select arrival_window_narrowed_at from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  null::timestamptz, 'dispatch: narrowed_at is stamped');
select is((select arrival_window_original_start from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  '2030-01-15 08:00+00'::timestamptz, 'dispatch: the original promise is preserved');
select is((select count(*) from public.arrival_window_notifications
           where job_id = '00000000-0000-0000-0000-0000000000e1' and kind = 'narrowed'),
  1::bigint, 'dispatch: exactly one narrowed notification is queued');

update public.jobs set scheduled_datetime = '2030-01-15 10:30+00' where id = '00000000-0000-0000-0000-0000000000e1';
select is((select count(*) from public.arrival_window_notifications where job_id = '00000000-0000-0000-0000-0000000000e1'),
  1::bigint, 'move inside the window: no new notification');

update public.jobs set scheduled_datetime = '2030-01-16 14:07+00' where id = '00000000-0000-0000-0000-0000000000e1';
select is((select arrival_window_start from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  '2030-01-16 14:00+00'::timestamptz, 'reschedule outside the window: re-based to the new day');
select is((select arrival_window_original_end from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  '2030-01-16 18:00+00'::timestamptz, 'reschedule outside the window: new original keeps the 4h length');
select is((select count(*) from public.arrival_window_notifications
           where job_id = '00000000-0000-0000-0000-0000000000e1' and kind = 'changed'),
  1::bigint, 'reschedule outside the window: a changed notification is queued');

-- arrival stamp
update public.jobs set job_status = 'in_progress' where id = '00000000-0000-0000-0000-0000000000e1';
select isnt((select arrival_confirmed_at from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'),
  null::timestamptz, 'arrival: stamped when the job becomes in_progress');
update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-0000000000e2';
select is((select arrival_confirmed_at from public.jobs where id = '00000000-0000-0000-0000-0000000000e2'),
  null::timestamptz, 'arrival: NOT guessed when a job jumps straight to completed');

-- ------------------------------------------------------------ on-time report --
-- R1 on time, R2 arrives 40 minutes after the window closed, R3 never arrived (missed).
insert into public.jobs (id, user_id, customer_name, assigned_technician_id, scheduled_datetime, job_status,
                         arrival_window_start, arrival_window_end, arrival_window_original_start, arrival_window_original_end, arrival_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'R1', '00000000-0000-0000-0000-0000000000c3',
   now() - interval '5 days', 'completed', now() - interval '5 days', now() - interval '5 days' + interval '2 hours',
   now() - interval '5 days', now() - interval '5 days' + interval '2 hours', now() - interval '5 days' + interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'R2', '00000000-0000-0000-0000-0000000000c3',
   now() - interval '4 days', 'completed', now() - interval '4 days', now() - interval '4 days' + interval '2 hours',
   now() - interval '4 days', now() - interval '4 days' + interval '2 hours', now() - interval '4 days' + interval '160 minutes'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'R3', '00000000-0000-0000-0000-0000000000c3',
   now() - interval '3 days', 'scheduled', now() - interval '3 days', now() - interval '3 days' + interval '2 hours',
   now() - interval '3 days', now() - interval '3 days' + interval '2 hours', null);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is((select measured_jobs from public.get_technician_on_time_report(now() - interval '10 days', now())),
  3, 'report: three measured visits');
select is((select on_time_jobs from public.get_technician_on_time_report(now() - interval '10 days', now())),
  1, 'report: one on time');
select is((select late_jobs from public.get_technician_on_time_report(now() - interval '10 days', now())),
  2, 'report: arrived-late and missed both count as late');
select is((select missed_jobs from public.get_technician_on_time_report(now() - interval '10 days', now())),
  1, 'report: the never-arrived visit is flagged as missed');
select is((select max_minutes_late::integer from public.get_technician_on_time_report(now() - interval '10 days', now())),
  40, 'report: 40 minutes after the window closed');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select is((select count(*) from public.get_technician_on_time_report(now() - interval '10 days', now())),
  0::bigint, 'report: another account sees none of these visits');

select * from finish();
rollback;
