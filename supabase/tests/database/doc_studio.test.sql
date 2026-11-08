-- Document Template Studio: tenant isolation, draft-only edits, publish approval, immutability,
-- generated documents, share-link lockdown, append-only access log (pgTAP).
-- Run with:  supabase test db
-- Assumes (as the other suites do) that inserting into auth.users provisions the owner's profile.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Fixture helper: stands in for the doc-studio edge function's server-side validation attestation.
create or replace function pg_temp.attest() returns void language plpgsql as $$
begin
  perform set_config('vireek.doc_rpc', 'on', true);
  update public.doc_clause_versions set validated_sha256 = sha256 where status = 'draft';
  update public.doc_content_template_versions set validated_sha256 = sha256 where status = 'draft';
  perform set_config('vireek.doc_rpc', 'off', true);
end $$;

-- ---------------------------------------------------------------- owner: clause lifecycle
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into public.doc_clauses (slug, title) values ('liability', 'Limitation of liability') $$, 'owner can create a clause');
select lives_ok($$ insert into public.doc_clause_versions (clause_id, body, status)
  select id, 'Liability is capped.', 'published' from public.doc_clauses where slug = 'liability' $$, 'owner can add a clause version');
select is((select status from public.doc_clause_versions), 'draft', 'a client cannot insert a version as published (forced to draft)');
select is((select sha256 from public.doc_clause_versions), encode(sha256(convert_to('Liability is capped.', 'UTF8')), 'hex'), 'the database computes the body hash');
select throws_ok($$ update public.doc_clause_versions set status = 'published' $$, '42501', null, 'status cannot be changed directly');
select throws_ok($$ update public.doc_clause_versions set validated_sha256 = sha256 $$, '42501', null, 'validation cannot be attested by a client');
select throws_ok($$ select public.doc_studio_submit('clause', (select id from public.doc_clause_versions)) $$, '55000', null, 'an unvalidated draft cannot be submitted');

reset role;
select pg_temp.attest();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.doc_studio_submit('clause', (select id from public.doc_clause_versions)) $$, 'a validated draft can be submitted');
select throws_ok($$ select public.doc_studio_review('clause', (select id from public.doc_clause_versions), true, null) $$, '22023', null, 'self-approval needs a written note');
select lives_ok($$ select public.doc_studio_review('clause', (select id from public.doc_clause_versions), true, 'Counsel reviewed on 2026-06-01') $$, 'self-approval with a note publishes');
select is((select self_approved from public.doc_clause_versions), true, 'self-approval is flagged');

update public.doc_clause_versions set body = 'Tampered.';
select is((select body from public.doc_clause_versions), 'Liability is capped.', 'a published body cannot be edited through the API');
reset role;
select throws_ok($$ update public.doc_clause_versions set body = 'Tampered.' $$, '55000', null, 'a published body is immutable even for privileged roles');

-- ---------------------------------------------------------------- templates pin clause hashes
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.doc_content_templates (name, doc_type) values ('Service agreement', 'contract');
insert into public.doc_content_template_versions (template_id, body, clause_refs)
  select t.id, '{{customer.name}} {{clause:liability}}',
         jsonb_build_array(jsonb_build_object('slug', 'liability', 'version', 1, 'sha256', 'deadbeef'))
    from public.doc_content_templates t;
reset role;
select pg_temp.attest();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.doc_studio_submit('template', (select id from public.doc_content_template_versions)) $$, 'template draft submitted');
select throws_ok($$ select public.doc_studio_review('template', (select id from public.doc_content_template_versions), true, 'Counsel reviewed OK') $$, '55000', null, 'a stale clause hash blocks publishing');

-- ---------------------------------------------------------------- tenant isolation + permissions
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.doc_clauses), 0, 'another account sees no clauses');
select throws_ok($$ insert into public.doc_clause_versions (clause_id, body)
  select id, 'x' from public.doc_clauses $$, '42501', null, 'cross-tenant clause_id cannot be targeted');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.doc_clauses), 1, 'a team member can read the clause library');
select throws_ok($$ insert into public.doc_clauses (slug, title) values ('x', 'X') $$, '42501', null, 'a member without permission cannot write');

-- ---------------------------------------------------------------- share links + access log lockdown
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select * from public.document_share_links $$, '42501', null, 'clients cannot read share-link secrets');
select throws_ok($$ insert into public.document_access_log (user_id, actor_kind, action) values ('00000000-0000-0000-0000-0000000000a1', 'member', 'view') $$, '42501', null, 'clients cannot write the access log');

select * from finish();
rollback;
