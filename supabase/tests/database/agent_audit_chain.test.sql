-- Agent audit chain: append, tamper detection, immutability, delete block (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o@acme.test');
insert into public.agent_action_catalog (slug, agent_source, label, category, default_requires_approval)
  values ('zz_test_action', 'test', 'Test', 'other', false) on conflict do nothing;

insert into public.agent_action_log (id, user_id, action_slug, agent_source, status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'zz_test_action', 'test', 'auto_approved');
update public.agent_action_log set status = 'executed' where id = '00000000-0000-0000-0000-0000000000e1';

select is((select count(*)::int from public.agent_audit_chain where user_id = '00000000-0000-0000-0000-0000000000a1'), 2, 'insert + update both chained');
select is((select ok from public.verify_agent_audit_chain('00000000-0000-0000-0000-0000000000a1')), true, 'untampered chain verifies');
select throws_ok($$delete from public.agent_action_log where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', null, 'log delete blocked');
select throws_ok($$update public.agent_audit_chain set event = 'INSERT' where seq = 1$$, '42501', null, 'chain update blocked');
select throws_ok($$delete from public.agent_audit_chain where seq = 2$$, '42501', null, 'chain delete blocked');

-- tamper with the live row while bypassing triggers (simulates a privileged out-of-band edit)
set local session_replication_role = replica;
update public.agent_action_log set amount_cents = 999999 where id = '00000000-0000-0000-0000-0000000000e1';
set local session_replication_role = origin;
select is((select ok from public.verify_agent_audit_chain('00000000-0000-0000-0000-0000000000a1')), false, 'tampered live row detected');
select matches((select reason from public.verify_agent_audit_chain('00000000-0000-0000-0000-0000000000a1')), 'differs from audited snapshot', 'reason names the diff');

select * from finish();
rollback;
