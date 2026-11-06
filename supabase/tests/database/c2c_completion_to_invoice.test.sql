-- Slice 2 pgTAP: completion -> draft invoice. Place at supabase/tests/database/c2c_completion_to_invoice.test.sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'owner@c2c2.test');
update public.feature_flags set enabled = true where key = 'c2c_orchestration';
insert into public.feature_flag_overrides (flag_id, tenant_id, state)
select id, '00000000-0000-0000-0000-0000000000d1', 'on' from public.feature_flags where key = 'c2c_orchestration';

insert into public.quotes (id, user_id, customer_name, line_items, tax_percent, status) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-0000000000d1', 'Bob',
   '[{"description":"Repair","quantity":1,"unit_price_cents":15000}]', 8, 'accepted'),
  ('00000000-0000-0000-0000-00000000d0a2', '00000000-0000-0000-0000-0000000000d1', 'Carl',
   '[{"description":"X","quantity":1,"unit_price_cents":100}]', 0, 'sent');

insert into public.jobs (id, user_id, customer_name, job_status, quote_id, completed_at) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000d1', 'Bob',  'in_progress', '00000000-0000-0000-0000-00000000d0a1', null),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000d1', 'Carl', 'completed',   '00000000-0000-0000-0000-00000000d0a2', now()),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000d1', 'NoQ',  'completed',   null, now());

select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d001'))->>'result', 'not_completed', 'refuses non-completed job');
update public.jobs set job_status = 'completed', completed_at = now() where id = '00000000-0000-0000-0000-00000000d001';

select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d001'))->>'result', 'drafted', 'drafts from accepted quote');
select is((select line_items->0->>'unit_price_cents' from public.invoices where job_id = '00000000-0000-0000-0000-00000000d001'), '15000', 'line items copied');
select is((select status from public.invoices where job_id = '00000000-0000-0000-0000-00000000d001'), 'draft', 'invoice is draft, never auto-sent');
select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d001'))->>'result', 'already_invoiced', 'replay is idempotent');
select is((select count(*)::int from public.invoices where job_id = '00000000-0000-0000-0000-00000000d001'), 1, 'exactly one invoice after replay');
select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d002'))->>'result', 'quote_not_accepted', 'unaccepted quote -> no invoice invented');
select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d003'))->>'result', 'no_quote', 'no quote -> no invoice invented');

insert into public.job_automation_locks (user_id, job_id, reason) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000d003', 'operator');
select is((public.c2c_draft_invoice_for_job('00000000-0000-0000-0000-00000000d003'))->>'result', 'operator_locked', 'operator lock stops automation');

select * from finish();
rollback;
