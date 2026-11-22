/*
  # SOC 2 readiness — policy approval workflow + workforce evidence (GOV-01, GOV-02)

  READINESS tooling. Nothing stored here is an attestation and none of it makes Vireek
  SOC 2 compliant. It records who approved which exact policy text, when, and which
  staff acknowledged it, plus the fact (and only the fact) that background-check /
  training obligations were completed.

  ## What this adds (extends 20280402000000_soc2_control_program.sql; nothing is duplicated)
  - compliance_policies                  one row per policy file in docs/compliance/policies/
                                          (repo_sha256 is pushed by CI: action `sync_policies`)
  - compliance_policy_versions           version + content hash + approver + dates; immutable once approved
  - compliance_policy_acknowledgements   APPEND-ONLY staff acknowledgements of an approved version
  - compliance_workforce_requirements    which workforce obligations management has decided apply
  - compliance_workforce_records         APPEND-ONLY completion facts (no results, no notes, no documents)
  - staff_* RPCs                         the only write path for signed-in staff (staff-gated, audited)
  - compliance_*_summary()/sync          service_role only; used by the compliance-evidence edge function

  ## Data minimisation for workforce records (deliberate)
  There is NO column for a check result, a finding, a report, a score, a date of birth, a government id,
  an address, or free-text notes. A background check is recorded as "process completed on <date>
  by <provider label>" and nothing else; the report stays with the provider. Training is recorded as
  "course key completed on <date>". Waivers use a fixed code list, not free text.

  ## Security model
  - RLS on every table; SELECT for Vireek staff only; NO client INSERT/UPDATE/DELETE grants.
  - Approval requires the caller to be staff. Self-approval is not blocked (a one-person company
    has no alternative) but is stored as self_approved = true and surfaced everywhere; it never
    counts as independent review.
  - Approval is bound to the exact content hash that CI observed in the repository. If the policy
    file changes afterwards the policy shows "content changed since approval" until re-approved.
  - Column names avoid `user_id` on purpose: these are compliance records that must outlive an
    account, so they must not be picked up by the account-erasure ratchet as personal data to delete.
    [COUNSEL] confirm retention period and lawful basis for HR-type compliance records per jurisdiction.

  ## Rollback
  Additive only. Drop the functions, then the tables (reverse order). Do this only through a reviewed
  migration — deleting approval or acknowledgement history must itself be a recorded decision.
*/

-- =============================================================
-- 0) HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.compliance_assert_staff()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.compliance_assert_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_assert_staff() TO authenticated, service_role;

-- =============================================================
-- 1) POLICIES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_policies (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]{2,60}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  source_path text NOT NULL CHECK (source_path ~ '^docs/compliance/policies/[a-z0-9-]+\.md$'),
  control_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(control_ids) <= 12),
  review_frequency_days integer NOT NULL DEFAULT 365 CHECK (review_frequency_days BETWEEN 30 AND 400),
  requires_acknowledgement boolean NOT NULL DEFAULT true,
  repo_sha256 text CHECK (repo_sha256 IS NULL OR repo_sha256 ~ '^[0-9a-f]{64}$'),
  repo_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.compliance_policies ENABLE ROW LEVEL SECURITY;

