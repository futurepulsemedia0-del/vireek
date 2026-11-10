-- Region configuration foundation: module entitlements + regional legal-document slots
--
-- ADDITIVE and IDEMPOTENT. Safe on a fresh DB and on the current schema. No existing table,
-- column, policy or function is changed. Default state for every account: nothing entitled.
--
-- Depends on (all already in the repo): public.get_account_owner_id(), public.is_vireek_staff(uuid),
--   public.log_audit_event(uuid,text,text,text,jsonb), public.can_manage_regional_packs()
--   (20271021000000_regional_packs.sql).
--
-- New objects
--   account_module_entitlements   per-account module switch (default OFF). Staff-written only.
--   get_my_module_entitlements()  module keys that are ON for the caller's account.
--   staff_set_module_entitlement  staff-only, audited.
--   regional_legal_documents      APPEND-ONLY versions of owner-supplied legal text per slot/country/locale.
--   add_regional_legal_document_version  owner-side RPC: validates, versions, audits.
--
-- REQUIRES COUNSEL: Vireek stores text the account owner supplies. It generates no legal text and
-- asserts no compliance. 'counsel_approved'/'published' rows must name the reviewer and review date.
--
-- ROLLBACK (drops the data these tables hold; nothing else depends on them):
--   DROP FUNCTION IF EXISTS public.add_regional_legal_document_version(text,text,text,text,text,text,text,date);
--   DROP TABLE    IF EXISTS public.regional_legal_documents;
--   DROP FUNCTION IF EXISTS public.rld_block_mutation();
--   DROP FUNCTION IF EXISTS public.staff_set_module_entitlement(uuid,text,boolean,text);
--   DROP FUNCTION IF EXISTS public.get_my_module_entitlements();
--   DROP TABLE    IF EXISTS public.account_module_entitlements;

-- =============================================================
-- MODULE ENTITLEMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.account_module_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- ACCOUNT OWNER id (same convention as regional_pack_enablements)
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  enabled boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 500),
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_key)
);
ALTER TABLE public.account_module_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ame_select ON public.account_module_entitlements;
CREATE POLICY ame_select ON public.account_module_entitlements FOR SELECT
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy on purpose: only staff_set_module_entitlement() writes.
REVOKE INSERT, UPDATE, DELETE ON public.account_module_entitlements FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_module_entitlements()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(module_key ORDER BY module_key), ARRAY[]::text[])
  FROM public.account_module_entitlements
  WHERE user_id = public.get_account_owner_id() AND enabled;
$$;
REVOKE ALL ON FUNCTION public.get_my_module_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_module_entitlements() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_module_entitlement(
  p_tenant uuid, p_module text, p_enabled boolean, p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access is required for this action.' USING ERRCODE = '42501';
  END IF;
  IF p_module IS NULL OR p_module !~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Invalid module key.' USING ERRCODE = '22023';
  END IF;
  IF p_tenant IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'Unknown tenant.' USING ERRCODE = 'P0002';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN
    RAISE EXCEPTION 'Note is too long (max 500 characters).' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_module_entitlements (user_id, module_key, enabled, note, granted_by)
  VALUES (p_tenant, p_module, COALESCE(p_enabled, false), p_note, auth.uid())
  ON CONFLICT (user_id, module_key)
  DO UPDATE SET enabled = EXCLUDED.enabled, note = EXCLUDED.note, granted_by = auth.uid(), updated_at = now();

  PERFORM public.log_audit_event(
    p_tenant,
    CASE WHEN COALESCE(p_enabled, false) THEN 'module_entitlement.enabled' ELSE 'module_entitlement.disabled' END,
    'account_module_entitlements', p_module,
    jsonb_build_object('note', p_note));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) TO authenticated;

