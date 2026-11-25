-- Callback Promise (pgTAP). Run with:  supabase test db
-- Covers: tenant isolation, forged-evidence guard on policy promises, honest manual resolution,
-- stats arithmetic, the public stat gate, and privileges. Impersonation mirrors PostgREST.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@cbp-a.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner@cbp-b.test');

-- Fixtures (inserted as the table owner, like the sweep does). promises.call_id is nullable and un-FK'd here on purpose.
insert into public.promises (id, user_id, promise_text, category, due_at, status, origin, policy_window_minutes, evidence_source, resolved_at) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000c1', 'Call back A within 30 min', 'callback', now() - interval '3 hours', 'fulfilled', 'callback_policy', 30, 'system', now() - interval '3 hours 10 minutes'),
  ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000000c1', 'Call back B within 30 min', 'callback', now() - interval '2 hours', 'fulfilled', 'callback_policy', 30, 'system', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000001a3', '00000000-0000-0000-0000-0000000000c1', 'Call back C within 30 min', 'callback', now() - interval '1 hour', 'pending',   'callback_policy', 30, null, null),
  ('00000000-0000-0000-0000-0000000001a4', '00000000-0000-0000-0000-0000000000c1', 'Call back D within 30 min', 'callback', now() + interval '2 hours', 'pending',   'callback_policy', 30, null, null),
  ('00000000-0000-0000-0000-0000000001a5', '00000000-0000-0000-0000-0000000000c1', 'Call back E within 30 min', 'callback', now() - interval '5 hours', 'cancelled', 'callback_policy', 30, 'system', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000000d1', 'Call back Z within 30 min', 'callback', now() - interval '1 hour', 'pending',   'callback_policy', 30, null, null);

-- stats: A = kept on time (system), B = late, C = open overdue, D = not yet due (excluded), E = cancelled (excluded)
select is(
  (public.callback_promise_stats_for('00000000-0000-0000-0000-0000000000c1', now() - interval '30 days', now() + interval '1 day') ->> 'decided')::int,
  3, 'decided counts kept, late and overdue-open only (not future-due, not cancelled)');
select is(
  (public.callback_promise_stats_for('00000000-0000-0000-0000-0000000000c1', now() - interval '30 days', now() + interval '1 day') ->> 'kept_system')::int,
  1, 'one case has a system-recorded callback inside the window');
select is(
  (public.callback_promise_stats_for('00000000-0000-0000-0000-0000000000c1', now() - interval '30 days', now() + interval '1 day') ->> 'late')::int,
  1, 'one case was made after the deadline');
select is(
  (public.callback_promise_stats_for('00000000-0000-0000-0000-0000000000c1', now() - interval '30 days', now() + interval '1 day') ->> 'open_overdue')::int,
  1, 'one case is still waiting past its deadline');

-- public stat: unknown or malformed slug reveals nothing
select is(public.callback_promise_public_stat('no-such-slug'), null, 'unknown slug returns NULL');
select is(public.callback_promise_public_stat('Bad Slug!'), null, 'malformed slug returns NULL');

-- client behaviour as account C1
create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');

select is((select count(*)::int from public.promises where origin = 'callback_policy'), 5, 'an account sees only its own policy promises');
select is((select count(*)::int from public.promises where user_id = '00000000-0000-0000-0000-0000000000d1'), 0, 'another account''s promises are invisible');

select throws_ok($$ update public.promises set due_at = now() + interval '1 day' where id = '00000000-0000-0000-0000-0000000001a3' $$,
  '42501', null, 'a client cannot move a policy deadline');
select throws_ok($$ update public.promises set evidence_source = 'system' where id = '00000000-0000-0000-0000-0000000001a3' $$,
  '42501', null, 'a client cannot forge system evidence');
select throws_ok($$ update public.promises set origin = 'extracted' where id = '00000000-0000-0000-0000-0000000001a3' $$,
  '42501', null, 'a client cannot disguise a policy promise as an extracted one');

-- an honest manual resolution is allowed, but is marked manual and cannot be back-dated
update public.promises set status = 'fulfilled', resolved_at = now() - interval '10 days' where id = '00000000-0000-0000-0000-0000000001a3';
select is((select evidence_source from public.promises where id = '00000000-0000-0000-0000-0000000001a3'), 'manual', 'a hand-resolved promise is marked manual');
select ok((select resolved_at from public.promises where id = '00000000-0000-0000-0000-0000000001a3') > now() - interval '1 minute', 'a hand resolution time cannot be back-dated');

reset role;
select ok(not has_function_privilege('authenticated', 'public.callback_promise_sweep(interval,integer)', 'execute'), 'authenticated cannot run the sweep');
select ok(not has_function_privilege('authenticated', 'public.callback_promise_public_stat(text)', 'execute')
      and not has_function_privilege('anon', 'public.callback_promise_public_stat(text)', 'execute'), 'only the service role can read the public stat');

select * from finish();
rollback;
