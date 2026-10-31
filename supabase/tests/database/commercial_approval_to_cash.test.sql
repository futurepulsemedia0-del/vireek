-- Commercial Approval-to-Cash: block rules, RLS / tenant isolation, idempotency, immutability (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@cc.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'billing@cc.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@cc.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-cc.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'billing@cc.test', 'Bea Billing', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_billing": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@cc.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_billing": false}');

insert into public.customers (id, user_id, name, customer_type) values
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000a1', 'Acme Property', 'commercial'),
  ('00000000-0000-0000-0000-00000000cc02', '00000000-0000-0000-0000-0000000000a1', 'Home Owner', 'residential'),
  ('00000000-0000-0000-0000-00000000cc99', '00000000-0000-0000-0000-0000000000b1', 'Other Tenant Co', 'commercial');
insert into public.jobs (id, user_id, customer_name, job_status, customer_signature_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Acme Property', 'completed', null),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'Acme Property', 'completed', now()),
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000b1', 'Other Tenant Co', 'completed', now());

insert into public.commercial_billing_profiles (user_id, customer_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000cc01'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000cc99');

-- $1,000.00 invoices (10 x 10000 cents, 0% tax)
insert into public.invoices (id, user_id, job_id, customer_id, invoice_number, customer_name, line_items, tax_percent, status, due_date) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000cc01', 'T-1', 'Acme Property', '[{"description":"x","quantity":10,"unit_price_cents":10000}]', 0, 'draft', current_date - 40),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000cc01', 'T-2', 'Acme Property', '[{"description":"x","quantity":10,"unit_price_cents":10000}]', 0, 'draft', current_date - 40),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', null, '00000000-0000-0000-0000-00000000cc02', 'T-3', 'Home Owner', '[{"description":"x","quantity":1,"unit_price_cents":5000}]', 0, 'draft', null),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-00000000cc99', 'O-1', 'Other Tenant Co', '[{"description":"x","quantity":1,"unit_price_cents":100}]', 0, 'draft', null);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ block rules --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select is((public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f3') ->> 'applies')::boolean, false,
  'residential / non-opted-in customer: nothing applies');
select is((select stage from public.commercial_invoice_tracking where invoice_id = '00000000-0000-0000-0000-0000000000f3'), null,
  'no tracking row is created for a non-opted-in customer');

select is(public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f1') -> 'reasons' @> '[{"code":"missing_po"}]', true,
  'rule: missing PO is reported');
select is(public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f1') -> 'reasons' @> '[{"code":"missing_completion_proof"}]', true,
  'rule: no photo and no signature = missing completion proof');
select is((select stage from public.commercial_invoice_tracking where invoice_id = '00000000-0000-0000-0000-0000000000f1'),
  'blocked_needs_approval', 'status becomes blocked_needs_approval with reasons stored');
select throws_ok(
  $$update public.invoices set status = 'sent' where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'hard gate: draft -> sent is refused while blocked');

-- record a $500 PO on job e2 (which has a signature) -> over-NTE for a $1,000 invoice
select lives_ok($$insert into public.commercial_approvals (customer_id, job_id, po_number, approved_amount_cents, approval_source, evidence_ref, approved_by_name, approved_at)
  values ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000e2', 'PO-500', 50000, 'purchase_order', 'msg-id-123', 'Pat Buyer', now())$$,
  'owner can record an approval with evidence');
select is(public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f2') -> 'reasons' @> '[{"code":"over_approved_amount"}]', true,
  'rule: invoice total above approved amount is blocked');
select is((public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f2') -> 'reasons' -> 0 ->> 'excess_cents')::bigint, 50000::bigint,
  'excess is computed ($1,000 - $500)');
select is(public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f2') -> 'reasons' @> '[{"code":"missing_po"}]', false,
  'job-linked approval satisfies the PO rule');

-- NTE is cumulative: approval for $1,500 covers one $1,000 invoice but not two
select lives_ok($$insert into public.commercial_approvals (customer_id, job_id, po_number, approved_amount_cents, approval_source, evidence_ref, approved_by_name, approved_at)
  values ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000e2', 'PO-1500', 150000, 'purchase_order', 'msg-id-124', 'Pat Buyer', now() + interval '1 second')$$,
  'newer approval (change order) recorded');
select is((public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f2') ->> 'blocked')::boolean, false,
  'newest approval is used and the invoice now passes');

-- owner override: needs a real reason and expires if the total grows
select throws_ok($$select public.commercial_override_block('00000000-0000-0000-0000-0000000000f1', 'short')$$, '22023', null,
  'override requires a written reason');
select lives_ok($$select public.commercial_override_block('00000000-0000-0000-0000-0000000000f1', 'Customer confirmed by phone, PO to follow')$$,
  'owner can override with a reason');
select lives_ok($$update public.invoices set status = 'sent', sent_at = now() where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'overridden invoice can be sent');
select is((select stage from public.commercial_invoice_tracking where invoice_id = '00000000-0000-0000-0000-0000000000f1'), 'sent',
  'stage follows the invoice to sent');

-- --------------------------------------------------------------- state machine --
select throws_ok($$select public.commercial_set_stage('00000000-0000-0000-0000-0000000000f1', 'rejected', null)$$, '22023', null,
  'rejection needs a reason');
select lives_ok($$select public.commercial_set_stage('00000000-0000-0000-0000-0000000000f1', 'rejected', 'PO number missing on invoice')$$,
  'sent -> rejected with reason');
select is((select source_type from public.revenue_recovery_events where source_table = 'invoices' and source_id = '00000000-0000-0000-0000-0000000000f1'),
  'invoice_rejected', 'rejected invoice is written to revenue_recovery_events');
select throws_ok($$select public.commercial_set_stage('00000000-0000-0000-0000-0000000000f1', 'paid', null)$$, '22023', null,
  'paid cannot be set by hand through the tracker');
select lives_ok($$update public.invoices set status = 'paid', paid_at = now() where id = '00000000-0000-0000-0000-0000000000f1'$$, 'invoice paid');
select is((select stage from public.commercial_invoice_tracking where invoice_id = '00000000-0000-0000-0000-0000000000f1'), 'paid', 'paid syncs to the tracker');
select is((select status from public.revenue_recovery_events where source_table = 'invoices' and source_id = '00000000-0000-0000-0000-0000000000f1'),
  'recovered', 'payment closes the recovery event');

-- -------------------------------------------------------------- idempotency --
reset role;
select is(public.commercial_claim_followup('00000000-0000-0000-0000-0000000000f2', 30, 'reminder'), true, 'first claim wins');
select is(public.commercial_claim_followup('00000000-0000-0000-0000-0000000000f2', 30, 'reminder'), false, 'second claim of the same step is refused');
select is((select count(*)::int from (select public.commercial_queue_demand_draft('00000000-0000-0000-0000-0000000000f2', 'b', 'd', '{}') union all
  select public.commercial_queue_demand_draft('00000000-0000-0000-0000-0000000000f2', 'b', 'd', '{}')) s where s.commercial_queue_demand_draft is not null), 1,
  'demand draft is created once per invoice');
select is((select status from public.commercial_demand_drafts where invoice_id = '00000000-0000-0000-0000-0000000000f2'), 'pending_review',
  'demand draft is pending human review');

-- ---------------------------------------------------------- RLS / isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.commercial_approvals), 0, 'other tenant cannot read this account''s approvals');
select is((select count(*)::int from public.commercial_demand_drafts), 0, 'other tenant cannot read this account''s drafts');
select throws_ok($$select public.commercial_precheck_invoice('00000000-0000-0000-0000-0000000000f2')$$, '42501', null,
  'other tenant cannot run the check on a foreign invoice');
select throws_ok($$insert into public.commercial_approvals (customer_id, po_number, approved_amount_cents, approval_source, evidence_ref, approved_by_name, approved_at)
  values ('00000000-0000-0000-0000-00000000cc01', 'X', 1, 'other', 'r', 'Eve Tenant', now())$$, '42501', null,
  'other tenant cannot attach an approval to a foreign customer');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.commercial_approvals), 0, 'team member without can_view_billing sees nothing');

select * from finish();
rollback;
