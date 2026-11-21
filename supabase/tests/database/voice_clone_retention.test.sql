-- Voice clone retention + consent versions (pgTAP): immutable texts, expiry stamping, shrink-only retention,
-- lease-based claim, purge-log tenant isolation, server-only writes.
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- 1-4 consent texts: seeded, hashed, immutable
select is((select count(*)::int from public.voice_clone_consent_texts where version in ('v1', 'v2')), 2, 'v1 and v2 consent texts are seeded');
select is((select text_sha256 from public.voice_clone_consent_texts where version = 'v2'),
          encode(sha256(convert_to((select body from public.voice_clone_consent_texts where version = 'v2'), 'UTF8')), 'hex'),
          'stored hash is the SHA-256 of the stored body');
select throws_ok($$ update public.voice_clone_consent_texts set body = body || ' tampered' where version = 'v2' $$, '42501', null, 'a published consent text cannot be edited');
select throws_ok($$ delete from public.voice_clone_consent_texts where version = 'v1' $$, '42501', null, 'a published consent text cannot be deleted');

-- 5 pending consent with a chosen retention
select lives_ok($$ insert into public.voice_clone_consents (id, user_id, signed_by, voice_owner_name, relationship, consent_version, consent_sha256, attested, liveness_phrase, retention_days)
  values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'Ann Owner', 'self', 'v2', repeat('a', 64), true, 'amber river cedar delta', 90) $$,
  'a consent can be created with a retention period');

-- 6 approval stamps the expiry
update public.voice_clone_consents set status = 'approved', provider_voice_id = 'voice_abcdef123', sample_path = '00000000-0000-0000-0000-0000000000a1/sample-1.mp3'
 where id = '00000000-0000-0000-0000-0000000000f1';
select is((select expires_at - approved_at from public.voice_clone_consents where id = '00000000-0000-0000-0000-0000000000f1'), interval '90 days', 'approval sets expires_at = approved_at + retention_days');

-- 7-9 retention can only shrink
select throws_ok($$ update public.voice_clone_consents set retention_days = 365 where id = '00000000-0000-0000-0000-0000000000f1' $$, '23514', null, 'retention cannot be lengthened on an approved voice');
select lives_ok($$ update public.voice_clone_consents set retention_days = 30 where id = '00000000-0000-0000-0000-0000000000f1' $$, 'retention can be shortened');
select is((select expires_at - approved_at from public.voice_clone_consents where id = '00000000-0000-0000-0000-0000000000f1'), interval '30 days', 'shortening moves the expiry earlier');

-- 10 unknown consent version is refused
select throws_ok($$ insert into public.voice_clone_consents (user_id, signed_by, voice_owner_name, relationship, consent_version, consent_sha256, attested, liveness_phrase)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'Bob Other', 'self', 'v99', repeat('b', 64), true, 'amber river cedar delta') $$,
  '23503', null, 'a consent must reference a published text version');

-- 11-13 claim: due rows only, once per lease
update public.voice_clone_consents set expires_at = now() - interval '1 day' where id = '00000000-0000-0000-0000-0000000000f1';
select is((select count(*)::int from public.voice_clone_claim_due(10, 600)), 1, 'an expired approved voice is claimed for purging');
select is((select count(*)::int from public.voice_clone_claim_due(10, 600)), 0, 'a claimed row is not handed out again within its lease');
select is((select purge_attempts from public.voice_clone_consents where id = '00000000-0000-0000-0000-0000000000f1'), 1, 'claiming counts one attempt');

-- 14 status expired is a valid state
select lives_ok($$ update public.voice_clone_consents set status = 'expired' where id = '00000000-0000-0000-0000-0000000000f1' $$, 'a consent can become expired');

insert into public.voice_clone_purge_log (consent_id, user_id, reason, outcome, provider_delete, provider_verified)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'retention_expired', 'purged', 'deleted', true),
       ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', 'revoked', 'purged', 'deleted', true);

-- 15-17 as a signed-in owner
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select * from public.voice_clone_claim_due(10, 600) $$, '42501', null, 'clients cannot claim purge work');
select is((select count(*)::int from public.voice_clone_purge_log), 1, 'an owner sees only their own purge evidence');
select throws_ok($$ insert into public.voice_clone_purge_log (consent_id, user_id, reason, outcome) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'revoked', 'purged') $$,
  '42501', null, 'clients cannot write purge evidence');

select * from finish();
rollback;
