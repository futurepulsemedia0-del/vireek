-- Incumbent ledger import (pgTAP). Run with:  supabase test db
-- Covers: idempotent re-import, totals check, read-only external records, RLS isolation,
-- permission gate, rollback, saved mappings.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@ledger.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner@other-ledger.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'member@ledger.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner')
on conflict (id) do update set role = excluded.role;
insert into public.team_members (account_owner_id, member_email, role)
values ('00000000-0000-0000-0000-0000000000c1', 'member@ledger.test', 'member');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

insert into public.customers (id, user_id, name, external_source, external_id) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000c1', 'Ann Alpha', 'service_titan', 'C1');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
insert into public.data_import_jobs (id, source, import_type, status)
values ('00000000-0000-0000-0000-0000000a0001', 'service_titan', 'invoices', 'running'),
       ('00000000-0000-0000-0000-0000000a0002', 'service_titan', 'invoices', 'running'),
       ('00000000-0000-0000-0000-0000000a0003', 'service_titan', 'line_items', 'running'),
       ('00000000-0000-0000-0000-0000000a0004', 'service_titan', 'payments', 'running'),
       ('00000000-0000-0000-0000-0000000a0005', 'service_titan', 'equipment', 'running');

-- ------------------------------------------------------------ invoices (1-4) --
create temp table r1 as select public.import_external_apply('00000000-0000-0000-0000-0000000a0001',
  '[{"source_id":"I1","customer_source_id":"C1","invoice_number":"1001","status":"paid","total_cents":15000,"subtotal_cents":15000,"tax_cents":0},
    {"source_id":"I2","customer_source_id":"C1","invoice_number":"1002","status":"sent","total_cents":10800,"subtotal_cents":10000,"tax_cents":800},
    {"source_id":"I3","customer_source_id":"NOPE","invoice_number":"1003","status":"unknown","total_cents":500}]'::jsonb) as r;
select is((select (r ->> 'created')::int from r1), 3, 'first import creates 3 invoices');
create temp table r2 as select public.import_external_apply('00000000-0000-0000-0000-0000000a0002',
  '[{"source_id":"I1","customer_source_id":"C1","invoice_number":"1001","status":"paid","total_cents":15000,"subtotal_cents":15000,"tax_cents":0},
    {"source_id":"I2","customer_source_id":"C1","invoice_number":"1002","status":"sent","total_cents":10800,"subtotal_cents":10000,"tax_cents":800},
    {"source_id":"I3","customer_source_id":"NOPE","invoice_number":"1003","status":"unknown","total_cents":500}]'::jsonb) as r;
select is((select (r ->> 'created')::int from r2), 0, 're-import creates nothing');
select is((select (r ->> 'skipped')::int from r2), 3, 're-import skips identical rows');
select is((select count(*)::int from public.external_invoices), 3, 'final invoice count identical after two imports');

-- ------------------------------------------------------ line items + totals (5-8) --
create temp table r3 as select public.import_external_apply('00000000-0000-0000-0000-0000000a0003',
  '[{"source_id":"L1","invoice_source_id":"I1","kind":"part","description":"Capacitor","quantity":1,"unit_price_cents":5000,"total_cents":5000},
    {"source_id":"L2","invoice_source_id":"I1","kind":"labor","description":"Labor","quantity":2,"unit_price_cents":5000,"total_cents":10000},
    {"source_id":"L3","invoice_source_id":"I2","kind":"part","description":"Filter","quantity":1,"unit_price_cents":9000,"total_cents":9000},
    {"source_id":"L4","invoice_source_id":"MISSING","kind":"part","total_cents":100}]'::jsonb) as r;
select is((select (r ->> 'created')::int from r3), 3, 'line items created for known invoices');
select is((select jsonb_array_length(r -> 'errors') from r3), 1, 'line for unknown invoice rejected with an error');
select is((select totals_verified from public.external_invoices where source_id = 'I1'), true, 'sum(lines) == invoice total -> verified');
select is((select totals_verified from public.external_invoices where source_id = 'I2'), false, 'sum(lines) != subtotal -> flagged');

-- ------------------------------------------------------- payments + equipment (9-10) --
create temp table r4 as select public.import_external_apply('00000000-0000-0000-0000-0000000a0004',
  '[{"source_id":"P1","invoice_source_id":"I1","amount_cents":15000,"method":"card","paid_on":"2027-01-05"}]'::jsonb) as r;
select is((select (r ->> 'created')::int from r4), 1, 'payment created');
create temp table r5 as select public.import_external_apply('00000000-0000-0000-0000-0000000a0005',
  '[{"source_id":"E1","customer_source_id":"C1","equipment_type":"Furnace","make":"Carrier","model":"59TP6","serial_number":"SN1","install_date":"2024-03-01"},
    {"source_id":"E2","customer_source_id":"NOPE","equipment_type":"AC"}]'::jsonb) as r;
select is((select (r ->> 'created')::int from r5), 1, 'equipment created for known customer only');

-- ---------------------------------------------------------- read-only (11-13) --
select throws_ok($$update public.external_invoices set total_cents = 1$$, '42501', null, 'authenticated cannot update external invoices');
select throws_ok($$delete from public.external_payments$$, '42501', null, 'authenticated cannot delete external payments');
select throws_ok($$insert into public.external_invoices (source_system, source_id, total_cents) values ('x','y',1)$$, '42501', null, 'authenticated cannot insert external invoices');

-- ----------------------------------------------------------- RLS isolation (14-17) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select is((select count(*)::int from public.external_invoices), 0, 'other tenant sees no external invoices');
select is((select count(*)::int from public.external_invoice_lines), 0, 'other tenant sees no lines');
select is((select count(*)::int from public.external_payments), 0, 'other tenant sees no payments');
select throws_ok($$select public.import_external_apply('00000000-0000-0000-0000-0000000a0001', '[]'::jsonb)$$, 'P0001', null, 'other tenant cannot write into a foreign import run');

-- ------------------------------------------------------- permission gate (18) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select throws_ok($$select public.import_external_apply('00000000-0000-0000-0000-0000000a0001', '[]'::jsonb)$$, '42501', null, 'team member without import permission is rejected');

-- ----------------------------------------------------------- saved mappings (19-20) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select lives_ok($$insert into public.import_saved_mappings (source, import_type, mapping) values ('service_titan','invoices','{"Invoice #":"invoice_number"}')$$, 'owner saves a mapping');
select throws_ok($$insert into public.import_saved_mappings (source, import_type, mapping) values ('service_titan','invoices','{}')$$, '23505', null, 'one saved mapping per source+type');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select is((select count(*)::int from public.import_saved_mappings), 0, 'saved mappings are tenant scoped');

-- ------------------------------------------------------------------ rollback (22-24) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
update public.data_import_jobs set status = 'rolling_back' where id = '00000000-0000-0000-0000-0000000a0003';
select is((select (public.import_external_rollback('00000000-0000-0000-0000-0000000a0003') ->> 'deleted')::int), 3, 'rollback deletes the lines the run created');
select is((select totals_verified from public.external_invoices where source_id = 'I1'), null, 'totals recomputed after rollback');
select is((select count(*)::int from public.external_invoices), 3, 'rollback of lines leaves invoices alone');

select * from finish();
rollback;
