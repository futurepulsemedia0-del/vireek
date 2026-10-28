/*
  # Team org chart (/dashboard/team/org-chart)

  Reporting lines + role history for the team. Additive only: two nullable
  columns on team_members, one new history table, two triggers, four RPCs.
  No existing column, policy or function is altered.

  ## Model
  - team_members.reports_to_id  who this person reports to. NULL = reports to
                                the account owner (the owner is the chart root
                                and is not a team_members row).
  - team_members.org_title      free-text job title (max 80 chars).
  - team_position_history       one row per period in which (access role,
                                job title, manager) stayed the same. The open
                                row (ended_at IS NULL) is the current position.

  ## History is automatic
  An AFTER trigger on team_members closes the open row and opens a new one
  whenever role, org_title or reports_to_id change - from ANY code path
  (Team page role edits, this page, SQL). Existing members are backfilled
  once, starting at their created_at.

  ## Integrity
  A BEFORE trigger rejects: reporting to yourself, a manager from another
  account, reporting loops, and titles over 80 characters.

  ## Security model
  - Rows carry account_owner_id = the ACCOUNT OWNER's id.
  - The history table has RLS enabled and NO table policy: it is read only
    through SECURITY DEFINER RPCs.
  - org_chart_overview(): every account member (emails shown to managers only).
  - org_chart_history(member): managers, or the person themselves.
  - org_chart_set_position(...): managers only (owner, or can_manage_team).
*/

-- =============================================================
-- COLUMNS
-- =============================================================

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS org_title text,
  ADD COLUMN IF NOT EXISTS reports_to_id uuid REFERENCES team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_reports_to
  ON team_members (reports_to_id) WHERE reports_to_id IS NOT NULL;

-- =============================================================
-- HISTORY TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS team_position_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  access_role text NOT NULL,
  org_title text,
  reports_to_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  reports_to_name text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  change_note text,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

ALTER TABLE team_position_history ENABLE ROW LEVEL SECURITY;

-- One open (current) row per member.
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_position_history_open
  ON team_position_history (team_member_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_team_position_history_member
  ON team_position_history (team_member_id, started_at DESC);

-- Backfill: one open row for every existing member (safe to re-run).
INSERT INTO team_position_history (
  account_owner_id, team_member_id, access_role, org_title,
  reports_to_id, reports_to_name, started_at
)
SELECT tm.account_owner_id, tm.id, tm.role, tm.org_title,
       tm.reports_to_id,
       (SELECT COALESCE(NULLIF(btrim(m.member_name), ''), m.member_email)
          FROM team_members m WHERE m.id = tm.reports_to_id),
       tm.created_at
FROM team_members tm
WHERE NOT EXISTS (
  SELECT 1 FROM team_position_history h
  WHERE h.team_member_id = tm.id AND h.ended_at IS NULL
);

-- =============================================================
-- TRIGGER: integrity guard (BEFORE)
-- =============================================================

CREATE OR REPLACE FUNCTION public.team_position_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.org_title := NULLIF(btrim(NEW.org_title), '');
  IF NEW.org_title IS NOT NULL AND char_length(NEW.org_title) > 80 THEN
    RAISE EXCEPTION 'Job title must be 80 characters or fewer';
  END IF;

  IF NEW.reports_to_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reports_to_id IS NOT DISTINCT FROM OLD.reports_to_id THEN
    RETURN NEW;
  END IF;

  IF NEW.reports_to_id = NEW.id THEN
    RAISE EXCEPTION 'A person cannot report to themselves';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members m
    WHERE m.id = NEW.reports_to_id AND m.account_owner_id = NEW.account_owner_id
  ) THEN
    RAISE EXCEPTION 'The manager must be on the same team';
  END IF;

  -- Walk up from the new manager; reaching this person means a loop.
  IF EXISTS (
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT m.id, m.reports_to_id, 1
      FROM team_members m
      WHERE m.id = NEW.reports_to_id
      UNION ALL
      SELECT m.id, m.reports_to_id, up.depth + 1
      FROM team_members m
      JOIN up ON m.id = up.parent_id
      WHERE up.depth < 100
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'That would create a reporting loop - this person already manages the chosen manager';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_position_guard ON team_members;
CREATE TRIGGER trg_team_position_guard
  BEFORE INSERT OR UPDATE OF org_title, reports_to_id ON team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_position_guard();

-- =============================================================
-- TRIGGER: role history (AFTER)
-- =============================================================

CREATE OR REPLACE FUNCTION public.team_position_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(current_setting('app.org_note', true), '')), '');
  v_mgr text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.org_title IS NOT DISTINCT FROM OLD.org_title
       AND NEW.reports_to_id IS NOT DISTINCT FROM OLD.reports_to_id THEN
      RETURN NULL;
    END IF;
    UPDATE team_position_history
       SET ended_at = now()
     WHERE team_member_id = NEW.id AND ended_at IS NULL;
  END IF;

  SELECT COALESCE(NULLIF(btrim(m.member_name), ''), m.member_email)
    INTO v_mgr
    FROM team_members m
   WHERE m.id = NEW.reports_to_id;

  INSERT INTO team_position_history (
    account_owner_id, team_member_id, access_role, org_title,
    reports_to_id, reports_to_name, started_at, change_note, changed_by
  )
  VALUES (
    NEW.account_owner_id, NEW.id, NEW.role, NEW.org_title,
    NEW.reports_to_id, v_mgr, now(), v_note, auth.uid()
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_position_log ON team_members;
CREATE TRIGGER trg_team_position_log
  AFTER INSERT OR UPDATE OF role, org_title, reports_to_id ON team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_position_log();

-- =============================================================
-- INTERNAL HELPER: owner, or accepted member with can_manage_team
-- =============================================================

CREATE OR REPLACE FUNCTION public.org_chart_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.invite_status IN ('accepted', 'active')
        AND COALESCE(cr.permissions ->> 'can_manage_team', tm.permissions ->> 'can_manage_team', 'false') = 'true'
    )
  );
