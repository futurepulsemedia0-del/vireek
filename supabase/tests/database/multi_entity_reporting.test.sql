-- Multi-entity reporting: totals, intercompany elimination, per-entity access, integrity (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- a1 owner | a2 team member WITH billing | a3 team member WITHOUT billing | b1 owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'billing@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'plain@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'billing@acme.test', 'Bea Billing', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false, "can_view_billing": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'plain@acme.test', 'Pat Plain', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}');

-- An entity that belongs to the OTHER account (inserted as superuser).
insert into public.reporting_entities (id, user_id, code, name) values
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'BX', 'Other Account Entity');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.acct(p_code text) returns uuid language sql as $$
  select id from public.chart_of_accounts where user_id = '00000000-0000-0000-0000-0000000000a1' and code = p_code
$$;

create or replace function pg_temp.post(p_date date, p_memo text, p_dr text, p_cr text, p_cents int) returns uuid language sql as $$
  select public.post_journal_entry(p_date, p_memo, 'manual', null::uuid, jsonb_build_array(
    jsonb_build_object('account_id', pg_temp.acct(p_dr), 'debit_cents', p_cents, 'credit_cents', 0, 'description', p_memo),
    jsonb_build_object('account_id', pg_temp.acct(p_cr), 'debit_cents', 0, 'credit_cents', p_cents, 'description', p_memo)
  ))
$$;

-- ------------------------------------------------------------ owner: setup --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.ensure_default_chart_of_accounts();

select is((select count(*)::int from public.list_reporting_entities()), 1, 'a new account starts with exactly one entity');
select is((select entity_code from public.list_reporting_entities() where is_default), 'MAIN', 'which is the default MAIN entity');

select set_config('t.main', public.ensure_default_reporting_entity()::text, true);
select set_config('t.beta', public.create_reporting_entity('Beta LLC', 'beta')::text, true);
select set_config('t.gamma', public.create_reporting_entity('Gamma LLC', 'GAMMA')::text, true);

select is((select entity_code from public.list_reporting_entities() where entity_name = 'Beta LLC'), 'BETA', 'entity codes are normalised to upper case');
select is((select count(*)::int from public.list_reporting_entities()), 3, 'owner sees all three entities');

-- ---------------------------------------------------------- ledger fixtures --
select set_config('t.e1', pg_temp.post('2026-09-10', 'Sale MAIN',  '1000', '4000', 100000)::text, true);  -- stays unassigned => MAIN
select set_config('t.e2', pg_temp.post('2026-09-11', 'Sale BETA',  '1000', '4000',  40000)::text, true);
select set_config('t.e3', pg_temp.post('2026-09-12', 'Cost BETA',  '6900', '1000',  15000)::text, true);
select set_config('t.e4', pg_temp.post('2026-09-13', 'Subs GAMMA', '5100', '1000',  30000)::text, true);
select set_config('t.e5', pg_temp.post('2026-08-15', 'Aug sale',   '1000', '4000',   7000)::text, true);

select is(public.assign_journal_entries_to_entity(
  array[current_setting('t.e2')::uuid, current_setting('t.e3')::uuid], current_setting('t.beta')::uuid), 2, 'two entries moved to BETA');
select is(public.assign_journal_entries_to_entity(
  array[current_setting('t.e4')::uuid], current_setting('t.gamma')::uuid), 1, 'one entry moved to GAMMA');
select is(public.assign_journal_entries_to_entity(
  array[current_setting('t.e2')::uuid], current_setting('t.beta')::uuid), 0, 'moving an entry to where it already is changes nothing');

select set_config('t.grp', public.post_intercompany_entry(
  '2026-09-20', 'mgmt fee', current_setting('t.main')::uuid, current_setting('t.beta')::uuid, 25000,
  pg_temp.acct('1100'), pg_temp.acct('4900'), pg_temp.acct('6900'), pg_temp.acct('2000'))::text, true);

