/*
  # Legal document versioning and re-acceptance

  Adds versioned legal documents (Terms of Service, Privacy Policy, ...), a per-user acceptance record, and the
  server-side rule that decides when a signed-in user must re-accept after a MATERIAL change.

  Nothing like this existed: the only acceptance today is the client-side checkbox on /signup (not recorded), and
  `consent_records` covers cookie consent only. This migration does not touch either.

  Model
    legal_document_versions  immutable once published. One row per (doc_key, version). Holds the effective date,
                             whether the change is material, and a structured DIFF SUMMARY (`changes`: array of
                             {section, kind: added|changed|removed, summary, i18n?: {lang: summary}}).
                             The legal TEXT stays where it is today (src/components/sections/*Content.tsx, routes /terms,
                             /privacy); a row stores the route and an optional SHA-256 of the published text.
    legal_acceptances        append-only proof: (user, version, timestamp, source). No IP / user agent is stored.

  Rules
    - Only a MATERIAL version gates the product. A non-material version is published for the record and never blocks.
    - A user must re-accept doc D when a published, material, already-effective version of D is newer than the
      newest version they accepted. If they have no acceptance record for D they are deemed to have accepted the version
      in force when their profile was created (they ticked the signup box). [COUNSEL] deemed acceptance is weaker
      evidence than a record; signup also writes an explicit record (accept_current_legal_documents).
    - Material versions need advance notice: effective_at >= now() + legal_material_notice_days() (30, PROPOSED
      DEFAULT, UNVALIDATED [COUNSEL]), unless staff give a written waiver reason (>= 10 chars, audit-logged).
    - Publishing requires an explicit counsel-review confirmation [COUNSEL]; the DB stores who confirmed and when,
      it does not assert that review happened.
    - Versions are sequential per document and effective dates are strictly increasing.

  Writes are RPC-only (SECURITY DEFINER); tables have no client write policy. Users read published versions through
  column-level grants (staff identities are not exposed) and their own acceptances through RLS.
  Audit: publish and accept call log_audit_event() (20271215090000 guard applies).

  Idempotent: safe to run twice.
*/

-- rollback (manual; keep the tables, acceptances are evidence):
--   DROP FUNCTION IF EXISTS public.publish_legal_document_version(text, integer, text, timestamptz, boolean, jsonb, text, text, boolean, text),
--     public.legal_acceptance_status(), public.accept_legal_versions(uuid[], text), public.accept_current_legal_documents(text),
--     public.staff_legal_documents(), public.legal_material_notice_days(), public.legal_validate_changes(jsonb);

CREATE OR REPLACE FUNCTION public.legal_material_notice_days()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 30 $$;