INSERT INTO public.compliance_policies (slug, title, source_path, control_ids) VALUES
  ('information-security',        'Information Security Policy',                    'docs/compliance/policies/information-security.md',        ARRAY['GOV-01']),
  ('acceptable-use',              'Acceptable Use Policy (internal)',               'docs/compliance/policies/acceptable-use.md',              ARRAY['GOV-01']),
  ('access-control',              'Access Control & Review Policy',                 'docs/compliance/policies/access-control.md',              ARRAY['ACC-03']),
  ('change-management',           'Change Management Policy',                       'docs/compliance/policies/change-management.md',           ARRAY['SDL-02','SDL-04']),
  ('incident-response',           'Incident Response Policy',                       'docs/compliance/policies/incident-response.md',           ARRAY['INC-01']),
  ('ai-incident-response',        'AI Incident Response Policy',                    'docs/compliance/policies/ai-incident-response.md',        ARRAY['INC-01']),
  ('backup-disaster-recovery',    'Backup & Disaster Recovery Policy',              'docs/compliance/policies/backup-disaster-recovery.md',    ARRAY['AVL-02','AVL-03','AVL-04']),
  ('business-continuity',         'Business Continuity Policy',                     'docs/compliance/policies/business-continuity.md',         ARRAY['AVL-04']),
  ('vendor-management',           'Vendor & Sub-processor Management Policy',       'docs/compliance/policies/vendor-management.md',           ARRAY['VND-01']),
  ('risk-assessment',             'Risk Assessment Policy',                         'docs/compliance/policies/risk-assessment.md',             ARRAY['RSK-01']),
  ('data-classification-retention','Data Classification & Retention Policy',        'docs/compliance/policies/data-classification-retention.md', ARRAY['CON-01','CON-02']),
  ('logging-monitoring',          'Logging & Monitoring Policy',                    'docs/compliance/policies/logging-monitoring.md',          ARRAY['LOG-01','LOG-02']),
  ('secrets-key-rotation',        'Secrets & Key Rotation Policy',                  'docs/compliance/policies/secrets-key-rotation.md',        ARRAY['ACC-06']),
  ('vulnerability-management',    'Vulnerability Management Policy',                'docs/compliance/policies/vulnerability-management.md',    ARRAY['SDL-01','PEN-01']),
  ('onboarding-offboarding',      'Onboarding & Offboarding Policy',                'docs/compliance/policies/onboarding-offboarding.md',      ARRAY['GOV-02']),
  ('security-training',           'Security Awareness Training Policy',             'docs/compliance/policies/security-training.md',           ARRAY['GOV-02'])
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- 2) POLICY VERSIONS (the approval record)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_slug text NOT NULL REFERENCES public.compliance_policies (slug) ON DELETE RESTRICT,
  version text NOT NULL CHECK (version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  change_summary text CHECK (change_summary IS NULL OR char_length(btrim(change_summary)) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review', 'approved', 'superseded', 'withdrawn')),
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approver_id uuid,
  approved_at timestamptz,
  effective_on date,
  next_review_due date,
  self_approved boolean,
  superseded_at timestamptz,
  withdrawn_at timestamptz,
  UNIQUE (policy_slug, version),
  CONSTRAINT policy_version_approved_fields CHECK (
    status NOT IN ('approved', 'superseded')
    OR (approver_id IS NOT NULL AND approved_at IS NOT NULL AND effective_on IS NOT NULL
        AND next_review_due IS NOT NULL AND self_approved IS NOT NULL)
  ),
  CONSTRAINT policy_version_review_after_effective CHECK (next_review_due IS NULL OR effective_on IS NULL OR next_review_due > effective_on)
);

-- At most one approved and one in-review version per policy.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_versions_one_approved
  ON public.compliance_policy_versions (policy_slug) WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_versions_one_in_review
  ON public.compliance_policy_versions (policy_slug) WHERE status = 'in_review';

ALTER TABLE public.compliance_policy_versions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.compliance_policy_versions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance_policy_versions rows are never deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.policy_slug IS DISTINCT FROM OLD.policy_slug
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'policy version identity, hash and submission are immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('approved', 'superseded') AND (
       NEW.approver_id IS DISTINCT FROM OLD.approver_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
    OR NEW.next_review_due IS DISTINCT FROM OLD.next_review_due
    OR NEW.self_approved IS DISTINCT FROM OLD.self_approved) THEN
    RAISE EXCEPTION 'approval details are immutable once approved' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'no in-place edits; change status through the workflow functions' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD.status = 'in_review' AND NEW.status IN ('approved', 'withdrawn'))
       OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'illegal policy version transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_compliance_policy_versions_guard ON public.compliance_policy_versions;
CREATE TRIGGER trg_compliance_policy_versions_guard
  BEFORE UPDATE OR DELETE ON public.compliance_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.compliance_policy_versions_guard();

-- =============================================================
-- 3) ACKNOWLEDGEMENTS (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_policy_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES public.compliance_policy_versions (id) ON DELETE RESTRICT,
  acknowledged_by uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, acknowledged_by)
);
CREATE INDEX IF NOT EXISTS compliance_policy_acks_by_idx
  ON public.compliance_policy_acknowledgements (acknowledged_by, acknowledged_at DESC);
ALTER TABLE public.compliance_policy_acknowledgements ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.compliance_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_compliance_policy_acks_append_only ON public.compliance_policy_acknowledgements;
CREATE TRIGGER trg_compliance_policy_acks_append_only
  BEFORE UPDATE OR DELETE ON public.compliance_policy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.compliance_append_only();

