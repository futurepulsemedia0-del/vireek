-- pgTAP: portal submission schema, RLS, duplicate prevention, state machine, append-only, task creation.  Run: supabase test db   (NOT RUN in the authoring environment: no Postgres available)
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','o@p.test'), ('00000000-0000-0000-0000-0000000000b1','x@p.test');
insert into public.profiles (id) values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b1') on conflict do nothing;
create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin perform set_config('role','authenticated',true); perform set_config('request.jwt.claim.sub',p_user::text,true);
  perform set_config('request.jwt.claims', json_build_object('sub',p_user,'role','authenticated')::text,true); end $$;

reset role;
insert into public.customers (id, user_id, name) values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','Big Property');
insert into public.invoices (id, user_id, invoice_number, customer_name, line_items) values
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','INV-1','Big Property','[{"description":"x","quantity":1,"unit_price":100}]');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((select require_approval from public.portal_set_account_settings(false,false,false,false,false,false,true)), 'settings default: approval required');
select throws_ok($$select public.portal_set_account_settings(true,true,true,false,false,false,false)$$, '22023', 'approval waiver consent required', 'cannot waive approval without consent');

select lives_ok($$select public.portal_save_profile(null,'00000000-0000-0000-0000-0000000000c1','Main AP','generic','https://ap.example.com','ap@example.com','{}'::jsonb,'assisted',
  '{"required_fields":[],"checklist":[],"status_map":{}}'::jsonb)$$, 'profile saved');
select throws_ok($$select public.portal_save_profile(null,'00000000-0000-0000-0000-0000000000c1','Auto','generic','https://ap.example.com',null,'{}'::jsonb,'automation','{"required_fields":[],"checklist":[],"status_map":{}}'::jsonb)$$, '22023', null, 'automation cannot be selected without consent flow');
select throws_ok($$insert into public.customer_portal_profiles (customer_id,name,portal_url) values ('00000000-0000-0000-0000-0000000000c1','Evil','http://insecure')$$, '42501', null, 'clients cannot insert directly');

-- disabled by default
select throws_ok($$select * from public.portal_enqueue_submission('00000000-0000-0000-0000-0000000000d1',(select id from public.customer_portal_profiles limit 1),'assisted',repeat('a',64),repeat('k',20))$$, '55000', null, 'enqueue refused while feature flag is OFF');
select public.portal_set_account_settings(true,true,true,false,false,false,true);

create temp table _p as select id from public.customer_portal_profiles limit 1;
grant all on _p to authenticated;
create temp table _s as select * from public.portal_enqueue_submission('00000000-0000-0000-0000-0000000000d1',(select id from _p),'assisted',repeat('a',64),repeat('k',20));
grant all on _s to authenticated;
select is((select o_duplicate from _s), false, 'first enqueue creates a row');
select is((select o_duplicate from public.portal_enqueue_submission('00000000-0000-0000-0000-0000000000d1',(select id from _p),'assisted',repeat('a',64),repeat('k',20))), true, 'retry with the same key is a no-op');
select is((select o_duplicate from public.portal_enqueue_submission('00000000-0000-0000-0000-0000000000d1',(select id from _p),'email',repeat('b',64),repeat('z',20))), true, 'a second live submission for the same invoice+portal is refused across channels');

-- state machine
select throws_ok($$select public.portal_apply_transition((select o_submission_id from _s),'submitted')$$, '22023', null, 'queued -> submitted is illegal');
select lives_ok($$select public.portal_apply_transition((select o_submission_id from _s),'prepared')$$, 'queued -> prepared');
select lives_ok($$select public.portal_apply_transition((select o_submission_id from _s),'awaiting_human')$$, 'prepared -> awaiting_human');
select throws_ok($$select public.portal_apply_transition((select o_submission_id from _s),'submitted','user','{}'::jsonb)$$, '22023', null, 'assisted confirmation needs reference or evidence');
select lives_ok($$select public.portal_apply_transition((select o_submission_id from _s),'submitted','user','{"reference":"R-1"}'::jsonb)$$, 'human records confirmation');
select public.portal_apply_transition((select o_submission_id from _s),'rejected','user','{"reason":"Missing PO number"}'::jsonb);
select is((select count(*)::int from public.tasks where description like '%[portal:%'), 1, 'rejection created exactly one fix-and-resubmit task');

-- isolation + append-only
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.portal_submissions), 0, 'other tenant sees nothing');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$delete from public.portal_submission_events$$, '42501', null, 'events are append-only');

select * from finish();
rollback;
