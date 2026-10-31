-- QuickBooks reconciliation audit: tenant isolation, no client writes, resolve-with-note, audit trail,
-- idempotent re-runs and the "audit never touches an invoice with payments" invariant (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

-- ---------------------------------------------------------------- fixtures --
-- A owner, M team member WITHOUT billing/profile permissions, B = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}');

insert into public.qbo_connections (id, user_id, realm_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '123145820001'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '123145820002');
insert into public.qbo_recon_runs (id, user_id, connection_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1');

-- an invoice WITH payments: the audit must never touch it
insert into public.ar_invoices (id, user_id, invoice_number, status, subtotal_cents, amount_paid_cents) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'INV-PAID', 'paid', 5000, 5000);
select set_config('t.inv_md5', (select md5(i::text) from public.ar_invoices i where id = '00000000-0000-0000-0000-0000000000e1'), true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.fs(p_sig_a text default 'a1') returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('fingerprint','amount_mismatch|v3|400','bucket','amount_mismatch','severity','low','cents_at_stake',500,'vireek_id','00000000-0000-0000-0000-0000000000e1','qbo_id','400','has_payments',true,'evidence','{}'::jsonb,'evidence_sig',p_sig_a,'suggested_action','Compare line items'),
    jsonb_build_object('fingerprint','missing_in_qbo|v2|-','bucket','missing_in_qbo','severity','high','cents_at_stake',25000,'vireek_id',null,'qbo_id',null,'has_payments',false,'evidence','{}'::jsonb,'evidence_sig','b1','suggested_action','Check export'),
    jsonb_build_object('fingerprint','tax_mismatch|v7|800','bucket','tax_mismatch','severity','low','cents_at_stake',25,'vireek_id',null,'qbo_id','800','has_payments',false,'evidence','{}'::jsonb,'evidence_sig','c1','suggested_action','Check tax'))
$$;

-- ------------------------------------------------------------ service apply --
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1', pg_temp.fs(), false)) ->> 'new', '3', 'first apply creates 3 findings');
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1', pg_temp.fs(), false)) ->> 'new', '0', 'apply is idempotent: same findings create nothing');
select is((select count(*)::int from public.qbo_recon_findings), 3, 'still exactly 3 findings after a repeat');
select is((select count(*)::int from public.qbo_recon_events where action = 'detected'), 3, 'one detected event per finding');
select throws_ok($$ select public.qbo_recon_apply('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1','[]'::jsonb,false) $$, 'P0001', 'Connection not found', 'apply refuses another account''s connection');

-- ------------------------------------------------------------ tenant access --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.qbo_recon_findings), 3, 'owner sees their findings');
select is((select count(*)::int from public.qbo_recon_runs), 1, 'owner sees their run');
select throws_ok($$ insert into public.qbo_recon_findings (user_id, connection_id, fingerprint, bucket, severity, cents_at_stake, evidence_sig, suggested_action)
  values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','x','tax_mismatch','low',1,'s','a') $$, '42501', null, 'owner cannot forge a finding');
select throws_ok($$ update public.qbo_recon_findings set cents_at_stake = 0 $$, '42501', null, 'owner cannot edit a finding directly');
select throws_ok($$ delete from public.qbo_recon_events $$, '42501', null, 'owner cannot delete audit events');
select throws_ok($$ select public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1','[]'::jsonb,true) $$, '42501', null, 'owner cannot call the service-only apply');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.qbo_recon_findings), 0, 'a member without billing + profile permissions sees nothing');
select throws_ok($$ select public.qbo_recon_set_status((select id from public.qbo_recon_findings limit 1), 'resolved', 'nope nope') $$, '42501', null, 'and cannot resolve');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.qbo_recon_findings), 0, 'another account sees no foreign findings');
select is((select count(*)::int from public.qbo_recon_runs) + (select count(*)::int from public.qbo_recon_events), 0, 'nor runs or events');
select throws_ok(format($$ select public.qbo_recon_set_status(%L::uuid, 'resolved', 'not mine') $$, (select id from public.qbo_recon_findings limit 1)), 'P0001', null, 'another account cannot resolve (finding invisible/not found)');

-- ------------------------------------------------------- human resolve + audit --
reset role;
select set_config('t.f', (select id::text from public.qbo_recon_findings where bucket = 'amount_mismatch'), true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok(format($$ select public.qbo_recon_set_status(%L::uuid, 'resolved', '  ') $$, current_setting('t.f')), 'P0001', 'A resolution note is required', 'resolving needs a note');
select lives_ok(format($$ select public.qbo_recon_set_status(%L::uuid, 'resolved', 'Corrected in QuickBooks by Sam') $$, current_setting('t.f')), 'owner resolves with a note');
select is((select status from public.qbo_recon_findings where id = current_setting('t.f')::uuid), 'resolved', 'status is resolved');
select is((select count(*)::int from public.qbo_recon_events where finding_id = current_setting('t.f')::uuid and action = 'resolved' and actor = '00000000-0000-0000-0000-0000000000a1' and note like 'Corrected%'), 1, 'audit event records actor and note');

-- ------------------------------------------------ re-run semantics (service) --
reset role;
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1', pg_temp.fs(), false)) ->> 'reopened', '0', 'unchanged numbers keep a resolved finding resolved');
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f1', pg_temp.fs('a2'), false)) ->> 'reopened', '1', 'changed numbers reopen a resolved finding');
select is((select status from public.qbo_recon_findings where id = current_setting('t.f')::uuid), 'open', 'and it is open again with the note cleared');
-- a NEW run (the first one finished): only a complete audit may clear what it no longer sees
update public.qbo_recon_runs set status = 'success', finished_at = now() where id = '00000000-0000-0000-0000-0000000000f1';
insert into public.qbo_recon_runs (id, user_id, connection_id) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1');
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f2', jsonb_build_array(pg_temp.fs('a2') -> 0), false)) ->> 'cleared', '0', 'a PARTIAL audit never clears anything');
select is((public.qbo_recon_apply('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f2', jsonb_build_array(pg_temp.fs('a2') -> 0), true)) ->> 'cleared', '2', 'a COMPLETE audit clears findings that are no longer detected');
select is((select count(*)::int from public.qbo_recon_events where action = 'cleared'), 2, 'each clearing is in the audit trail');

-- ------------------------------------------------------------- invariants --
select is((select md5(i::text) from public.ar_invoices i where id = '00000000-0000-0000-0000-0000000000e1'), current_setting('t.inv_md5'), 'an invoice with payments is byte-for-byte untouched by everything above');
select throws_ok($$ insert into public.qbo_recon_runs (user_id, connection_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1') $$, '23505', null, 'only one running audit per connection');
select throws_ok($$ insert into public.ar_invoices (user_id, invoice_number, bill_to_role) values ('00000000-0000-0000-0000-0000000000a1','INV-BT','landlord') $$, '23514', null, 'bill_to_role only allows owner or tenant');

select * from finish();
rollback;