-- =============================================================
-- 4) WORKFORCE REQUIREMENTS + RECORDS (completion facts only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_workforce_requirements (
  requirement_key text PRIMARY KEY CHECK (requirement_key ~ '^[a-z][a-z0-9_]{2,50}$'),
  record_type text NOT NULL CHECK (record_type IN ('background_check', 'security_training')),
  course_key text NOT NULL DEFAULT '' CHECK (course_key = '' OR course_key ~ '^[a-z][a-z0-9_]{2,40}$'),
  required boolean NOT NULL,
  max_age_days integer CHECK (max_age_days IS NULL OR max_age_days BETWEEN 30 AND 1100),
  decided_by uuid,
  decided_at timestamptz,
  UNIQUE (record_type, course_key),
  CONSTRAINT workforce_req_course_matches CHECK ((record_type = 'security_training') = (course_key <> ''))
);
ALTER TABLE public.compliance_workforce_requirements ENABLE ROW LEVEL SECURITY;

-- Background checks: NOT required until management decides. [COUNSEL] lawfulness, scope and
-- consent for background screening differ by country and role; Vireek has recorded no decision.
INSERT INTO public.compliance_workforce_requirements (requirement_key, record_type, course_key, required, max_age_days) VALUES
  ('background_check',          'background_check',  '',                          false, NULL),
  ('security_awareness_annual', 'security_training',  'security_awareness_annual', true,  365)
ON CONFLICT (requirement_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.compliance_workforce_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL,
  record_type text NOT NULL CHECK (record_type IN ('background_check', 'security_training', 'offboarding_checklist')),
  course_key text NOT NULL DEFAULT '' CHECK (course_key = '' OR course_key ~ '^[a-z][a-z0-9_]{2,40}$'),
  status text NOT NULL CHECK (status IN ('completed', 'waived')),
  waiver_code text CHECK (waiver_code IS NULL OR waiver_code IN ('role_not_applicable', 'not_required_by_policy', 'legal_restriction')),
  completed_on date,
  valid_until date,
  -- A label for WHO performed it (a vendor or "internal"), never a person's details.
  provider_label text CHECK (provider_label IS NULL OR (
    char_length(btrim(provider_label)) BETWEEN 2 AND 80 AND provider_label !~ '[@<>]' AND provider_label !~ '[0-9]{6,}')),
  -- Opaque pointer into the provider's own system. Charset-restricted so it cannot carry prose.
  external_ref text CHECK (external_ref IS NULL OR external_ref ~ '^[A-Za-z0-9._-]{3,64}$'),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  CONSTRAINT workforce_course_matches CHECK ((record_type = 'security_training') = (course_key <> '')),
  CONSTRAINT workforce_completed_needs_date CHECK (status <> 'completed' OR completed_on IS NOT NULL),
  CONSTRAINT workforce_waived_needs_code CHECK ((status = 'waived') = (waiver_code IS NOT NULL)),
  CONSTRAINT workforce_validity_order CHECK (valid_until IS NULL OR completed_on IS NULL OR valid_until >= completed_on),
  CONSTRAINT workforce_void_pair CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX IF NOT EXISTS compliance_workforce_records_subject_idx
  ON public.compliance_workforce_records (subject_user_id, record_type, course_key, recorded_at DESC);
ALTER TABLE public.compliance_workforce_records ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.compliance_workforce_records_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance_workforce_records rows are never deleted; void them' USING ERRCODE = '42501';
  END IF;
  -- The only permitted change: NULL -> value on voided_at / voided_by (a correction, not an erasure).
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - 'voided_at' - 'voided_by') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by') THEN
    RAISE EXCEPTION 'workforce records are append-only; only a one-time void is allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_compliance_workforce_records_guard ON public.compliance_workforce_records;
CREATE TRIGGER trg_compliance_workforce_records_guard
  BEFORE UPDATE OR DELETE ON public.compliance_workforce_records
  FOR EACH ROW EXECUTE FUNCTION public.compliance_workforce_records_guard();

-- =============================================================
-- 5) ACCESS: staff read-only through RLS; writes only through the RPCs below
-- =============================================================
REVOKE ALL ON public.compliance_policies, public.compliance_policy_versions, public.compliance_policy_acknowledgements,
              public.compliance_workforce_requirements, public.compliance_workforce_records FROM anon, authenticated;
