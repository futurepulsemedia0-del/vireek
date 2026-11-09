-- Trade Pack framework: flag + entitlement gating, guarded install / upgrade / rollback,
-- customization preservation, idempotency, immutability, tenant isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@pack.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-pack.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'staff@pack.test');
update public.profiles set role = 'owner' where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1');
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000f1';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- 1. seeded OFF
select is((select enabled from public.feature_flags where key = 'trade_pack_framework'), false, 'flag: seeded off');

-- 2. with the flag off nothing can be applied
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_like(
  $$select public.pack_apply('t_pack', 'install', '1.0.0', '[]'::jsonb, '10000000-0000-0000-0000-000000000001')$$,
  '%feature_disabled%', 'gate: flag off blocks pack_apply');

-- turn the flag on for everyone (as superuser)
reset role;
update public.feature_flags set enabled = true, rollout_pct = 100 where key = 'trade_pack_framework';

-- 3. non-staff cannot publish
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_like(
  $$select public.staff_publish_pack_version('t_pack', '1.0.0', 'T', '{}'::jsonb)$$,
  '%not_permitted%', 'publish: non-staff denied');

-- staff publishes 1.0.0 and 1.1.0
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.staff_publish_pack_version('t_pack', '1.0.0', 'T pack', $j${
  "term:job": {"key":"job","singular":"Job","plural":"Jobs"},
  "status:open_s": {"key":"open_s","label":"Open","category":"open","order":10}
}$j$::jsonb);
select public.staff_publish_pack_version('t_pack', '1.1.0', 'T pack', $j${
  "term:job": {"key":"job","singular":"Visit","plural":"Visits"},
  "status:open_s": {"key":"open_s","label":"Open","category":"open","order":10}
}$j$::jsonb);

-- 4. versions are immutable
select throws_like(
  $$select public.staff_publish_pack_version('t_pack', '1.0.0', 'T pack', '{}'::jsonb)$$,
  '%version_immutable%', 'publish: same version with different content is refused');

-- 5. not entitled yet
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_like(
  $$select public.pack_apply('t_pack', 'install', '1.0.0', '[]'::jsonb, '10000000-0000-0000-0000-000000000002')$$,
  '%not_entitled%', 'entitlement: required for install');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.staff_set_pack_entitlement('00000000-0000-0000-0000-0000000000a1', 't_pack', true);

-- 6. install creates both artifacts
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(
  (public.pack_apply('t_pack', 'install', '1.0.0', $j$[
    {"op":"create","id":"term:job","liveBefore":null,"liveAfter":{"key":"job","singular":"Job","plural":"Jobs"},"baseBefore":null,"baseAfter":{"key":"job","singular":"Job","plural":"Jobs"}},
    {"op":"create","id":"status:open_s","liveBefore":null,"liveAfter":{"key":"open_s","label":"Open","category":"open","order":10},"baseBefore":null,"baseAfter":{"key":"open_s","label":"Open","category":"open","order":10}}
  ]$j$::jsonb, '10000000-0000-0000-0000-000000000003') ->> 'ops')::int,
  2, 'install: two artifacts created');

-- 7. replay with the same idempotency key is a no-op
select is(
  (public.pack_apply('t_pack', 'install', '1.0.0', '[]'::jsonb, '10000000-0000-0000-0000-000000000003') ->> 'replayed')::boolean,
  true, 'idempotency: replay returns the original event');

-- 8. forged base is refused
select throws_like(
  $$select public.pack_apply('t_pack', 'upgrade', '1.1.0', '[
    {"op":"update","id":"term:job","liveBefore":{"key":"job","singular":"Job","plural":"Jobs"},"liveAfter":{"key":"job","singular":"EVIL","plural":"EVIL"},"baseBefore":{"key":"job","singular":"Job","plural":"Jobs"},"baseAfter":{"key":"job","singular":"EVIL","plural":"EVIL"}}
  ]'::jsonb, '10000000-0000-0000-0000-000000000004')$$,
  '%base_not_in_target_version%', 'guard: base must be the target version content');

-- 9. a plan that does not cover the target version is refused
select throws_like(
  $$select public.pack_apply('t_pack', 'upgrade', '1.1.0', '[]'::jsonb, '10000000-0000-0000-0000-000000000005')$$,
  '%invariant_violation%', 'invariant: untouched artifact would stay at the old version');

