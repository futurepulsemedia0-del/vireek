/*
  # Document Template Studio — clause library + merge-field content templates (Phase 1, part 1)

  ## Scope
  Content templates for contracts and notices ({{merge fields}}, conditional sections, locked clauses),
  separate from the visual PDF designer in `document_templates` (20280101000000), which keeps controlling
  how the rendered text looks. Templates are DRAFTS FOR COUNSEL REVIEW — nothing here is legal advice.

  ## Model (all scoped by user_id = get_account_owner_id())
    doc_clauses / doc_clause_versions                 clause library, jurisdiction tags, immutable versions
    doc_content_templates / doc_content_template_versions   templates pin clause versions {slug, version, sha256}

  ## Security
  - Version content (body, clause_refs, test_data) is editable ONLY while status = 'draft'; every other
    state is frozen by trigger (published bodies can never change; a change = a new version).
  - sha256 is computed by the database (clients cannot supply it).
  - Publishing requires a server-side syntax/field validation attestation (validated_sha256), written only
    by the service role (edge function, next part), then a review step. Self-approval by the author is
    allowed only with a written note and is flagged (self_approved) — solo owners must not deadlock.
  - Template publish verifies every pinned clause is published and its hash matches the DB.
  - No DELETE policy / privilege anywhere: retire or archive instead.
  - Additive only. Depends on: get_account_owner_id(), can_manage_documents() (20270410000000),
    log_audit_event(), profiles.
*/

