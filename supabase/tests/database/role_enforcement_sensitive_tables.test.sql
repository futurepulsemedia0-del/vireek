-- DB-level role enforcement (identity-authz-audit F2). pgTAP. Run: supabase test db
-- Actors: O owner, M manager (all permissions), B billing-only member, T technician (no permissions), X owner of ANOTHER account.
-- Matrix: role x table x operation. Behavioural rows for employees + api_keys; catalog + permission checks for every other classified table.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'billing@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

-- Members must resolve to the OWNER's account: they have no profile of their own.
delete from public.profiles where id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a4');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin', '00000000-0000-0000-0000-0000000000a2', 'active',
   '{"can_manage_team":true,"can_view_billing":true,"can_manage_security":true,"can_issue_refunds":true,"can_edit_business_profile":true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'billing@acme.test', 'Bo Billing', 'member', '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_billing":true}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician', '00000000-0000-0000-0000-0000000000a4', 'active', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Fixtures (as postgres).
insert into public.employees (id, user_id, full_name) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', 'Emp A'),
  ('00000000-0000-0000-0000-00000000e00a', '00000000-0000-0000-0000-0000000000a1', 'Upd O'),
  ('00000000-0000-0000-0000-00000000e00b', '00000000-0000-0000-0000-0000000000a1', 'Upd M'),
  ('00000000-0000-0000-0000-00000000e00c', '00000000-0000-0000-0000-0000000000a1', 'Upd B'),
  ('00000000-0000-0000-0000-00000000e00d', '00000000-0000-0000-0000-0000000000a1', 'Upd T'),
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-0000000000b1', 'Emp X');
insert into public.api_keys (id, user_id, name, key_prefix, key_hash) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', 'key A', 'vrk_live_a', 'hash-a'),
  ('00000000-0000-0000-0000-00000000f0f1', '00000000-0000-0000-0000-0000000000b1', 'key X', 'vrk_live_x', 'hash-x');

-- ============================================================ 1. catalog: no tenant-only policy is left on a classified table
select is(
  (select count(*)::int from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.tbl
      and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ilike '%get_account_owner_id%'
      and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) not ilike '%has_account_permission%'
      and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) not ilike '%bank_can_access%'),
  0, t.tbl || ': no tenant-only policy remains')
from (values ('employees'), ('timesheets'), ('pay_runs'), ('pay_run_items'), ('refunds'), ('credit_memos'), ('stripe_connect_accounts'),
  ('financing_connections'), ('cash_flow_settings'), ('cash_flow_fixed_expenses'), ('cash_flow_snapshots'), ('chart_of_accounts'),
  ('accounting_periods'), ('journal_entries'), ('journal_lines'), ('ar_invoices'), ('ar_invoice_lines'), ('ar_payments'), ('ap_bills'),
  ('ap_bill_lines'), ('ap_bill_payments'), ('bank_matches'), ('api_keys'), ('webhook_endpoints')) as t(tbl);

select ok(exists (select 1 from pg_policies where tablename = 'employees' and policyname like 'rbac\_insert\_employees%'), 'employees: write policies are permission-gated (insert)');
select ok(exists (select 1 from pg_policies where tablename = 'pay_runs' and cmd = 'SELECT' and qual ilike '%can_view_billing%'), 'pay_runs: select requires can_view_billing');
select ok(not exists (select 1 from pg_policies where tablename = 'pay_runs' and cmd <> 'SELECT'), 'pay_runs: still no client write policy (writes stay server-side)');
select ok(exists (select 1 from pg_policies where tablename = 'api_keys' and qual ilike '%can_manage_security%'), 'api_keys: requires can_manage_security');
select ok(exists (select 1 from pg_policies where tablename = 'bank_matches' and qual ilike '%bank_can_access%'), 'bank_matches: gated by bank_can_access like its siblings');

-- ============================================================ 2. permission matrix (the keys the policies call)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok(public.has_account_permission('can_manage_team') and public.has_account_permission('can_view_billing') and public.has_account_permission('can_manage_security'), 'owner holds every permission');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select ok(public.has_account_permission('can_manage_team') and public.has_account_permission('can_issue_refunds'), 'manager holds the granted permissions');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select ok(public.has_account_permission('can_view_billing') and not public.has_account_permission('can_manage_team'), 'billing member: billing yes, team no');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select ok(not public.has_account_permission('can_view_billing') and not public.has_account_permission('can_manage_security'), 'technician holds no sensitive permission');

-- ============================================================ 3. employees: role x operation
-- SELECT
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.employees where full_name = 'Emp A'), 1, 'employees SELECT: owner sees rows');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.employees where full_name = 'Emp A'), 1, 'employees SELECT: manager sees rows');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.employees where full_name = 'Emp A'), 1, 'employees SELECT: billing member sees rows (earnings need billing)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from public.employees), 0, 'employees SELECT: technician sees NOTHING (pay rates are not for technicians)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select array_agg(full_name) from public.employees), array['Emp X'], 'employees SELECT: other account sees only its own');

