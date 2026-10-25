/*
  # Safety Data Sheet (SDS) / Hazmat Library

  ## Why
  Crews handle refrigerants, solvents, cleaners, flux and chemicals every day.
  Every one of them needs a Safety Data Sheet that anyone on the account can
  open in seconds, and the owner needs PROOF that a technician reviewed the
  right sheet for a given job. This adds a searchable SDS library that can be
  attached to jobs and to individual job checklist items.

  ## Model
  - sds_documents         one row per product sheet (hazard info + optional PDF)
  - sds_job_links         SDS <-> job, optionally pinned to one job checklist item
  - sds_acknowledgements  append-only proof: who reviewed which SDS on which job

  ## Security
  - Tenancy: user_id = public.get_account_owner_id() (owner + team share a scope).
  - READ: every member of the account (a technician in the field must be able
    to open a sheet; hiding safety data behind a manager permission would be
    wrong).
  - WRITE sheets / files: owner, or a team member with can_manage_team
    (can_manage_sds()).
  - Linking and acknowledging go through SECURITY DEFINER RPCs that re-validate
    the account, the job and the checklist item on the server.
  - Acknowledgements have no UPDATE/DELETE policy (append-only).
  - Sheets are archived, never deleted, so job history keeps its references.
  - Private storage bucket `sds-files`, folder = account owner id.

  ## Depends on
  20260821101104_create_profiles_and_team_members.sql (profiles, team_members, get_account_owner_id)
  20261103000000_enterprise_identity_security.sql (custom_roles, team_members.custom_role_id)
  20270410000000_job_templates.sql (jobs, job_checklist_items)
*/

-- =============================================================
-- 1. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_sds()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM team_members t
      LEFT JOIN custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_manage_team')::boolean,
              (t.permissions ->> 'can_manage_team')::boolean,
              false
            )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_sds() TO authenticated;

CREATE OR REPLACE FUNCTION public.sds_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS sds_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  product_name text NOT NULL CHECK (char_length(btrim(product_name)) BETWEEN 1 AND 160),
  manufacturer text CHECK (manufacturer IS NULL OR char_length(manufacturer) <= 160),
  product_code text CHECK (product_code IS NULL OR char_length(product_code) <= 80),
  cas_numbers text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(cas_numbers) <= 30),
  signal_word text NOT NULL DEFAULT 'none' CHECK (signal_word IN ('danger', 'warning', 'none')),
  hazard_classes text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (
      cardinality(hazard_classes) <= 12
      AND hazard_classes <@ ARRAY[
        'explosive', 'flammable', 'oxidizer', 'compressed_gas', 'corrosive',
        'toxic', 'health_hazard', 'irritant', 'environmental'
      ]::text[]
    ),
  hazard_statements text CHECK (hazard_statements IS NULL OR char_length(hazard_statements) <= 4000),
  first_aid text CHECK (first_aid IS NULL OR char_length(first_aid) <= 4000),
  ppe text CHECK (ppe IS NULL OR char_length(ppe) <= 2000),
  storage_notes text CHECK (storage_notes IS NULL OR char_length(storage_notes) <= 2000),
  location text CHECK (location IS NULL OR char_length(location) <= 200),
  revision_date date,
  review_due_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  file_path text CHECK (file_path IS NULL OR char_length(file_path) <= 500),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 255),
  file_mime text CHECK (file_mime IS NULL OR char_length(file_mime) <= 120),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sds_documents_owner_status ON sds_documents (user_id, status);
CREATE INDEX IF NOT EXISTS idx_sds_documents_owner_name ON sds_documents (user_id, lower(product_name));