-- 1) versions ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_key text NOT NULL CHECK (doc_key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  effective_at timestamptz NOT NULL,
  is_material boolean NOT NULL DEFAULT false,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) <= 50),
  content_path text CHECK (content_path IS NULL OR (content_path ~ '^/[A-Za-z0-9/_-]{1,120}$')),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  notice_waiver_reason text CHECK (notice_waiver_reason IS NULL OR char_length(notice_waiver_reason) <= 500),
  counsel_confirmed_by uuid,
  counsel_confirmed_at timestamptz,
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_versions_unique UNIQUE (doc_key, version),
  CONSTRAINT legal_versions_material_needs_diff CHECK (NOT is_material OR jsonb_array_length(changes) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_legal_versions_doc ON public.legal_document_versions (doc_key, version DESC);

ALTER TABLE public.legal_document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read_legal_versions" ON public.legal_document_versions;
CREATE POLICY "authenticated_read_legal_versions" ON public.legal_document_versions
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.legal_document_versions FROM anon, authenticated;
-- column-level: who published / who confirmed counsel review stays staff-side (staff_legal_documents())
GRANT SELECT (id, doc_key, version, title, effective_at, is_material, changes, content_path, content_sha256, status, published_at)
  ON public.legal_document_versions TO authenticated;

CREATE OR REPLACE FUNCTION public.legal_versions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal document versions cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'a published legal document version is immutable; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'invalid status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_versions_guard ON public.legal_document_versions;
CREATE TRIGGER trg_legal_versions_guard
  BEFORE UPDATE OR DELETE ON public.legal_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.legal_versions_guard();

-- 2) acceptances ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  version_id uuid NOT NULL REFERENCES public.legal_document_versions (id),
  doc_key text NOT NULL,
  version integer NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('signup', 'gate', 'settings')),
  CONSTRAINT legal_acceptances_once UNIQUE (user_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user ON public.legal_acceptances (user_id, doc_key, version DESC);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_version ON public.legal_acceptances (version_id);

ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_legal_acceptances" ON public.legal_acceptances;
CREATE POLICY "select_own_legal_acceptances" ON public.legal_acceptances
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "staff_select_legal_acceptances" ON public.legal_acceptances;
CREATE POLICY "staff_select_legal_acceptances" ON public.legal_acceptances
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.legal_acceptances FROM anon, authenticated;
GRANT SELECT ON public.legal_acceptances TO authenticated;

CREATE OR REPLACE FUNCTION public.legal_acceptances_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- the only permitted change is the FK action ON DELETE SET NULL when an account is deleted
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legal_acceptances is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_acceptances_immutable ON public.legal_acceptances;
CREATE TRIGGER trg_legal_acceptances_immutable
  BEFORE UPDATE OR DELETE ON public.legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.legal_acceptances_immutable();

-- 3) diff-summary validation --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_validate_changes(p_changes jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  el jsonb;
  k text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) > 50 THEN
    RAISE EXCEPTION 'legal_guardrail: changes must be a JSON array of at most 50 items.' USING ERRCODE = 'check_violation';
  END IF;
  FOR el IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    IF jsonb_typeof(el) <> 'object'
       OR coalesce(el->>'kind', '') NOT IN ('added', 'changed', 'removed')
       OR char_length(btrim(coalesce(el->>'section', ''))) NOT BETWEEN 1 AND 120
       OR char_length(btrim(coalesce(el->>'summary', ''))) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'legal_guardrail: each change needs kind (added|changed|removed), section (1-120) and summary (1-500).' USING ERRCODE = 'check_violation';
    END IF;
    IF el ? 'i18n' THEN
      IF jsonb_typeof(el->'i18n') <> 'object' THEN
        RAISE EXCEPTION 'legal_guardrail: i18n must be an object of language -> summary.' USING ERRCODE = 'check_violation';
      END IF;
      FOR k IN SELECT jsonb_object_keys(el->'i18n') LOOP
        IF k !~ '^[a-z]{2}$' OR jsonb_typeof(el->'i18n'->k) <> 'string' OR char_length(el->'i18n'->>k) NOT BETWEEN 1 AND 500 THEN
          RAISE EXCEPTION 'legal_guardrail: bad i18n entry "%".', k USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