-- =============================================================
-- CLAUSES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.doc_clauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'payment', 'liability', 'warranty', 'termination', 'privacy', 'dispute', 'notice')),
  -- ISO 3166-1 alpha-2 or alpha-2 + subdivision, e.g. {US,US-TX,DE}
  jurisdictions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(jurisdictions) <= 20),
  locale text NOT NULL DEFAULT 'en' CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  archived_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS public.doc_clause_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clause_id uuid NOT NULL REFERENCES public.doc_clauses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version_number integer NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'retired')),
  validated_sha256 text,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  self_approved boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE (clause_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_doc_clause_versions_clause ON public.doc_clause_versions (clause_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_doc_clause_versions_pending ON public.doc_clause_versions (user_id) WHERE status = 'pending_review';

-- =============================================================
-- CONTENT TEMPLATES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.doc_content_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  doc_type text NOT NULL CHECK (doc_type IN ('contract', 'notice')),
  jurisdictions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(jurisdictions) <= 20),
  locale text NOT NULL DEFAULT 'en' CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  archived_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_content_templates_name
  ON public.doc_content_templates (user_id, doc_type, lower(btrim(name))) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.doc_content_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.doc_content_templates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version_number integer NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100000),
  -- [{ "slug": "...", "version": 3, "sha256": "..." }] — pinned, verified at publish
  clause_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(clause_refs) = 'array' AND jsonb_array_length(clause_refs) <= 50),
  -- sample values for the preview; never real customer data
  test_data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(test_data) = 'object' AND octet_length(test_data::text) <= 16384),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'retired')),
  validated_sha256 text,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  self_approved boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE (template_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_doc_tpl_versions_tpl ON public.doc_content_template_versions (template_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_doc_tpl_versions_pending ON public.doc_content_template_versions (user_id) WHERE status = 'pending_review';

-- =============================================================
-- GUARD TRIGGERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.doc_studio_guard_parent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.jurisdictions := COALESCE(NEW.jurisdictions, '{}');
  IF EXISTS (SELECT 1 FROM unnest(NEW.jurisdictions) j WHERE j !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$') THEN
    RAISE EXCEPTION 'invalid jurisdiction tag' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    IF TG_TABLE_NAME = 'doc_clauses' THEN
      NEW.slug := OLD.slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_doc_clauses_guard ON public.doc_clauses;
CREATE TRIGGER trg_doc_clauses_guard BEFORE INSERT OR UPDATE ON public.doc_clauses
  FOR EACH ROW EXECUTE FUNCTION public.doc_studio_guard_parent();
DROP TRIGGER IF EXISTS trg_doc_templates_guard ON public.doc_content_templates;
CREATE TRIGGER trg_doc_templates_guard BEFORE INSERT OR UPDATE ON public.doc_content_templates
  FOR EACH ROW EXECUTE FUNCTION public.doc_studio_guard_parent();

-- One guard for both version tables. TG_ARGV[0] = parent table, TG_ARGV[1] = parent FK column.
CREATE OR REPLACE FUNCTION public.doc_studio_guard_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rpc boolean := COALESCE(current_setting('vireek.doc_rpc', true), '') = 'on';
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_parent uuid;
  v_old_parent uuid;
  v_owner uuid;
  v_next integer;
  v_content_changed boolean;
BEGIN
  IF TG_TABLE_NAME = 'doc_clause_versions' THEN
    v_parent := NEW.clause_id;
    IF TG_OP = 'UPDATE' THEN v_old_parent := OLD.clause_id; END IF;
  ELSE
    v_parent := NEW.template_id;
    IF TG_OP = 'UPDATE' THEN v_old_parent := OLD.template_id; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'doc_clause_versions' THEN
      SELECT c.user_id INTO v_owner FROM doc_clauses c WHERE c.id = v_parent FOR UPDATE;
      SELECT COALESCE(max(v.version_number), 0) + 1 INTO v_next FROM doc_clause_versions v WHERE v.clause_id = v_parent;
    ELSE
      SELECT t.user_id INTO v_owner FROM doc_content_templates t WHERE t.id = v_parent FOR UPDATE;
      SELECT COALESCE(max(v.version_number), 0) + 1 INTO v_next FROM doc_content_template_versions v WHERE v.template_id = v_parent;
    END IF;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'parent not found' USING ERRCODE = '42501';
    END IF;
    NEW.user_id := v_owner;
    NEW.version_number := v_next;
    NEW.status := 'draft';
    NEW.validated_sha256 := NULL;
    NEW.review_note := NULL;
    NEW.self_approved := false;
    NEW.reviewed_by := NULL;
    NEW.submitted_at := NULL;
    NEW.reviewed_at := NULL;
    NEW.published_at := NULL;
    NEW.retired_at := NULL;
    NEW.created_at := now();
    NEW.sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
    RETURN NEW;
  END IF;

  -- UPDATE ---------------------------------------------------------------
  IF NEW.id <> OLD.id OR v_parent <> v_old_parent
     OR NEW.user_id <> OLD.user_id OR NEW.version_number <> OLD.version_number
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable columns cannot change' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'doc_clause_versions' THEN
    v_content_changed := NEW.body IS DISTINCT FROM OLD.body;
  ELSE
    v_content_changed := (NEW.body, NEW.clause_refs, NEW.test_data) IS DISTINCT FROM (OLD.body, OLD.clause_refs, OLD.test_data);
  END IF;

  IF v_content_changed THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only drafts can be edited; create a new version' USING ERRCODE = '55000';
    END IF;
    NEW.validated_sha256 := NULL;
  END IF;
  NEW.sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');

  IF NEW.validated_sha256 IS DISTINCT FROM OLD.validated_sha256
     AND NOT v_content_changed AND NOT (v_service OR v_rpc) THEN
    RAISE EXCEPTION 'validation can only be attested by the server' USING ERRCODE = '42501';
  END IF;

  IF NOT v_rpc THEN
    IF (NEW.status, NEW.review_note, NEW.self_approved, NEW.reviewed_by, NEW.submitted_at, NEW.reviewed_at, NEW.published_at, NEW.retired_at)
       IS DISTINCT FROM
       (OLD.status, OLD.review_note, OLD.self_approved, OLD.reviewed_by, OLD.submitted_at, OLD.reviewed_at, OLD.published_at, OLD.retired_at) THEN
      RAISE EXCEPTION 'status changes go through the doc_studio_* functions' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_doc_clause_versions_guard ON public.doc_clause_versions;
CREATE TRIGGER trg_doc_clause_versions_guard BEFORE INSERT OR UPDATE ON public.doc_clause_versions
  FOR EACH ROW EXECUTE FUNCTION public.doc_studio_guard_version();
DROP TRIGGER IF EXISTS trg_doc_tpl_versions_guard ON public.doc_content_template_versions;
CREATE TRIGGER trg_doc_tpl_versions_guard BEFORE INSERT OR UPDATE ON public.doc_content_template_versions
  FOR EACH ROW EXECUTE FUNCTION public.doc_studio_guard_version();

-- =============================================================
-- RLS (read: whole account; write: can_manage_documents(); versions: drafts only)
-- =============================================================
ALTER TABLE public.doc_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_clause_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_content_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_content_template_versions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc_clauses', 'doc_clause_versions', 'doc_content_templates', 'doc_content_template_versions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND created_by = auth.uid())',
      t || '_insert', t);
  END LOOP;
END $$;

-- Parents: archive via UPDATE. user_id is re-derived/pinned by trigger; RLS pins it again.
DROP POLICY IF EXISTS doc_clauses_update ON public.doc_clauses;
CREATE POLICY doc_clauses_update ON public.doc_clauses FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());
DROP POLICY IF EXISTS doc_content_templates_update ON public.doc_content_templates;
CREATE POLICY doc_content_templates_update ON public.doc_content_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());

