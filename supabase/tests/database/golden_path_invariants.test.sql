-- Golden path invariants (pgTAP). NOT RUN when authored: no Postgres was available. Run with:  supabase test db
-- Covers: double-booking constraint, job completion needs technician, payment <= balance, refund <= payment,
-- Stripe payment_request mirrored into invoice_payments (capped, idempotent), append-only workflow_events, tenant isolation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@gp.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-gp.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'tech@gp.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'tech@gp.test', 'Tess Tech', 'technician',
   '00000000-0000-0000-0000-0000000000c1', 'active', '{}');
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000c1';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- J1 unassigned, J2 assigned, J3/J4 overlapping with no technician (double-booking), J5 for the Stripe mirror
insert into public.jobs (id, user_id, customer_name, scheduled_datetime, job_status, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Unassigned', '2030-03-01 08:00+00', 'in_progress', null),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'Assigned',   '2030-03-02 08:00+00', 'in_progress', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'Slot A',     '2030-03-03 09:00+00', 'scheduled',   null),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a1', 'Stripe job', '2030-03-05 09:00+00', 'completed',   '00000000-0000-0000-0000-0000000000d1');

-- INV1: $100.00 (no tax)   INV2: linked to the Stripe job, $100.00
insert into public.invoices (id, user_id, customer_name, line_items, tax_percent, job_id) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000a1', 'Acme',
   '[{"description":"Labor","quantity":1,"unit_price_cents":10000}]', 0, null),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000a1', 'Stripe Co',
   '[{"description":"Svc","quantity":1,"unit_price_cents":10000}]', 0, '00000000-0000-0000-0000-0000000000e5');

-- ------------------------------------------------------------ structure ----
select has_table('public', 'workflow_events', 'workflow_events exists');

-- ------------------------------------------------------- double booking ----
select throws_ok(
  $$insert into public.jobs (user_id, customer_name, scheduled_datetime, job_status)
    values ('00000000-0000-0000-0000-0000000000a1', 'Slot B', '2030-03-03 09:30+00', 'scheduled')$$,
  '23P01', null, 'overlapping job for the same resource is rejected by the exclusion constraint');

-- ----------------------------------------------------------- job events ----
select is((select count(*)::int from public.workflow_events
           where entity_type = 'job' and entity_id = '00000000-0000-0000-0000-0000000000e1' and event_type = 'job.created'),
  1, 'job insert writes job.created');

update public.jobs set job_status = 'en_route' where id = '00000000-0000-0000-0000-0000000000e1';
select is((select count(*)::int from public.workflow_events
           where entity_id = '00000000-0000-0000-0000-0000000000e1' and event_type = 'job.status_changed'
             and from_status = 'in_progress' and to_status = 'en_route'),
  1, 'status change writes job.status_changed with from/to');

update public.jobs set assigned_technician_id = '00000000-0000-0000-0000-0000000000d1' where id = '00000000-0000-0000-0000-0000000000e1';
select is((select count(*)::int from public.workflow_events
           where entity_id = '00000000-0000-0000-0000-0000000000e1' and event_type = 'job.technician_changed'),
  1, 'assignment change writes job.technician_changed');
update public.jobs set assigned_technician_id = null where id = '00000000-0000-0000-0000-0000000000e1';

-- ------------------------------------------ completion needs a technician --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  '23514', null, 'end user cannot complete a job with no technician');
select lives_ok(
  $$update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-0000000000e2'$$,
  'end user can complete a job that has a technician');
reset role;
select lives_ok(
  $$update public.jobs set job_status = 'completed' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'service role / automation (no auth.uid) is exempt');

-- -------------------------------------------------- payment <= balance due --
select lives_ok(
  $$insert into public.invoice_payments (user_id, invoice_id, amount_cents, method)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001', 6000, 'cash')$$,
  'partial payment of 60.00 on 100.00 is accepted');
select throws_ok(
  $$insert into public.invoice_payments (user_id, invoice_id, amount_cents, method)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001', 4001, 'cash')$$,
  '23514', 'Payment exceeds the balance due', 'one cent over the balance is rejected');