$$;

-- =============================================================
-- RPC: org_chart_overview - everyone on the account
-- =============================================================

CREATE OR REPLACE FUNCTION public.org_chart_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean := public.org_chart_is_manager();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'can_manage', v_manager,
    'owner', (
      SELECT jsonb_build_object(
        'name', COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.company_name), ''), split_part(p.email, '@', 1)),
        'company', NULLIF(btrim(p.company_name), '')
      )
      FROM profiles p
      WHERE p.id = v_owner
    ),
    'members', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', tm.id,
          'name', CASE WHEN v_manager
                    THEN COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email)
                    ELSE COALESCE(NULLIF(btrim(tm.member_name), ''), split_part(tm.member_email, '@', 1))
                  END,
          'email', CASE WHEN v_manager THEN tm.member_email ELSE NULL END,
          'photo_url', tm.photo_url,
          'access_role', tm.role,
          'title', tm.org_title,
          'reports_to_id', tm.reports_to_id,
          'invite_status', tm.invite_status,
          'is_me', (tm.user_id IS NOT NULL AND tm.user_id = auth.uid()),
          'since', COALESCE(
            (SELECT h.started_at FROM team_position_history h
              WHERE h.team_member_id = tm.id AND h.ended_at IS NULL
              LIMIT 1),
            tm.created_at
          )
        )
        ORDER BY lower(COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email)), tm.id
      )
      FROM team_members tm
      WHERE tm.account_owner_id = v_owner
    ), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- RPC: org_chart_history - role history of one member
-- =============================================================

CREATE OR REPLACE FUNCTION public.org_chart_history(p_member uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean := public.org_chart_is_manager();
  v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT tm.user_id INTO v_user
    FROM team_members tm
   WHERE tm.id = p_member AND tm.account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team member not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_manager AND (v_user IS NULL OR v_user <> auth.uid()) THEN
    RAISE EXCEPTION 'Role history is only visible to managers and the person themselves' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'access_role', h.access_role,
        'title', h.org_title,
        'reports_to_name', h.reports_to_name,
        'started_at', h.started_at,
        'ended_at', h.ended_at,
        'note', h.change_note,
        'changed_by_name', COALESCE(
          (SELECT NULLIF(btrim(p.full_name), '') FROM profiles p WHERE p.id = h.changed_by),
          (SELECT COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email)
             FROM team_members t
            WHERE t.user_id = h.changed_by AND t.account_owner_id = v_owner
            LIMIT 1)
        )
      )
      ORDER BY h.started_at DESC, h.id
    )
    FROM team_position_history h
    WHERE h.team_member_id = p_member AND h.account_owner_id = v_owner
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- RPC: org_chart_set_position (manager)
-- =============================================================

CREATE OR REPLACE FUNCTION public.org_chart_set_position(
  p_member uuid,
  p_title text,
  p_reports_to uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_title text := NULLIF(btrim(COALESCE(p_title, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row team_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.org_chart_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change reporting lines' USING ERRCODE = '42501';
  END IF;

  IF v_title IS NOT NULL AND char_length(v_title) > 80 THEN
    RAISE EXCEPTION 'Job title must be 80 characters or fewer';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 280 THEN
    RAISE EXCEPTION 'The note must be 280 characters or fewer';
  END IF;

  SELECT * INTO v_row
    FROM team_members
   WHERE id = p_member AND account_owner_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team member not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.org_title IS NOT DISTINCT FROM v_title
     AND v_row.reports_to_id IS NOT DISTINCT FROM p_reports_to THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  -- Picked up by team_position_log() for this transaction only.
  PERFORM set_config('app.org_note', COALESCE(v_note, ''), true);

  UPDATE team_members
     SET org_title = v_title,
         reports_to_id = p_reports_to
   WHERE id = p_member;

  RETURN jsonb_build_object('changed', true);
END;
$$;

-- =============================================================
-- GRANTS - authenticated only; helpers and triggers stay internal
-- =============================================================

REVOKE ALL ON FUNCTION public.team_position_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.team_position_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.org_chart_is_manager() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.org_chart_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.org_chart_history(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.org_chart_set_position(uuid, text, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.org_chart_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_chart_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_chart_set_position(uuid, text, uuid, text) TO authenticated;
