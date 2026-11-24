-- Marketplace vetting: approval gate, checklist, append-only reports, delisting, reinstating (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- ---------------------------------------------------------------- fixtures --
-- S = Vireek staff, P = publisher, T = tenant that installs the agent.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff@mkv.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'publisher@mkv.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'tenant@mkv.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', true),
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false),
  ('00000000-0000-0000-0000-0000000000c1', 'owner', false)
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff;

-- A1: third-party agent by P. A2: agent whose publisher IS the staff user (self-review case).
insert into public.marketplace_agents (id, slug, publisher_id, publisher_name, name, tagline, description, category, runtime, endpoint_url, status) values
  ('10000000-0000-0000-0000-000000000001', 'mkv-acme-agent', '00000000-0000-0000-0000-0000000000b1', 'Acme Ltd', 'Acme Furnace Helper', 'tag', 'desc', 'hvac', 'webhook', 'https://agents.acme.example/h', 'in_review'),
  ('10000000-0000-0000-0000-000000000002', 'mkv-staff-agent', '00000000-0000-0000-0000-0000000000a1', 'Staff Co', 'Staff Own Agent', 'tag', 'desc', 'hvac', 'webhook', 'https://agents.staffco.example/h', 'in_review');
insert into public.marketplace_agent_versions (id, agent_id, version, manifest, manifest_hash, status) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '1.0.0', '{"scopes":["read:jobs","act:record_insight"],"triggers":["manual"]}', 'h1', 'submitted'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '1.0.0', '{"scopes":["read:jobs"],"triggers":["manual"]}', 'h2', 'submitted');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- ---------------------------------------------------------------- structure --
select has_table('public', 'marketplace_vetting_reports', 'vetting reports table exists');
select has_table('public', 'marketplace_review_checklist_answers', 'checklist answers table exists');
select has_table('public', 'marketplace_delisting_events', 'delisting events table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.marketplace_vetting_reports'::regclass), 'RLS enabled on vetting reports');
select is((select count(*)::int from public.marketplace_review_checklist_items), 12, 'twelve checklist items are seeded');