CREATE TABLE IF NOT EXISTS sds_job_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sds_id uuid NOT NULL REFERENCES sds_documents(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  checklist_item_id uuid REFERENCES job_checklist_items(id) ON DELETE CASCADE,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sds_job_links_target ON sds_job_links (
  sds_id, job_id, COALESCE(checklist_item_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_sds_job_links_job ON sds_job_links (job_id);
CREATE INDEX IF NOT EXISTS idx_sds_job_links_sds ON sds_job_links (sds_id);

CREATE TABLE IF NOT EXISTS sds_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sds_id uuid NOT NULL REFERENCES sds_documents(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ack_user_id uuid NOT NULL,
  ack_name text NOT NULL CHECK (char_length(btrim(ack_name)) BETWEEN 2 AND 120),
  sds_revision_date date,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sds_id, job_id, ack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_sds_ack_job ON sds_acknowledgements (job_id);

DROP TRIGGER IF EXISTS trg_sds_documents_updated_at ON sds_documents;
CREATE TRIGGER trg_sds_documents_updated_at
  BEFORE UPDATE ON sds_documents
  FOR EACH ROW EXECUTE FUNCTION public.sds_touch_updated_at();

-- =============================================================
-- 3. RLS
-- =============================================================

ALTER TABLE sds_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sds_job_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sds_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_select_sds_documents" ON sds_documents;
CREATE POLICY "member_select_sds_documents" ON sds_documents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "manager_insert_sds_documents" ON sds_documents;
CREATE POLICY "manager_insert_sds_documents" ON sds_documents FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_sds());

DROP POLICY IF EXISTS "manager_update_sds_documents" ON sds_documents;
CREATE POLICY "manager_update_sds_documents" ON sds_documents FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_sds())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_sds());

DROP POLICY IF EXISTS "member_select_sds_job_links" ON sds_job_links;
CREATE POLICY "member_select_sds_job_links" ON sds_job_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "member_select_sds_acknowledgements" ON sds_acknowledgements;
CREATE POLICY "member_select_sds_acknowledgements" ON sds_acknowledgements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. RPC: attach_sds_to_job
-- =============================================================

CREATE OR REPLACE FUNCTION public.attach_sds_to_job(
  p_sds_id uuid,
  p_job_id uuid,
  p_checklist_item_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_zero uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sds_documents d
    WHERE d.id = p_sds_id AND d.user_id = v_owner AND d.status = 'active'
  ) THEN
    RAISE EXCEPTION 'sds_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;
  IF p_checklist_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_checklist_items c WHERE c.id = p_checklist_item_id AND c.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'checklist_item_not_found';
  END IF;

  SELECT l.id INTO v_id
  FROM sds_job_links l
  WHERE l.sds_id = p_sds_id
    AND l.job_id = p_job_id
    AND COALESCE(l.checklist_item_id, v_zero) = COALESCE(p_checklist_item_id, v_zero);
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  BEGIN
    INSERT INTO sds_job_links (user_id, sds_id, job_id, checklist_item_id, note)
    VALUES (v_owner, p_sds_id, p_job_id, p_checklist_item_id, v_note)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT l.id INTO v_id
    FROM sds_job_links l
    WHERE l.sds_id = p_sds_id
      AND l.job_id = p_job_id
      AND COALESCE(l.checklist_item_id, v_zero) = COALESCE(p_checklist_item_id, v_zero);
  END;

  RETURN v_id;
END;
$$;

-- =============================================================
-- 5. RPC: detach_sds_from_job
-- =============================================================

CREATE OR REPLACE FUNCTION public.detach_sds_from_job(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_deleted integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  DELETE FROM sds_job_links l
  WHERE l.id = p_link_id
    AND l.user_id = v_owner
    AND (l.created_by = auth.uid() OR public.can_manage_sds());
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- =============================================================
-- 6. RPC: acknowledge_sds_for_job  (append-only proof of review)
-- =============================================================

CREATE OR REPLACE FUNCTION public.acknowledge_sds_for_job(
  p_sds_id uuid,
  p_job_id uuid,
  p_name text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text := btrim(COALESCE(p_name, ''));
  v_rev date;
  v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'name_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sds_job_links l
    WHERE l.sds_id = p_sds_id AND l.job_id = p_job_id AND l.user_id = v_owner
  ) THEN
    RAISE EXCEPTION 'sds_not_attached';
  END IF;

  SELECT d.revision_date INTO v_rev
  FROM sds_documents d
  WHERE d.id = p_sds_id AND d.user_id = v_owner;

  INSERT INTO sds_acknowledgements (user_id, sds_id, job_id, ack_user_id, ack_name, sds_revision_date)
  VALUES (v_owner, p_sds_id, p_job_id, auth.uid(), v_name, v_rev)
  ON CONFLICT (sds_id, job_id, ack_user_id) DO NOTHING;

  SELECT a.acknowledged_at INTO v_at
  FROM sds_acknowledgements a
  WHERE a.sds_id = p_sds_id AND a.job_id = p_job_id AND a.ack_user_id = auth.uid();

  RETURN v_at;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_sds_to_job(uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.detach_sds_from_job(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acknowledge_sds_for_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_sds_to_job(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detach_sds_from_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_sds_for_job(uuid, uuid, text) TO authenticated;

-- =============================================================
-- 7. STORAGE: private bucket, folder = account owner id
--    Path layout: <account_owner_id>/<uuid>-<safe_name>
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sds-files', 'sds-files', false, 26214400, -- 25 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "sds_files_read_account" ON storage.objects;
CREATE POLICY "sds_files_read_account" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sds-files' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "sds_files_insert_manager" ON storage.objects;
CREATE POLICY "sds_files_insert_manager" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'sds-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sds()
  );

DROP POLICY IF EXISTS "sds_files_update_manager" ON storage.objects;
CREATE POLICY "sds_files_update_manager" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'sds-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sds()
  );

DROP POLICY IF EXISTS "sds_files_delete_manager" ON storage.objects;
CREATE POLICY "sds_files_delete_manager" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'sds-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sds()
  );

COMMENT ON TABLE sds_acknowledgements IS
  'Append-only proof that a person reviewed a Safety Data Sheet for a job. No UPDATE/DELETE policy by design.';
