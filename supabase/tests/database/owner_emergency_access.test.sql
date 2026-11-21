-- Owner-incapacity emergency access (pgTAP): flow, mandatory delay, tenant isolation (RLS), read-only guarantee,
-- audit immutability + hash chain, owner overrides, cooldown, privileges.
-- Migration under test: 20290306000100_owner_emergency_access.sql
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- O = owner, C/C2/C3 = emergency contacts, S = unrelated tenant, T = another user (team-member style)
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000e0001', 'owner@emerg.test',   now()),
  ('00000000-0000-0000-0000-0000000e0002', 'contact@emerg.test', now()),
  ('00000000-0000-0000-0000-0000000e0003', 'stranger@emerg.test', now()),
  ('00000000-0000-0000-0000-0000000e0004', 'contact2@emerg.test', now()),
  ('00000000-0000-0000-0000-0000000e0005', 'contact3@emerg.test', now()),
  ('00000000-0000-0000-0000-0000000e0006', 'team@emerg.test',    now());
update public.profiles set company_name = 'Acme HVAC' where id = '00000000-0000-0000-0000-0000000e0001';

insert into public.customers (user_id, name, notes) values
  ('00000000-0000-0000-0000-0000000e0001', 'Owner Customer', 'private note'),
  ('00000000-0000-0000-0000-0000000e0003', 'Stranger Customer', null);
insert into public.jobs (user_id, customer_name) values
  ('00000000-0000-0000-0000-0000000e0001', 'Owner Job'),
  ('00000000-0000-0000-0000-0000000e0003', 'Stranger Job');
insert into public.ar_invoices (user_id, invoice_number) values
  ('00000000-0000-0000-0000-0000000e0001', 'INV-O-1'),
  ('00000000-0000-0000-0000-0000000e0003', 'INV-S-1');

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
end $$;

-- owner designates, contact accepts; returns the contact id
create or replace function pg_temp.enroll(p_contact_user uuid, p_email text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
  v_id := public.emergency_contact_add(p_email, 'Contact ' || p_email, 'friend', 72, 30, array['customers','invoices','jobs']);
  perform pg_temp.as_user(p_contact_user);
  perform public.emergency_contact_accept(v_id);
  perform pg_temp.as_service();
  return v_id;
end $$;

-- contact files a request and confirms the code; returns request id (runs as service role, like the edge function)
create or replace function pg_temp.start(p_contact uuid, p_user uuid) returns uuid language plpgsql as $$
declare v_req uuid := gen_random_uuid();
begin
  perform pg_temp.as_service();
  perform public.emergency_request_create(v_req, p_contact, p_user, 'Owner is in hospital and cannot work; need customer list.', repeat('a', 64), 30);
  if public.emergency_request_verify(v_req, p_user, repeat('a', 64)) <> 'verified' then raise exception 'verify failed'; end if;
  return v_req;
end $$;

-- fast-forward the waiting period while keeping the table's own CHECK satisfied
create or replace function pg_temp.travel(p_req uuid) returns void language plpgsql as $$
begin
  update public.emergency_access_requests
     set verified_at = verified_at - interval '4 days', access_available_at = access_available_at - interval '4 days'
   where id = p_req;
end $$;

-- ------------------------------------------------------ privileges / RLS on --
select ok((select relrowsecurity from pg_class where oid = 'public.emergency_contacts'::regclass), 'contacts: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.emergency_access_requests'::regclass), 'requests: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.emergency_access_audit'::regclass), 'audit: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.emergency_notice_outbox'::regclass), 'outbox: RLS on');

