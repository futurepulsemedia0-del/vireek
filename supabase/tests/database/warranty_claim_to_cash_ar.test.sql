-- Warranty claim-to-cash: accounting handoff (ar_invoices via qbo_create_ar_invoice, payment via record_ar_payment).
-- Separate file so fixture differences (profiles/chart of accounts) cannot mask the main suite. NOT executed by the author.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a9', 'owner@wcc-ar.test');
-- has_account_permission() needs a profiles row for the owner; add required columns here if your profiles table needs more.
insert into public.profiles (id) values ('00000000-0000-0000-0000-0000000000a9') on conflict (id) do nothing;

insert into public.warranty_claims (id, user_id, customer_name, manufacturer, serial_number, status, claim_type, claim_number, estimated_recovery_cents)
values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000a9', 'Pat', 'Carrier', 'SN-AR-1', 'needs_review', 'manufacturer', 'RMA-9', 15000);
update public.warranty_claims set failure_description = 'x', model_number = 'm', status = 'ready' where id = '00000000-0000-0000-0000-0000000000aa';
update public.warranty_claims set status = 'submitted' where id = '00000000-0000-0000-0000-0000000000aa';

create temp table ctx (k text primary key, v text);
grant all on ctx to public;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a9', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok($$select public.wcc_create_ar_invoice('00000000-0000-0000-0000-0000000000aa')$$, '23514', 'claim_not_approved', 'cannot bill before approval');
reset role;
update public.warranty_claims set status = 'approved', approved_amount_cents = 12000 where id = '00000000-0000-0000-0000-0000000000aa';
set local role authenticated;

insert into ctx select 'inv', public.wcc_create_ar_invoice('00000000-0000-0000-0000-0000000000aa')::text;
select ok((select v from ctx where k = 'inv') is not null, 'invoice created');
select is(public.wcc_create_ar_invoice('00000000-0000-0000-0000-0000000000aa')::text, (select v from ctx where k = 'inv'), 'second call returns the same invoice (idempotent)');
select is((select total_cents from public.ar_invoices where id = (select v::uuid from ctx where k = 'inv')), 12000, 'invoice total = approved amount');
select is((select count(*)::int from public.ar_invoices where user_id = '00000000-0000-0000-0000-0000000000a9'), 1, 'exactly one invoice exists');

reset role;
update public.warranty_claims set status = 'paid', credit_received_cents = 10000 where id = '00000000-0000-0000-0000-0000000000aa';
set local role authenticated;
select ok(public.wcc_apply_payment('00000000-0000-0000-0000-0000000000aa') is not null, 'payment recorded against the invoice');
select is((select amount_paid_cents from public.ar_invoices where id = (select v::uuid from ctx where k = 'inv')), 10000, 'invoice shows the short-pay; remaining 2000 stays receivable');

reset role;
select * from finish();
rollback;
