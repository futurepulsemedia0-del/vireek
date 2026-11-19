-- number_health: owner-only reads, no client writes, remediation ticks scoped to the caller's own numbers (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@nh.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@nh.test');
insert into public.phone_numbers (id, account_id, phone_number) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '+15125550101'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', '+15125550102');
insert into public.number_health (user_id, phone_number_id, spam_label, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'flagged', 'ok'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f2', 'clean', 'ok');

select ok((select relrowsecurity from pg_class where oid = 'public.number_health'::regclass), 'number_health has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.number_health_events'::regclass), 'events have RLS');
select throws_ok($$insert into public.number_health (user_id, phone_number_id, spam_label) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'bogus')$$, '23514', null, 'invalid spam_label is rejected');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select is((select count(*)::int from public.number_health), 1, 'owner sees only their own row');
select is((select spam_label from public.number_health limit 1), 'flagged', 'owner reads their label');
select throws_ok($$update public.number_health set spam_label = 'clean'$$, '42501', null, 'clients cannot overwrite a provider result');
select throws_ok($$delete from public.number_health$$, '42501', null, 'clients cannot delete rows');
select is((public.number_health_set_step('00000000-0000-0000-0000-0000000000f1', 'pause_outbound', true)) -> 'remediation_done' ->> 'pause_outbound', 'true', 'owner can tick a step');
select is((public.number_health_set_step('00000000-0000-0000-0000-0000000000f1', 'pause_outbound', false)) -> 'remediation_done' ->> 'pause_outbound', null, 'and untick it');
select throws_ok($$select public.number_health_set_step('00000000-0000-0000-0000-0000000000f2', 'pause_outbound', true)$$, '42501', null, 'cannot tick steps on another account''s number');
select throws_ok($$select public.number_health_set_step('00000000-0000-0000-0000-0000000000f1', 'Bad Step!', true)$$, '22023', null, 'malformed step ids are refused');

select * from finish();
rollback;