select is((select count(*)::int from public.journal_entries where intercompany_group_id = current_setting('t.grp')::uuid and is_intercompany),
  2, 'an intercompany posting creates two flagged entries');
select is((select count(*)::int from public.journal_entries je where je.intercompany_group_id = current_setting('t.grp')::uuid
  and je.entity_id = current_setting('t.main')::uuid and je.counterparty_entity_id = current_setting('t.beta')::uuid), 1,
  'the provider side points at the recipient');
select is((select count(*)::int from public.journal_entries je where je.intercompany_group_id = current_setting('t.grp')::uuid
  and je.entity_id = current_setting('t.beta')::uuid and je.counterparty_entity_id = current_setting('t.main')::uuid), 1,
  'and the recipient side points back at the provider');

-- Entry counts per entity (unassigned entries belong to MAIN).
select is((select entry_count from public.list_reporting_entities() where entity_code = 'MAIN'), 3::bigint, 'MAIN holds the unassigned entries plus its intercompany side');
select is((select entry_count from public.list_reporting_entities() where entity_code = 'BETA'), 3::bigint, 'BETA holds its entries plus its intercompany side');
select is((select entry_count from public.list_reporting_entities() where entity_code = 'GAMMA'), 1::bigint, 'GAMMA holds one entry');

-- ------------------------------------------------------- totals (September) --
-- MAIN: revenue 100000 + 25000 IC | BETA: revenue 40000, expense 15000 + 25000 IC | GAMMA: expense 30000
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where entity_code = 'MAIN' and type = 'revenue')::bigint,
  125000::bigint, 'MAIN gross revenue');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where entity_code = 'BETA' and type = 'revenue')::bigint,
  40000::bigint, 'BETA gross revenue');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where entity_code = 'BETA' and type = 'expense')::bigint,
  40000::bigint, 'BETA gross expense includes the intercompany charge');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where entity_code = 'GAMMA' and type = 'expense')::bigint,
  30000::bigint, 'GAMMA gross expense');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  165000::bigint, 'combined gross revenue is the sum of the entities');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'expense')::bigint,
  70000::bigint, 'combined gross expense is the sum of the entities');

-- Reconciles with the existing single-book report.
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  (select coalesce(sum(amount_cents), 0) from public.get_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  'gross revenue across entities equals get_profit_and_loss');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'expense')::bigint,
  (select coalesce(sum(amount_cents), 0) from public.get_profit_and_loss('2026-09-01', '2026-09-30') where type = 'expense')::bigint,
  'gross expense across entities equals get_profit_and_loss');

-- Date filter.
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-08-01', '2026-08-31') where type = 'revenue')::bigint,
  7000::bigint, 'only August entries appear in an August report');
select throws_ok($$ select * from public.get_multi_entity_profit_and_loss('2026-09-30', '2026-09-01') $$, '22023', null, 'an inverted date range is rejected');

-- ----------------------------------------------------------- elimination --
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  25000::bigint, 'intercompany revenue is eliminated');
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'expense')::bigint,
  25000::bigint, 'intercompany expense is eliminated');
select is((select coalesce(sum(intercompany_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  25000::bigint, 'the intercompany share is reported separately');
select is((select coalesce(sum(gross_cents - eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint
  - (select coalesce(sum(gross_cents - eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'expense')::bigint,
  95000::bigint, 'combined net income is unchanged by elimination');
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30', null, false))::bigint,
  0::bigint, 'nothing is eliminated when the flag is off');
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30',
  array[current_setting('t.main')::uuid, current_setting('t.gamma')::uuid]))::bigint,
  0::bigint, 'nothing is eliminated when the counterparty is outside the selection');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30',
  array[current_setting('t.main')::uuid, current_setting('t.gamma')::uuid]) where type = 'revenue')::bigint,
  125000::bigint, 'a partial selection reports only the selected entities');
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30',
  array[current_setting('t.main')::uuid, current_setting('t.beta')::uuid]))::bigint,
  50000::bigint, 'both sides are eliminated when both entities are selected');