select throws_ok(
  $$insert into public.invoice_payments (user_id, invoice_id, amount_cents, method)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000a001', 1000, 'cash')$$,
  '23514', null, 'payment with another tenant''s user_id is rejected');
select lives_ok(
  $$insert into public.invoice_payments (user_id, invoice_id, amount_cents, method)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001', 4000, 'cash')$$,
  'exact remaining balance is accepted');

-- ------------------------------------------------------ refund <= payment --
select throws_ok(
  $$insert into public.invoice_refunds (user_id, invoice_id, payment_id, amount_cents, reason)
    select user_id, invoice_id, id, 6001, 'too much' from public.invoice_payments
    where invoice_id = '00000000-0000-0000-0000-00000000a001' and amount_cents = 6000$$,
  '23514', 'Refund exceeds the refundable amount of this payment', 'refund above payment is rejected');

-- ------------------------------------------------- invoice shape (NOT VALID) --
select throws_ok(
  $$insert into public.invoices (user_id, customer_name, line_items, tax_percent)
    values ('00000000-0000-0000-0000-0000000000a1', 'Bad', '{}'::jsonb, 0)$$,
  '23514', null, 'line_items must be a jsonb array');
select throws_ok(
  $$insert into public.invoices (user_id, customer_name, line_items, tax_percent)
    values ('00000000-0000-0000-0000-0000000000a1', 'Bad', '[]'::jsonb, 150)$$,
  '23514', null, 'tax_percent above 100 is rejected');

-- ------------------------------------------- Stripe payment -> invoice -----
-- request 1: $40.00 of the $100.00 invoice
insert into public.payment_requests (id, user_id, job_id, customer_name, amount, status)
values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000e5', 'Stripe Co', 40.00, 'sent');
update public.payment_requests set status = 'paid', paid_at = now(), stripe_payment_intent_id = 'pi_gp_1'
 where id = '00000000-0000-0000-0000-00000000f001';
select is((select amount_cents from public.invoice_payments where reference = 'payment_request:00000000-0000-0000-0000-00000000f001'),
  4000::bigint, 'paid payment_request is mirrored into invoice_payments (card, 40.00)');

-- toggling back and re-paying must not duplicate
update public.payment_requests set status = 'sent' where id = '00000000-0000-0000-0000-00000000f001';
update public.payment_requests set status = 'paid' where id = '00000000-0000-0000-0000-00000000f001';
select is((select count(*)::int from public.invoice_payments where reference = 'payment_request:00000000-0000-0000-0000-00000000f001'),
  1, 'mirror is idempotent');

-- request 2: $100.00 but only $60.00 is still due -> booked 60.00, excess flagged
insert into public.payment_requests (id, user_id, job_id, customer_name, amount, status)
values ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000e5', 'Stripe Co', 100.00, 'sent');
update public.payment_requests set status = 'paid', paid_at = now(), stripe_payment_intent_id = 'pi_gp_2'
 where id = '00000000-0000-0000-0000-00000000f002';
select is((select amount_cents from public.invoice_payments where reference = 'payment_request:00000000-0000-0000-0000-00000000f002'),
  6000::bigint, 'mirror caps at the balance due');
select is((select status from public.invoices where id = '00000000-0000-0000-0000-00000000a002'),
  'paid', 'invoice becomes paid once net payments reach the total');
select is((select count(*)::int from public.audit_log
           where action = 'invoice_payment_needs_review' and target_id = '00000000-0000-0000-0000-00000000a002'),
  1, 'the unbooked excess is flagged for a human');

-- ---------------------------------------------------- append-only + RLS ----
select throws_ok($$update public.workflow_events set event_type = 'x'$$, '42501', null, 'workflow_events: UPDATE rejected');
select throws_ok($$delete from public.workflow_events$$, '42501', null, 'workflow_events: DELETE rejected');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.workflow_events), 0, 'another tenant sees none of these events');

select * from finish();
rollback;