-- =============================================================
-- REGIONAL LEGAL DOCUMENT SLOTS (append-only versions)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.regional_legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  slot_key text NOT NULL CHECK (slot_key IN (
    'terms_of_service', 'privacy_notice', 'cookie_notice', 'data_processing_agreement',
    'consumer_cancellation_notice', 'marketing_consent_text', 'warranty_terms')),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  locale text NOT NULL CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'counsel_approved', 'published', 'retired')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
  counsel_reviewer text CHECK (counsel_reviewer IS NULL OR length(counsel_reviewer) <= 200),
  counsel_reviewed_on date,
  requires_counsel boolean NOT NULL DEFAULT true CHECK (requires_counsel),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slot_key, country, locale, version),
  CONSTRAINT rld_counsel_review_required CHECK (
    status NOT IN ('counsel_approved', 'published')
    OR (btrim(body) <> '' AND btrim(COALESCE(counsel_reviewer, '')) <> '' AND counsel_reviewed_on IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_rld_lookup ON public.regional_legal_documents (user_id, slot_key, country, locale, version DESC);
ALTER TABLE public.regional_legal_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rld_select ON public.regional_legal_documents;
CREATE POLICY rld_select ON public.regional_legal_documents FOR SELECT
  USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE ON public.regional_legal_documents FROM anon, authenticated;

-- Versions are immutable evidence: nobody (including the table owner via SQL) edits or deletes a row.
CREATE OR REPLACE FUNCTION public.rld_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'regional_legal_documents is append-only; add a new version instead.' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_rld_append_only ON public.regional_legal_documents;
CREATE TRIGGER trg_rld_append_only BEFORE UPDATE OR DELETE ON public.regional_legal_documents
  FOR EACH ROW EXECUTE FUNCTION public.rld_block_mutation();

CREATE OR REPLACE FUNCTION public.add_regional_legal_document_version(
  p_slot text, p_country text, p_locale text, p_status text, p_title text, p_body text,
  p_reviewer text DEFAULT NULL, p_reviewed_on date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_country text := upper(btrim(COALESCE(p_country, '')));
  v_version integer;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_regional_packs() THEN
    RAISE EXCEPTION 'You do not have permission to manage legal documents.' USING ERRCODE = '42501';
  END IF;
  -- Server-side module gate: anything other than the default region needs the entitlement.
  IF v_country <> 'US' AND NOT EXISTS (
    SELECT 1 FROM public.account_module_entitlements
    WHERE user_id = v_owner AND module_key = 'regional_config' AND enabled
  ) THEN
    RAISE EXCEPTION 'Regional configuration is not enabled for this account.' USING ERRCODE = '42501';
  END IF;
  IF p_reviewed_on IS NOT NULL AND p_reviewed_on > current_date THEN
    RAISE EXCEPTION 'The counsel review date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  -- Serialise concurrent versioning of the same slot; the UNIQUE constraint is the backstop.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || '|' || COALESCE(p_slot, '') || '|' || v_country || '|' || COALESCE(p_locale, ''), 0));
  SELECT COALESCE(max(version), 0) + 1 INTO v_version
  FROM public.regional_legal_documents
  WHERE user_id = v_owner AND slot_key = p_slot AND country = v_country AND locale = p_locale;

  -- Column CHECK constraints validate slot, country, locale, status, title, size and the counsel-review rule.
  INSERT INTO public.regional_legal_documents
    (user_id, slot_key, country, locale, version, status, title, body, counsel_reviewer, counsel_reviewed_on)
  VALUES
    (v_owner, p_slot, v_country, p_locale, v_version, p_status, p_title, COALESCE(p_body, ''), NULLIF(btrim(p_reviewer), ''), p_reviewed_on)
  RETURNING id INTO v_id;

  -- Audit metadata deliberately excludes the document body (minimise stored text in logs).
  PERFORM public.log_audit_event(v_owner, 'regional_legal_document.version_added', 'regional_legal_documents', v_id::text,
    jsonb_build_object('slot', p_slot, 'country', v_country, 'locale', p_locale, 'version', v_version, 'status', p_status));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.add_regional_legal_document_version(text, text, text, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_regional_legal_document_version(text, text, text, text, text, text, text, date) TO authenticated;
