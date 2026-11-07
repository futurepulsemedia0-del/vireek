-- Economics ledger: append-only, RLS (staff-only), correction idempotency, tenant isolation of ROI inputs (pgTAP).
-- Run with:  supabase test db        (NOT RUN by the author: no Postgres available in the authoring environment)
-- Requires migrations 20281110000000 and 20281111000000. Impersonation mirrors PostgREST.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'tenant-a@test'),
  ('00000000-0000-0000-0000-0000000000b1', 'tenant-b@test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@test');
-- Staff = profiles.is_staff (see is_vireek_staff in 20260913020000). If profiles has other NOT NULL columns, add them here.
insert into public.profiles (id, is_staff) values ('00000000-0000-0000-0000-0000000000c1', true)
  on conflict (id) do update set is_staff = true;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  set local role authenticated;
end $$;

-- 1-4: structure + append-only (as table owner / service path)
select has_table('public', 'cost_ledger', 'ledger exists');
insert into public.cost_ledger (account_id, provider, resource_type, cost_micro, basis, source, ref, call_id)
  values ('00000000-0000-0000-0000-0000000000a1', 'vapi', 'stt', 1500, 'provider_reported', 't', 'r1', 'call-1');
select throws_ok($$update public.cost_ledger set cost_micro = 1 where ref = 'r1'$$, '42501', null, 'UPDATE is blocked');
select throws_ok($$delete from public.cost_ledger where ref = 'r1'$$, '42501', null, 'DELETE is blocked');
select throws_ok($$truncate public.cost_ledger$$, '42501', null, 'TRUNCATE is blocked');

-- 5-7: constraints
select throws_ok($$insert into public.cost_ledger (provider, resource_type, cost_micro, basis, source) values ('x','stt',-5,'estimated','t')$$, '23514', null, 'negative usage cost rejected');
select throws_ok($$insert into public.cost_ledger (provider, resource_type, cost_micro, basis, kind, source) values ('x','stt',-5,'invoiced','correction','t')$$, '23514', null, 'correction needs a reason');
select throws_ok($$insert into public.cost_ledger (provider, resource_type, cost_micro, basis, source, ref) values ('x','stt',1,'estimated','t','r1')$$, '23505', null, '(source,ref) is idempotent');

-- 8-10: tenant cannot read or write the ledger
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.cost_ledger), 0, 'tenant sees no ledger rows (staff-only RLS)');
select throws_ok($$insert into public.cost_ledger (provider, resource_type, cost_micro, basis, source) values ('x','stt',1,'estimated','t')$$, '42501', null, 'tenant cannot insert');
select throws_ok($$select public.staff_unit_costs(now() - interval '1 day', now())$$, '42501', null, 'tenant cannot call staff RPCs');
reset role;

-- 11-12: tenant ROI inputs are scoped to the caller (no cross-tenant parameter exists)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.tenant_roi_inputs(now() - interval '30 days', now()) ->> 'outcomes_total')::int, 0, 'tenant A sees only its own outcomes');
select throws_ok($$select public.tenant_roi_inputs(now(), now() - interval '1 day')$$, '22023', null, 'invalid window rejected');
reset role;

-- 13-14: service-only core + learning contract are not callable by clients
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select public.economics_action_cost_outcome(now() - interval '1 day', now())$$, '42501', null, 'learning contract is service-role only');
select throws_ok($$select public.economics_reconciliation_core(date_trunc('month', now())::date)$$, '42501', null, 'core reconciliation is service-role only');
reset role;

-- 15-17: staff can read, run unit costs, and post an idempotent offsetting correction
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.cost_ledger where ref = 'r1'), 1, 'staff can read the ledger');
select public.post_cost_correction('vapi', date_trunc('month', now())::date, 500, 'invoice higher than ledger', 'recon:test');
select public.post_cost_correction('vapi', date_trunc('month', now())::date, 500, 'invoice higher than ledger', 'recon:test');
select is((select count(*)::int from public.cost_ledger where source = 'reconciliation' and ref = 'recon:test'), 1, 'correction is idempotent on ref');
select isnt(public.staff_unit_costs(now() - interval '1 day', now()), null, 'staff unit-cost RPC returns a report');
reset role;

select * from finish();
rollback;