-- 4) publish (staff) ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_legal_document_version(
  p_doc_key text,
  p_version integer,
  p_title text,
  p_effective_at timestamptz,
  p_is_material boolean,
  p_changes jsonb,
  p_content_sha256 text,
  p_content_path text,
  p_counsel_confirmed boolean,
  p_notice_waiver_reason text DEFAULT NULL
)
RETURNS legal_document_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row legal_document_versions;
  v_prev legal_document_versions;
  v_waiver text := NULLIF(btrim(coalesce(p_notice_waiver_reason, '')), '');
  v_changes jsonb := coalesce(p_changes, '[]'::jsonb);
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_counsel_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'legal_guardrail: legal review of this wording must be confirmed before publishing. [COUNSEL]' USING ERRCODE = 'check_violation';
  END IF;
  IF p_effective_at IS NULL OR p_title IS NULL OR p_doc_key IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'legal_guardrail: document, version, title and effective date are required.' USING ERRCODE = '22023';
  END IF;

  PERFORM public.legal_validate_changes(v_changes);
  IF p_is_material IS TRUE AND jsonb_array_length(v_changes) = 0 THEN
    RAISE EXCEPTION 'legal_guardrail: a material change needs a diff summary (at least one change).' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('legal_doc:' || p_doc_key, 0));

  SELECT * INTO v_prev FROM legal_document_versions WHERE doc_key = p_doc_key ORDER BY version DESC LIMIT 1;
  IF v_prev.id IS NULL THEN
    IF p_version <> 1 THEN
      RAISE EXCEPTION 'legal_guardrail: the first version of a document must be 1.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_version <> v_prev.version + 1 THEN
      RAISE EXCEPTION 'legal_guardrail: next version must be % (got %).', v_prev.version + 1, p_version USING ERRCODE = 'check_violation';
    END IF;
    IF p_effective_at <= v_prev.effective_at THEN
      RAISE EXCEPTION 'legal_guardrail: the effective date must be later than version %.', v_prev.version USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_is_material IS TRUE AND p_version > 1 AND p_effective_at < now() + make_interval(days => public.legal_material_notice_days()) THEN
    IF v_waiver IS NULL OR char_length(v_waiver) < 10 THEN
      RAISE EXCEPTION 'legal_guardrail: a material change needs % days of notice; give a written waiver reason (>= 10 characters) to publish sooner. [COUNSEL]',
        public.legal_material_notice_days() USING ERRCODE = 'check_violation';
    END IF;
    IF p_effective_at < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'legal_guardrail: the effective date cannot be in the past.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    v_waiver := NULL;
  END IF;

  INSERT INTO legal_document_versions (
    doc_key, version, title, effective_at, is_material, changes, content_path, content_sha256,
    notice_waiver_reason, counsel_confirmed_by, counsel_confirmed_at, published_by
  ) VALUES (
    p_doc_key, p_version, btrim(p_title), p_effective_at, coalesce(p_is_material, false), v_changes,
    NULLIF(btrim(coalesce(p_content_path, '')), ''), NULLIF(lower(btrim(coalesce(p_content_sha256, ''))), ''),
    left(v_waiver, 500), auth.uid(), now(), auth.uid()
  ) RETURNING * INTO v_row;

  PERFORM public.log_audit_event(
    auth.uid(), 'legal_document_published', 'legal_document_versions', v_row.id::text,
    jsonb_build_object('doc_key', v_row.doc_key, 'version', v_row.version, 'material', v_row.is_material,
                       'effective_at', v_row.effective_at, 'changes', jsonb_array_length(v_row.changes),
                       'notice_waived', v_waiver IS NOT NULL, 'waiver_reason', v_waiver)
  );
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_legal_document_version(text, integer, text, timestamptz, boolean, jsonb, text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_legal_document_version(text, integer, text, timestamptz, boolean, jsonb, text, text, boolean, text) TO authenticated;

-- 5) the gate decision ------------------------------------------------------------------------------
-- Returns {"decision": "ok"|"must_accept", "required": [{doc_key, version_id, version, title, effective_at,
--   content_path, accepted_version, versions: [{version, effective_at, changes}]}]}
CREATE OR REPLACE FUNCTION public.legal_acceptance_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_created timestamptz;
  v_required jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('decision', 'ok', 'required', '[]'::jsonb);
  END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  IF v_created IS NULL THEN
    v_created := now();
  END IF;

  WITH docs AS (
    SELECT DISTINCT doc_key FROM legal_document_versions WHERE status = 'published'
  ),
  accepted AS (
    SELECT d.doc_key,
           COALESCE(
             (SELECT max(a.version) FROM legal_acceptances a WHERE a.user_id = v_uid AND a.doc_key = d.doc_key),
             (SELECT max(v.version) FROM legal_document_versions v
               WHERE v.doc_key = d.doc_key AND v.status = 'published' AND v.effective_at <= v_created),
             0
           ) AS accepted_version
    FROM docs d
  ),
  pending AS (
    SELECT v.*, ac.accepted_version
    FROM legal_document_versions v
    JOIN accepted ac ON ac.doc_key = v.doc_key
    WHERE v.status = 'published' AND v.is_material AND v.effective_at <= now() AND v.version > ac.accepted_version
  ),
  latest AS (
    SELECT DISTINCT ON (doc_key) * FROM pending ORDER BY doc_key, version DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'doc_key', l.doc_key, 'version_id', l.id, 'version', l.version, 'title', l.title,
      'effective_at', l.effective_at, 'content_path', l.content_path, 'accepted_version', l.accepted_version,
      'versions', (SELECT jsonb_agg(jsonb_build_object('version', p.version, 'effective_at', p.effective_at, 'changes', p.changes)
                                    ORDER BY p.version)
                   FROM pending p WHERE p.doc_key = l.doc_key)
    ) ORDER BY l.doc_key), '[]'::jsonb)
  INTO v_required FROM latest l;

  RETURN jsonb_build_object(
    'decision', CASE WHEN jsonb_array_length(v_required) > 0 THEN 'must_accept' ELSE 'ok' END,
    'required', v_required
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legal_acceptance_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.legal_acceptance_status() TO authenticated;

-- 6) accept ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_legal_versions(p_version_ids uuid[], p_source text DEFAULT 'gate')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found integer;
  v_inserted integer := 0;
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('gate', 'settings') THEN
    RAISE EXCEPTION 'legal_guardrail: invalid source.' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(p_version_ids) AS x WHERE x IS NOT NULL;
  IF coalesce(array_length(v_ids, 1), 0) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'legal_guardrail: between 1 and 10 versions can be accepted at once.' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_found FROM legal_document_versions
  WHERE id = ANY (v_ids) AND status = 'published' AND effective_at <= now();
  IF v_found <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'legal_guardrail: unknown, retired or not-yet-effective version.' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO legal_acceptances (user_id, version_id, doc_key, version, source)
  SELECT v_uid, v.id, v.doc_key, v.version, p_source FROM legal_document_versions v WHERE v.id = ANY (v_ids)
  ON CONFLICT (user_id, version_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_inserted := v_n;

  IF v_inserted > 0 THEN
    PERFORM public.log_audit_event(
      v_uid, 'legal_terms_accepted', 'legal_acceptances', NULL,
      jsonb_build_object('source', p_source, 'versions',
        (SELECT jsonb_agg(jsonb_build_object('doc_key', v.doc_key, 'version', v.version) ORDER BY v.doc_key) FROM legal_document_versions v WHERE v.id = ANY (v_ids)))
    );
  END IF;
  RETURN jsonb_build_object('accepted', v_inserted, 'requested', array_length(v_ids, 1));
END;
$$;

REVOKE ALL ON FUNCTION public.accept_legal_versions(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_legal_versions(uuid[], text) TO authenticated;

-- Signup: records the explicit acceptance behind the checkbox (current effective version of every document).
-- Only for brand-new accounts, so it cannot be used later to skip the re-acceptance screen.
CREATE OR REPLACE FUNCTION public.accept_current_legal_documents(p_source text DEFAULT 'signup')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_created timestamptz;
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_source <> 'signup' THEN
    RAISE EXCEPTION 'legal_guardrail: invalid source.' USING ERRCODE = '22023';
  END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  IF v_created IS NULL OR v_created < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'legal_guardrail: only available right after signup.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO legal_acceptances (user_id, version_id, doc_key, version, source)
  SELECT v_uid, l.id, l.doc_key, l.version, 'signup'
  FROM (
    SELECT DISTINCT ON (doc_key) id, doc_key, version FROM legal_document_versions
    WHERE status = 'published' AND effective_at <= now() ORDER BY doc_key, version DESC
  ) l
  ON CONFLICT (user_id, version_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    PERFORM public.log_audit_event(v_uid, 'legal_terms_accepted', 'legal_acceptances', NULL,
                                   jsonb_build_object('source', 'signup', 'documents', v_n));
  END IF;
  RETURN jsonb_build_object('accepted', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_current_legal_documents(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_current_legal_documents(text) TO authenticated;

-- 7) staff read ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_legal_documents()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.doc_key, t.version DESC)
    FROM (
      SELECT v.id, v.doc_key, v.version, v.title, v.effective_at, v.is_material, v.status,
             jsonb_array_length(v.changes) AS change_count, v.notice_waiver_reason,
             v.counsel_confirmed_at, v.published_at,
             (SELECT count(*) FROM legal_acceptances a WHERE a.version_id = v.id) AS accepted_count,
             (SELECT count(*) FROM profiles p
               WHERE p.created_at < v.effective_at
                 AND NOT EXISTS (SELECT 1 FROM legal_acceptances a WHERE a.user_id = p.id AND a.doc_key = v.doc_key AND a.version >= v.version)) AS pending_count
      FROM legal_document_versions v
      ORDER BY v.doc_key, v.version DESC
      LIMIT 200
    ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_legal_documents() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_legal_documents() TO authenticated;

-- 8) baseline: the versions that are live today (dates from the "Last updated" lines of the current pages) -------------
-- Not material (nothing to re-accept) and no counsel confirmation is recorded: that must come from a person. [COUNSEL]
INSERT INTO public.legal_document_versions (doc_key, version, title, effective_at, is_material, changes, content_path)
VALUES
  ('terms', 1, 'Terms of Service', '2026-08-20T00:00:00Z', false, '[]'::jsonb, '/terms'),
  ('privacy', 1, 'Privacy Policy', '2026-10-31T00:00:00Z', false, '[]'::jsonb, '/privacy')
ON CONFLICT (doc_key, version) DO NOTHING;

/*
  Publishing example (staff session, e.g. via the SQL editor with a staff JWT or a one-off script):
    select public.publish_legal_document_version(
      'terms', 2, 'Terms of Service', now() + interval '30 days', true,
      '[{"section":"Billing","kind":"changed","summary":"Annual plans renew at the then-current price.","i18n":{"fa":"..."}}]'::jsonb,
      '<sha256 of the published text>', '/terms', true);
  Verification:
    select doc_key, version, is_material, effective_at from public.legal_document_versions order by 1, 2;
    select doc_key, version, count(*) from public.legal_acceptances group by 1, 2;
*/