-- ------------------------------------------------------- validation + guards --
select throws_ok(format($$ select public.post_intercompany_entry('2026-09-21', 'x', %L, %L, 100, %L, %L, %L, %L) $$,
  current_setting('t.main'), current_setting('t.main'), pg_temp.acct('1100'), pg_temp.acct('4900'), pg_temp.acct('6900'), pg_temp.acct('2000')),
  '22023', null, 'an entity cannot bill itself');
select throws_ok(format($$ select public.post_intercompany_entry('2026-09-21', 'x', %L, %L, 0, %L, %L, %L, %L) $$,
  current_setting('t.main'), current_setting('t.beta'), pg_temp.acct('1100'), pg_temp.acct('4900'), pg_temp.acct('6900'), pg_temp.acct('2000')),
  '22023', null, 'the amount must be positive');
select throws_ok(format($$ select public.post_intercompany_entry('2026-09-21', 'x', %L, %L, 100, %L, %L, %L, %L) $$,
  current_setting('t.main'), current_setting('t.beta'), pg_temp.acct('4000'), pg_temp.acct('4900'), pg_temp.acct('6900'), pg_temp.acct('2000')),
  '22023', null, 'the receivable account must be an asset');
select throws_ok(format($$ select public.assign_journal_entries_to_entity(array[%L::uuid], %L::uuid) $$,
  (select id from public.journal_entries where intercompany_group_id = current_setting('t.grp')::uuid and entity_id = current_setting('t.main')::uuid), current_setting('t.gamma')),
  '22023', null, 'intercompany entries cannot be moved');
select throws_ok($$ select public.create_reporting_entity('Dup', 'BETA') $$, '23505', null, 'duplicate entity codes are rejected');
select throws_ok($$ select public.create_reporting_entity('Bad', 'no spaces!') $$, '22023', null, 'invalid entity codes are rejected');
select throws_ok(format($$ select public.update_reporting_entity(%L::uuid, null, false) $$, current_setting('t.main')),
  '22023', null, 'the default entity cannot be deactivated');
select throws_ok($$ insert into public.reporting_entities (user_id, code, name) values ('00000000-0000-0000-0000-0000000000a1', 'HACK', 'Hack') $$,
  '42501', null, 'entities cannot be written directly from the client');
select throws_ok($$ select public.set_reporting_entity_access('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', true) $$,
  'P0002', null, 'the owner cannot grant access to another account''s entity');