select ok(not has_table_privilege('authenticated', 'public.emergency_contacts', 'insert'), 'clients cannot insert contacts directly');
select ok(not has_table_privilege('authenticated', 'public.emergency_contacts', 'update'), 'clients cannot update contacts directly');
select ok(not has_table_privilege('authenticated', 'public.emergency_access_requests', 'update'), 'clients cannot update requests directly');
select ok(not has_table_privilege('authenticated', 'public.emergency_access_audit', 'insert'), 'clients cannot write the audit log');
select ok(not has_table_privilege('authenticated', 'public.emergency_notice_outbox', 'select'), 'clients cannot read the outbox');
select ok(not has_table_privilege('anon', 'public.emergency_contacts', 'select'), 'anon cannot read contacts');
select ok(not has_column_privilege('authenticated', 'public.emergency_access_requests', 'code_hash', 'select'), 'the code hash is never readable by clients');
select ok(not has_column_privilege('authenticated', 'public.emergency_access_requests', 'code_attempts', 'select'), 'attempt counter is not readable by clients');

select ok(not has_function_privilege('authenticated', 'public.emergency_tick()', 'execute'), 'clients cannot run the grant engine');
select ok(not has_function_privilege('authenticated', 'public.emergency_request_create(uuid,uuid,uuid,text,text,integer)', 'execute'), 'clients cannot create requests (code is minted server-side)');
select ok(not has_function_privilege('authenticated', 'public.emergency_request_verify(uuid,uuid,text)', 'execute'), 'clients cannot verify codes directly');
select ok(not has_function_privilege('authenticated', 'public.emergency_claim_notices(integer)', 'execute'), 'clients cannot claim notices');
select ok(not has_function_privilege('authenticated', 'public._emergency_close(uuid,text,text,uuid,text)', 'execute'), 'clients cannot close requests via internals');
select ok(not has_function_privilege('anon', 'public.emergency_read(uuid,text,integer,integer)', 'execute'), 'anon cannot read');
select ok(has_function_privilege('authenticated', 'public.emergency_read(uuid,text,integer,integer)', 'execute'), 'authenticated may call the gated read');
select ok(has_function_privilege('service_role', 'public.emergency_tick()', 'execute'), 'service_role runs the tick');

-- ------------------------------------------------------------ owner designates
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
select throws_ok($$ select public.emergency_contact_add('owner@emerg.test', 'Me', null, 72, 30, array['customers']) $$, '22023', null, 'cannot designate yourself');
select throws_ok($$ select public.emergency_contact_add('x@emerg.test', 'X', null, 24, 30, array['customers']) $$, '23514', null, 'a wait shorter than 48h is rejected');
select throws_ok($$ select public.emergency_contact_add('x@emerg.test', 'X', null, 72, 30, array['bank']) $$, '23514', null, 'no bank/payment scope can exist');
select throws_ok($$ select public.emergency_contact_add('not-an-email', 'X', null, 72, 30, array['customers']) $$, '23514', null, 'e-mail format enforced');
select pg_temp.as_service();

select pg_temp.as_user('00000000-0000-0000-0000-0000000e0003');
select throws_ok($$ select public.emergency_contact_accept(gen_random_uuid()) $$, 'P0002', null, 'unknown invitation');
select pg_temp.as_service();

select set_config('t.c1', pg_temp.enroll('00000000-0000-0000-0000-0000000e0002', 'contact@emerg.test')::text, true);
select is((select status from public.emergency_contacts where id = current_setting('t.c1')::uuid), 'active', 'accepted contact is active');
select is((select contact_user_id from public.emergency_contacts where id = current_setting('t.c1')::uuid), '00000000-0000-0000-0000-0000000e0002'::uuid, 'contact bound to the verified account');

select pg_temp.as_user('00000000-0000-0000-0000-0000000e0003');
select throws_ok(format($$ select public.emergency_contact_accept(%L) $$, current_setting('t.c1')), 'P0002', null, 'another user cannot accept someone else''s invitation');
select pg_temp.as_service();

-- RLS isolation of the designation tables
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
select is((select count(*)::int from public.emergency_contacts), 1, 'owner sees own contact');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0003');
select is((select count(*)::int from public.emergency_contacts), 0, 'stranger sees no contacts');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0006');
select is((select count(*)::int from public.emergency_contacts where owner_id = '00000000-0000-0000-0000-0000000e0001'), 0, 'other users cannot see the owner''s contacts');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select is((select count(*)::int from public.emergency_contacts), 0, 'the contact cannot read the contacts table (uses the RPC)');
select is(jsonb_array_length(public.emergency_my_designations()), 1, 'contact sees their designation through the RPC');
select is((public.emergency_my_designations() -> 0 ->> 'owner_business'), 'Acme HVAC', 'only the business name is exposed');
select pg_temp.as_service();

