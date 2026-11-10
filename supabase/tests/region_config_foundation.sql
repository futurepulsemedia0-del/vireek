-- supabase/tests/region_config_foundation.sql
-- Plain-SQL assertions. Run on a scratch/staging DB AFTER 20290301000000_region_config_foundation.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/region_config_foundation.sql
-- Runs as the table owner in ONE transaction and rolls back. Prints NOTICE 'PASS: ...' per check.
-- (RPC behaviour that depends on auth.uid() must be verified manually; see the checklist in the report.)

BEGIN;

DO $$
DECLARE u uuid := gen_random_uuid(); v_ok boolean; v_id uuid;
BEGIN
  -- entitlements default OFF
  INSERT INTO account_module_entitlements (user_id, module_key) VALUES (u, 'regional_config');
  SELECT enabled INTO v_ok FROM account_module_entitlements WHERE user_id = u AND module_key = 'regional_config';
  IF v_ok IS NOT FALSE THEN RAISE EXCEPTION 'FAIL: entitlement must default to OFF'; END IF;
  RAISE NOTICE 'PASS: entitlement defaults to OFF';

  -- invalid module key rejected
  BEGIN
    INSERT INTO account_module_entitlements (user_id, module_key) VALUES (u, 'Bad Key');
    RAISE EXCEPTION 'FAIL: bad module key accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: bad module key rejected'; END;

  -- duplicate (tenant, module) rejected
  BEGIN
    INSERT INTO account_module_entitlements (user_id, module_key) VALUES (u, 'regional_config');
    RAISE EXCEPTION 'FAIL: duplicate entitlement accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: duplicate entitlement rejected'; END;

  -- a published legal doc must name a reviewer + date
  BEGIN
    INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title, body)
    VALUES (u, 'privacy_notice', 'DE', 'de-DE', 1, 'published', 'T', 'text');
    RAISE EXCEPTION 'FAIL: published without counsel review accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: published requires counsel reviewer + date'; END;

  -- requires_counsel cannot be switched off
  BEGIN
    INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title, requires_counsel)
    VALUES (u, 'privacy_notice', 'DE', 'de-DE', 1, 'draft', 'T', false);
    RAISE EXCEPTION 'FAIL: requires_counsel=false accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: requires_counsel cannot be false'; END;

  -- unknown slot / bad country rejected
  BEGIN
    INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title)
    VALUES (u, 'made_up', 'DE', 'de-DE', 1, 'draft', 'T');
    RAISE EXCEPTION 'FAIL: unknown slot accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: unknown slot rejected'; END;
  BEGIN
    INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title)
    VALUES (u, 'privacy_notice', 'DEU', 'de-DE', 1, 'draft', 'T');
    RAISE EXCEPTION 'FAIL: 3-letter country accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: bad country rejected'; END;

  -- a valid approved version is accepted, and is then immutable
  INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title, body, counsel_reviewer, counsel_reviewed_on)
  VALUES (u, 'privacy_notice', 'DE', 'de-DE', 1, 'published', 'Datenschutz', 'text', 'Kanzlei X', DATE '2026-01-01')
  RETURNING id INTO v_id;
  RAISE NOTICE 'PASS: valid reviewed version accepted';
  BEGIN
    UPDATE regional_legal_documents SET body = 'edited' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: update allowed on append-only table';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: UPDATE blocked (append-only)'; END;
  BEGIN
    DELETE FROM regional_legal_documents WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: delete allowed on append-only table';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: DELETE blocked (append-only)'; END;

  -- version uniqueness
  BEGIN
    INSERT INTO regional_legal_documents (user_id, slot_key, country, locale, version, status, title)
    VALUES (u, 'privacy_notice', 'DE', 'de-DE', 1, 'draft', 'dup');
    RAISE EXCEPTION 'FAIL: duplicate version accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: duplicate version rejected'; END;
END $$;

-- RLS on, and no write policies / grants for tenants
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.account_module_entitlements'::regclass, 'public.regional_legal_documents'::regclass) AND relrowsecurity) <> 2 THEN
    RAISE EXCEPTION 'FAIL: RLS not enabled on both tables';
  END IF;
  RAISE NOTICE 'PASS: RLS enabled on both tables';
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('account_module_entitlements', 'regional_legal_documents') AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: unexpected write policy present';
  END IF;
  RAISE NOTICE 'PASS: only SELECT policies exist';
  IF has_table_privilege('authenticated', 'public.account_module_entitlements', 'INSERT')
     OR has_table_privilege('authenticated', 'public.regional_legal_documents', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: authenticated can INSERT directly';
  END IF;
  RAISE NOTICE 'PASS: no direct INSERT for authenticated';
  IF has_function_privilege('anon', 'public.get_my_module_entitlements()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.staff_set_module_entitlement(uuid,text,boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.add_regional_legal_document_version(text,text,text,text,text,text,text,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can EXECUTE a new RPC';
  END IF;
  RAISE NOTICE 'PASS: anon cannot EXECUTE the new RPCs';
END $$;

ROLLBACK;
