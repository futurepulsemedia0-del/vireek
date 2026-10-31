-- Approval-to-Cash: link integrity, gate (block/warn/override), AP state machine, ladder claim,
-- recovery ledger, demand drafts (no send state), RLS + service-only surface (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a2c.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@a2c.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-a2c.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'admin@a2c.test', 'Ada Admin', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{}');

-- Team members have no profile of their own (app convention: owner = profile with role 'owner').
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a2';

-- WO1: approved, PO, NTE $1,000.00.  WO2: pending approval.  WOB: other tenant.
insert into public.work_orders (id, user_id, title, po_number, approval_status, not_to_exceed_cents) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', 'HVAC PM', 'PO-1', 'approved', 100000),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', 'Pending WO', null, 'pending', null),
  ('00000000-0000-0000-0000-00000000f0b1', '00000000-0000-0000-0000-0000000000b1', 'Other tenant WO', 'PO-B', 'approved', 5000);

insert into public.invoices (id, user_id, customer_name, line_items, tax_percent, work_order_id, due_date) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000a1', 'Acme', '[{"description":"Labor","quantity":1,"unit_price_cents":60000}]', 0, '00000000-0000-0000-0000-00000000f001', current_date + 30),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000a1', 'Acme', '[{"description":"Parts","quantity":1,"unit_price_cents":50000}]', 0, '00000000-0000-0000-0000-00000000f001', current_date + 30),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-0000000000a1', 'Acme', '[{"description":"Misc","quantity":1,"unit_price_cents":1000}]', 0, '00000000-0000-0000-0000-00000000f002', current_date + 30),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-0000000000a1', 'Overdue Co', '[{"description":"Svc","quantity":1,"unit_price_cents":20000}]', 0, null, current_date - 20);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------- structure ----
select has_table('public', 'invoice_ar_tracking', 'tracking table exists');
select has_table('public', 'invoice_gate_overrides', 'override table exists');
select has_table('public', 'invoice_demand_drafts', 'demand draft table exists');
select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('public.invoice_ar_tracking'::regclass, 'public.invoice_gate_overrides'::regclass, 'public.invoice_demand_drafts'::regclass)),
  'RLS is enabled on all three new tables');

-- ------------------------------------------------------- link integrity -----
select throws_ok($$ insert into public.invoices (user_id, customer_name, line_items, work_order_id)
    values ('00000000-0000-0000-0000-0000000000a1', 'X', '[]', '00000000-0000-0000-0000-00000000f0b1') $$,
  '42501', null, 'cannot link an invoice to another tenant''s work order');

-- ----------------------------------------------------------------- gate -----
select is((public.a2c_gate_for_service('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001')->>'ok')::boolean,
  true, 'gate: $600 within $1,000 NTE, approved WO -> ok');
select is((public.a2c_gate_for_service('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001')->'findings'->0->>'code'),
  'MISSING_COMPLETION_PROOF', 'gate: missing completion proof is reported (warn by default)');
select is((public.a2c_gate_for_service('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a003')->>'ok')::boolean,
  false, 'gate: pending work order blocks');

update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-00000000a001';
select is((select status from public.invoices where id = '00000000-0000-0000-0000-00000000a001'), 'sent', 'first invoice within NTE can be sent');

select throws_ok($$ update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-00000000a002' $$,
  '23514', null, 'DB backstop: second invoice would exceed the NTE ($1,100 > $1,000)');
select throws_ok($$ update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-00000000a003' $$,
  '23514', null, 'DB backstop: unapproved work order cannot be billed');
select throws_ok($$ update public.invoices set work_order_id = null where id = '00000000-0000-0000-0000-00000000a001' $$,
  '23514', null, 'a sent invoice cannot be unlinked from its work order');

-- override: admin cannot, owner can (reason required), and it is audited
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$ select public.a2c_override_gate('00000000-0000-0000-0000-00000000a002', 'Customer approved by phone') $$,
  'P0001', 'Only the account owner can override an approval check', 'non-owner cannot override');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.a2c_override_gate('00000000-0000-0000-0000-00000000a002', 'short') $$,
  'P0001', 'Enter a reason of at least 10 characters', 'override needs a real reason');
select lives_ok($$ select public.a2c_override_gate('00000000-0000-0000-0000-00000000a002', 'Customer approved extra parts by phone 5/1') $$,
  'owner can override with a reason');
reset role;
select is((select count(*) from public.audit_log where action = 'invoice_gate_overridden' and target_id = '00000000-0000-0000-0000-00000000a002'),
  1::bigint, 'override is in the audit trail');
