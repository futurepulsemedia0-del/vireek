-- Partner portal scope (20290307000100): partner users see ONLY the accounts they referred.
-- NOT executed by the author with pgTAP (no Supabase CLI in the authoring sandbox). The same scenarios, plus member management,
-- self-dealing and revocation, ran green on PGlite: scripts/db-tests/partner-scope.pglite.mjs (107 checks).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f5001', 'owner@ps.test'), ('00000000-0000-0000-0000-0000000f5002', 'member@ps.test'),
  ('00000000-0000-0000-0000-0000000f5003', 'otherowner@ps.test'), ('00000000-0000-0000-0000-0000000f5011', 'acc1@ps.test'),
  ('00000000-0000-0000-0000-0000000f5013', 'acc3@ps.test');
insert into public.profiles (id, company_name) values
  ('00000000-0000-0000-0000-0000000f5011', 'PS Acme'), ('00000000-0000-0000-0000-0000000f5013', 'PS Other')
on conflict (id) do update set company_name = excluded.company_name;
insert into public.partners (id, user_id, company_name, contact_name, contact_email, referral_code, status) values
  ('00000000-0000-0000-0000-000000000f51', '00000000-0000-0000-0000-0000000f5001', 'PS A', 'A', 'a@ps.test', 'PSAAAAAA', 'approved'),
  ('00000000-0000-0000-0000-000000000f52', '00000000-0000-0000-0000-0000000f5003', 'PS B', 'B', 'b@ps.test', 'PSBBBBBB', 'approved');
insert into public.partner_members (partner_id, user_id) values ('00000000-0000-0000-0000-000000000f51', '00000000-0000-0000-0000-0000000f5002');
insert into public.partner_referrals (partner_id, referred_user_id, status, mrr_cents, commission_cents) values
  ('00000000-0000-0000-0000-000000000f51', '00000000-0000-0000-0000-0000000f5011', 'converted', 19900, 3980),
  ('00000000-0000-0000-0000-000000000f52', '00000000-0000-0000-0000-0000000f5013', 'converted', 7900, 1580);
insert into public.customers (user_id, name) values ('00000000-0000-0000-0000-0000000f5011', 'secret customer');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000f5001"}';
select is((select count(*)::int from public.partner_list_referred_accounts()), 1, 'owner lists only its own referral');
select is((select commission_cents from public.partner_list_referred_accounts()), 3980, 'owner sees commission figures');
select throws_ok($$select * from public.partner_get_referred_account('00000000-0000-0000-0000-0000000f5013')$$, 'Account not found.', 'another partner''s account is not retrievable');
select is((select count(*)::int from public.customers), 0, 'owner sees no tenant data of a referred account');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000f5011'), 0, 'owner cannot read the referred profile directly');
select is((select count(*)::int from public.partner_access_log), 0, 'listing writes no access-log row (only single-account views do)');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000f5002"}';
select is((select commission_cents from public.partner_list_referred_accounts()), null, 'member sees NULL money columns');
select is((select count(*)::int from public.partner_referrals), 0, 'member cannot read partner_referrals directly');
select throws_ok($$select * from public.partner_add_member('x@y.test')$$, 'Only an approved partner owner can manage members.', 'member cannot add members');
select throws_ok($$insert into public.partner_members (partner_id, user_id) values ('00000000-0000-0000-0000-000000000f51', '00000000-0000-0000-0000-0000000f5011')$$, null, 'no direct insert into partner_members');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000f5011"}';
select throws_ok($$select * from public.partner_list_referred_accounts()$$, 'No partner access.', 'a referred customer has no partner scope');

reset role;
select throws_ok($$update public.partner_access_log set action = 'view_account'$$, 'partner_access_log is append-only.', 'access log is append-only');
select ok(not has_function_privilege('anon', 'public.partner_list_referred_accounts(integer,integer)', 'EXECUTE'), 'anon cannot execute the RPCs');
select ok(not has_function_privilege('authenticated', 'public.partner_scope_for(uuid)', 'EXECUTE'), 'internal scope resolver is not callable by clients');

select * from finish();
rollback;