-- --------------------------------------------------------------- request flow
select throws_ok(format($$ select public.emergency_request_create(gen_random_uuid(), %L, '00000000-0000-0000-0000-0000000e0003', 'a long enough reason for the test', repeat('a',64), 30) $$, current_setting('t.c1')),
  '42501', null, 'a stranger cannot file a request for someone else''s contact');
select throws_ok(format($$ select public.emergency_request_create(gen_random_uuid(), %L, '00000000-0000-0000-0000-0000000e0002', 'short', repeat('a',64), 30) $$, current_setting('t.c1')),
  '22023', null, 'reason must be substantive');

select set_config('t.r1', gen_random_uuid()::text, true);
select lives_ok(format($$ select public.emergency_request_create(%L, %L, '00000000-0000-0000-0000-0000000e0002', 'Owner is in hospital and cannot work; need customer list.', repeat('a',64), 30) $$, current_setting('t.r1'), current_setting('t.c1')), 'request created');
select throws_ok(format($$ select public.emergency_request_create(gen_random_uuid(), %L, '00000000-0000-0000-0000-0000000e0002', 'Owner is in hospital and cannot work; need customer list.', repeat('b',64), 30) $$, current_setting('t.c1')),
  '23505', null, 'only one open request per contact');
select is((select status from public.emergency_access_requests where id = current_setting('t.r1')::uuid), 'pending_verification', 'awaiting code');
select is((select count(*)::int from public.emergency_notice_outbox where request_id = current_setting('t.r1')::uuid and kind = 'requested' and recipient = 'owner'), 1, 'owner is told immediately, before verification');

select is(public.emergency_request_verify(current_setting('t.r1')::uuid, '00000000-0000-0000-0000-0000000e0002', repeat('c', 64)), 'invalid', 'wrong code rejected');
select is((select code_attempts from public.emergency_access_requests where id = current_setting('t.r1')::uuid), 1, 'failed attempt is counted (not rolled back)');
select is(public.emergency_request_verify(current_setting('t.r1')::uuid, '00000000-0000-0000-0000-0000000e0003', repeat('a', 64)), 'invalid', 'another user cannot confirm someone else''s code');
select is(public.emergency_request_verify(current_setting('t.r1')::uuid, '00000000-0000-0000-0000-0000000e0002', repeat('a', 64)), 'verified', 'correct code starts the clock');
select is((select status from public.emergency_access_requests where id = current_setting('t.r1')::uuid), 'waiting', 'now waiting');
select is((select access_available_at - verified_at from public.emergency_access_requests where id = current_setting('t.r1')::uuid), interval '72 hours', 'full mandatory delay applied');
select is((select code_hash from public.emergency_access_requests where id = current_setting('t.r1')::uuid), null, 'code hash burned after use');
select is((select count(*)::int from public.emergency_notice_outbox where request_id = current_setting('t.r1')::uuid and kind in ('verified','pre_grant','reminder') and recipient = 'owner'), 3, 'owner gets: verified + 1 reminder + final notice');

-- the delay cannot be skipped
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select throws_ok(format($$ select public.emergency_read(%L, 'customers', 10, 0) $$, current_setting('t.r1')), '42501', null, 'no access while waiting');
select pg_temp.as_service();
select throws_ok(format($$ update public.emergency_access_requests set status = 'granted', granted_at = now(), access_expires_at = now() + interval '1 day' where id = %L $$, current_setting('t.r1')),
  '23514', null, 'even a privileged role cannot forge a grant before the delay has elapsed (table CHECK)');
select is((public.emergency_tick() ->> 'granted')::int, 0, 'tick does not grant early');

