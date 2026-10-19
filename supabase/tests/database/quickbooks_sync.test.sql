-- QuickBooks sync: tenant isolation, secrets lockdown, ledger functions (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- ---------------------------------------------------------------- fixtures --
-- A owner, M team member WITHOUT billing/profile permissions, B = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}');

insert into public.qbo_connections (id, user_id, realm_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '123145820001'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '123145820002');
insert into public.qbo_connection_secrets (connection_id, user_id, access_token_enc, refresh_token_enc) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'v1.x.y', 'v1.x.y');
insert into public.customers (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Ann Customer');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ tenant access --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.qbo_connections), 1, 'owner sees exactly their own connection');
select is((select realm_id from public.qbo_connections), '123145820001', 'and it is the right company');
select throws_ok($$ select * from public.qbo_connection_secrets $$, '42501', null, 'owner cannot read encrypted tokens');
select throws_ok($$ insert into public.qbo_connections (user_id, realm_id) values ('00000000-0000-0000-0000-0000000000a1', '123145820099') $$,
  '42501', null, 'owner cannot write connections from the client');
select is((with u as (update public.qbo_connections set status = 'error' returning 1) select count(*)::int from u), 0,
  'owner cannot update connections from the client');
select throws_ok($$ select public.qbo_create_ar_invoice('00000000-0000-0000-0000-0000000000a1', null, current_date, current_date, 0, '[]'::jsonb) $$,
  '42501', null, 'owner cannot call the service-only ledger functions');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.qbo_connections), 0, 'a team member without billing + profile permissions sees nothing');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.qbo_connections), 1, 'another account sees only its own connection');
select is((select count(*)::int from public.qbo_record_links), 0, 'and no foreign links');

reset role;

-- ------------------------------------------------------------------ grants --
select ok(not has_function_privilege('authenticated', 'public.qbo_record_ar_payment(uuid,uuid,integer,text,date,uuid)', 'execute'), 'authenticated cannot execute qbo_record_ar_payment');
select ok(has_function_privilege('service_role', 'public.qbo_record_ar_payment(uuid,uuid,integer,text,date,uuid)', 'execute'), 'service_role can execute qbo_record_ar_payment');

-- one live connection per QuickBooks company
select throws_ok($$ insert into public.qbo_connections (user_id, realm_id) values ('00000000-0000-0000-0000-0000000000b1', '123145820001') $$,
  '23505', null, 'a QuickBooks company cannot be live in two accounts');

-- ----------------------------------------------------------- ledger functions --
select set_config('t.inv', public.qbo_create_ar_invoice(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', date '2026-09-15', date '2026-10-15', 500,
  '[{"description":"Tune-up","quantity":2,"unit_price_cents":5000,"amount_cents":10000}]'::jsonb, 'QBO-1001')::text, true);

select is((select total_cents from public.ar_invoices where id = current_setting('t.inv')::uuid), 10500, 'invoice total = lines + tax');
select is((select entry_date from public.journal_entries je join public.ar_invoices i on i.journal_entry_id = je.id where i.id = current_setting('t.inv')::uuid),
  date '2026-09-15', 'journal entry is posted on the QuickBooks transaction date');
select is((select sum(debit_cents) - sum(credit_cents) from public.journal_lines jl join public.ar_invoices i on i.journal_entry_id = jl.journal_entry_id where i.id = current_setting('t.inv')::uuid)::int,
  0, 'the journal entry balances');

select set_config('t.pay', public.qbo_record_ar_payment('00000000-0000-0000-0000-0000000000a1', current_setting('t.inv')::uuid, 10500, 'card', date '2026-09-20')::text, true);
select is((select status from public.ar_invoices where id = current_setting('t.inv')::uuid), 'paid', 'a full payment marks the invoice paid');

select throws_ok(format($$ select public.qbo_replace_ar_invoice('00000000-0000-0000-0000-0000000000a1', %L::uuid, null, null, 0,
  '[{"description":"x","quantity":1,"unit_price_cents":1,"amount_cents":1}]'::jsonb) $$, current_setting('t.inv')),
  'P0001', 'PAYMENTS_EXIST: invoice has payments and cannot be re-itemised', 'a paid invoice is never re-itemised automatically');

select * from finish();
rollback;