-- 10. a customization made after the plan was drawn up makes the plan stale
select public.pack_customize('t_pack', 'term:job', '{"key":"job","singular":"Ticket","plural":"Tickets"}'::jsonb, '10000000-0000-0000-0000-000000000006');
select throws_like(
  $$select public.pack_apply('t_pack', 'upgrade', '1.1.0', '[
    {"op":"update","id":"term:job","liveBefore":{"key":"job","singular":"Job","plural":"Jobs"},"liveAfter":{"key":"job","singular":"Visit","plural":"Visits"},"baseBefore":{"key":"job","singular":"Job","plural":"Jobs"},"baseAfter":{"key":"job","singular":"Visit","plural":"Visits"}}
  ]'::jsonb, '10000000-0000-0000-0000-000000000007')$$,
  '%stale_plan%', 'guard: stale plan cannot overwrite a customization');

-- 11. upgrade that keeps the customization (rebase) succeeds and keeps the account's content
select public.pack_apply('t_pack', 'upgrade', '1.1.0', $j$[
  {"op":"rebase","id":"term:job","liveBefore":{"key":"job","singular":"Ticket","plural":"Tickets"},"liveAfter":{"key":"job","singular":"Ticket","plural":"Tickets"},"baseBefore":{"key":"job","singular":"Job","plural":"Jobs"},"baseAfter":{"key":"job","singular":"Visit","plural":"Visits"}},
  {"op":"rebase","id":"status:open_s","liveBefore":{"key":"open_s","label":"Open","category":"open","order":10},"liveAfter":{"key":"open_s","label":"Open","category":"open","order":10},"baseBefore":{"key":"open_s","label":"Open","category":"open","order":10},"baseAfter":{"key":"open_s","label":"Open","category":"open","order":10}}
]$j$::jsonb, '10000000-0000-0000-0000-000000000008');
select is((select content ->> 'singular' from public.pack_artifacts where artifact_id = 'term:job'), 'Ticket', 'upgrade: customization preserved');

-- 12. rollback of the upgrade restores the earlier base, keeps the customization
select public.pack_apply('t_pack', 'rollback', null, $j$[
  {"op":"rebase","id":"status:open_s","liveBefore":{"key":"open_s","label":"Open","category":"open","order":10},"liveAfter":{"key":"open_s","label":"Open","category":"open","order":10},"baseBefore":{"key":"open_s","label":"Open","category":"open","order":10},"baseAfter":{"key":"open_s","label":"Open","category":"open","order":10}},
  {"op":"rebase","id":"term:job","liveBefore":{"key":"job","singular":"Ticket","plural":"Tickets"},"liveAfter":{"key":"job","singular":"Ticket","plural":"Tickets"},"baseBefore":{"key":"job","singular":"Visit","plural":"Visits"},"baseAfter":{"key":"job","singular":"Job","plural":"Jobs"}}
]$j$::jsonb, '10000000-0000-0000-0000-000000000009',
  (select id from public.pack_events where kind = 'upgrade' and pack_id = 't_pack'));
select is((select version from public.pack_installs where pack_id = 't_pack'), '1.0.0', 'rollback: installed version is back to 1.0.0');

-- 13. the same event cannot be rolled back twice
select throws_like(
  $$select public.pack_apply('t_pack', 'rollback', null, '[]'::jsonb, '10000000-0000-0000-0000-00000000000a',
      (select id from public.pack_events where kind = 'upgrade' and pack_id = 't_pack'))$$,
  '%already_reverted%', 'rollback: an event can only be reverted once');

-- 14. tenant isolation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.pack_artifacts), 0, 'rls: other tenant sees no artifacts');
select throws_like(
  $$select public.pack_apply('t_pack', 'rollback', null, '[]'::jsonb, '10000000-0000-0000-0000-00000000000b',
      (select id from public.pack_events where kind = 'install' and pack_id = 't_pack' limit 1))$$,
  '%unknown_event%', 'rls: other tenant cannot roll back someone else''s event');

-- 15. no direct writes, append-only audit trail
select throws_like(
  $$insert into public.pack_artifacts (user_id, pack_id, artifact_id, content) values ('00000000-0000-0000-0000-0000000000b1', 't_pack', 'term:x_y', '{"key":"x_y"}')$$,
  '%permission denied%', 'writes: direct insert is not allowed');
reset role;
select throws_like($$update public.pack_events set summary = '{}'::jsonb$$, '%append-only%', 'events: append-only');

select * from finish();
rollback;
