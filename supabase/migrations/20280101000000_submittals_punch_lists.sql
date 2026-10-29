/*
  # Submittals + Punch Lists (Install Projects)

  Submittals: spec section, type, reviewer, revisions (Rev 0, 1, 2 ...) and a
  status workflow. Punch lists: item, location, photos, assignee and a
  verify / close workflow. Both share ONE attachments table + private bucket.

  - Purely additive: new tables, functions, policies and one storage bucket.
  - Owner is forced by the existing install_projects_force_owner() trigger.
  - Status changes happen ONLY through the RPCs install_submittal_transition()
    and install_punch_transition(); a direct UPDATE of a workflow column is
    rejected by the guard triggers ('flow_only').
  - Access: every account member can read; reviewers (owner, admin/manager,
    can_manage_team or can_view_billing) manage submittals; any member can
    report a punch item and attach photos; an assignee can start / mark fixed.
  - Revisions, attachments and events are written by the database only.
*/

-- =============================================================
-- 0. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_review_install_items()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.get_account_owner_id() IS NOT NULL
    AND (
      NOT EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
        WHERE tm.user_id = auth.uid()
          AND (
            tm.role IN ('admin', 'manager')
            OR COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true'
            OR COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
            OR COALESCE(cr.permissions ->> 'can_manage_team', 'false') = 'true'
            OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
          )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.install_actor_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(btrim(tm.member_name), '') FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1),
    (SELECT u.email::text FROM auth.users u WHERE u.id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.can_review_install_items() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.install_actor_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_review_install_items() TO authenticated;
GRANT EXECUTE ON FUNCTION public.install_actor_name() TO authenticated;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS install_submittals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  seq integer NOT NULL,
  spec_section text NOT NULL CHECK (spec_section ~ '^[0-9]{2}( [0-9]{2}){0,2}(\.[0-9]{1,2})?$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  submittal_type text NOT NULL DEFAULT 'product_data'
    CHECK (submittal_type IN ('product_data', 'shop_drawing', 'sample', 'mock_up', 'test_report', 'certificate', 'warranty', 'om_manual', 'other')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected', 'void')),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision BETWEEN 0 AND 25),
  reviewer_name text CHECK (reviewer_name IS NULL OR length(btrim(reviewer_name)) BETWEEN 1 AND 120),
  reviewer_email text CHECK (reviewer_email IS NULL OR reviewer_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  due_date date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_install_submittals_project ON install_submittals(project_id, spec_section, seq);
CREATE INDEX IF NOT EXISTS idx_install_submittals_user_status ON install_submittals(user_id, status);

CREATE TABLE IF NOT EXISTS install_submittal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  submittal_id uuid NOT NULL REFERENCES install_submittals(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number BETWEEN 0 AND 25),
  submitted_at timestamptz,
  submitted_by uuid,
  decision text CHECK (decision IS NULL OR decision IN ('approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),
  decided_at timestamptz,
  decided_by uuid,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submittal_id, revision_number),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision IS NULL OR submitted_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_install_submittal_revisions_project ON install_submittal_revisions(project_id);

CREATE TABLE IF NOT EXISTS install_punch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  seq integer NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  location text NOT NULL CHECK (length(btrim(location)) BETWEEN 1 AND 160),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'ready_for_review', 'verified', 'closed')),
  assignee_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  due_date date,
  fix_note text CHECK (fix_note IS NULL OR length(fix_note) <= 2000),
  fixed_at timestamptz,
  fixed_by uuid,
  verified_at timestamptz,
  verified_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_install_punch_project ON install_punch_items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_install_punch_assignee ON install_punch_items(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_punch_user_status ON install_punch_items(user_id, status);

-- One attachments table for both features (exactly one parent).
CREATE TABLE IF NOT EXISTS install_project_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  submittal_revision_id uuid REFERENCES install_submittal_revisions(id) ON DELETE CASCADE,
  punch_item_id uuid REFERENCES install_punch_items(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'general' CHECK (purpose IN ('package', 'review', 'before', 'after', 'general')),
  storage_path text NOT NULL CHECK (length(storage_path) BETWEEN 1 AND 500),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 150),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  caption text CHECK (caption IS NULL OR length(caption) <= 300),
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(submittal_revision_id, punch_item_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_install_attachments_path ON install_project_attachments(storage_path);
CREATE INDEX IF NOT EXISTS idx_install_attachments_revision ON install_project_attachments(submittal_revision_id) WHERE submittal_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_attachments_punch ON install_project_attachments(punch_item_id) WHERE punch_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_attachments_project ON install_project_attachments(project_id);

-- Append-only history (written by the RPCs only).
CREATE TABLE IF NOT EXISTS install_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('submittal', 'punch')),
  item_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  from_status text,
  to_status text,
  revision_number integer,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  actor_id uuid,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_item_events_item ON install_item_events(item_type, item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_install_item_events_project ON install_item_events(project_id, created_at DESC);

-- =============================================================
-- 2. GUARD TRIGGERS (rules live in the database, not the UI)
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_submittal_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flow boolean := COALESCE(current_setting('vireek.item_flow', true), 'off') = 'on';
  v_pstatus text;
  v_seq integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_pstatus FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_project'; END IF;
    IF v_pstatus = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
    SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM install_submittals WHERE project_id = NEW.project_id;
    NEW.seq := v_seq;
    NEW.status := 'draft';
    NEW.current_revision := 0;
    NEW.created_by := auth.uid();
    RETURN NEW;
  END IF;

  IF NEW.seq <> OLD.seq THEN RAISE EXCEPTION 'immutable_link'; END IF;
  IF NOT v_flow THEN
    IF NEW.status <> OLD.status OR NEW.current_revision <> OLD.current_revision THEN
      RAISE EXCEPTION 'flow_only';
    END IF;
    -- A void submittal is frozen (a phase delete may still null phase_id).
    IF OLD.status = 'void' AND (
      (to_jsonb(NEW) - 'phase_id' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'phase_id' - 'updated_at')
      OR (NEW.phase_id IS NOT NULL AND NEW.phase_id IS DISTINCT FROM OLD.phase_id)
    ) THEN
      RAISE EXCEPTION 'submittal_void';
    END IF;
    -- Identity of a submittal is fixed once it has left draft.
    IF OLD.status <> 'draft' AND (
      NEW.spec_section <> OLD.spec_section OR NEW.title <> OLD.title OR NEW.submittal_type <> OLD.submittal_type
    ) THEN
      RAISE EXCEPTION 'submittal_locked';
    END IF;
  END IF;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_submittal_seed_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO install_submittal_revisions (user_id, project_id, submittal_id, revision_number)
  VALUES (NEW.user_id, NEW.project_id, NEW.id, 0);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_punch_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flow boolean := COALESCE(current_setting('vireek.item_flow', true), 'off') = 'on';
  v_pstatus text;
  v_seq integer;
BEGIN
  IF NEW.assignee_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = NEW.assignee_id AND account_owner_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_technician';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_pstatus FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_project'; END IF;
    IF v_pstatus = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
    SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM install_punch_items WHERE project_id = NEW.project_id;
    NEW.seq := v_seq;
    NEW.status := 'open';
    NEW.fix_note := NULL;
    NEW.fixed_at := NULL;
    NEW.fixed_by := NULL;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    NEW.reopen_count := 0;
    NEW.created_by := auth.uid();
    RETURN NEW;
  END IF;

  IF NEW.seq <> OLD.seq THEN RAISE EXCEPTION 'immutable_link'; END IF;
  IF NOT v_flow THEN
    -- A closed item is frozen (deleting its assignee may still null assignee_id).
    IF OLD.status = 'closed' AND (
      (to_jsonb(NEW) - 'assignee_id' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'assignee_id' - 'updated_at')
      OR (NEW.assignee_id IS NOT NULL AND NEW.assignee_id IS DISTINCT FROM OLD.assignee_id)
    ) THEN
      RAISE EXCEPTION 'item_closed';
    END IF;
    IF (NEW.status, NEW.fix_note, NEW.fixed_at, NEW.fixed_by, NEW.verified_at, NEW.verified_by, NEW.closed_at, NEW.closed_by, NEW.reopen_count)
       IS DISTINCT FROM
       (OLD.status, OLD.fix_note, OLD.fixed_at, OLD.fixed_by, OLD.verified_at, OLD.verified_by, OLD.closed_at, OLD.closed_by, OLD.reopen_count) THEN
      RAISE EXCEPTION 'flow_only';
    END IF;
  END IF;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_attachment_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_submitted timestamptz;
  v_sub_status text;
  v_rev_project uuid;
  v_rev_user uuid;
  v_punch_status text;
  v_punch_project uuid;
  v_punch_user uuid;
  v_count integer;
BEGIN
  NEW.uploaded_by := auth.uid();
  IF position('..' IN NEW.storage_path) > 0
     OR NEW.storage_path NOT LIKE NEW.user_id::text || '/' || NEW.project_id::text || '/%' THEN
    RAISE EXCEPTION 'invalid_path';
  END IF;

  IF NEW.submittal_revision_id IS NOT NULL THEN
    SELECT r.submitted_at, r.project_id, r.user_id, s.status
      INTO v_submitted, v_rev_project, v_rev_user, v_sub_status
      FROM install_submittal_revisions r
      JOIN install_submittals s ON s.id = r.submittal_id
     WHERE r.id = NEW.submittal_revision_id;
    IF NOT FOUND OR v_rev_project <> NEW.project_id OR v_rev_user <> NEW.user_id THEN RAISE EXCEPTION 'invalid_parent'; END IF;
    IF v_sub_status = 'void' THEN RAISE EXCEPTION 'submittal_void'; END IF;
    IF NEW.purpose NOT IN ('package', 'review') THEN RAISE EXCEPTION 'invalid_purpose'; END IF;
    -- The package is frozen once submitted; reviewer markup only exists after.
    IF v_submitted IS NOT NULL AND NEW.purpose = 'package' THEN RAISE EXCEPTION 'revision_locked'; END IF;
    IF v_submitted IS NULL AND NEW.purpose = 'review' THEN RAISE EXCEPTION 'invalid_purpose'; END IF;
    SELECT count(*) INTO v_count FROM install_project_attachments WHERE submittal_revision_id = NEW.submittal_revision_id;
  ELSE
    SELECT status, project_id, user_id INTO v_punch_status, v_punch_project, v_punch_user
      FROM install_punch_items WHERE id = NEW.punch_item_id;
    IF NOT FOUND OR v_punch_project <> NEW.project_id OR v_punch_user <> NEW.user_id THEN RAISE EXCEPTION 'invalid_parent'; END IF;
    IF v_punch_status = 'closed' THEN RAISE EXCEPTION 'item_closed'; END IF;
    IF NEW.purpose NOT IN ('before', 'after', 'general') THEN RAISE EXCEPTION 'invalid_purpose'; END IF;
    SELECT count(*) INTO v_count FROM install_project_attachments WHERE punch_item_id = NEW.punch_item_id;
  END IF;

  IF v_count >= 30 THEN RAISE EXCEPTION 'attachment_limit'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_item_events_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM install_item_events WHERE item_type = TG_ARGV[0] AND item_id = OLD.id;
  RETURN OLD;
END $$;

-- Whether the caller may delete an attachment (package frozen after submit;
-- punch evidence frozen once the item is ready for review).
CREATE OR REPLACE FUNCTION public.install_attachment_deletable(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM install_project_attachments a
    LEFT JOIN install_submittal_revisions r ON r.id = a.submittal_revision_id
    LEFT JOIN install_submittals s ON s.id = r.submittal_id
    LEFT JOIN install_punch_items p ON p.id = a.punch_item_id
    WHERE a.id = p_id
      AND (a.uploaded_by = auth.uid() OR public.can_review_install_items())
      AND (
        (a.submittal_revision_id IS NOT NULL AND s.status <> 'void'
          AND ((a.purpose = 'package' AND r.submitted_at IS NULL)
            OR (a.purpose = 'review' AND public.can_review_install_items())))
        OR (a.punch_item_id IS NOT NULL AND p.status IN ('open', 'in_progress'))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.install_attachment_deletable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.install_attachment_deletable(uuid) TO authenticated;

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_submittals;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_submittals;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_submittals;
CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();
DROP TRIGGER IF EXISTS trg_ip_04_guard ON install_submittals;
CREATE TRIGGER trg_ip_04_guard BEFORE INSERT OR UPDATE ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_submittal_guard();
DROP TRIGGER IF EXISTS trg_ip_05_seed ON install_submittals;
CREATE TRIGGER trg_ip_05_seed AFTER INSERT ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_submittal_seed_revision();
DROP TRIGGER IF EXISTS trg_ip_06_events ON install_submittals;
CREATE TRIGGER trg_ip_06_events AFTER DELETE ON install_submittals FOR EACH ROW EXECUTE FUNCTION public.install_item_events_cleanup('submittal');

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_punch_items;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_punch_items FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_punch_items;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_punch_items FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_punch_items;
CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_punch_items FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();
DROP TRIGGER IF EXISTS trg_ip_04_guard ON install_punch_items;
CREATE TRIGGER trg_ip_04_guard BEFORE INSERT OR UPDATE ON install_punch_items FOR EACH ROW EXECUTE FUNCTION public.install_punch_guard();
DROP TRIGGER IF EXISTS trg_ip_06_events ON install_punch_items;
CREATE TRIGGER trg_ip_06_events AFTER DELETE ON install_punch_items FOR EACH ROW EXECUTE FUNCTION public.install_item_events_cleanup('punch');

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_project_attachments;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_project_attachments FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_project_attachments;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT ON install_project_attachments FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_04_guard ON install_project_attachments;
CREATE TRIGGER trg_ip_04_guard BEFORE INSERT ON install_project_attachments FOR EACH ROW EXECUTE FUNCTION public.install_attachment_guard();

-- =============================================================
-- 3. ROW LEVEL SECURITY
-- =============================================================

ALTER TABLE install_submittals ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_submittal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_punch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_project_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_item_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS install_submittals_select ON install_submittals;
CREATE POLICY install_submittals_select ON install_submittals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS install_submittals_insert ON install_submittals;
CREATE POLICY install_submittals_insert ON install_submittals FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_review_install_items());
DROP POLICY IF EXISTS install_submittals_update ON install_submittals;
CREATE POLICY install_submittals_update ON install_submittals FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_review_install_items())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_review_install_items());
DROP POLICY IF EXISTS install_submittals_delete ON install_submittals;
CREATE POLICY install_submittals_delete ON install_submittals FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_review_install_items() AND status = 'draft' AND current_revision = 0);

DROP POLICY IF EXISTS install_submittal_revisions_select ON install_submittal_revisions;
CREATE POLICY install_submittal_revisions_select ON install_submittal_revisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS install_punch_items_select ON install_punch_items;
CREATE POLICY install_punch_items_select ON install_punch_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS install_punch_items_insert ON install_punch_items;
CREATE POLICY install_punch_items_insert ON install_punch_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS install_punch_items_update ON install_punch_items;
CREATE POLICY install_punch_items_update ON install_punch_items FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_review_install_items())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_review_install_items());
DROP POLICY IF EXISTS install_punch_items_delete ON install_punch_items;
CREATE POLICY install_punch_items_delete ON install_punch_items FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_review_install_items() AND status <> 'closed');

