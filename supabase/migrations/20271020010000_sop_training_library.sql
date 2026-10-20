/*
  # SOP & Training Library

  ## Why
  Owners need one place to keep standard operating procedures, make sure the
  right people have read them, and be able to PROVE it (who, which version,
  when). This adds written/uploaded SOPs, role/person assignment, quizzes,
  read-and-acknowledge with a server timestamp, completion tracking, and links
  from SOPs to job templates and to individual template checklist items.

  ## Model
  - sop_documents        working copy (draft being edited) + published_version
  - sop_versions         IMMUTABLE snapshot written on every publish (what people
                         actually read and acknowledged)
  - sop_quiz_questions   working-copy quiz (answers never readable by learners)
  - sop_version_quiz     IMMUTABLE quiz snapshot per published version (graded server-side)
  - sop_assignments      who must complete it: everyone | role | custom role | person
  - sop_acknowledgements one row per (sop, version, person); server timestamp; append-only
  - sop_quiz_attempts    every attempt, graded in the database
  - sop_template_links   SOP <-> job_templates
  - sop_checklist_links  SOP <-> a template checklist item, keyed by item LABEL
                         (save_job_template deletes and re-inserts checklist rows,
                         so a row-id key would silently break on every template edit)

  ## Why academy_progress is NOT reused
  academy_progress is per-user and award_academy_badge_if_complete() counts every
  row for the user against the static lesson total. Writing SOP rows there would
  award the Academy badge early. It also has no version, no account scope and no
  quiz. We reuse the Academy PATTERNS instead (own-row completion, server-side
  verification, idempotent writes) and the shared tenancy/permission helpers.

  ## Security
  - Tenancy: user_id = public.get_account_owner_id() (owner + team share a scope).
  - Managing SOPs: can_manage_sops() = account owner, or a team member whose
    effective can_manage_team is true (custom role overrides base flags).
  - ALL table reads are manager-only. Learners read through SECURITY DEFINER RPCs
    that never return quiz answers and only expose the published snapshot.
  - Writes go through RPCs (save_sop, publish_sop, ...). The only direct table
    write policy is deleting a never-published draft.
  - Acknowledgements/versions have no UPDATE/DELETE policy (append-only).
  - Private storage bucket `sop-files`, folder = account owner id.

  ## Depends on
  20260821101104_create_profiles_and_team_members.sql (profiles, team_members, get_account_owner_id)
  20260925000000_team_invite_tokens.sql (team_members.user_id)
  20261103000000_enterprise_identity_security.sql (custom_roles, team_members.custom_role_id)
  20270410000000_job_templates.sql (job_templates)
  public.set_updated_at() from 20261122000000_compliance_dispatch_gate.sql
*/

-- =============================================================
-- 1. PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_sops()
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

GRANT EXECUTE ON FUNCTION public.can_manage_sops() TO authenticated;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS sop_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 600),
  category text CHECK (category IS NULL OR char_length(category) <= 80),
  body_md text CHECK (body_md IS NULL OR char_length(body_md) <= 60000),
  file_path text CHECK (file_path IS NULL OR char_length(file_path) <= 500),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 255),
  file_mime text CHECK (file_mime IS NULL OR char_length(file_mime) <= 120),
  pass_score_pct integer NOT NULL DEFAULT 80 CHECK (pass_score_pct BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_version integer NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sop_documents_owner_status ON sop_documents (user_id, status);

CREATE TABLE IF NOT EXISTS sop_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL,
  summary text,
  category text,
  body_md text,
  file_path text,
  file_name text,
  file_mime text,
  change_note text CHECK (change_note IS NULL OR char_length(change_note) <= 500),
  published_by uuid DEFAULT auth.uid(),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sop_id, version)
);

CREATE TABLE IF NOT EXISTS sop_quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  prompt text NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 400),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
  correct_index integer NOT NULL CHECK (correct_index BETWEEN 0 AND 5),
  explanation text CHECK (explanation IS NULL OR char_length(explanation) <= 600)
);

