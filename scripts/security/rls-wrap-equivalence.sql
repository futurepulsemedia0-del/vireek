-- scripts/security/rls-wrap-equivalence.sql
-- BEFORE/AFTER behavioural proof for the RLS initPlan wrap, on the real tables, for sample principals.
-- For every table x principal it stores (visible row count, fingerprint of every visible row) as seen THROUGH RLS
-- (or the SQLSTATE if the role may not read the table). The "after" run must equal the "before" run exactly.
--
--   psql "$DB" -X -v ON_ERROR_STOP=1 -v phase=before  -v tables='jobs,customers' -f scripts/security/rls-wrap-equivalence.sql
--   ... apply the migration ...
--   psql "$DB" -X -v ON_ERROR_STOP=1 -v phase=after   -v tables='jobs,customers' -f scripts/security/rls-wrap-equivalence.sql
--   psql "$DB" -X -v ON_ERROR_STOP=1 -v phase=cleanup -f scripts/security/rls-wrap-equivalence.sql
--
-- Principals: anon · authenticated without sub · authenticated with an unknown uid · authenticated as the MIN and MAX
-- tenant id found in the table (account_owner_id | user_id | owner_id; stored by "before", replayed by "after").
-- Run on staging or a restored copy: it scans the listed tables. It only READS, plus one scratch table
-- public._rlsw_snapshot (RLS on, no policy) that `cleanup` drops. RLS-bypassing roles are out of scope by design.
select set_config('rlsw.phase', :'phase', false) \gset
select set_config('rlsw.tables', coalesce(:'tables', ''), false) \gset

do $rlsw_eq$
declare
  v_phase  text := current_setting('rlsw.phase');
  v_tables text[] := string_to_array(nullif(current_setting('rlsw.tables'), ''), ',');
  t text; col text; pr record; mn text; mx text; v_n bigint; v_fp text; v_bad int; v_seen int := 0; v_nonempty int := 0;
begin
  if v_phase = 'cleanup' then
    drop table if exists public._rlsw_snapshot;
    raise notice 'rls-wrap-equivalence: scratch table dropped';
    return;
  end if;
  if v_phase not in ('before', 'after') then raise exception 'phase must be before | after | cleanup'; end if;
  if v_tables is null then raise exception 'pass -v tables=a,b,c'; end if;

  create table if not exists public._rlsw_snapshot (
    phase text not null, tbl text not null, principal text not null, n bigint, fp text, primary key (phase, tbl, principal));
  alter table public._rlsw_snapshot enable row level security;
  delete from public._rlsw_snapshot where phase = v_phase and tbl = any (v_tables);

  foreach t in array v_tables loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relkind in ('r','p')) then
      raise exception 'table public.% not found', t;
    end if;
    select c into col from unnest(array['account_owner_id','user_id','owner_id']) c
     where exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name=c) limit 1;

    create temp table _rlsw_p (principal text, role_name text, claims text) on commit drop;
    insert into _rlsw_p values
      ('anon', 'anon', ''),
      ('auth_no_sub', 'authenticated', '{"role":"authenticated"}'),
      ('auth_unknown_uid', 'authenticated', '{"sub":"ffffffff-ffff-4fff-8fff-ffffffffffff","role":"authenticated"}');
    if v_phase = 'before' and col is not null then
      execute format('select min(%I::text), max(%I::text) from public.%I', col, col, t) into mn, mx;
      insert into _rlsw_p select 'auth_owner:' || s, 'authenticated', format('{"sub":"%s","role":"authenticated"}', s)
        from (select distinct s from unnest(array[mn, mx]) s where s is not null) q;
    elsif v_phase = 'after' then
      insert into _rlsw_p select principal, 'authenticated', format('{"sub":"%s","role":"authenticated"}', substring(principal from 12))
        from public._rlsw_snapshot where phase = 'before' and tbl = t and principal like 'auth_owner:%';
    end if;

    for pr in select * from _rlsw_p order by principal loop
      perform set_config('request.jwt.claims', pr.claims, true);
      perform set_config('role', pr.role_name, true);
      begin
        execute format($f$select count(*), coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') from public.%I x$f$, t)
          into v_n, v_fp;
      exception when others then
        v_n := -1; v_fp := 'ERR:' || sqlstate;
      end;
      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);
      insert into public._rlsw_snapshot values (v_phase, t, pr.principal, v_n, v_fp);
      v_seen := v_seen + 1;
      if v_n > 0 then v_nonempty := v_nonempty + 1; end if;
    end loop;
    drop table _rlsw_p;
  end loop;

  if v_phase = 'after' then
    select count(*) into v_bad from public._rlsw_snapshot a
      full join public._rlsw_snapshot b on b.phase = 'before' and b.tbl = a.tbl and b.principal = a.principal
     where a.phase = 'after' and a.tbl = any (v_tables) and (b.principal is null or (a.n, a.fp) is distinct from (b.n, b.fp));
    if v_bad > 0 then
      raise exception 'rls-wrap-equivalence FAILED: % table/principal pairs differ between before and after', v_bad;
    end if;
  end if;
  raise notice 'rls-wrap-equivalence % OK: % table/principal pairs recorded (% with visible rows)', v_phase, v_seen, v_nonempty;
end
$rlsw_eq$;
