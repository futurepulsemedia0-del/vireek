/*
  # Document Studio part 2 — generated documents, share links, per-document access log

  ## Model
    generated_documents     immutable snapshot of one render (text, hash, input values, pinned clause refs).
                            May later be linked ONCE to a vault document (PDF) and to a signature request.
    document_share_links    expiring, optionally password-protected, view-capped links to ONE pinned vault
                            version. Only the SHA-256 of the token is stored. No client access at all:
                            managed by edge functions (service role) and the SECURITY DEFINER RPCs below.
    document_access_log     append-only: who opened / shared / was denied, per document.

  ## Security
  - generated_documents.user_id is derived from the PUBLISHED template version; customer/job must belong to
    that account; body_sha256 is computed by the database; content columns are immutable.
  - Share-link secrets (token hash, password hash/salt) are never readable by clients; brute force is
    throttled in the database (5 failures → 15 min lock) and views are consumed atomically.
  - Access log: readable only by can_manage_documents(); no client INSERT/UPDATE/DELETE.
  - Additive only. Depends on 20270410000000 (documents), 20280501000000 (Template Studio),
    20261201000000 (signature_requests).
*/

-- =============================================================
-- GENERATED DOCUMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.generated_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL REFERENCES public.doc_content_template_versions(id),
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  locale text NOT NULL CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  rendered_text text NOT NULL CHECK (char_length(rendered_text) BETWEEN 1 AND 300000),
  body_sha256 text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input_snapshot) = 'object' AND octet_length(input_snapshot::text) <= 65536),
  clause_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(clause_refs) = 'array'),
  vault_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  signature_request_id uuid REFERENCES public.signature_requests(id) ON DELETE SET NULL,
  voided_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generated_documents_account ON public.generated_documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_documents_customer ON public.generated_documents (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_vault ON public.generated_documents (vault_document_id) WHERE vault_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.generated_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT v.user_id, v.status INTO v_owner, v_status
      FROM doc_content_template_versions v WHERE v.id = NEW.template_version_id;
    IF v_owner IS NULL OR v_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'template version must be published' USING ERRCODE = '55000';
    END IF;
    IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = v_owner) THEN
      RAISE EXCEPTION 'customer does not belong to this account' USING ERRCODE = '42501';
    END IF;
    IF NEW.job_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = v_owner) THEN
      RAISE EXCEPTION 'job does not belong to this account' USING ERRCODE = '42501';
    END IF;
    NEW.user_id := v_owner;
    NEW.title := btrim(NEW.title);
    NEW.body_sha256 := encode(sha256(convert_to(NEW.rendered_text, 'UTF8')), 'hex');
    NEW.vault_document_id := NULL;
    NEW.signature_request_id := NULL;
    NEW.voided_at := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: content is frozen. Links may be set once (NULL -> value) and cleared (FK ON DELETE SET NULL).
  IF (NEW.id, NEW.user_id, NEW.template_version_id, NEW.title, NEW.locale, NEW.currency, NEW.rendered_text,
      NEW.body_sha256, NEW.input_snapshot, NEW.clause_refs, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.template_version_id, OLD.title, OLD.locale, OLD.currency, OLD.rendered_text,
      OLD.body_sha256, OLD.input_snapshot, OLD.clause_refs, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'generated documents are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'generated documents are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'generated documents are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.vault_document_id IS NOT NULL AND NEW.vault_document_id IS DISTINCT FROM OLD.vault_document_id THEN
    IF OLD.vault_document_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM documents d WHERE d.id = NEW.vault_document_id AND d.user_id = OLD.user_id) THEN
      RAISE EXCEPTION 'invalid vault document link' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.signature_request_id IS NOT NULL AND NEW.signature_request_id IS DISTINCT FROM OLD.signature_request_id THEN
    IF OLD.signature_request_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM signature_requests s
          WHERE s.id = NEW.signature_request_id AND s.document_type = 'contract' AND s.document_id = OLD.id) THEN
      RAISE EXCEPTION 'invalid signature request link' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.voided_at IS DISTINCT FROM OLD.voided_at AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'generated documents are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_generated_documents_guard ON public.generated_documents;
CREATE TRIGGER trg_generated_documents_guard BEFORE INSERT OR UPDATE ON public.generated_documents
  FOR EACH ROW EXECUTE FUNCTION public.generated_documents_guard();