-- ------------------------------------------------------- grant after the delay
select pg_temp.travel(current_setting('t.r1')::uuid);
select is((public.emergency_tick() ->> 'granted')::int, 1, 'tick grants once the delay has elapsed');
select is((select status from public.emergency_access_requests where id = current_setting('t.r1')::uuid), 'granted', 'granted');
select is((select access_expires_at - granted_at from public.emergency_access_requests where id = current_setting('t.r1')::uuid), interval '30 days', 'bounded access window');

-- scoped READ
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select is((public.emergency_read(current_setting('t.r1')::uuid, 'customers', 100, 0) ->> 'total')::int, 1, 'contact reads only the owner''s customers');
select is(public.emergency_read(current_setting('t.r1')::uuid, 'customers', 100, 0) -> 'rows' -> 0 ->> 'name', 'Owner Customer', 'correct tenant');
select ok(not (public.emergency_read(current_setting('t.r1')::uuid, 'customers', 100, 0) -> 'rows' -> 0) ? 'notes', 'private notes are not exposed');
select ok(not (public.emergency_read(current_setting('t.r1')::uuid, 'customers', 100, 0) -> 'rows' -> 0) ? 'user_id', 'tenant id is not exposed');
select is(public.emergency_read(current_setting('t.r1')::uuid, 'invoices', 100, 0) -> 'rows' -> 0 ->> 'invoice_number', 'INV-O-1', 'invoices scope');
select is(public.emergency_read(current_setting('t.r1')::uuid, 'jobs', 100, 0) -> 'rows' -> 0 ->> 'customer_name', 'Owner Job', 'jobs scope');
select is((public.emergency_read(current_setting('t.r1')::uuid, 'jobs', 99999, -5) ->> 'limit')::int, 500, 'page size is capped');
select is((public.emergency_read(current_setting('t.r1')::uuid, 'jobs', 10, -5) ->> 'offset')::int, 0, 'negative offset is clamped');
select throws_ok(format($$ select public.emergency_read(%L, 'bank', 10, 0) $$, current_setting('t.r1')), '42501', null, 'there is no bank/payment scope');
select throws_ok(format($$ select public.emergency_read(%L, 'customers', 10, 0) $$, gen_random_uuid()), '42501', null, 'unknown request id');
select lives_ok(format($$ select public.emergency_log_export(%L, 'customers', 1, 'csv') $$, current_setting('t.r1')), 'exports are logged');

-- READ ONLY: direct table access gives the contact nothing, and writes are impossible
select is((select count(*)::int from public.customers), 0, 'contact has no direct RLS access to customers');
select is((select count(*)::int from public.customers where user_id = '00000000-0000-0000-0000-0000000e0001'), 0, 'nor to the owner''s rows');
select throws_ok($$ insert into public.customers (user_id, name) values ('00000000-0000-0000-0000-0000000e0001', 'Injected') $$, '42501', null, 'cannot insert customers for the owner');
select throws_ok($$ insert into public.jobs (user_id, customer_name) values ('00000000-0000-0000-0000-0000000e0001', 'Injected') $$, '42501', null, 'cannot insert jobs for the owner');
select throws_ok($$ insert into public.ar_invoices (user_id, invoice_number) values ('00000000-0000-0000-0000-0000000e0001', 'INJECTED') $$, '42501', null, 'cannot insert invoices for the owner');
select lives_ok($$ update public.customers set name = 'Hacked' where user_id = '00000000-0000-0000-0000-0000000e0001' $$, 'an UPDATE attempt is silently filtered by RLS (0 rows) or refused; it never succeeds');
select lives_ok($$ delete from public.jobs where user_id = '00000000-0000-0000-0000-0000000e0001' $$, 'a DELETE attempt is silently filtered by RLS (0 rows) or refused; it never succeeds');
select is((select count(*)::int from public.emergency_access_requests), 0, 'contact cannot list requests through the table');
select is((select count(*)::int from public.emergency_access_audit), 0, 'contact cannot read the audit log');
select throws_ok(format($$ update public.emergency_access_requests set access_expires_at = now() + interval '5 years' where id = %L $$, current_setting('t.r1')), '42501', null, 'contact cannot extend their own access');
select pg_temp.as_service();
select is((select name from public.customers where user_id = '00000000-0000-0000-0000-0000000e0001'), 'Owner Customer', 'owner data unchanged after the emergency session');
select is((select count(*)::int from public.jobs where user_id = '00000000-0000-0000-0000-0000000e0001'), 1, 'owner jobs unchanged');
select is((select count(*)::int from public.customers), 2, 'no rows were created anywhere');