-- ------------------------------------------------------- access: BEFORE grants --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.reporting_entities), 0, 'a billing member with no grants sees no entities');
select is((select count(*)::int from public.list_reporting_entities()), 0, 'and the entity list is empty');
select is((select count(*)::int from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30')), 0, 'and the report is empty');

-- ------------------------------------------------------------- owner: grants --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(format($$ select public.set_reporting_entity_access(%L::uuid, '00000000-0000-0000-0000-0000000000a2', true) $$, current_setting('t.beta')),
  'owner grants BETA to the billing member');
select lives_ok(format($$ select public.set_reporting_entity_access(%L::uuid, '00000000-0000-0000-0000-0000000000a3', true) $$, current_setting('t.beta')),
  'owner grants BETA to the member without billing access');
select throws_ok(format($$ select public.set_reporting_entity_access(%L::uuid, '00000000-0000-0000-0000-0000000000b1', true) $$, current_setting('t.beta')),
  '22023', null, 'access can only be granted to people on the team');

-- --------------------------------------------------------- access: AFTER grants --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.reporting_entities), 1, 'the billing member sees only the granted entity');
select is((select code from public.reporting_entities), 'BETA', 'and it is BETA');
select is((select count(distinct entity_code)::int from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30')), 1, 'the report covers only BETA');
select is((select coalesce(sum(gross_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') where type = 'revenue')::bigint,
  40000::bigint, 'with BETA revenue only');
select is((select coalesce(sum(eliminated_cents), 0) from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30'))::bigint,
  0::bigint, 'intercompany with a hidden entity is never eliminated or leaked');
select throws_ok(format($$ select * from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30', array[%L::uuid]) $$, current_setting('t.main')),
  '42501', null, 'asking for an entity you cannot see is an error, not a silent omission');
select throws_ok(format($$ select * from public.list_journal_entries_for_entity(%L::uuid, 10) $$, current_setting('t.main')),
  '42501', null, 'entries of a hidden entity cannot be listed');
select throws_ok(format($$ select public.assign_journal_entries_to_entity(array[%L::uuid], %L::uuid) $$, current_setting('t.e1'), current_setting('t.beta')),
  '42501', null, 'entries cannot be pulled out of an entity you cannot see');
select throws_ok($$ select public.create_reporting_entity('Nope', 'NOPE') $$, '42501', null, 'members cannot create entities');
select throws_ok($$ select * from public.get_reporting_entity_access_overview() $$, '42501', null, 'members cannot read the access matrix');
select is((select count(*)::int from public.reporting_entity_access), 1, 'a member sees only their own grants');
select is((select count(*)::int from public.reporting_entity_audit_events), 0, 'members cannot read the audit trail');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.reporting_entities), 0, 'a grant without billing permission shows nothing');
select throws_ok($$ select * from public.list_reporting_entities() $$, '42501', null, 'members without billing cannot list entities');
select throws_ok($$ select * from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30') $$, '42501', null, 'or run the report');

-- ----------------------------------------------------------- other account --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.reporting_entities where id = current_setting('t.beta')::uuid), 0, 'another account cannot see this account''s entities');
select throws_ok(format($$ select * from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30', array[%L::uuid]) $$, current_setting('t.beta')),
  '42501', null, 'or report on them');
select throws_ok(format($$ select public.assign_journal_entries_to_entity(array[%L::uuid], '00000000-0000-0000-0000-0000000000b2') $$, current_setting('t.e1')),
  'P0002', null, 'or move their ledger entries');
select is((select count(*)::int from public.get_multi_entity_profit_and_loss('2026-09-01', '2026-09-30')), 0, 'the other account''s own report is empty');

-- ------------------------------------------------------ reversal inheritance --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.rev', public.void_journal_entry(current_setting('t.e2')::uuid, 'test void')::text, true);
select is((select entity_id from public.journal_entries where id = current_setting('t.rev')::uuid), current_setting('t.beta')::uuid,
  'a reversal stays in the entity of the entry it reverses');
select throws_ok(format($$ select public.assign_journal_entries_to_entity(array[%L::uuid], %L::uuid) $$, current_setting('t.rev'), current_setting('t.gamma')),
  '22023', null, 'a reversal cannot be moved on its own');
select ok((select count(*) from public.reporting_entity_audit_events) >= 6, 'owner changes are written to the audit trail');

-- ------------------------------------------------- integrity (as superuser) --
reset role;
select throws_ok($$ update public.journal_entries set is_intercompany = true where id = current_setting('t.e1')::uuid $$,
  '23514', null, 'an intercompany flag needs two different entities and a group');
select throws_ok($$ update public.journal_entries set entity_id = '00000000-0000-0000-0000-0000000000b2' where id = current_setting('t.e1')::uuid $$,
  '23503', null, 'an entry can never point at another account''s entity');

-- ------------------------------------------------------------------ grants --
select ok(not has_function_privilege('anon', 'public.get_multi_entity_profit_and_loss(date,date,uuid[],boolean)', 'execute'), 'anon cannot run the report');
select ok(has_function_privilege('authenticated', 'public.get_multi_entity_profit_and_loss(date,date,uuid[],boolean)', 'execute'), 'authenticated can run the report');
select ok(not has_function_privilege('authenticated', 'public._mer_ensure_default(uuid)', 'execute'), 'internal helpers are not callable from the client');
select ok(not has_function_privilege('authenticated', 'public._mer_require_owner()', 'execute'), 'internal guards are not callable from the client');

select * from finish();
rollback;