-- Versions: only drafts are updatable by clients (status transitions use the RPCs below).
DROP POLICY IF EXISTS doc_clause_versions_update ON public.doc_clause_versions;
CREATE POLICY doc_clause_versions_update ON public.doc_clause_versions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND status = 'draft')
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND status = 'draft');
DROP POLICY IF EXISTS doc_content_template_versions_update ON public.doc_content_template_versions;
CREATE POLICY doc_content_template_versions_update ON public.doc_content_template_versions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND status = 'draft')
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents() AND status = 'draft');

REVOKE ALL ON public.doc_clauses, public.doc_clause_versions,
              public.doc_content_templates, public.doc_content_template_versions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.doc_clauses, public.doc_clause_versions,
              public.doc_content_templates, public.doc_content_template_versions TO authenticated;

-- =============================================================
-- WORKFLOW RPCs: submit → review (approve = publish | reject) → retire
-- p_kind: 'clause' | 'template'
-- =============================================================
CREATE OR REPLACE FUNCTION public.doc_studio_submit(p_kind text, p_version_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('vireek.doc_rpc', 'on', true);

  IF p_kind = 'clause' THEN
    UPDATE doc_clause_versions
       SET status = 'pending_review', submitted_at = now()
     WHERE id = p_version_id AND user_id = v_owner AND status = 'draft' AND validated_sha256 = sha256;
  ELSIF p_kind = 'template' THEN
    UPDATE doc_content_template_versions
       SET status = 'pending_review', submitted_at = now()
     WHERE id = p_version_id AND user_id = v_owner AND status = 'draft' AND validated_sha256 = sha256;
  ELSE
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'version is not a validated draft' USING ERRCODE = '55000';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'doc_' || p_kind || '_submitted', 'doc_studio', p_version_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.doc_studio_review(p_kind text, p_version_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_creator uuid;
  v_status text;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_self boolean;
  v_ref jsonb;
  v_ok boolean;
  v_clause_refs jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_kind = 'clause' THEN
    SELECT created_by, status INTO v_creator, v_status FROM doc_clause_versions
     WHERE id = p_version_id AND user_id = v_owner FOR UPDATE;
  ELSIF p_kind = 'template' THEN
    SELECT created_by, status, clause_refs INTO v_creator, v_status, v_clause_refs FROM doc_content_template_versions
     WHERE id = p_version_id AND user_id = v_owner FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023';
  END IF;
  IF v_status IS DISTINCT FROM 'pending_review' THEN
    RAISE EXCEPTION 'version is not awaiting review' USING ERRCODE = '55000';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'p_approve is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_approve AND v_note IS NULL THEN
    RAISE EXCEPTION 'a rejection needs a note' USING ERRCODE = '22023';
  END IF;

  v_self := (v_creator = auth.uid());
  IF v_self AND p_approve AND (v_note IS NULL OR char_length(v_note) < 10) THEN
    RAISE EXCEPTION 'self-approval needs a note of at least 10 characters' USING ERRCODE = '22023';
  END IF;

  -- A template may only pin clause versions that are published and unchanged.
  IF p_approve AND p_kind = 'template' THEN
    FOR v_ref IN SELECT * FROM jsonb_array_elements(v_clause_refs) LOOP
      IF jsonb_typeof(v_ref -> 'slug') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_ref -> 'version') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_ref -> 'sha256') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'malformed clause reference' USING ERRCODE = '22023';
      END IF;
      SELECT EXISTS (
        SELECT 1
          FROM doc_clause_versions cv
          JOIN doc_clauses c ON c.id = cv.clause_id
         WHERE c.user_id = v_owner
           AND c.slug = v_ref ->> 'slug'
           AND cv.version_number = (v_ref ->> 'version')::integer
           AND cv.status = 'published'
           AND cv.sha256 = lower(v_ref ->> 'sha256')
      ) INTO v_ok;
      IF NOT v_ok THEN
        RAISE EXCEPTION 'clause % v% is not published or does not match its hash', v_ref ->> 'slug', v_ref ->> 'version'
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('vireek.doc_rpc', 'on', true);
  IF p_kind = 'clause' THEN
    UPDATE doc_clause_versions
       SET status = CASE WHEN p_approve THEN 'published' ELSE 'rejected' END,
           reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note,
           self_approved = v_self AND p_approve,
           published_at = CASE WHEN p_approve THEN now() ELSE NULL END
     WHERE id = p_version_id;
  ELSE
    UPDATE doc_content_template_versions
       SET status = CASE WHEN p_approve THEN 'published' ELSE 'rejected' END,
           reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note,
           self_approved = v_self AND p_approve,
           published_at = CASE WHEN p_approve THEN now() ELSE NULL END
     WHERE id = p_version_id;
  END IF;
  PERFORM public.log_audit_event(
    v_owner, 'doc_' || p_kind || CASE WHEN p_approve THEN '_published' ELSE '_rejected' END, 'doc_studio', p_version_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.doc_studio_retire(p_kind text, p_version_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('vireek.doc_rpc', 'on', true);
  IF p_kind = 'clause' THEN
    UPDATE doc_clause_versions SET status = 'retired', retired_at = now()
     WHERE id = p_version_id AND user_id = v_owner AND status = 'published';
  ELSIF p_kind = 'template' THEN
    UPDATE doc_content_template_versions SET status = 'retired', retired_at = now()
     WHERE id = p_version_id AND user_id = v_owner AND status = 'published';
  ELSE
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'version is not published' USING ERRCODE = '55000';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'doc_' || p_kind || '_retired', 'doc_studio', p_version_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.doc_studio_submit(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.doc_studio_review(text, uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.doc_studio_retire(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doc_studio_submit(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doc_studio_review(text, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doc_studio_retire(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.doc_studio_guard_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_studio_guard_parent() FROM PUBLIC, anon, authenticated;

/*
  ROLLBACK (only if nothing has been published/used yet — published versions are intentionally permanent):
    DROP TABLE IF EXISTS public.doc_content_template_versions, public.doc_content_templates,
                         public.doc_clause_versions, public.doc_clauses CASCADE;
    DROP FUNCTION IF EXISTS public.doc_studio_submit(text, uuid), public.doc_studio_review(text, uuid, boolean, text),
                            public.doc_studio_retire(text, uuid), public.doc_studio_guard_version(),
                            public.doc_studio_guard_parent();
*/
