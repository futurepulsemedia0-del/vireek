-- ml_feature_snapshots (feature-store pilot): tenant isolation, read-only clients, append-only, as_of guard,
-- idempotent writers, leakage-safe point-in-time lookup, purge guard (pgTAP). Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@mfs-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@mfs-b.test');

-- service-role style writes (the edge function uses the service key)
insert into public.ml_feature_snapshots
  (id, user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash, source_table, source_id)
values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment',
   '00000000-0000-0000-0000-0000000000e1', now() - interval '400 days', '{"v":1}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pfn_forecasts', '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment',
   '00000000-0000-0000-0000-0000000000e1', now() - interval '300 days', '{"v":2}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', null, null),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000b1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '400 days', '{"v":9}', 'cccccccccccccccccccccccccccccccc', null, null);

-- ── structure ────────────────────────────────────────────────────────────────────────────────
select has_table('public', 'ml_feature_snapshots', 'table exists');
select is((select relrowsecurity from pg_class where oid = 'public.ml_feature_snapshots'::regclass), true, 'RLS is enabled');
select has_index('public', 'ml_feature_snapshots', 'uq_ml_feature_snapshots_point', 'unique point index exists (idempotent writers rely on it)');
select ok(not has_table_privilege('anon', 'public.ml_feature_snapshots', 'select'), 'anon has no access');
select ok(not has_table_privilege('authenticated', 'public.ml_feature_snapshots', 'insert')
      and not has_table_privilege('authenticated', 'public.ml_feature_snapshots', 'update')
      and not has_table_privilege('authenticated', 'public.ml_feature_snapshots', 'delete'), 'authenticated has no write privileges');
select ok(not has_table_privilege('service_role', 'public.ml_feature_snapshots', 'update'), 'even service_role has no UPDATE privilege');

-- ── constraints (as table owner) ─────────────────────────────────────────────────────────────
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e1', now() - interval '400 days', '{"dup":true}', 'dddddddddddddddddddddddddddddddd') $$,
  '23505', null, 'one snapshot per (tenant, engine, feature set, entity, as_of): retries cannot duplicate');
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now() + interval '1 day', '{}', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') $$,
  '23514', null, 'as_of in the future is rejected (cannot pre-date features from the future)');
select lives_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now() + interval '2 minutes', '{}', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') $$,
  'a couple of minutes of clock skew is tolerated');
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now(), '[]', 'ffffffffffffffffffffffffffffffff') $$,
  '23514', null, 'features must be a JSON object');
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now(), '{}', 'not-a-hash') $$,
  '23514', null, 'features_hash must be 32 lowercase hex chars');
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash, source_table)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now(), '{}', 'ffffffffffffffffffffffffffffffff', 'pfn_forecasts') $$,
  '23514', null, 'source_table and source_id must be set together');
select throws_ok($$ update public.ml_feature_snapshots set features = '{"tampered":true}' where id = '00000000-0000-0000-0000-00000000f001' $$,
  '23001', null, 'append-only: UPDATE is rejected by the guard trigger');

-- ── point-in-time lookup (service role) ──────────────────────────────────────────────────────
select is((select (features->>'v') from public.ml_feature_snapshot_as_of('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e1', now() - interval '350 days')),
  '1', 'between two snapshots the OLDER one is returned (no look-ahead)');
select is((select (features->>'v') from public.ml_feature_snapshot_as_of('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e1', now() - interval '300 days')),
  '2', 'exact as_of returns that snapshot');
select is((select count(*)::int from public.ml_feature_snapshot_as_of('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e1', now() - interval '401 days')),
  0, 'before the first snapshot nothing is returned (never the future)');
select is((select count(*)::int from public.ml_feature_snapshot_as_of('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e2', now())),
  0, 'another tenant''s entity is not returned for this tenant');

-- ── tenant isolation + read-only for clients ─────────────────────────────────────────────────
create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((select count(*)::int from public.ml_feature_snapshots where user_id = '00000000-0000-0000-0000-0000000000a1') >= 2, 'an account reads its own snapshots');
select is((select count(*)::int from public.ml_feature_snapshots where user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'another account''s snapshots are invisible');
select throws_ok($$ insert into public.ml_feature_snapshots (user_id, engine, engine_version, feature_set_version, entity_type, entity_id, as_of, features, features_hash)
  values ('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-1.0.0', 'pfn-features-1', 'equipment', gen_random_uuid(), now(), '{}', 'ffffffffffffffffffffffffffffffff') $$,
  '42501', null, 'clients cannot insert snapshots (no forged features)');
select throws_ok($$ delete from public.ml_feature_snapshots where id = '00000000-0000-0000-0000-00000000f001' $$,
  '42501', null, 'clients cannot delete snapshots');
select throws_ok($$ select * from public.ml_feature_snapshot_as_of('00000000-0000-0000-0000-0000000000a1', 'pfn', 'pfn-features-1', 'equipment', '00000000-0000-0000-0000-0000000000e1', now()) $$,
  '42501', null, 'the point-in-time function is service_role only');

-- ── purge guard (service role) ───────────────────────────────────────────────────────────────
reset role;
select throws_ok($$ select public.ml_feature_snapshots_purge(now()) $$, '22023', null, 'purge refuses a cutoff newer than 1 day (accident guard)');
select is(public.ml_feature_snapshots_purge(now() - interval '350 days', '00000000-0000-0000-0000-0000000000a1'), 1,
  'purge deletes only the requested tenant''s rows older than the cutoff');

select * from finish();
rollback;