-- ------------------------------------------------------------------ audit log
select ok((select count(*)::int from public.emergency_access_audit where owner_id = '00000000-0000-0000-0000-0000000e0001' and event = 'read') >= 5, 'every read is audited');
select is((select count(*)::int from public.emergency_access_audit where event = 'export'), 1, 'export is audited');
select ok((select bool_and(detail ?| array['scope','offset','limit','returned']) from public.emergency_access_audit where event = 'read'), 'read audit holds scope/paging/count only');
select ok(not exists (select 1 from public.emergency_access_audit where detail::text ilike '%Owner Customer%' or detail::text ilike '%@emerg.test%'), 'audit never stores record contents or e-mail addresses');
select throws_ok($$ update public.emergency_access_audit set event = 'nothing happened' $$, '42501', null, 'audit rows cannot be edited');
select throws_ok($$ delete from public.emergency_access_audit $$, '42501', null, 'audit rows cannot be deleted');
select throws_ok($$ truncate public.emergency_access_audit $$, '42501', null, 'audit cannot be truncated');
select is((select ok from public.emergency_audit_verify_owner('00000000-0000-0000-0000-0000000e0001')), true, 'hash chain verifies');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
select is((select ok from public.emergency_audit_verify()), true, 'owner can verify their own chain');
select ok((select count(*)::int from public.emergency_access_audit) > 8, 'owner can read their audit log');
select throws_ok($$ select code_hash from public.emergency_access_requests $$, '42501', null, 'owner cannot read the code hash either');
select is((select count(*)::int from public.emergency_access_requests where status = 'granted'), 1, 'owner sees the active grant');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0003');
select is((select count(*)::int from public.emergency_access_audit), 0, 'stranger cannot read anyone''s audit log');
select pg_temp.as_service();