-- INSERT
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into public.employees (user_id, full_name) values ('00000000-0000-0000-0000-0000000000a1', 'New by O') $$, 'employees INSERT: owner');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$ insert into public.employees (user_id, full_name) values ('00000000-0000-0000-0000-0000000000a1', 'New by M') $$, 'employees INSERT: manager');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ insert into public.employees (user_id, full_name) values ('00000000-0000-0000-0000-0000000000a1', 'New by B') $$, '42501', null, 'employees INSERT: billing member denied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ insert into public.employees (user_id, full_name) values ('00000000-0000-0000-0000-0000000000a1', 'New by T') $$, '42501', null, 'employees INSERT: technician denied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ insert into public.employees (user_id, full_name) values ('00000000-0000-0000-0000-0000000000a1', 'New by X') $$, '42501', null, 'employees INSERT: other account cannot write into this account');

-- UPDATE (RLS filters silently: verify the effect as postgres afterwards)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); update public.employees set full_name = 'Done O' where id = '00000000-0000-0000-0000-00000000e00a';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); update public.employees set full_name = 'Done M' where id = '00000000-0000-0000-0000-00000000e00b';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); update public.employees set full_name = 'Done B' where id = '00000000-0000-0000-0000-00000000e00c';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4'); update public.employees set full_name = 'Done T' where id = '00000000-0000-0000-0000-00000000e00d';
reset role;
select is((select full_name from public.employees where id = '00000000-0000-0000-0000-00000000e00a'), 'Done O', 'employees UPDATE: owner');
select is((select full_name from public.employees where id = '00000000-0000-0000-0000-00000000e00b'), 'Done M', 'employees UPDATE: manager');
select is((select full_name from public.employees where id = '00000000-0000-0000-0000-00000000e00c'), 'Upd B', 'employees UPDATE: billing member denied');
select is((select full_name from public.employees where id = '00000000-0000-0000-0000-00000000e00d'), 'Upd T', 'employees UPDATE: technician denied');

-- DELETE
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4'); delete from public.employees where id = '00000000-0000-0000-0000-00000000e00d';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); delete from public.employees where id = '00000000-0000-0000-0000-00000000e00c';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1'); delete from public.employees where id = '00000000-0000-0000-0000-00000000e00a';
reset role;
select is((select count(*)::int from public.employees where id in ('00000000-0000-0000-0000-00000000e00d', '00000000-0000-0000-0000-00000000e00c', '00000000-0000-0000-0000-00000000e00a')), 3,
  'employees DELETE: technician, billing member and other account all denied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); delete from public.employees where id = '00000000-0000-0000-0000-00000000e00b';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); delete from public.employees where id = '00000000-0000-0000-0000-00000000e00a';
reset role;
select is((select count(*)::int from public.employees where id in ('00000000-0000-0000-0000-00000000e00b', '00000000-0000-0000-0000-00000000e00a')), 0, 'employees DELETE: manager and owner allowed');

-- ============================================================ 4. employee_directory keeps the technician UI working (names only)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select ok((select count(*)::int from public.employee_directory where full_name = 'Emp A') = 1, 'directory: technician can list names of their own account');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_directory' and column_name ~ 'rate|salary|commission|withholding'), 'directory: exposes no pay columns');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.employee_directory where full_name = 'Emp A'), 0, 'directory: other account sees nothing of this account');

-- ============================================================ 5. api_keys: role x operation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.api_keys where name = 'key A'), 1, 'api_keys SELECT: owner');
select lives_ok($$ insert into public.api_keys (user_id, name, key_prefix, key_hash) values ('00000000-0000-0000-0000-0000000000a1', 'by O', 'vrk_live_o', 'hash-o') $$, 'api_keys INSERT: owner');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.api_keys where name = 'key A'), 1, 'api_keys SELECT: manager (can_manage_security)');
select lives_ok($$ insert into public.api_keys (user_id, name, key_prefix, key_hash) values ('00000000-0000-0000-0000-0000000000a1', 'by M', 'vrk_live_m', 'hash-m') $$, 'api_keys INSERT: manager');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.api_keys), 0, 'api_keys SELECT: billing member sees no keys');
select throws_ok($$ insert into public.api_keys (user_id, name, key_prefix, key_hash) values ('00000000-0000-0000-0000-0000000000a1', 'by B', 'vrk_live_b', 'hash-b') $$, '42501', null, 'api_keys INSERT: billing member denied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from public.api_keys), 0, 'api_keys SELECT: technician sees no keys');
select throws_ok($$ insert into public.api_keys (user_id, name, key_prefix, key_hash) values ('00000000-0000-0000-0000-0000000000a1', 'by T', 'vrk_live_t', 'hash-t') $$, '42501', null, 'api_keys INSERT: technician denied');
update public.api_keys set revoked_at = now() where id = '00000000-0000-0000-0000-00000000f001';
reset role;
select is((select revoked_at from public.api_keys where id = '00000000-0000-0000-0000-00000000f001'), null, 'api_keys UPDATE (revoke): technician denied');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select array_agg(name) from public.api_keys), array['key X'], 'api_keys SELECT: other account sees only its own key');

select * from finish();
rollback;