-- ---------------------------------------------------------------- gate: no report --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_like($$select public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001')$$, '%Staff only%', 'a tenant cannot read review state');
select throws_like($$select public.save_marketplace_review_answer('20000000-0000-0000-0000-000000000001', 'publisher_identity', 'pass', null)$$, '%Staff only%', 'a tenant cannot answer the checklist');
select throws_like($$select public.delist_marketplace_agent('10000000-0000-0000-0000-000000000001', 'security', 'internal detail', 'message to publisher')$$, '%Staff only%', 'a tenant cannot delist');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001') -> 'blockers') ? 'no_report', 'no report => blocker no_report');
select throws_like($$select public.review_marketplace_agent_version('20000000-0000-0000-0000-000000000001', true, 'ok')$$, 'APPROVAL_BLOCKED:%no_report%', 'approval without a report is refused');

-- ---------------------------------------------------------------- gate: report verdicts --
select pg_temp.reset_role();
insert into public.marketplace_vetting_reports (version_id, manifest_hash, endpoint_url, verdict, risk_tier, checks, created_at)
values ('20000000-0000-0000-0000-000000000001', 'h1', 'https://agents.acme.example/h', 'fail', 'low', '[]'::jsonb, now() - interval '2 minutes');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001') -> 'blockers') ? 'report_failed', 'failed report blocks approval');

select pg_temp.reset_role();
insert into public.marketplace_vetting_reports (version_id, manifest_hash, endpoint_url, verdict, risk_tier, checks, created_at)
values ('20000000-0000-0000-0000-000000000001', 'h1', 'https://agents.acme.example/h', 'pass', 'low', '[]'::jsonb, now());
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok(not ((public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001') -> 'blockers') ? 'report_failed'), 'the newest report wins');
select ok((public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001') -> 'blockers') ? 'checklist_incomplete', 'unanswered checklist blocks approval');

-- ---------------------------------------------------------------- checklist rules --
select throws_like($$select public.save_marketplace_review_answer('20000000-0000-0000-0000-000000000001', 'publisher_identity', 'fail', null)$$, '%note of at least 5%', 'fail needs a note');
select throws_like($$select public.save_marketplace_review_answer('20000000-0000-0000-0000-000000000001', 'publisher_identity', 'na', 'not applicable here')$$, '%cannot be marked not applicable%', 'na only where the item allows it');
select is(
  (select count(*)::int from (
     select public.save_marketplace_review_answer('20000000-0000-0000-0000-000000000001', s, 'pass', null)
     from unnest(array['publisher_identity','security_contact','endpoint_control','signature_verification','scopes_justified','sandbox_run_reviewed','delisting_terms_ack']) as s
   ) x),
  7, 'seven applicable items answered for a low-risk free agent');
select ok(((public.get_marketplace_review_state('20000000-0000-0000-0000-000000000001') ->> 'ready'))::boolean, 'ready once report + checklist are in place');

-- ---------------------------------------------------------------- reviewer rules --
select throws_like($$select public.review_marketplace_agent_version('20000000-0000-0000-0000-000000000002', true, 'ok')$$, '%cannot review your own agent%', 'staff cannot approve their own agent');
select throws_like($$select public.review_marketplace_agent_version('20000000-0000-0000-0000-000000000001', false, null)$$, '%rejection needs a note%', 'a rejection needs a note');
select is((select status from public.review_marketplace_agent_version('20000000-0000-0000-0000-000000000001', true, 'looks fine')), 'approved', 'approval succeeds when the gate is satisfied');
select is((select status from public.marketplace_agents where id = '10000000-0000-0000-0000-000000000001'), 'published', 'agent is published after approval');

-- ---------------------------------------------------------------- delisting --
select pg_temp.reset_role();
insert into public.marketplace_agent_installs (id, user_id, agent_id, version_id, installed_by, granted_scopes)
values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '{read:jobs}');
insert into public.marketplace_agent_runs (id, install_id, user_id, agent_id, version_id, trigger, status)
values ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'manual', 'queued');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.delist_marketplace_agent('10000000-0000-0000-0000-000000000001', 'security', 'internal detail here', 'Message for publisher') ->> 'installs_revoked')::int, 1, 'delisting reports the revoked installs');
select pg_temp.reset_role();
select is((select status from public.marketplace_agents where id = '10000000-0000-0000-0000-000000000001'), 'delisted', 'agent is delisted');
select is((select status from public.marketplace_agent_installs where id = '30000000-0000-0000-0000-000000000001'), 'revoked', 'install is revoked');
select is((select status from public.marketplace_agent_runs where id = '40000000-0000-0000-0000-000000000001'), 'blocked', 'queued run is blocked');
select is((select status from public.marketplace_agent_versions where id = '20000000-0000-0000-0000-000000000001'), 'deprecated', 'approved version is deprecated');
select is((select count(*)::int from public.marketplace_delisting_events where agent_id = '10000000-0000-0000-0000-000000000001' and action = 'delisted'), 1, 'one delisting event recorded');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select suspended_reason from public.marketplace_agents where id = '10000000-0000-0000-0000-000000000001'), 'Message for publisher', 'publisher sees the publisher-facing message');
select is((select count(*)::int from public.marketplace_delisting_events), 0, 'publisher cannot read internal delisting events');
select throws_like($$select public.submit_marketplace_agent_version('10000000-0000-0000-0000-000000000001', '1.1.0', '{"scopes":["read:jobs"],"triggers":["manual"]}'::jsonb)$$, '%delisted%', 'a delisted agent cannot receive versions');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.marketplace_vetting_reports), 0, 'tenants cannot read vetting reports');

-- ---------------------------------------------------------------- append-only + reinstate + changes --
select pg_temp.reset_role();
select throws_like($$update public.marketplace_vetting_reports set verdict = 'pass'$$, '%append-only%', 'reports cannot be edited');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.reinstate_marketplace_agent('10000000-0000-0000-0000-000000000001', 'issue fixed and verified');
select pg_temp.reset_role();
select is((select status || ':' || coalesce(current_version_id::text, 'none') from public.marketplace_agents where id = '10000000-0000-0000-0000-000000000001'), 'draft:none', 'reinstated as draft without a current version');

insert into public.marketplace_agent_versions (id, agent_id, version, manifest, manifest_hash, status)
values ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '2.0.0', '{"scopes":["read:jobs"],"triggers":["manual"]}', 'h3', 'submitted');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select status from public.request_marketplace_changes('20000000-0000-0000-0000-000000000003', 'Please narrow the scopes')), 'changes_requested', 'changes can be requested');

-- ---------------------------------------------------------------- manifest outbound_domains --
select lives_ok($$select public.validate_marketplace_manifest('{"scopes":["read:jobs"],"triggers":["manual"],"outbound_domains":["a.example.com"]}'::jsonb)$$, 'valid outbound_domains accepted');
select throws_like($$select public.validate_marketplace_manifest('{"scopes":["read:jobs"],"triggers":["manual"],"outbound_domains":["https://bad"]}'::jsonb)$$, '%Invalid outbound domain%', 'invalid outbound domain rejected');

select * from finish();
rollback;
