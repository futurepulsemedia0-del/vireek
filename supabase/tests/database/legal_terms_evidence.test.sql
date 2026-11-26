-- Terms acceptance evidence + grace (20290312000000). NOT EXECUTED by the author (no Postgres in the authoring
-- sandbox). Run with `supabase test db` after 20290306000200 and 20290312000000 are applied.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f001', 'owner@lte.test'),
  ('00000000-0000-0000-0000-00000000f002', 'other@lte.test'),
  ('00000000-0000-0000-0000-00000000f003', 'staff@lte.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000f001'),
  ('00000000-0000-0000-0000-00000000f002'),
  ('00000000-0000-0000-0000-00000000f003')
on conflict (id) do nothing;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000f003';
update public.profiles set created_at = now() - interval '3 days' where id in ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f002');

select is((select count(*)::int from public.legal_document_versions where doc_key = 'msa' and version = 1), 1, 'baseline msa v1 exists');
select is((select grace_days from public.legal_gate_settings), 0, 'default grace is 0 (previous behaviour)');
select is((select non_gating_doc_keys from public.legal_gate_settings), array['msa']::text[], 'msa is non-gating by default');

-- ---- staff publishes a material terms v2 (immediate, with waiver) and a material msa v2
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f003', 'role', 'authenticated')::text, true);
set local role authenticated;
select lives_ok($$select public.publish_legal_document_version('terms', 2, 'Terms of Service', now(), true,
  '[{"section":"Billing","kind":"changed","summary":"x"}]'::jsonb, repeat('b', 64), '/terms', true, 'Test waiver reason')$$, 'material terms v2 published');
select lives_ok($$select public.publish_legal_document_version('msa', 2, 'Master Services Agreement', now(), true,
  '[{"section":"Term","kind":"changed","summary":"x"}]'::jsonb, repeat('c', 64), '/msa', true, 'Test waiver reason')$$, 'material msa v2 published');
select throws_ok($$select public.staff_set_legal_grace_days(7, 'short')$$, '22023', null, 'grace change needs a written reason');
select throws_ok($$select public.staff_set_legal_grace_days(91, 'ninety-one is too many')$$, '22023', null, 'grace above 90 days is refused');
select is((public.staff_legal_gate_settings())->>'grace_days', '0', 'staff can read the settings');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

-- ---- owner: grace 0 -> blocked; msa never gates
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f001', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f001', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(public.legal_acceptance_status()->>'decision', 'must_accept', 'grace 0: a material effective version blocks at once');
select is(public.legal_acceptance_status()->'required'->0->>'blocking', 'true', 'the required document is marked blocking');
select is(jsonb_array_length(public.legal_acceptance_status()->'required'), 1, 'only terms is listed: the material msa v2 does not gate');
select throws_ok($$select public.staff_legal_acceptance_history('00000000-0000-0000-0000-00000000f001')$$, '42501', null, 'non-staff cannot read the history');
select throws_ok($$select public.staff_set_legal_grace_days(7, 'not allowed for non-staff')$$, '42501', null, 'non-staff cannot change the grace');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

-- ---- staff sets a 7-day grace
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f003', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((public.staff_set_legal_grace_days(7, 'Give customers a week to review'))->>'grace_days', '7', 'staff sets a 7-day grace');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_log where action = 'legal_grace_days_changed'), 1, 'the grace change is audit-logged');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f001', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f001', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(public.legal_acceptance_status()->>'decision', 'ok', 'inside the grace window the user is not blocked');
select is(public.legal_acceptance_status()->'required'->0->>'blocking', 'false', 'but the pending document is still listed (not blocking)');
select ok((public.legal_acceptance_status()->'required'->0->>'deadline')::timestamptz > now() + interval '6 days', 'the deadline is effective_at + grace');

