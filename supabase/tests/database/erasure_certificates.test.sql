-- Run (needs the Vireek schema applied, incl. 20290306000000_erasure_certificates.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/database/erasure_certificates.test.sql
-- One transaction, rolled back. Prints "PASS: ..." per check. NOT EXECUTED in authoring (no database available).
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
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', uid)::text, true);
  SET LOCAL ROLE authenticated;
END; $$;

-- fixtures -------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','ownerA@a.test'),
 ('bbbbbbbb-0000-0000-0000-000000000001','ownerB@b.test');
INSERT INTO public.deletion_requests (id, user_id, request_type, status, completed_at) VALUES
 ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','full_account','completed', now()),
 ('d0000000-0000-0000-0000-00000000000b','bbbbbbbb-0000-0000-0000-000000000001','full_account','completed', now());
INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES
 ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','VRK-ERC-AAAAAAAAAAAA','{"a":1}',repeat('a',64),repeat('b',64),'k1','completed'),
 ('d0000000-0000-0000-0000-00000000000b','bbbbbbbb-0000-0000-0000-000000000001','VRK-ERC-BBBBBBBBBBBB','{"b":1}',repeat('c',64),repeat('d',64),'k1','completed');
INSERT INTO public.erasure_job_evidence (deletion_request_id, account_id, evidence) VALUES
 ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','{"ownedTables":{}}');

-- 1. constraints ---------------------------------------------------------------
SELECT pg_temp.fails_with($$INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','VRK-ERC-CCCCCCCCCCCC','{}',repeat('a',64),repeat('b',64),'k1','completed')$$, '23505', 'one certificate per deletion request');
SELECT pg_temp.fails_with($$INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','VRK-ERC-FFFFFFFFFFFF','{}',repeat('a',64),repeat('b',64),'k1','completed')$$, '23503', 'FK to deletion_requests is enforced');
SELECT pg_temp.fails_with($$INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','bad','{}',repeat('a',64),repeat('b',64),'k1','completed')$$, '23514', 'certificate number format is enforced');
SELECT pg_temp.fails_with($$INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','VRK-ERC-DDDDDDDDDDDD','{}','xyz',repeat('b',64),'k1','completed')$$, '23514', 'sha256 format is enforced');

-- 2. append-only (even for the table owner / service role) ---------------------------
SELECT pg_temp.fails_with($$UPDATE public.erasure_certificates SET status = 'completed_with_exceptions'$$, '55000', 'UPDATE is rejected');
SELECT pg_temp.fails_with($$DELETE FROM public.erasure_certificates$$, '55000', 'DELETE is rejected');
SELECT pg_temp.fails_with($$TRUNCATE public.erasure_certificates$$, '55000', 'TRUNCATE is rejected');

-- 3. RLS: owner sees only their own certificate -------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.erasure_certificates) = 1, 'owner A sees exactly one certificate');
SELECT pg_temp.ok((SELECT count(*) FROM public.erasure_certificates WHERE account_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0, 'owner A cannot see owner B certificate');
SELECT pg_temp.fails_with($$INSERT INTO public.erasure_certificates (deletion_request_id, account_id, certificate_number, document_json, sha256, signature, key_id, status) VALUES (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','VRK-ERC-EEEEEEEEEEEE','{}',repeat('a',64),repeat('b',64),'k1','completed')$$, '42501', 'client cannot forge a certificate');
SELECT pg_temp.fails_with($$UPDATE public.erasure_certificates SET status = 'completed'$$, '42501', 'client cannot update');
SELECT pg_temp.fails_with($$DELETE FROM public.erasure_certificates$$, '42501', 'client cannot delete');
SELECT pg_temp.fails_with($$SELECT * FROM public.erasure_job_evidence$$, '42501', 'client cannot read job evidence');
RESET ROLE;

SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.erasure_certificates WHERE certificate_number = 'VRK-ERC-AAAAAAAAAAAA') = 0, 'owner B cannot see owner A certificate');
RESET ROLE;

-- 4. the certificate survives erase_user_rows() (owner column is account_id, not user_id) ----
SELECT public.erase_user_rows('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.erasure_certificates WHERE account_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1, 'certificate survives erase_user_rows');
SELECT pg_temp.ok((SELECT count(*) FROM public.erasure_job_evidence WHERE account_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1, 'evidence survives erase_user_rows');

ROLLBACK;
