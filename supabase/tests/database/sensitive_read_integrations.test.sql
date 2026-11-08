-- Run after 20281103000000 and 20281103000100 are applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/database/sensitive_read_integrations.test.sql
-- One transaction, rolled back.
BEGIN;
CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'PASS: %', label; END; $$;
CREATE FUNCTION pg_temp.fails_with(stmt text, code text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = code THEN RAISE NOTICE 'PASS: %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % (got % / %)', label, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % (no error raised)', label;
END; $$;
CREATE FUNCTION pg_temp.as_user(uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', uid)::text, true); SET LOCAL ROLE authenticated; END; $$;

INSERT INTO auth.users (id, email) VALUES ('a1a1a1a1-0000-0000-0000-000000000001','o1@t.test'),('b2b2b2b2-0000-0000-0000-000000000001','o2@t.test'),('a1a1a1a1-0000-0000-0000-000000000002','tech@t.test');
INSERT INTO profiles (id,email) VALUES ('a1a1a1a1-0000-0000-0000-000000000001','o1@t.test'),('b2b2b2b2-0000-0000-0000-000000000001','o2@t.test') ON CONFLICT (id) DO NOTHING;
DELETE FROM profiles WHERE id NOT IN ('a1a1a1a1-0000-0000-0000-000000000001','b2b2b2b2-0000-0000-0000-000000000001');
INSERT INTO team_members (account_owner_id, member_email, permissions) VALUES ('a1a1a1a1-0000-0000-0000-000000000001','tech@t.test','{}');
INSERT INTO calls (id,user_id,recording_url,transcript) VALUES
 ('c1c1c1c1-0000-0000-0000-000000000001','a1a1a1a1-0000-0000-0000-000000000001','https://rec/1.mp3','T1'),
 ('c1c1c1c1-0000-0000-0000-000000000002','a1a1a1a1-0000-0000-0000-000000000001',NULL,'T2'),
 ('c1c1c1c1-0000-0000-0000-000000000003','a1a1a1a1-0000-0000-0000-000000000001','http://insecure/3.mp3','T3');

-- calls_safe -----------------------------------------------------------------------------
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='calls_safe' AND column_name IN ('recording_url','transcript')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='calls_safe' AND column_name='user_id'), 'calls_safe hides recording_url + transcript, keeps the rest');
SELECT pg_temp.as_user('a1a1a1a1-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.calls_safe) = 3, 'owner reads own rows through calls_safe');
RESET ROLE;

-- recording flags ---------------------------------------------------------------------------
SELECT pg_temp.as_user('a1a1a1a1-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.calls_recording_flags(ARRAY['c1c1c1c1-0000-0000-0000-000000000001','c1c1c1c1-0000-0000-0000-000000000002','c1c1c1c1-0000-0000-0000-000000000003']::uuid[]) WHERE has_recording) = 1, 'only https recordings flagged; no URL returned');
RESET ROLE;
SELECT pg_temp.as_user('b2b2b2b2-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.calls_recording_flags(ARRAY['c1c1c1c1-0000-0000-0000-000000000001']::uuid[])) = 0, 'other tenant gets no flags');
RESET ROLE;
SELECT pg_temp.as_user('a1a1a1a1-0000-0000-0000-000000000002');
SELECT pg_temp.fails_with($$SELECT * FROM public.calls_recording_flags(ARRAY['c1c1c1c1-0000-0000-0000-000000000001']::uuid[])$$, '42501', 'member without view permission denied');
RESET ROLE;

-- search_calls_text ------------------------------------------------------------------------------
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_name text; ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_phone text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS summary text; ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_datetime timestamptz DEFAULT now();
UPDATE calls SET caller_name = 'Dana', summary = 'boiler repair' WHERE id = 'c1c1c1c1-0000-0000-0000-000000000001';
SELECT pg_temp.as_user('a1a1a1a1-0000-0000-0000-000000000001');
SELECT pg_temp.ok(public.search_calls_text(ARRAY['dana','T1']) = ARRAY['c1c1c1c1-0000-0000-0000-000000000001']::uuid[], 'search matches across name + transcript (all tokens)');
SELECT pg_temp.ok(public.search_calls_text(ARRAY['dana','nomatch']) = ARRAY[]::uuid[], 'a missing token yields no rows');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM sensitive_read_log WHERE action='list' AND asset_class='transcript' AND record_count=1) = 1, 'matches logged as one aggregated row, empty search not logged');
SELECT pg_temp.as_user('b2b2b2b2-0000-0000-0000-000000000001');
SELECT pg_temp.ok(public.search_calls_text(ARRAY['dana']) = ARRAY[]::uuid[], 'other tenant cannot search tenant A calls');
RESET ROLE;
SELECT pg_temp.as_user('a1a1a1a1-0000-0000-0000-000000000002');
SELECT pg_temp.fails_with($$SELECT public.search_calls_text(ARRAY['dana'])$$, '42501', 'member without permission cannot search');
RESET ROLE;

-- homeowner document path (needs the homeowner tables) -----------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.homeowner_business_links') IS NULL OR to_regprocedure('public.homeowner_live_link(uuid)') IS NULL THEN
    RAISE NOTICE 'SKIP: homeowner tables not present in this database';
  ELSE
    RAISE NOTICE 'INFO: verify manually that homeowner_get_document_path now includes business_user_id';
  END IF;
END $$;
ROLLBACK;