-- click-through evidence (plan change): headers as PostgREST would expose them
select set_config('request.headers', '{"X-Forwarded-For":"198.51.100.7, 10.0.0.1","User-Agent":"LteTest/1.0"}', true);
select is((public.record_legal_click_through('plan_change', array['terms'], '{"plan_id":"business","evil":"x"}'::jsonb))->>'recorded', '1', 'a plan-change click-through is recorded');
select is((public.record_legal_click_through('plan_change', array['terms'], '{"plan_id":"business","evil":"x"}'::jsonb))->>'recorded', '0', 'an identical double-click within 60 s is not recorded twice');
select is((public.record_legal_click_through('plan_change', array['terms'], '{"plan_id":"starter"}'::jsonb))->>'recorded', '1', 'a different plan change is its own event');
select throws_ok($$select public.record_legal_click_through('gate', array['terms'])$$, '22023', null, 'click-through only accepts plan_change / msa_click_through');
select throws_ok($$select public.record_legal_click_through('msa_click_through', array['terms'])$$, '22023', null, 'an MSA click-through must name the msa document');
select is((public.record_legal_click_through('msa_click_through', array['msa'], '{"authority_confirmed":true}'::jsonb))->>'recorded', '1', 'an MSA click-through is recorded');
select is(public.legal_acceptance_status()->'required'->0->>'blocking', 'false', 'click-throughs never clear the re-acceptance requirement');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select is((select ip_address::text from public.legal_acceptances where source = 'plan_change' and context->>'plan_id' = 'business'), '198.51.100.7/32'::text,
  'IP is taken from the first x-forwarded-for hop (header names are case-insensitive)');
select is((select ip_source from public.legal_acceptances where source = 'plan_change' and context->>'plan_id' = 'business'), 'x-forwarded-for', 'the header used is recorded');
select is((select user_agent from public.legal_acceptances where source = 'plan_change' and context->>'plan_id' = 'business'), 'LteTest/1.0', 'user agent is recorded');
select is((select content_sha256 from public.legal_acceptances where source = 'plan_change' and context->>'plan_id' = 'business'), repeat('b', 64), 'the document hash is snapshotted from the version');
select ok((select not (context ? 'evil') from public.legal_acceptances where source = 'plan_change' and context->>'plan_id' = 'business'), 'context keys outside the whitelist are dropped');
select is((select account_owner_id from public.legal_acceptances where source = 'msa_click_through'), '00000000-0000-0000-0000-00000000f001'::uuid, 'the account owner is recorded');

-- ---- invalid IP header is stored as NULL, not as an error
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f002', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f002', 'role', 'authenticated')::text, true);
select set_config('request.headers', '{"x-forwarded-for":"not-an-ip","user-agent":"Bad/1"}', true);
set local role authenticated;
select lives_ok($$select public.accept_legal_versions(array(select id from public.legal_document_versions where doc_key = 'terms' and version = 2))$$, 'acceptance still works with an unusable IP header');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select ip_address from public.legal_acceptances where user_id = '00000000-0000-0000-0000-00000000f002' and source = 'gate'), null::inet, 'an unparseable IP is stored as NULL');

-- ---- staff history (audit-logged) and retention
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f003', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(jsonb_array_length(public.staff_legal_acceptance_history(null, 'OWNER@lte.test')), 3, 'staff finds the history by email (case-insensitive): 2 plan changes + MSA');
select is(public.staff_legal_acceptance_history('00000000-0000-0000-0000-00000000f001')->0->>'ip_address' is not null, true, 'history exposes the IP to staff');
select throws_ok($$select public.staff_legal_acceptance_history()$$, '22023', null, 'history needs a user id or email');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_log where action = 'legal_acceptance_history_viewed'), 2, 'every staff history read is audit-logged');

insert into public.legal_acceptances (user_id, version_id, doc_key, version, source, accepted_at, ip_address, ip_source, user_agent, content_sha256)
select '00000000-0000-0000-0000-00000000f001', id, doc_key, version, 'settings', now() - interval '2 days', '203.0.113.5', 'x-real-ip', 'Old/1', content_sha256
from public.legal_document_versions where doc_key = 'terms' and version = 1;
select throws_ok($$update public.legal_acceptances set ip_address = null where source = 'settings'$$, '42501', null, 'IP cannot be edited outside the redaction function');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f003', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((public.staff_redact_legal_network_data(now() - interval '1 day', null, 'Retention window elapsed'))->>'redacted', '1', 'retention redaction nulls only rows older than the cutoff');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select ip_address from public.legal_acceptances where source = 'settings'), null::inet, 'the redacted row has no IP');
select is((select content_sha256 is not null from public.legal_acceptances where source = 'settings'), true, 'redaction keeps the hash, version and timestamp');
select throws_ok($$update public.legal_acceptances set accepted_at = now() where source = 'plan_change'$$, '42501', null, 'acceptances stay append-only');

select * from finish();
rollback;
