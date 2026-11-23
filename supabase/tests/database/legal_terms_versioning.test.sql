-- Legal terms versioning + re-acceptance (20290306000200). NOT EXECUTED by the author (no Postgres in the
-- authoring sandbox). Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e001', 'fresh@ltv.test'),
  ('00000000-0000-0000-0000-00000000e002', 'old@ltv.test'),
  ('00000000-0000-0000-0000-00000000e003', 'staff@ltv.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000e001'),
  ('00000000-0000-0000-0000-00000000e002'),
  ('00000000-0000-0000-0000-00000000e003')
on conflict (id) do nothing;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000e003';
update public.profiles set created_at = now() - interval '1 hour' where id = '00000000-0000-0000-0000-00000000e001';
update public.profiles set created_at = now() - interval '3 days' where id = '00000000-0000-0000-0000-00000000e002';

select is((select count(*)::int from public.legal_document_versions where doc_key in ('terms', 'privacy') and version = 1), 2, 'baseline terms v1 and privacy v1 exist');

-- ---- as staff: publishing rules
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000e003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e003', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok($$select public.publish_legal_document_version('terms', 2, 'Terms', now() + interval '40 days', true, '[]'::jsonb, null, '/terms', true)$$,
  '23514', null, 'a material version without a diff summary is refused');
select throws_ok($$select public.publish_legal_document_version('terms', 2, 'Terms', now() + interval '40 days', true, '[{"section":"Billing","kind":"changed","summary":"x"}]'::jsonb, null, '/terms', false)$$,
  '23514', null, 'publishing without the legal-review confirmation is refused [COUNSEL]');
select throws_ok($$select public.publish_legal_document_version('terms', 2, 'Terms', now() + interval '5 days', true, '[{"section":"Billing","kind":"changed","summary":"x"}]'::jsonb, null, '/terms', true)$$,
  '23514', null, 'a material change with less than 30 days notice and no waiver is refused');
select throws_ok($$select public.publish_legal_document_version('terms', 4, 'Terms', now() + interval '40 days', false, '[]'::jsonb, null, '/terms', true)$$,
  '23514', null, 'versions must be sequential');
select throws_ok($$select public.publish_legal_document_version('terms', 2, 'Terms', now() + interval '40 days', true, '[{"section":"Billing","kind":"bogus","summary":"x"}]'::jsonb, null, '/terms', true)$$,
  '23514', null, 'a malformed diff entry is refused');
select throws_ok($$select public.publish_legal_document_version('terms', 2, 'Terms', now() + interval '40 days', false, '[]'::jsonb, 'not-a-hash', '/terms', true)$$,
  '23514', null, 'a malformed content hash is refused');

-- v2 material, effective immediately with a written waiver; privacy v2 non-material; privacy v3 material with notice
select is((public.publish_legal_document_version('terms', 2, 'Terms of Service', now(), true,
  '[{"section":"Billing","kind":"changed","summary":"Annual plans renew at the then-current price.","i18n":{"fa":"x"}},{"section":"Liability","kind":"added","summary":"New cap on indirect damages."}]'::jsonb,
  repeat('a', 64), '/terms', true, 'Required by a payment-provider change; reviewed')).version, 2, 'material v2 published with a notice waiver');
select is((public.publish_legal_document_version('privacy', 2, 'Privacy Policy', now(), false, '[]'::jsonb, null, '/privacy', true)).is_material, false, 'non-material privacy v2 published');
select is((public.publish_legal_document_version('privacy', 3, 'Privacy Policy', now() + interval '40 days', true,
  '[{"section":"Processors","kind":"added","summary":"New sub-processor."}]'::jsonb, null, '/privacy', true)).version, 3, 'material privacy v3 published with full notice');