DROP POLICY IF EXISTS install_project_attachments_select ON install_project_attachments;
CREATE POLICY install_project_attachments_select ON install_project_attachments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS install_project_attachments_insert ON install_project_attachments;
CREATE POLICY install_project_attachments_insert ON install_project_attachments FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND (punch_item_id IS NOT NULL OR public.can_review_install_items()));
DROP POLICY IF EXISTS install_project_attachments_delete ON install_project_attachments;
CREATE POLICY install_project_attachments_delete ON install_project_attachments FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.install_attachment_deletable(id));

DROP POLICY IF EXISTS install_item_events_select ON install_item_events;
CREATE POLICY install_item_events_select ON install_item_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. WORKFLOW RPCs (the only way a status can change)
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_submittal_transition(p_submittal_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  s install_submittals%ROWTYPE;
  r install_submittal_revisions%ROWTYPE;
  v_to text;
  v_rev integer;
  v_pkg integer;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL OR NOT public.can_review_install_items() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'note_too_long'; END IF;

  SELECT * INTO s FROM install_submittals WHERE id = p_submittal_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submittal_not_found'; END IF;
  SELECT * INTO r FROM install_submittal_revisions WHERE submittal_id = s.id AND revision_number = s.current_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submittal_not_found'; END IF;
  v_rev := s.current_revision;

  PERFORM set_config('vireek.item_flow', 'on', true);

  CASE p_action
    WHEN 'submit' THEN
      IF s.status <> 'draft' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF s.reviewer_name IS NULL THEN RAISE EXCEPTION 'reviewer_required'; END IF;
      SELECT count(*) INTO v_pkg FROM install_project_attachments WHERE submittal_revision_id = r.id AND purpose = 'package';
      IF v_pkg = 0 THEN RAISE EXCEPTION 'attachment_required'; END IF;
      UPDATE install_submittal_revisions SET submitted_at = now(), submitted_by = v_uid WHERE id = r.id;
      v_to := 'submitted';
    WHEN 'start_review' THEN
      IF s.status <> 'submitted' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      v_to := 'in_review';
    WHEN 'approve', 'approve_as_noted', 'revise_resubmit', 'reject' THEN
      IF s.status NOT IN ('submitted', 'in_review') THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF p_action <> 'approve' AND (v_note IS NULL OR length(v_note) < 3) THEN RAISE EXCEPTION 'note_required'; END IF;
      v_to := CASE p_action
        WHEN 'approve' THEN 'approved'
        WHEN 'approve_as_noted' THEN 'approved_as_noted'
        WHEN 'revise_resubmit' THEN 'revise_resubmit'
        ELSE 'rejected' END;
      UPDATE install_submittal_revisions
         SET decision = v_to, decided_at = now(), decided_by = v_uid, decision_note = v_note
       WHERE id = r.id;
    WHEN 'new_revision' THEN
      IF s.status NOT IN ('revise_resubmit', 'rejected') THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF s.current_revision >= 25 THEN RAISE EXCEPTION 'revision_limit'; END IF;
      v_rev := s.current_revision + 1;
      INSERT INTO install_submittal_revisions (user_id, project_id, submittal_id, revision_number)
      VALUES (s.user_id, s.project_id, s.id, v_rev);
      v_to := 'draft';
    WHEN 'void' THEN
      IF s.status = 'void' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'note_required'; END IF;
      v_to := 'void';
    ELSE
      RAISE EXCEPTION 'invalid_action';
  END CASE;

  UPDATE install_submittals SET status = v_to, current_revision = v_rev WHERE id = s.id;

  INSERT INTO install_item_events (user_id, project_id, item_type, item_id, action, from_status, to_status, revision_number, note, actor_id, actor_name)
  VALUES (s.user_id, s.project_id, 'submittal', s.id, p_action, s.status, v_to, v_rev, v_note, v_uid, public.install_actor_name());

  PERFORM set_config('vireek.item_flow', 'off', true);
  RETURN v_to;
END $$;

CREATE OR REPLACE FUNCTION public.install_punch_transition(p_item_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  i install_punch_items%ROWTYPE;
  v_reviewer boolean;
  v_assignee boolean;
  v_my_member uuid;
  v_to text;
  v_after integer;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'note_too_long'; END IF;

  SELECT * INTO i FROM install_punch_items WHERE id = p_item_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'punch_not_found'; END IF;

  v_reviewer := public.can_review_install_items();
  v_my_member := public.get_my_team_member_id();
  v_assignee := v_my_member IS NOT NULL AND i.assignee_id = v_my_member;
  IF NOT (v_reviewer OR v_assignee) THEN RAISE EXCEPTION 'not_authorized'; END IF;

  PERFORM set_config('vireek.item_flow', 'on', true);

  CASE p_action
    WHEN 'start' THEN
      IF i.status <> 'open' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      v_to := 'in_progress';
      UPDATE install_punch_items SET status = v_to WHERE id = i.id;
    WHEN 'mark_fixed' THEN
      IF i.status NOT IN ('open', 'in_progress') THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      SELECT count(*) INTO v_after FROM install_project_attachments WHERE punch_item_id = i.id AND purpose = 'after';
      IF v_after = 0 THEN RAISE EXCEPTION 'after_photo_required'; END IF;
      v_to := 'ready_for_review';
      UPDATE install_punch_items SET status = v_to, fix_note = v_note, fixed_at = now(), fixed_by = v_uid WHERE id = i.id;
    WHEN 'verify', 'verify_close' THEN
      IF NOT v_reviewer THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF i.status <> 'ready_for_review' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      -- Four-eyes rule: whoever marked it fixed cannot verify it (the account owner may).
      IF i.fixed_by IS NOT DISTINCT FROM v_uid AND v_uid <> v_owner THEN RAISE EXCEPTION 'verifier_must_differ'; END IF;
      IF p_action = 'verify' THEN
        v_to := 'verified';
        UPDATE install_punch_items SET status = v_to, verified_at = now(), verified_by = v_uid WHERE id = i.id;
      ELSE
        v_to := 'closed';
        UPDATE install_punch_items
           SET status = v_to, verified_at = now(), verified_by = v_uid, closed_at = now(), closed_by = v_uid
         WHERE id = i.id;
      END IF;
    WHEN 'close' THEN
      IF NOT v_reviewer THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF i.status <> 'verified' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      v_to := 'closed';
      UPDATE install_punch_items SET status = v_to, closed_at = now(), closed_by = v_uid WHERE id = i.id;
    WHEN 'reject', 'reopen' THEN
      IF NOT v_reviewer THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF p_action = 'reject' AND i.status <> 'ready_for_review' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF p_action = 'reopen' AND i.status NOT IN ('verified', 'closed') THEN RAISE EXCEPTION 'invalid_transition'; END IF;
      IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'note_required'; END IF;
      v_to := 'open';
      UPDATE install_punch_items
         SET status = v_to, reopen_count = reopen_count + 1, fix_note = NULL,
             fixed_at = NULL, fixed_by = NULL, verified_at = NULL, verified_by = NULL, closed_at = NULL, closed_by = NULL
       WHERE id = i.id;
    ELSE
      RAISE EXCEPTION 'invalid_action';
  END CASE;

  INSERT INTO install_item_events (user_id, project_id, item_type, item_id, action, from_status, to_status, note, actor_id, actor_name)
  VALUES (i.user_id, i.project_id, 'punch', i.id, p_action, i.status, v_to, v_note, v_uid, public.install_actor_name());

  PERFORM set_config('vireek.item_flow', 'off', true);
  RETURN v_to;
END $$;

REVOKE ALL ON FUNCTION public.install_submittal_transition(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.install_punch_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.install_submittal_transition(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.install_punch_transition(uuid, text, text) TO authenticated;

-- =============================================================
-- 5. STORAGE (private bucket, tenant folder = account owner id)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-attachments', 'project-attachments', false, 26214400,
  ARRAY[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "project_attachments_select" ON storage.objects;
CREATE POLICY "project_attachments_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'project-attachments' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "project_attachments_insert" ON storage.objects;
CREATE POLICY "project_attachments_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'project-attachments' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

-- An object can only be removed once no attachment row points at it (orphan cleanup).
DROP POLICY IF EXISTS "project_attachments_delete" ON storage.objects;
CREATE POLICY "project_attachments_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-attachments'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND NOT EXISTS (SELECT 1 FROM public.install_project_attachments a WHERE a.storage_path = name)
  );