-- notices: claim -> in-app notification for the owner -> mark sent
select ok((select count(*)::int from public.emergency_claim_notices(100)) >= 5, 'due notices are claimed');
select ok(exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000e0001' and title like 'Emergency access:%'), 'owner gets an in-app notification even if e-mail fails');
select is((select count(*)::int from public.emergency_claim_notices(100)), 0, 'a claimed notice is not handed out twice');

-- --------------------------------------------------------------- window ends
update public.emergency_access_requests set access_expires_at = now() - interval '1 minute' where id = current_setting('t.r1')::uuid;
select is((public.emergency_tick() ->> 'expired')::int, 1, 'tick ends the access window');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select throws_ok(format($$ select public.emergency_read(%L, 'customers', 10, 0) $$, current_setting('t.r1')), '42501', null, 'no read after expiry');
select pg_temp.as_service();

-- -------------------------------------------------- owner deny ends a live grant
select set_config('t.r2', pg_temp.start(current_setting('t.c1')::uuid, '00000000-0000-0000-0000-0000000e0002')::text, true);
select pg_temp.travel(current_setting('t.r2')::uuid);
select is((public.emergency_tick() ->> 'granted')::int, 1, 'second request granted after the delay');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select lives_ok(format($$ select public.emergency_read(%L, 'customers', 10, 0) $$, current_setting('t.r2')), 'read works while granted');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0003');
select throws_ok(format($$ select public.emergency_request_deny(%L) $$, current_setting('t.r2')), 'P0002', null, 'a stranger cannot deny someone else''s request');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
select lives_ok(format($$ select public.emergency_request_deny(%L) $$, current_setting('t.r2')), 'owner denies');
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0002');
select throws_ok(format($$ select public.emergency_read(%L, 'customers', 10, 0) $$, current_setting('t.r2')), '42501', null, 'access ends the moment the owner denies');
select pg_temp.as_service();
select is((select status from public.emergency_access_requests where id = current_setting('t.r2')::uuid), 'denied', 'status denied');
select throws_ok(format($$ select public.emergency_request_create(gen_random_uuid(), %L, '00000000-0000-0000-0000-0000000e0002', 'Trying again right after being denied, please.', repeat('a',64), 30) $$, current_setting('t.c1')),
  '53400', null, '30-day cooldown after an owner denial');

-- ------------------------------------------ owner signing in cancels a pending request
select set_config('t.c2', pg_temp.enroll('00000000-0000-0000-0000-0000000e0004', 'contact2@emerg.test')::text, true);
select set_config('t.r3', pg_temp.start(current_setting('t.c2')::uuid, '00000000-0000-0000-0000-0000000e0004')::text, true);
update auth.users set last_sign_in_at = now() + interval '1 second' where id = '00000000-0000-0000-0000-0000000e0001';
select is((public.emergency_tick() ->> 'cancelled_owner_signed_in')::int, 1, 'owner sign-in cancels the countdown');
select is((select closed_reason from public.emergency_access_requests where id = current_setting('t.r3')::uuid), 'owner_signed_in', 'reason recorded');
select is((select count(*)::int from public.emergency_notice_outbox where request_id = current_setting('t.r3')::uuid and sent_at is null and kind in ('reminder','pre_grant')), 0, 'pending reminders are dropped for a closed request');
update auth.users set last_sign_in_at = null where id = '00000000-0000-0000-0000-0000000e0001';

-- --------------------------------------------- revoking a contact ends everything
select set_config('t.c3', pg_temp.enroll('00000000-0000-0000-0000-0000000e0005', 'contact3@emerg.test')::text, true);
select set_config('t.r4', pg_temp.start(current_setting('t.c3')::uuid, '00000000-0000-0000-0000-0000000e0005')::text, true);
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0001');
select throws_ok($$ select public.emergency_contact_add('fourth@emerg.test', 'Fourth', null, 72, 30, array['customers']) $$, '54000', null, 'at most 3 contacts');
select lives_ok(format($$ select public.emergency_contact_revoke(%L) $$, current_setting('t.c3')), 'owner revokes a contact');
select pg_temp.as_service();
select is((select status from public.emergency_access_requests where id = current_setting('t.r4')::uuid), 'revoked', 'open request is closed by the revocation');
select throws_ok(format($$ select public.emergency_request_create(gen_random_uuid(), %L, '00000000-0000-0000-0000-0000000e0005', 'Trying after being removed as a contact.', repeat('a',64), 30) $$, current_setting('t.c3')),
  '42501', null, 'a revoked contact cannot file requests');

-- code lock-out
select set_config('t.c4', pg_temp.enroll('00000000-0000-0000-0000-0000000e0005', 'contact3@emerg.test')::text, true);
select set_config('t.r5', gen_random_uuid()::text, true);
select lives_ok(format($$ select public.emergency_request_create(%L, %L, '00000000-0000-0000-0000-0000000e0005', 'Brute force attempt should be locked out quickly.', repeat('a',64), 30) $$, current_setting('t.r5'), current_setting('t.c4')), 'request for lock-out test');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('1', 64)), 'invalid', 'attempt 1');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('2', 64)), 'invalid', 'attempt 2');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('3', 64)), 'invalid', 'attempt 3');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('4', 64)), 'invalid', 'attempt 4');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('5', 64)), 'locked', 'attempt 5 locks');
select is((select status from public.emergency_access_requests where id = current_setting('t.r5')::uuid), 'cancelled', 'request is cancelled after too many wrong codes');
select is(public.emergency_request_verify(current_setting('t.r5')::uuid, '00000000-0000-0000-0000-0000000e0005', repeat('a', 64)), 'invalid', 'the right code no longer works after lock-out');

select is((select ok from public.emergency_audit_verify_owner('00000000-0000-0000-0000-0000000e0001')), true, 'hash chain still intact at the end');

select * from finish();
rollback;