GRANT SELECT ON public.compliance_policies, public.compliance_policy_versions, public.compliance_policy_acknowledgements,
                public.compliance_workforce_requirements, public.compliance_workforce_records TO authenticated;

DROP POLICY IF EXISTS "staff_select_compliance_policies" ON public.compliance_policies;
CREATE POLICY "staff_select_compliance_policies" ON public.compliance_policies
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_compliance_policy_versions" ON public.compliance_policy_versions;
CREATE POLICY "staff_select_compliance_policy_versions" ON public.compliance_policy_versions
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_compliance_policy_acks" ON public.compliance_policy_acknowledgements;
CREATE POLICY "staff_select_compliance_policy_acks" ON public.compliance_policy_acknowledgements
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_compliance_workforce_req" ON public.compliance_workforce_requirements;
CREATE POLICY "staff_select_compliance_workforce_req" ON public.compliance_workforce_requirements
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_compliance_workforce_rec" ON public.compliance_workforce_records;
CREATE POLICY "staff_select_compliance_workforce_rec" ON public.compliance_workforce_records
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- =============================================================
-- 6) POLICY WORKFLOW RPCs (staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_policy_submit_version(
  p_slug text,
  p_version text,
  p_change_summary text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_policy public.compliance_policies%ROWTYPE;
  v_id uuid;
  v_max_major int;
  v_max_minor int;
BEGIN
  PERFORM public.compliance_assert_staff();

  SELECT * INTO v_policy FROM public.compliance_policies WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy' USING ERRCODE = 'P0002'; END IF;
  IF v_policy.repo_sha256 IS NULL THEN
    RAISE EXCEPTION 'policy content hash has not been synced from the repository yet' USING ERRCODE = '55000';
  END IF;
  IF p_version IS NULL OR p_version !~ '^[0-9]{1,3}\.[0-9]{1,3}$' THEN
    RAISE EXCEPTION 'version must look like 1.0' USING ERRCODE = '22023';
  END IF;

  SELECT split_part(v.version, '.', 1)::int, split_part(v.version, '.', 2)::int
    INTO v_max_major, v_max_minor
    FROM public.compliance_policy_versions v
   WHERE v.policy_slug = p_slug
   ORDER BY split_part(v.version, '.', 1)::int DESC, split_part(v.version, '.', 2)::int DESC
   LIMIT 1;
  IF v_max_major IS NOT NULL
     AND (split_part(p_version, '.', 1)::int, split_part(p_version, '.', 2)::int) <= (v_max_major, v_max_minor) THEN
    RAISE EXCEPTION 'version must be greater than the latest existing version (%.%)', v_max_major, v_max_minor USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.compliance_policy_versions WHERE policy_slug = p_slug AND status = 'in_review') THEN
    RAISE EXCEPTION 'a version of this policy is already in review; withdraw it first' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.compliance_policy_versions (policy_slug, version, content_sha256, change_summary, submitted_by)
  VALUES (p_slug, p_version, v_policy.repo_sha256, NULLIF(btrim(p_change_summary), ''), auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.log_audit_event(auth.uid(), 'compliance_policy_submitted', 'compliance_policy_versions', v_id::text,
    jsonb_build_object('policy', p_slug, 'version', p_version));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_policy_approve_version(
  p_version_id uuid,
  p_effective_on date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ver public.compliance_policy_versions%ROWTYPE;
  v_policy public.compliance_policies%ROWTYPE;
  v_eff date := COALESCE(p_effective_on, current_date);
  v_self boolean;
BEGIN
  PERFORM public.compliance_assert_staff();

  SELECT * INTO v_ver FROM public.compliance_policy_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy version' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_policy FROM public.compliance_policies WHERE slug = v_ver.policy_slug FOR UPDATE;
  -- Re-read under the policy lock so two concurrent approvals cannot both pass the status check.
  SELECT * INTO v_ver FROM public.compliance_policy_versions WHERE id = p_version_id FOR UPDATE;

  IF v_ver.status <> 'in_review' THEN
    RAISE EXCEPTION 'only an in-review version can be approved (current status: %)', v_ver.status USING ERRCODE = '55000';
  END IF;
  IF v_policy.repo_sha256 IS DISTINCT FROM v_ver.content_sha256 THEN
    RAISE EXCEPTION 'policy text changed after submission; withdraw this version and submit again' USING ERRCODE = '55000';
  END IF;
  IF v_eff < current_date - 30 OR v_eff > current_date + 90 THEN
    RAISE EXCEPTION 'effective date must be within 30 days before and 90 days after today' USING ERRCODE = '22023';
  END IF;

  v_self := (v_ver.submitted_by = auth.uid());

  UPDATE public.compliance_policy_versions
     SET status = 'superseded', superseded_at = now()
   WHERE policy_slug = v_ver.policy_slug AND status = 'approved';

  UPDATE public.compliance_policy_versions
     SET status = 'approved',
         approver_id = auth.uid(),
         approved_at = now(),
         effective_on = v_eff,
         next_review_due = v_eff + v_policy.review_frequency_days,
         self_approved = v_self
   WHERE id = p_version_id;

  PERFORM public.log_audit_event(auth.uid(), 'compliance_policy_approved', 'compliance_policy_versions', p_version_id::text,
    jsonb_build_object('policy', v_ver.policy_slug, 'version', v_ver.version, 'self_approved', v_self));

  RETURN jsonb_build_object('id', p_version_id, 'policy', v_ver.policy_slug, 'version', v_ver.version, 'self_approved', v_self,
                            'effective_on', v_eff, 'next_review_due', v_eff + v_policy.review_frequency_days);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_policy_withdraw_version(p_version_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ver public.compliance_policy_versions%ROWTYPE;
BEGIN
  PERFORM public.compliance_assert_staff();
  SELECT * INTO v_ver FROM public.compliance_policy_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy version' USING ERRCODE = 'P0002'; END IF;
  IF v_ver.status <> 'in_review' THEN
    RAISE EXCEPTION 'only an in-review version can be withdrawn' USING ERRCODE = '55000';
  END IF;
  UPDATE public.compliance_policy_versions SET status = 'withdrawn', withdrawn_at = now() WHERE id = p_version_id;
  PERFORM public.log_audit_event(auth.uid(), 'compliance_policy_withdrawn', 'compliance_policy_versions', p_version_id::text,
    jsonb_build_object('policy', v_ver.policy_slug, 'version', v_ver.version));
END;
$$;

-- A staff member acknowledges for THEMSELVES only (auth.uid()); there is no "acknowledge on behalf of".
CREATE OR REPLACE FUNCTION public.staff_policy_acknowledge(p_version_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_status text;
  v_slug text;
  v_ver text;
  v_inserted int;
BEGIN
  PERFORM public.compliance_assert_staff();
  SELECT status, policy_slug, version INTO v_status, v_slug, v_ver FROM public.compliance_policy_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy version' USING ERRCODE = 'P0002'; END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'only the currently approved version can be acknowledged' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.compliance_policy_acknowledgements (version_id, acknowledged_by)
  VALUES (p_version_id, auth.uid())
  ON CONFLICT (version_id, acknowledged_by) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted > 0 THEN
    PERFORM public.log_audit_event(auth.uid(), 'compliance_policy_acknowledged', 'compliance_policy_versions', p_version_id::text,
      jsonb_build_object('policy', v_slug, 'version', v_ver));
  END IF;
  RETURN v_inserted > 0;
END;
$$;

-- One review-state rule, used by the UI overview and the evidence summary.
-- never_approved | content_changed | overdue | review_due (<= 30 days) | current
CREATE OR REPLACE FUNCTION public.compliance_policy_review_state(
  p_has_approved boolean, p_next_review_due date, p_approved_sha text, p_repo_sha text
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN NOT p_has_approved THEN 'never_approved'
    WHEN p_repo_sha IS NOT NULL AND p_repo_sha IS DISTINCT FROM p_approved_sha THEN 'content_changed'
    WHEN p_next_review_due < current_date THEN 'overdue'
    WHEN p_next_review_due <= current_date + 30 THEN 'review_due'
    ELSE 'current'
  END;
$$;

CREATE OR REPLACE FUNCTION public.staff_policy_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.compliance_assert_staff();
  WITH active_staff AS (
    SELECT p.id FROM public.profiles p WHERE p.is_staff AND p.status = 'active'
  ), cur AS (
    SELECT v.*, (SELECT count(*) FROM public.compliance_policy_acknowledgements a
                  WHERE a.version_id = v.id AND a.acknowledged_by IN (SELECT id FROM active_staff)) AS ack_count,
           EXISTS (SELECT 1 FROM public.compliance_policy_acknowledgements a
                    WHERE a.version_id = v.id AND a.acknowledged_by = auth.uid()) AS i_ack
      FROM public.compliance_policy_versions v WHERE v.status = 'approved'
  ), pend AS (
    SELECT v.* FROM public.compliance_policy_versions v WHERE v.status = 'in_review'
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'active_staff', (SELECT count(*) FROM active_staff),
    'me', auth.uid(),
    'policies', coalesce(jsonb_agg(jsonb_build_object(
      'slug', p.slug,
      'title', p.title,
      'source_path', p.source_path,
      'control_ids', p.control_ids,
      'review_frequency_days', p.review_frequency_days,
      'requires_acknowledgement', p.requires_acknowledgement,
      'repo_synced', p.repo_sha256 IS NOT NULL,
      'review_state', public.compliance_policy_review_state(c.id IS NOT NULL, c.next_review_due, c.content_sha256, p.repo_sha256),
      'current', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
        'version_id', c.id, 'version', c.version, 'approved_at', c.approved_at, 'effective_on', c.effective_on,
        'next_review_due', c.next_review_due, 'approver_id', c.approver_id,
        'approver_email', (SELECT pr.email FROM public.profiles pr WHERE pr.id = c.approver_id),
        'self_approved', c.self_approved, 'ack_count', c.ack_count, 'i_acknowledged', c.i_ack) END,
      'pending', CASE WHEN n.id IS NULL THEN NULL ELSE jsonb_build_object(
        'version_id', n.id, 'version', n.version, 'submitted_at', n.submitted_at, 'submitted_by', n.submitted_by,
        'change_summary', n.change_summary, 'hash_matches_repo', n.content_sha256 IS NOT DISTINCT FROM p.repo_sha256) END
    ) ORDER BY p.slug), '[]'::jsonb))
  INTO v_result
  FROM public.compliance_policies p
  LEFT JOIN cur c ON c.policy_slug = p.slug
  LEFT JOIN pend n ON n.policy_slug = p.slug;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_policy_ack_matrix(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_version uuid;
BEGIN
  PERFORM public.compliance_assert_staff();
  SELECT id INTO v_version FROM public.compliance_policy_versions WHERE policy_slug = p_slug AND status = 'approved';
  RETURN jsonb_build_object(
    'policy', p_slug,
    'version_id', v_version,
    'staff', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'acknowledged_at', a.acknowledged_at) ORDER BY p.email)
        FROM public.profiles p
        LEFT JOIN public.compliance_policy_acknowledgements a ON a.version_id = v_version AND a.acknowledged_by = p.id
       WHERE p.is_staff AND p.status = 'active'), '[]'::jsonb));
END;
$$;

-- =============================================================
-- 7) WORKFORCE RPCs (staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_workforce_record_add(
  p_subject uuid,
  p_record_type text,
  p_course_key text,
  p_status text,
  p_completed_on date DEFAULT NULL,
  p_valid_until date DEFAULT NULL,
  p_waiver_code text DEFAULT NULL,
  p_provider_label text DEFAULT NULL,
  p_external_ref text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.compliance_assert_staff();
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_subject AND is_staff) THEN
    RAISE EXCEPTION 'subject must be a Vireek staff account' USING ERRCODE = '22023';
  END IF;
  IF p_completed_on IS NOT NULL AND (p_completed_on > current_date OR p_completed_on < current_date - 1830) THEN
    RAISE EXCEPTION 'completed_on must be in the past five years and not in the future' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.compliance_workforce_records
    (subject_user_id, record_type, course_key, status, waiver_code, completed_on, valid_until, provider_label, external_ref, recorded_by)
  VALUES
    (p_subject, p_record_type, COALESCE(p_course_key, ''), p_status, NULLIF(p_waiver_code, ''), p_completed_on, p_valid_until,
     NULLIF(btrim(p_provider_label), ''), NULLIF(btrim(p_external_ref), ''), auth.uid())
  RETURNING id INTO v_id;

  -- Audit metadata is identifiers only: never a provider label, reference or any outcome.
  PERFORM public.log_audit_event(auth.uid(), 'compliance_workforce_record_added', 'compliance_workforce_records', v_id::text,
    jsonb_build_object('record_type', p_record_type, 'course_key', COALESCE(p_course_key, ''), 'status', p_status));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_workforce_record_void(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n int;
BEGIN
  PERFORM public.compliance_assert_staff();
  UPDATE public.compliance_workforce_records
     SET voided_at = now(), voided_by = auth.uid()
   WHERE id = p_id AND voided_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'record not found or already voided' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.log_audit_event(auth.uid(), 'compliance_workforce_record_voided', 'compliance_workforce_records', p_id::text, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_workforce_set_requirement(p_key text, p_required boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n int;
BEGIN
  PERFORM public.compliance_assert_staff();
  UPDATE public.compliance_workforce_requirements
     SET required = p_required, decided_by = auth.uid(), decided_at = now()
   WHERE requirement_key = p_key;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'unknown requirement' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.log_audit_event(auth.uid(), 'compliance_workforce_requirement_set', 'compliance_workforce_requirements', p_key,
    jsonb_build_object('required', p_required));
END;
$$;

-- Latest non-voided record per (subject, type, course) decides the state.
-- state: current | waived | expired | missing
CREATE OR REPLACE FUNCTION public.compliance_workforce_matrix()
RETURNS TABLE (subject_id uuid, subject_email text, requirement_key text, required boolean, state text,
               completed_on date, valid_until date, provider_label text, waiver_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT s.id, s.email, r.requirement_key, r.required,
         CASE
           WHEN l.id IS NULL THEN 'missing'
           WHEN l.status = 'waived' THEN 'waived'
           WHEN (r.max_age_days IS NOT NULL AND l.completed_on + r.max_age_days < current_date)
             OR (l.valid_until IS NOT NULL AND l.valid_until < current_date) THEN 'expired'
           ELSE 'current'
         END,
         l.completed_on, l.valid_until, l.provider_label, l.waiver_code
    FROM public.profiles s
   CROSS JOIN public.compliance_workforce_requirements r
    LEFT JOIN LATERAL (
      SELECT w.* FROM public.compliance_workforce_records w
       WHERE w.subject_user_id = s.id AND w.record_type = r.record_type AND w.course_key = r.course_key AND w.voided_at IS NULL
       ORDER BY w.recorded_at DESC, w.id DESC LIMIT 1
    ) l ON true
   WHERE s.is_staff AND s.status = 'active';
$$;
REVOKE ALL ON FUNCTION public.compliance_workforce_matrix() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_workforce_matrix() TO service_role;

CREATE OR REPLACE FUNCTION public.staff_workforce_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.compliance_assert_staff();
  RETURN jsonb_build_object(
    'generated_at', now(),
    'requirements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'requirement_key', r.requirement_key, 'record_type', r.record_type, 'course_key', r.course_key,
        'required', r.required, 'max_age_days', r.max_age_days, 'decided_at', r.decided_at) ORDER BY r.requirement_key)
      FROM public.compliance_workforce_requirements r), '[]'::jsonb),
    'matrix', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'subject_id', m.subject_id, 'subject_email', m.subject_email, 'requirement_key', m.requirement_key,
        'required', m.required, 'state', m.state, 'completed_on', m.completed_on, 'valid_until', m.valid_until,
        'provider_label', m.provider_label, 'waiver_code', m.waiver_code) ORDER BY m.subject_email, m.requirement_key)
      FROM public.compliance_workforce_matrix() m), '[]'::jsonb));