ALTER TABLE public.generated_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS generated_documents_select ON public.generated_documents;
CREATE POLICY generated_documents_select ON public.generated_documents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS generated_documents_insert ON public.generated_documents;
CREATE POLICY generated_documents_insert ON public.generated_documents FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND created_by = auth.uid());
DROP POLICY IF EXISTS generated_documents_update ON public.generated_documents;
CREATE POLICY generated_documents_update ON public.generated_documents FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());
REVOKE ALL ON public.generated_documents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.generated_documents TO authenticated;
REVOKE ALL ON FUNCTION public.generated_documents_guard() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- ACCESS LOG (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.document_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_id uuid,
  version_id uuid,
  share_link_id uuid,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'share_link', 'system')),
  action text NOT NULL
    CHECK (action IN ('view', 'download', 'generate', 'link_vault', 'share_create', 'share_revoke', 'share_view', 'share_denied')),
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'denied')),
  ip_hash text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 64),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_access_log_doc ON public.document_access_log (user_id, document_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.document_access_log_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the access log is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_document_access_log_no_update ON public.document_access_log;
CREATE TRIGGER trg_document_access_log_no_update BEFORE UPDATE ON public.document_access_log
  FOR EACH ROW EXECUTE FUNCTION public.document_access_log_block_update();

ALTER TABLE public.document_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_access_log_select ON public.document_access_log;
CREATE POLICY document_access_log_select ON public.document_access_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents());
REVOKE ALL ON public.document_access_log FROM anon, authenticated;
GRANT SELECT ON public.document_access_log TO authenticated;

-- Members record their own view/download of a vault version (the client cannot write the log directly).
CREATE OR REPLACE FUNCTION public.log_document_access(p_document_id uuid, p_version_id uuid, p_action text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR p_action NOT IN ('view', 'download') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM document_versions v
        WHERE v.id = p_version_id AND v.document_id = p_document_id AND v.user_id = v_owner) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO document_access_log (user_id, document_id, version_id, actor_id, actor_kind, action)
  VALUES (v_owner, p_document_id, p_version_id, auth.uid(), 'member', p_action);
END;
$$;
REVOKE ALL ON FUNCTION public.log_document_access(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_document_access(uuid, uuid, text) TO authenticated;

-- =============================================================
-- SHARE LINKS (no client access; edge functions use the service role)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.document_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  password_hash text CHECK (password_hash IS NULL OR password_hash ~ '^[0-9a-f]{64}$'),
  password_salt text CHECK (password_salt IS NULL OR password_salt ~ '^[0-9a-f]{32}$'),
  expires_at timestamptz NOT NULL,
  max_views integer CHECK (max_views IS NULL OR max_views BETWEEN 1 AND 10000),
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((password_hash IS NULL) = (password_salt IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);
CREATE INDEX IF NOT EXISTS idx_document_share_links_doc ON public.document_share_links (user_id, document_id, created_at DESC);

ALTER TABLE public.document_share_links ENABLE ROW LEVEL SECURITY;  -- no policies: deny all to clients
REVOKE ALL ON public.document_share_links FROM anon, authenticated;

-- Safe listing for managers (no hashes).
CREATE OR REPLACE FUNCTION public.list_document_share_links(p_document_id uuid)
RETURNS TABLE (id uuid, version_id uuid, expires_at timestamptz, max_views integer, view_count integer,
               has_password boolean, revoked_at timestamptz, created_at timestamptz, created_by uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.id, l.version_id, l.expires_at, l.max_views, l.view_count,
           (l.password_hash IS NOT NULL), l.revoked_at, l.created_at, l.created_by
      FROM document_share_links l
     WHERE l.document_id = p_document_id AND l.user_id = v_owner
     ORDER BY l.created_at DESC
     LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_document_share_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_doc uuid;
  v_ver uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE document_share_links
     SET revoked_at = now()
   WHERE id = p_link_id AND user_id = v_owner AND revoked_at IS NULL
   RETURNING document_id, version_id INTO v_doc, v_ver;
  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'link not found or already revoked' USING ERRCODE = '55000';
  END IF;
  INSERT INTO document_access_log (user_id, document_id, version_id, share_link_id, actor_id, actor_kind, action)
  VALUES (v_owner, v_doc, v_ver, p_link_id, auth.uid(), 'member', 'share_revoke');
END;
$$;

-- Failure throttle + atomic view consumption: service role only (called by the doc-share edge function).
CREATE OR REPLACE FUNCTION public.doc_share_fail(p_link_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE document_share_links
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
   WHERE id = p_link_id;
$$;

CREATE OR REPLACE FUNCTION public.doc_share_consume(p_link_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE document_share_links
     SET view_count = view_count + 1, failed_attempts = 0
   WHERE id = p_link_id
     AND revoked_at IS NULL
     AND expires_at > now()
     AND (max_views IS NULL OR view_count < max_views)
     AND (locked_until IS NULL OR locked_until <= now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.list_document_share_links(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_document_share_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_document_share_links(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_document_share_link(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.doc_share_fail(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_share_consume(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.doc_share_fail(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.doc_share_consume(uuid) TO service_role;

/*
  ROLLBACK (generated documents may be legal records — export first):
    DROP TABLE IF EXISTS public.document_share_links, public.document_access_log, public.generated_documents CASCADE;
    DROP FUNCTION IF EXISTS public.log_document_access(uuid, uuid, text), public.list_document_share_links(uuid),
      public.revoke_document_share_link(uuid), public.doc_share_fail(uuid), public.doc_share_consume(uuid),
      public.generated_documents_guard(), public.document_access_log_block_update();
*/