select is((select count(*)::int from public.staff_legal_documents() as j, jsonb_array_elements(j) as e where e->>'doc_key' = 'terms'), 2, 'staff list shows both terms versions');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select is((select count(*)::int from public.audit_log where action = 'legal_document_published' and user_id = '00000000-0000-0000-0000-00000000e003'), 3, 'each publish is audit-logged');
select throws_ok($$update public.legal_document_versions set title = 'Hacked' where doc_key = 'terms' and version = 2$$, '42501', null, 'a published version is immutable');
select throws_ok($$delete from public.legal_document_versions where doc_key = 'terms' and version = 2$$, '42501', null, 'a published version cannot be deleted');

-- ---- as the fresh user (created 1 hour ago: deemed to have accepted terms v1, privacy v1; still inside the 24 h signup window)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000e001', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e001', 'role', 'authenticated')::text, true);
set local role authenticated;

select is(public.legal_acceptance_status()->>'decision', 'must_accept', 'a material, effective terms v2 gates the user');
select is(jsonb_array_length(public.legal_acceptance_status()->'required'), 1, 'only terms is required: privacy v2 is non-material and v3 is not effective yet');
select is(public.legal_acceptance_status()->'required'->0->>'doc_key', 'terms', 'the required document is terms');
select is(jsonb_array_length(public.legal_acceptance_status()->'required'->0->'versions'->0->'changes'), 2, 'the gate carries the diff summary (2 changes)');
select throws_ok($$select public.accept_legal_versions(array(select id from public.legal_document_versions where doc_key = 'privacy' and version = 3))$$,
  '23514', null, 'a not-yet-effective version cannot be accepted');
select throws_ok($$select public.accept_legal_versions(array[]::uuid[])$$, '22023', null, 'an empty acceptance is refused');
select is((public.accept_legal_versions(array(select id from public.legal_document_versions where doc_key = 'terms' and version = 2)))->>'accepted', '1', 'accepting terms v2 records one acceptance');
select is((public.accept_legal_versions(array(select id from public.legal_document_versions where doc_key = 'terms' and version = 2)))->>'accepted', '0', 'accepting twice is idempotent');
select is(public.legal_acceptance_status()->>'decision', 'ok', 'after accepting, the gate opens');
select is((select count(*)::int from public.legal_acceptances), 1, 'the user sees exactly their own acceptance (RLS)');
select throws_ok($$insert into public.legal_acceptances (user_id, version_id, doc_key, version, source) select '00000000-0000-0000-0000-00000000e001', id, doc_key, version, 'gate' from public.legal_document_versions limit 1$$,
  '42501', null, 'clients cannot write acceptances directly');
select throws_ok($$select published_by from public.legal_document_versions$$, '42501', null, 'staff identities are not readable by users (column grants)');
select ok((select count(*) from public.legal_document_versions) >= 5, 'users can read the published versions and their diff summaries');
select lives_ok($$select public.accept_current_legal_documents('signup')$$, 'a brand-new account can record the signup acceptance');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select is((select count(*)::int from public.audit_log where action = 'legal_terms_accepted' and user_id = '00000000-0000-0000-0000-00000000e001'), 2, 'acceptances are audit-logged (gate + signup)');
select throws_ok($$update public.legal_acceptances set accepted_at = now() - interval '1 year'$$, '42501', null, 'acceptances are append-only (update)');
select throws_ok($$delete from public.legal_acceptances$$, '42501', null, 'acceptances are append-only (delete)');

-- ---- an older account: signup shortcut is closed; it is gated until it accepts
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000e002', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e002', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$select public.accept_current_legal_documents('signup')$$, '42501', null, 'the signup shortcut cannot be used by an older account to skip the screen');
select is(public.legal_acceptance_status()->>'decision', 'must_accept', 'the older account is gated');
select throws_ok($$select public.staff_legal_documents()$$, '42501', null, 'non-staff cannot read the staff overview');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

set local role anon;
select throws_ok($$select count(*) from public.legal_acceptances$$, '42501', null, 'anon has no access to acceptances');
reset role;

select * from finish();
rollback;