END;
$$;

-- =============================================================
-- 8) SERVICE-ROLE FUNCTIONS for the evidence pipeline (aggregates only: no names, no ids)
-- =============================================================
CREATE OR REPLACE FUNCTION public.compliance_sync_policy_hashes(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_item jsonb;
  v_updated int := 0;
  v_created int := 0;
  v_slug text;
  v_sha text;
  v_path text;
  v_title text;
  v_was_insert boolean;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'items must be an array of at most 100 entries' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_slug := v_item ->> 'slug';
    v_sha := v_item ->> 'sha256';
    v_path := v_item ->> 'source_path';
    v_title := v_item ->> 'title';
    IF v_slug IS NULL OR v_slug !~ '^[a-z][a-z0-9-]{2,60}$' OR v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid policy item' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.compliance_policies (slug, title, source_path, repo_sha256, repo_synced_at)
    VALUES (v_slug, COALESCE(NULLIF(btrim(v_title), ''), v_slug), COALESCE(v_path, 'docs/compliance/policies/' || v_slug || '.md'), v_sha, now())
    ON CONFLICT (slug) DO UPDATE SET repo_sha256 = EXCLUDED.repo_sha256, repo_synced_at = EXCLUDED.repo_synced_at
    RETURNING (xmax = 0) INTO v_was_insert;
    IF v_was_insert THEN v_created := v_created + 1; ELSE v_updated := v_updated + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.compliance_policy_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH active_staff AS (
    SELECT p.id FROM public.profiles p WHERE p.is_staff AND p.status = 'active'
  ), per AS (
    SELECT p.slug, p.requires_acknowledgement,
           c.id AS version_id, c.self_approved,
           public.compliance_policy_review_state(c.id IS NOT NULL, c.next_review_due, c.content_sha256, p.repo_sha256) AS review_state,
           (SELECT count(*) FROM public.compliance_policy_acknowledgements a
             WHERE a.version_id = c.id AND a.acknowledged_by IN (SELECT id FROM active_staff)) AS acks
      FROM public.compliance_policies p
      LEFT JOIN public.compliance_policy_versions c ON c.policy_slug = p.slug AND c.status = 'approved'
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'active_staff', (SELECT count(*) FROM active_staff),
    'policies_total', (SELECT count(*) FROM per),
    'never_approved', (SELECT count(*) FROM per WHERE review_state = 'never_approved'),
    'content_changed', (SELECT count(*) FROM per WHERE review_state = 'content_changed'),
    'overdue', (SELECT count(*) FROM per WHERE review_state = 'overdue'),
    'review_due', (SELECT count(*) FROM per WHERE review_state = 'review_due'),
    'current', (SELECT count(*) FROM per WHERE review_state = 'current'),
    'self_approved_current', (SELECT count(*) FROM per WHERE version_id IS NOT NULL AND self_approved),
    'pending_acknowledgements', (SELECT coalesce(sum(greatest((SELECT count(*) FROM active_staff) - acks, 0)), 0)
                                   FROM per WHERE version_id IS NOT NULL AND requires_acknowledgement),
    'unsynced_hashes', (SELECT count(*) FROM public.compliance_policies WHERE repo_sha256 IS NULL),
    'by_policy', coalesce((SELECT jsonb_agg(jsonb_build_object('slug', slug, 'review_state', review_state, 'acknowledged', acks) ORDER BY slug) FROM per), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.compliance_workforce_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH per AS (
    SELECT r.requirement_key, r.required,
           count(*) FILTER (WHERE m.state = 'current') AS n_current,
           count(*) FILTER (WHERE m.state = 'waived')  AS n_waived,
           count(*) FILTER (WHERE m.state = 'expired') AS n_expired,
           count(*) FILTER (WHERE m.state = 'missing') AS n_missing
      FROM public.compliance_workforce_requirements r
      LEFT JOIN public.compliance_workforce_matrix() m ON m.requirement_key = r.requirement_key
     GROUP BY r.requirement_key, r.required
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'active_staff', (SELECT count(*) FROM public.profiles WHERE is_staff AND status = 'active'),
    'requirements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'requirement_key', requirement_key, 'required', required,
        'current', n_current, 'waived', n_waived, 'expired', n_expired, 'missing', n_missing) ORDER BY requirement_key) FROM per), '[]'::jsonb)
  );
$$;

-- =============================================================
-- 9) PRIVILEGES
-- =============================================================
REVOKE ALL ON FUNCTION public.staff_policy_submit_version(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_policy_approve_version(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_policy_withdraw_version(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_policy_acknowledge(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_policy_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_policy_ack_matrix(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_workforce_record_add(uuid, text, text, text, date, date, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_workforce_record_void(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_workforce_set_requirement(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_workforce_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_policy_review_state(boolean, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_sync_policy_hashes(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_policy_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_workforce_summary() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.staff_policy_submit_version(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_policy_approve_version(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_policy_withdraw_version(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_policy_acknowledge(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_policy_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_policy_ack_matrix(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_workforce_record_add(uuid, text, text, text, date, date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_workforce_record_void(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_workforce_set_requirement(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_workforce_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_policy_review_state(boolean, date, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compliance_sync_policy_hashes(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_policy_summary() TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_workforce_summary() TO service_role;
