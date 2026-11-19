-- pgTAP: wrapping auth.*() as (select auth.*()) in RLS policies must NOT change behaviour.
-- Two identical tables: t_before (bare auth.uid() etc.) and t_after (wrapped). For sample principals the visible
-- rows and the outcome (SQLSTATE) of INSERT / UPDATE / DELETE must be identical. Rolled back at the end.
begin;
select plan(25);

create schema rlsw_eq;
grant usage on schema rlsw_eq to anon, authenticated;
create table rlsw_eq.members (account_owner_id uuid not null, user_id uuid not null);
create table rlsw_eq.t_before (id int primary key, account_owner_id uuid not null, body text);
create table rlsw_eq.t_after  (id int primary key, account_owner_id uuid not null, body text);
grant select, insert, update, delete on rlsw_eq.members, rlsw_eq.t_before, rlsw_eq.t_after to authenticated;
grant select on rlsw_eq.t_before, rlsw_eq.t_after to anon;
alter table rlsw_eq.members  enable row level security;
alter table rlsw_eq.t_before enable row level security;
alter table rlsw_eq.t_after  enable row level security;
create policy m_sel on rlsw_eq.members for select to authenticated using (true);

-- UNWRAPPED (legacy shape)
create policy sel on rlsw_eq.t_before for select to authenticated using (
  account_owner_id = auth.uid()
  or exists (select 1 from rlsw_eq.members m where m.account_owner_id = t_before.account_owner_id and m.user_id = auth.uid()));
create policy ins on rlsw_eq.t_before for insert to authenticated with check (account_owner_id = auth.uid() and auth.role() = 'authenticated');
create policy upd on rlsw_eq.t_before for update to authenticated using (account_owner_id = auth.uid()) with check (account_owner_id = auth.uid());
create policy del on rlsw_eq.t_before for delete to authenticated using ((auth.jwt() ->> 'app_role') = 'admin' and account_owner_id = auth.uid());
-- WRAPPED (what rls-wrap-generator.mjs emits)
create policy sel on rlsw_eq.t_after for select to authenticated using (
  account_owner_id = (select auth.uid())
  or exists (select 1 from rlsw_eq.members m where m.account_owner_id = t_after.account_owner_id and m.user_id = (select auth.uid())));
create policy ins on rlsw_eq.t_after for insert to authenticated with check (account_owner_id = (select auth.uid()) and (select auth.role()) = 'authenticated');
create policy upd on rlsw_eq.t_after for update to authenticated using (account_owner_id = (select auth.uid())) with check (account_owner_id = (select auth.uid()));
create policy del on rlsw_eq.t_after for delete to authenticated using (((select auth.jwt()) ->> 'app_role') = 'admin' and account_owner_id = (select auth.uid()));

insert into rlsw_eq.members values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');   -- u2 is a member of u1's account
insert into rlsw_eq.t_before select g, case when g % 2 = 0 then 'aaaaaaaa-0000-4000-8000-000000000001'::uuid else 'cccccccc-0000-4000-8000-000000000003'::uuid end, 'r'||g from generate_series(1, 10) g;
insert into rlsw_eq.t_after  select * from rlsw_eq.t_before;

create function rlsw_eq.ids(t text) returns text language plpgsql as $$
declare r text; begin
  begin execute format('select coalesce(string_agg(id::text, '','' order by id), '''') from rlsw_eq.%I', t) into r;
  exception when others then r := 'ERR:' || sqlstate; end; return r; end $$;
-- Runs one DML statement and ALWAYS rolls it back (the handler catches the deliberate exception), so every
-- principal is compared against the same fixture. Returns the affected row count or the SQLSTATE.
create function rlsw_eq.dml(t text, op text) returns text language plpgsql as $$
declare n bigint; begin
  if op = 'insert' then execute format('insert into rlsw_eq.%I values (100, ''aaaaaaaa-0000-4000-8000-000000000001'', ''x'')', t); n := 1;
  elsif op = 'update' then execute format('with u as (update rlsw_eq.%I set body = body returning 1) select count(*) from u', t) into n;
  else execute format('with d as (delete from rlsw_eq.%I returning 1) select count(*) from d', t) into n; end if;
  raise exception 'rollback:%', n;
exception when others then
  if sqlerrm like 'rollback:%' then return 'ok:' || substr(sqlerrm, 10); end if;
  return 'ERR:' || sqlstate;
end $$;
grant usage on schema rlsw_eq to authenticated, anon;
grant execute on all functions in schema rlsw_eq to authenticated, anon;

-- sanity: the fixtures differ exactly in wrapping, and the comparison is not vacuous
select ok((select qual from pg_policies where schemaname='rlsw_eq' and tablename='t_before' and policyname='upd') !~* 'select auth\.uid',
          'before-table policy is unwrapped');
select ok((select qual from pg_policies where schemaname='rlsw_eq' and tablename='t_after'  and policyname='upd') ~* 'select auth\.uid',
          'after-table policy is wrapped');

-- principal 1: owner u1 (admin claim)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","app_role":"admin"}', true);
select isnt(rlsw_eq.ids('t_before'), '', 'u1 sees rows (non-vacuous)');
select isnt(rlsw_eq.dml('t_before', 'update'), 'ok:0', 'u1 can update rows (non-vacuous)');
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'u1: same visible rows');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'u1: same INSERT outcome');
select is(rlsw_eq.dml('t_after', 'update'), rlsw_eq.dml('t_before', 'update'), 'u1: same UPDATE outcome');
select is(rlsw_eq.dml('t_after', 'delete'), rlsw_eq.dml('t_before', 'delete'), 'u1: same DELETE outcome');

-- principal 2: u2, member of u1's account (exists-subquery path), no admin claim
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'u2 (member): same visible rows');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'u2: same INSERT outcome');
select is(rlsw_eq.dml('t_after', 'update'), rlsw_eq.dml('t_before', 'update'), 'u2: same UPDATE outcome');
select is(rlsw_eq.dml('t_after', 'delete'), rlsw_eq.dml('t_before', 'delete'), 'u2: same DELETE outcome');

-- principal 3: unrelated user u3 (owns the other half of the rows)
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'u3: same visible rows');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'u3: same INSERT outcome');
select is(rlsw_eq.dml('t_after', 'update'), rlsw_eq.dml('t_before', 'update'), 'u3: same UPDATE outcome');
select is(rlsw_eq.dml('t_after', 'delete'), rlsw_eq.dml('t_before', 'delete'), 'u3: same DELETE outcome');

-- principal 4: unknown uid
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'unknown uid: same visible rows');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'unknown uid: same INSERT outcome');
select is(rlsw_eq.dml('t_after', 'delete'), rlsw_eq.dml('t_before', 'delete'), 'unknown uid: same DELETE outcome');

-- principal 5: authenticated role without a sub claim (auth.uid() is NULL)
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'no sub: same visible rows');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'no sub: same INSERT outcome');

-- principal 6: anon (no policy for anon => nothing visible, identical on both)
set local role anon;
select set_config('request.jwt.claims', '', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'anon: same result');
select is(rlsw_eq.dml('t_after', 'insert'), rlsw_eq.dml('t_before', 'insert'), 'anon: same INSERT outcome');

-- principal 7: the claim changes inside the same transaction (initPlan must not leak a stale uid across statements)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), rlsw_eq.ids('t_before'), 'u1 again: same rows');
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is(rlsw_eq.ids('t_after'), '', 'claim switch u1 -> unknown within one transaction: wrapped policy re-evaluates per statement');

reset role;
select * from finish();
rollback;