select lives_ok($$ update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-00000000a002' $$,
  'overridden invoice can be sent');

-- ------------------------------------------------------- state machine ------
select is((select ap_state from public.invoice_ar_tracking where invoice_id = '00000000-0000-0000-0000-00000000a001'),
  'sent', 'tracking row created when the invoice is sent');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.set_invoice_ap_state('00000000-0000-0000-0000-00000000a001', 'rejected', '  ') $$,
  'P0001', 'A rejection reason is required', 'rejection requires a reason');
select throws_ok($$ select public.set_invoice_ap_state('00000000-0000-0000-0000-00000000a001', 'paid') $$,
  'P0001', null, 'paid cannot be set manually');
select is(public.set_invoice_ap_state('00000000-0000-0000-0000-00000000a001', 'rejected', 'PO number is wrong'),
  'rejected', 'sent -> rejected with a reason');
reset role;
select is((select source_type from public.revenue_recovery_events where source_table = 'invoices' and source_id = '00000000-0000-0000-0000-00000000a001'),
  'invoice_rejected', 'rejected invoice lands in revenue_recovery_events');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.set_invoice_ap_state('00000000-0000-0000-0000-00000000a001', 'approved'),
  'approved', 'rejected -> approved after resolution');
reset role;
select is((select count(*) from public.revenue_recovery_events where source_table = 'invoices' and source_id = '00000000-0000-0000-0000-00000000a001'),
  0::bigint, 'resolved (never worked) event is removed, not claimed as a recovery');
update public.invoices set status = 'paid' where id = '00000000-0000-0000-0000-00000000a001';
select is((select ap_state from public.invoice_ar_tracking where invoice_id = '00000000-0000-0000-0000-00000000a001'),
  'paid', 'payment sets paid automatically');

-- ------------------------------------------------------ ladder + ledger -----
update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-00000000a004';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.a2c_approve_followups('00000000-0000-0000-0000-00000000a004') $$, 'human approves follow-ups');
reset role;
select is((select count(*) from public.a2c_followup_candidates(current_date)), 1::bigint,
  'only the approved, overdue invoice is a ladder candidate');
select is(public.a2c_claim_followup_step('00000000-0000-0000-0000-00000000a004', 0, 1), true, 'step 1 claimed');
select is(public.a2c_claim_followup_step('00000000-0000-0000-0000-00000000a004', 0, 1), false, 'second claim of the same step loses (idempotent)');
select public.a2c_sync_recovery_events(current_date);
select is((select source_type from public.revenue_recovery_events where source_table = 'invoices' and source_id = '00000000-0000-0000-0000-00000000a004'),
  'invoice_overdue', 'overdue invoice lands in revenue_recovery_events');

-- ----------------------------------------------------- demand drafts ---------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok(public.a2c_save_demand_draft('00000000-0000-0000-0000-00000000a004', 'Draft v1') is not null, 'draft saved');
select ok(public.a2c_save_demand_draft('00000000-0000-0000-0000-00000000a004', 'Draft v2') is not null, 'saving again updates the same draft');
select is((select count(*) from public.invoice_demand_drafts where invoice_id = '00000000-0000-0000-0000-00000000a004' and status = 'draft'),
  1::bigint, 'only one open draft per invoice (idempotent save)');
select throws_ok($$ select public.a2c_save_demand_draft('00000000-0000-0000-0000-00000000a002', 'x') $$, 'P0001', null,
  'no draft for an invoice that is not overdue / has no balance');
reset role;
select throws_ok($$ update public.invoice_demand_drafts set status = 'sent' $$, '23514', null, 'there is no sent state for demand drafts');

-- ------------------------------------------------------------------- RLS ----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.invoice_ar_tracking), 0::bigint, 'other tenant sees no tracking rows');
select is((select count(*) from public.invoice_demand_drafts), 0::bigint, 'other tenant sees no demand drafts');
select throws_ok($$ select public.a2c_claim_followup_step('00000000-0000-0000-0000-00000000a004', 1, 2) $$, '42501', null,
  'clients cannot call the cron-only claim function');
select throws_ok($$ select public.invoice_send_gate('00000000-0000-0000-0000-00000000a004') $$, 'P0001', 'Invoice not found',
  'other tenant cannot evaluate this tenant''s invoice');
select throws_ok($$ insert into public.invoice_ar_tracking (invoice_id, user_id) values ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'clients cannot write tracking rows directly');
reset role;

select * from finish();
rollback;