CREATE INDEX IF NOT EXISTS idx_sop_quiz_questions_sop ON sop_quiz_questions (sop_id, sort_order);

CREATE TABLE IF NOT EXISTS sop_version_quiz (
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  user_id uuid NOT NULL,
  pass_score_pct integer NOT NULL CHECK (pass_score_pct BETWEEN 1 AND 100),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  PRIMARY KEY (sop_id, version)
);

CREATE TABLE IF NOT EXISTS sop_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('everyone', 'role', 'custom_role', 'member')),
  target_role text CHECK (target_role IS NULL OR target_role IN ('owner', 'admin', 'technician', 'member')),
  target_custom_role_id uuid REFERENCES custom_roles(id) ON DELETE CASCADE,
  target_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  due_at timestamptz,
  assigned_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sop_assignment_target_shape CHECK (
    (target_type = 'everyone' AND target_role IS NULL AND target_custom_role_id IS NULL AND target_member_id IS NULL) OR
    (target_type = 'role' AND target_role IS NOT NULL AND target_custom_role_id IS NULL AND target_member_id IS NULL) OR
    (target_type = 'custom_role' AND target_custom_role_id IS NOT NULL AND target_role IS NULL AND target_member_id IS NULL) OR
    (target_type = 'member' AND target_member_id IS NOT NULL AND target_role IS NULL AND target_custom_role_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sop_assignments_target ON sop_assignments (
  sop_id, target_type,
  COALESCE(target_role, ''),
  COALESCE(target_custom_role_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(target_member_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_sop_assignments_owner ON sop_assignments (user_id, sop_id);

CREATE TABLE IF NOT EXISTS sop_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                   -- account owner (tenant)
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  ack_user_id uuid NOT NULL,
  ack_name text NOT NULL CHECK (char_length(btrim(ack_name)) BETWEEN 2 AND 120),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sop_id, version, ack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_sop_ack_person ON sop_acknowledgements (user_id, ack_user_id);

CREATE TABLE IF NOT EXISTS sop_quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  taker_user_id uuid NOT NULL,
  score_pct integer NOT NULL CHECK (score_pct BETWEEN 0 AND 100),
  passed boolean NOT NULL,
  answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sop_attempts_person ON sop_quiz_attempts (sop_id, version, taker_user_id);

CREATE TABLE IF NOT EXISTS sop_template_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES job_templates(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sop_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_sop_template_links_template ON sop_template_links (template_id);

CREATE TABLE IF NOT EXISTS sop_checklist_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sop_id uuid NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES job_templates(id) ON DELETE CASCADE,
  item_label text NOT NULL CHECK (char_length(btrim(item_label)) BETWEEN 1 AND 200),
  item_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sop_id, template_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_sop_checklist_links_template ON sop_checklist_links (template_id);

DROP TRIGGER IF EXISTS trg_sop_documents_updated_at ON sop_documents;
CREATE TRIGGER trg_sop_documents_updated_at
  BEFORE UPDATE ON sop_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 3. RLS  (reads: managers only; learners use RPCs below)
-- =============================================================

-- RLS is enabled explicitly per table (linted by scripts/lint-migrations.mjs).
ALTER TABLE sop_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_version_quiz ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_template_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_checklist_links ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sop_documents', 'sop_versions', 'sop_quiz_questions', 'sop_version_quiz',
    'sop_assignments', 'sop_acknowledgements', 'sop_quiz_attempts',
    'sop_template_links', 'sop_checklist_links'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "manager_select_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "manager_select_%1$s" ON %1$I FOR SELECT TO authenticated
         USING (user_id = public.get_account_owner_id() AND public.can_manage_sops())', t);
  END LOOP;
END $$;

-- A never-published draft can be deleted directly; anything published is archived instead.
DROP POLICY IF EXISTS "manager_delete_draft_sop_documents" ON sop_documents;
CREATE POLICY "manager_delete_draft_sop_documents" ON sop_documents FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND public.can_manage_sops()
    AND published_version = 0
  );

-- =============================================================
-- 4. ROSTER + PROGRESS HELPERS (internal; not granted to clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sop_roster(p_owner uuid)
RETURNS TABLE (user_id uuid, team_member_id uuid, full_name text, email text, role text, custom_role_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, NULL::uuid, COALESCE(NULLIF(btrim(p.full_name), ''), p.email), p.email, 'owner'::text, NULL::uuid
  FROM profiles p
  WHERE p.id = p_owner
  UNION ALL
  SELECT
    COALESCE(tm.user_id, (SELECT u.id FROM auth.users u WHERE u.email = tm.member_email LIMIT 1)),
    tm.id,
    COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
    tm.member_email,
    tm.role,
    tm.custom_role_id
  FROM team_members tm
  WHERE tm.account_owner_id = p_owner
    AND tm.invite_status IN ('active', 'accepted')
    AND COALESCE(tm.user_id, (SELECT u.id FROM auth.users u WHERE u.email = tm.member_email LIMIT 1)) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.sop_roster(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sop_user_progress(p_owner uuid, p_user uuid, p_sop uuid, p_version integer)
RETURNS TABLE (
  acknowledged_at timestamptz,
  acknowledged_prior boolean,
  quiz_required boolean,
  quiz_passed boolean,
  best_score integer,
  attempts integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT a.acknowledged_at FROM sop_acknowledgements a
      WHERE a.sop_id = p_sop AND a.version = p_version AND a.ack_user_id = p_user),
    EXISTS (SELECT 1 FROM sop_acknowledgements a
      WHERE a.sop_id = p_sop AND a.version < p_version AND a.ack_user_id = p_user),
    COALESCE((SELECT jsonb_array_length(q.questions) > 0 FROM sop_version_quiz q
      WHERE q.sop_id = p_sop AND q.version = p_version), false),
    EXISTS (SELECT 1 FROM sop_quiz_attempts t
      WHERE t.sop_id = p_sop AND t.version = p_version AND t.taker_user_id = p_user AND t.passed),
    (SELECT MAX(t.score_pct) FROM sop_quiz_attempts t
      WHERE t.sop_id = p_sop AND t.version = p_version AND t.taker_user_id = p_user),
    (SELECT COUNT(*)::integer FROM sop_quiz_attempts t
      WHERE t.sop_id = p_sop AND t.version = p_version AND t.taker_user_id = p_user);
$$;

REVOKE ALL ON FUNCTION public.sop_user_progress(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sop_status_rows(p_owner uuid, p_user uuid, p_sop uuid)
RETURNS TABLE (
  sop_id uuid,
  title text,
  summary text,
  category text,
  version integer,
  user_id uuid,
  team_member_id uuid,
  full_name text,
  email text,
  role text,
  due_at timestamptz,
  acknowledged_at timestamptz,
  quiz_required boolean,
  quiz_passed boolean,
  best_score integer,
  attempts integer,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    SELECT * FROM public.sop_roster(p_owner) ro WHERE p_user IS NULL OR ro.user_id = p_user
  ),
  s AS (
    SELECT d.id, d.title, d.summary, d.category, d.published_version
    FROM sop_documents d
    WHERE d.user_id = p_owner AND d.status = 'published' AND d.published_version > 0
      AND (p_sop IS NULL OR d.id = p_sop)
  ),
  a AS (
    SELECT s.id AS sop_id, s.title, s.summary, s.category, s.published_version AS version,
           r.user_id, r.team_member_id, r.full_name, r.email, r.role,
           MIN(x.due_at) AS due_at
    FROM s
    JOIN sop_assignments x ON x.sop_id = s.id AND x.user_id = p_owner
    JOIN r ON x.target_type = 'everyone'
           OR (x.target_type = 'role' AND x.target_role = r.role)
           OR (x.target_type = 'custom_role' AND x.target_custom_role_id = r.custom_role_id)
           OR (x.target_type = 'member' AND x.target_member_id = r.team_member_id)
    GROUP BY s.id, s.title, s.summary, s.category, s.published_version,
             r.user_id, r.team_member_id, r.full_name, r.email, r.role
  )
  SELECT
    a.sop_id, a.title, a.summary, a.category, a.version,
    a.user_id, a.team_member_id, a.full_name, a.email, a.role, a.due_at,
    pr.acknowledged_at, pr.quiz_required, pr.quiz_passed, pr.best_score, pr.attempts,
    CASE
      WHEN pr.acknowledged_at IS NOT NULL AND (NOT pr.quiz_required OR pr.quiz_passed) THEN 'completed'
      WHEN a.due_at IS NOT NULL AND a.due_at < now() THEN 'overdue'
      WHEN pr.acknowledged_prior THEN 'needs_reack'
      WHEN pr.attempts > 0 THEN 'in_progress'
      ELSE 'not_started'
    END
  FROM a
  CROSS JOIN LATERAL public.sop_user_progress(p_owner, a.user_id, a.sop_id, a.version) pr;
$$;

REVOKE ALL ON FUNCTION public.sop_status_rows(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. RPC: save_sop  (atomic upsert of the working copy + quiz + links + assignments)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_sop(p_sop_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_title text := btrim(COALESCE(p_payload ->> 'title', ''));
  v_file text := NULLIF(btrim(COALESCE(p_payload ->> 'file_path', '')), '');
  v_quiz jsonb := COALESCE(p_payload -> 'quiz', '[]'::jsonb);
  v_templates jsonb := COALESCE(p_payload -> 'template_ids', '[]'::jsonb);
  v_items jsonb := COALESCE(p_payload -> 'checklist_links', '[]'::jsonb);
  v_assign jsonb := COALESCE(p_payload -> 'assignments', '[]'::jsonb);
  v_pass integer := COALESCE(NULLIF(p_payload ->> 'pass_score_pct', '')::integer, 80);
  v_count integer;
  v_valid integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_sops() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_title = '' THEN RAISE EXCEPTION 'title_required'; END IF;
  IF v_pass NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_pass_score'; END IF;
  IF jsonb_typeof(v_quiz) <> 'array' OR jsonb_typeof(v_templates) <> 'array'
     OR jsonb_typeof(v_items) <> 'array' OR jsonb_typeof(v_assign) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF jsonb_array_length(v_quiz) > 50 OR jsonb_array_length(v_templates) > 100
     OR jsonb_array_length(v_items) > 300 OR jsonb_array_length(v_assign) > 100 THEN
    RAISE EXCEPTION 'too_many_lines';
  END IF;
  IF v_file IS NOT NULL AND split_part(v_file, '/', 1) <> v_owner::text THEN
    RAISE EXCEPTION 'file_outside_account' USING ERRCODE = '42501';
  END IF;

  -- quiz sanity: every correct_index must point at an existing option
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_quiz) q
    WHERE jsonb_typeof(q -> 'options') <> 'array'
       OR jsonb_array_length(q -> 'options') NOT BETWEEN 2 AND 6
       OR COALESCE((q ->> 'correct_index')::integer, -1) NOT BETWEEN 0 AND jsonb_array_length(q -> 'options') - 1
       OR btrim(COALESCE(q ->> 'prompt', '')) = ''
  ) THEN
    RAISE EXCEPTION 'invalid_quiz';
  END IF;

  -- templates must belong to this account
  SELECT count(DISTINCT t.value #>> '{}') INTO v_count FROM jsonb_array_elements(v_templates) t;
  SELECT count(*) INTO v_valid FROM job_templates jt
    WHERE jt.user_id = v_owner
      AND jt.id IN (SELECT (t.value #>> '{}')::uuid FROM jsonb_array_elements(v_templates) t);
  IF v_valid <> v_count THEN RAISE EXCEPTION 'invalid_template'; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) i
    WHERE NOT EXISTS (SELECT 1 FROM job_templates jt
      WHERE jt.user_id = v_owner AND jt.id = NULLIF(i ->> 'template_id', '')::uuid)
       OR btrim(COALESCE(i ->> 'item_label', '')) = ''
  ) THEN
    RAISE EXCEPTION 'invalid_template';
  END IF;

  -- assignment targets must belong to this account
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_assign) a
    WHERE a ->> 'target_type' NOT IN ('everyone', 'role', 'custom_role', 'member')
       OR (a ->> 'target_type' = 'role' AND COALESCE(a ->> 'target_role', '') NOT IN ('owner', 'admin', 'technician', 'member'))
       OR (a ->> 'target_type' = 'custom_role' AND NOT EXISTS (
            SELECT 1 FROM custom_roles cr WHERE cr.user_id = v_owner AND cr.id = NULLIF(a ->> 'target_custom_role_id', '')::uuid))
       OR (a ->> 'target_type' = 'member' AND NOT EXISTS (
            SELECT 1 FROM team_members tm WHERE tm.account_owner_id = v_owner AND tm.id = NULLIF(a ->> 'target_member_id', '')::uuid))
  ) THEN
    RAISE EXCEPTION 'invalid_assignment';
  END IF;

  IF p_sop_id IS NULL THEN
    INSERT INTO sop_documents (user_id, title, summary, category, body_md, file_path, file_name, file_mime, pass_score_pct)
    VALUES (
      v_owner, v_title,
      NULLIF(btrim(COALESCE(p_payload ->> 'summary', '')), ''),
      NULLIF(btrim(COALESCE(p_payload ->> 'category', '')), ''),
      NULLIF(btrim(COALESCE(p_payload ->> 'body_md', '')), ''),
      v_file,
      CASE WHEN v_file IS NULL THEN NULL ELSE NULLIF(btrim(COALESCE(p_payload ->> 'file_name', '')), '') END,
      CASE WHEN v_file IS NULL THEN NULL ELSE NULLIF(btrim(COALESCE(p_payload ->> 'file_mime', '')), '') END,
      v_pass
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE sop_documents SET
      title = v_title,
      summary = NULLIF(btrim(COALESCE(p_payload ->> 'summary', '')), ''),
      category = NULLIF(btrim(COALESCE(p_payload ->> 'category', '')), ''),
      body_md = NULLIF(btrim(COALESCE(p_payload ->> 'body_md', '')), ''),
      file_path = v_file,
      file_name = CASE WHEN v_file IS NULL THEN NULL ELSE NULLIF(btrim(COALESCE(p_payload ->> 'file_name', '')), '') END,
      file_mime = CASE WHEN v_file IS NULL THEN NULL ELSE NULLIF(btrim(COALESCE(p_payload ->> 'file_mime', '')), '') END,
      pass_score_pct = v_pass
    WHERE id = p_sop_id AND user_id = v_owner
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;

    DELETE FROM sop_quiz_questions WHERE sop_id = v_id;
    DELETE FROM sop_template_links WHERE sop_id = v_id;
    DELETE FROM sop_checklist_links WHERE sop_id = v_id;
    DELETE FROM sop_assignments WHERE sop_id = v_id;
  END IF;

  INSERT INTO sop_quiz_questions (user_id, sop_id, sort_order, prompt, options, correct_index, explanation)
  SELECT v_owner, v_id, (q.ordinality - 1)::integer, btrim(q.value ->> 'prompt'), q.value -> 'options',
         (q.value ->> 'correct_index')::integer,
         NULLIF(btrim(COALESCE(q.value ->> 'explanation', '')), '')
  FROM jsonb_array_elements(v_quiz) WITH ORDINALITY AS q(value, ordinality);

  INSERT INTO sop_template_links (user_id, sop_id, template_id)
  SELECT DISTINCT v_owner, v_id, (t.value #>> '{}')::uuid FROM jsonb_array_elements(v_templates) t;

  INSERT INTO sop_checklist_links (user_id, sop_id, template_id, item_label, item_key)
  SELECT DISTINCT ON ((i ->> 'template_id')::uuid, lower(btrim(i ->> 'item_label')))
         v_owner, v_id, (i ->> 'template_id')::uuid, btrim(i ->> 'item_label'), lower(btrim(i ->> 'item_label'))
  FROM jsonb_array_elements(v_items) i;

  INSERT INTO sop_assignments (user_id, sop_id, target_type, target_role, target_custom_role_id, target_member_id, due_at)
  SELECT DISTINCT ON (a ->> 'target_type', COALESCE(a ->> 'target_role', ''), COALESCE(a ->> 'target_custom_role_id', ''), COALESCE(a ->> 'target_member_id', ''))
         v_owner, v_id, a ->> 'target_type',
         CASE WHEN a ->> 'target_type' = 'role' THEN a ->> 'target_role' END,
         CASE WHEN a ->> 'target_type' = 'custom_role' THEN (a ->> 'target_custom_role_id')::uuid END,
         CASE WHEN a ->> 'target_type' = 'member' THEN (a ->> 'target_member_id')::uuid END,
         NULLIF(a ->> 'due_at', '')::timestamptz
  FROM jsonb_array_elements(v_assign) a;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_sop(uuid, jsonb) TO authenticated;

-- =============================================================
-- 6. RPC: publish_sop / archive_sop
-- =============================================================

CREATE OR REPLACE FUNCTION public.publish_sop(p_sop_id uuid, p_change_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d sop_documents;
  v_next integer;
  v_questions jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_sops() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO d FROM sop_documents WHERE id = p_sop_id AND user_id = v_owner FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;
  IF COALESCE(btrim(d.body_md), '') = '' AND d.file_path IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sop_assignments WHERE sop_id = d.id) THEN
    RAISE EXCEPTION 'assignment_required';
  END IF;

  v_next := d.published_version + 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'prompt', q.prompt, 'options', q.options,
           'correct_index', q.correct_index, 'explanation', q.explanation
         ) ORDER BY q.sort_order), '[]'::jsonb)
    INTO v_questions FROM sop_quiz_questions q WHERE q.sop_id = d.id;

  INSERT INTO sop_versions (user_id, sop_id, version, title, summary, category, body_md, file_path, file_name, file_mime, change_note)
  VALUES (v_owner, d.id, v_next, d.title, d.summary, d.category, d.body_md, d.file_path, d.file_name, d.file_mime,
          NULLIF(btrim(COALESCE(p_change_note, '')), ''));

  INSERT INTO sop_version_quiz (sop_id, version, user_id, pass_score_pct, questions)
  VALUES (d.id, v_next, v_owner, d.pass_score_pct, v_questions);

  UPDATE sop_documents SET status = 'published', published_version = v_next WHERE id = d.id;
  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION public.publish_sop(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_sop(p_sop_id uuid, p_archived boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_found uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_sops() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  UPDATE sop_documents SET
    status = CASE WHEN p_archived THEN 'archived'
                  WHEN published_version > 0 THEN 'published'
                  ELSE 'draft' END
  WHERE id = p_sop_id AND user_id = v_owner
  RETURNING id INTO v_found;
  IF v_found IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.archive_sop(uuid, boolean) TO authenticated;

-- =============================================================
-- 7. RPCs for learners
-- =============================================================

CREATE OR REPLACE FUNCTION public.my_sop_training()
RETURNS TABLE (
  sop_id uuid, title text, summary text, category text, version integer,
  due_at timestamptz, acknowledged_at timestamptz,
  quiz_required boolean, quiz_passed boolean, best_score integer, attempts integer, status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT r.sop_id, r.title, r.summary, r.category, r.version, r.due_at, r.acknowledged_at,
         r.quiz_required, r.quiz_passed, r.best_score, r.attempts, r.status
  FROM public.sop_status_rows(v_owner, auth.uid(), NULL) r
  ORDER BY
    CASE r.status WHEN 'overdue' THEN 0 WHEN 'needs_reack' THEN 1 WHEN 'in_progress' THEN 2
                  WHEN 'not_started' THEN 3 ELSE 4 END,
    r.due_at NULLS LAST, r.title;
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_sop_training() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_sop_reader(p_sop_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d sop_documents;
  v sop_versions;
  qz sop_version_quiz;
  pr record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO d FROM sop_documents WHERE id = p_sop_id AND user_id = v_owner AND status = 'published' AND published_version > 0;
  IF d.id IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v FROM sop_versions WHERE sop_id = d.id AND version = d.published_version;
  SELECT * INTO qz FROM sop_version_quiz WHERE sop_id = d.id AND version = d.published_version;
  SELECT * INTO pr FROM public.sop_user_progress(v_owner, auth.uid(), d.id, d.published_version);

  RETURN jsonb_build_object(
    'sop_id', d.id, 'version', v.version, 'title', v.title, 'summary', v.summary, 'category', v.category,
    'body_md', v.body_md, 'file_path', v.file_path, 'file_name', v.file_name, 'file_mime', v.file_mime,
    'change_note', v.change_note, 'published_at', v.published_at,
    'pass_score_pct', COALESCE(qz.pass_score_pct, 80),
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('prompt', q ->> 'prompt', 'options', q -> 'options') ORDER BY o)
      FROM jsonb_array_elements(COALESCE(qz.questions, '[]'::jsonb)) WITH ORDINALITY AS t(q, o)
    ), '[]'::jsonb),
    'my', jsonb_build_object(
      'acknowledged_at', pr.acknowledged_at, 'quiz_required', pr.quiz_required,
      'quiz_passed', pr.quiz_passed, 'best_score', pr.best_score, 'attempts', pr.attempts
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sop_reader(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_sop_quiz(p_sop_id uuid, p_answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d sop_documents;
  qz sop_version_quiz;
  v_total integer;
  v_correct integer := 0;
  v_wrong jsonb := '[]'::jsonb;
  v_score integer;
  v_passed boolean;
  i integer;
  v_given text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  SELECT * INTO d FROM sop_documents WHERE id = p_sop_id AND user_id = v_owner AND status = 'published' AND published_version > 0;
  IF d.id IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO qz FROM sop_version_quiz WHERE sop_id = d.id AND version = d.published_version;
  v_total := COALESCE(jsonb_array_length(qz.questions), 0);
  IF v_total = 0 THEN RAISE EXCEPTION 'no_quiz'; END IF;
  IF jsonb_array_length(p_answers) <> v_total THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  FOR i IN 0 .. v_total - 1 LOOP
    v_given := p_answers ->> i;
    IF v_given IS NOT NULL AND v_given ~ '^[0-9]$'
       AND v_given::integer = (qz.questions -> i ->> 'correct_index')::integer THEN
      v_correct := v_correct + 1;
    ELSE
      v_wrong := v_wrong || to_jsonb(i);
    END IF;
  END LOOP;

  v_score := round(v_correct * 100.0 / v_total)::integer;
  v_passed := v_score >= qz.pass_score_pct;

  INSERT INTO sop_quiz_attempts (user_id, sop_id, version, taker_user_id, score_pct, passed, answers)
  VALUES (v_owner, d.id, d.published_version, auth.uid(), v_score, v_passed, p_answers);

  RETURN jsonb_build_object(
    'score_pct', v_score, 'passed', v_passed, 'correct', v_correct, 'total', v_total,
    'pass_score_pct', qz.pass_score_pct,
    'wrong', CASE WHEN v_passed THEN '[]'::jsonb ELSE v_wrong END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_sop_quiz(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_sop(p_sop_id uuid, p_typed_name text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d sop_documents;
  pr record;
  v_name text := btrim(COALESCE(p_typed_name, ''));
  v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF char_length(v_name) < 2 THEN RAISE EXCEPTION 'name_required'; END IF;
  SELECT * INTO d FROM sop_documents WHERE id = p_sop_id AND user_id = v_owner AND status = 'published' AND published_version > 0;
  IF d.id IS NULL THEN RAISE EXCEPTION 'sop_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO pr FROM public.sop_user_progress(v_owner, auth.uid(), d.id, d.published_version);
  IF pr.quiz_required AND NOT pr.quiz_passed THEN RAISE EXCEPTION 'quiz_not_passed'; END IF;

  INSERT INTO sop_acknowledgements (user_id, sop_id, version, ack_user_id, ack_name)
  VALUES (v_owner, d.id, d.published_version, auth.uid(), v_name)
  ON CONFLICT (sop_id, version, ack_user_id) DO NOTHING;

  SELECT a.acknowledged_at INTO v_at FROM sop_acknowledgements a
   WHERE a.sop_id = d.id AND a.version = d.published_version AND a.ack_user_id = auth.uid();
  RETURN v_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_sop(uuid, text) TO authenticated;

-- =============================================================
-- 8. RPCs for managers: completion tracking
-- =============================================================

CREATE OR REPLACE FUNCTION public.sop_completion_report(p_sop_id uuid DEFAULT NULL)
RETURNS TABLE (
  sop_id uuid, title text, version integer, user_id uuid, team_member_id uuid,
  full_name text, email text, role text, due_at timestamptz, acknowledged_at timestamptz,
  quiz_required boolean, quiz_passed boolean, best_score integer, attempts integer, status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_sops() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.sop_id, r.title, r.version, r.user_id, r.team_member_id, r.full_name, r.email, r.role,
         r.due_at, r.acknowledged_at, r.quiz_required, r.quiz_passed, r.best_score, r.attempts, r.status
  FROM public.sop_status_rows(v_owner, NULL, p_sop_id) r
  ORDER BY r.title, r.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sop_completion_report(uuid) TO authenticated;

-- =============================================================
-- 9. RPC: SOPs attached to a job template (read by anyone on the account)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sops_for_job_template(p_template_id uuid)
RETURNS TABLE (
  sop_id uuid, title text, summary text, category text, version integer,
  linked_items text[], status text, due_at timestamptz, acknowledged_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT
    d.id, d.title, d.summary, d.category, d.published_version,
    COALESCE((SELECT array_agg(cl.item_label ORDER BY cl.item_label)
              FROM sop_checklist_links cl
              WHERE cl.sop_id = d.id AND cl.template_id = p_template_id), ARRAY[]::text[]),
    CASE
      WHEN pr.acknowledged_at IS NOT NULL AND (NOT pr.quiz_required OR pr.quiz_passed) THEN 'completed'
      WHEN st.status IS NOT NULL THEN st.status
      ELSE 'reference'
    END,
    st.due_at,
    pr.acknowledged_at
  FROM sop_documents d
  CROSS JOIN LATERAL public.sop_user_progress(v_owner, auth.uid(), d.id, d.published_version) pr
  LEFT JOIN LATERAL (
    SELECT s.status, s.due_at FROM public.sop_status_rows(v_owner, auth.uid(), d.id) s LIMIT 1
  ) st ON true
  WHERE d.user_id = v_owner
    AND d.status = 'published'
    AND d.published_version > 0
    AND (
      EXISTS (SELECT 1 FROM sop_template_links tl WHERE tl.sop_id = d.id AND tl.template_id = p_template_id)
      OR EXISTS (SELECT 1 FROM sop_checklist_links cl WHERE cl.sop_id = d.id AND cl.template_id = p_template_id)
    )
  ORDER BY d.title;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sops_for_job_template(uuid) TO authenticated;

-- =============================================================
-- 10. STORAGE: private bucket, folder = account owner id
--     Path layout: <account_owner_id>/<sop_id_or_new>/<uuid>-<safe_name>
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sop-files', 'sop-files', false, 52428800, -- 50 MB
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'video/mp4'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "sop_files_read_account" ON storage.objects;
CREATE POLICY "sop_files_read_account" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sop-files' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "sop_files_insert_manager" ON storage.objects;
CREATE POLICY "sop_files_insert_manager" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'sop-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sops()
  );

DROP POLICY IF EXISTS "sop_files_update_manager" ON storage.objects;
CREATE POLICY "sop_files_update_manager" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'sop-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sops()
  );

DROP POLICY IF EXISTS "sop_files_delete_manager" ON storage.objects;
CREATE POLICY "sop_files_delete_manager" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'sop-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_sops()
  );

COMMENT ON TABLE sop_acknowledgements IS
  'Append-only proof that a person read a specific SOP version. Written only by acknowledge_sop(); server timestamp.';
COMMENT ON TABLE sop_versions IS
  'Immutable snapshot of what was published. Learners read this, never the working copy in sop_documents.';
