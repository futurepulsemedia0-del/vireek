/*
  # Project Scheduler — Gantt, dependencies, crews, lead times, customer progress link

  Purely additive on top of Install Projects:
  - install_phase_dependencies: FS/SS/FF/SF links with lag; loops are rejected in the DB.
  - install_phase_crews: team members assigned to a phase (same account only).
  - install_project_shares: token for the customer-facing progress page.
  - New columns: phases.locked / baseline_start / baseline_end,
    projects.work_weekends, materials.lead_time_days.
  - reschedule_install_phases(): atomic, validated batch move (stale-edit safe).
  - get_project_progress(): public, token-gated, NO money, notes or crew names.
  Access: same rule as Install Projects (can_manage_install_projects()).
*/

ALTER TABLE install_projects ADD COLUMN IF NOT EXISTS work_weekends boolean NOT NULL DEFAULT false;
ALTER TABLE install_project_phases
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS baseline_start date,
  ADD COLUMN IF NOT EXISTS baseline_end date;
ALTER TABLE install_project_materials
  ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days BETWEEN 0 AND 365);

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS install_phase_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  predecessor_id uuid NOT NULL REFERENCES install_project_phases(id) ON DELETE CASCADE,
  successor_id uuid NOT NULL REFERENCES install_project_phases(id) ON DELETE CASCADE,
  dep_type text NOT NULL DEFAULT 'FS' CHECK (dep_type IN ('FS', 'SS', 'FF', 'SF')),
  lag_days integer NOT NULL DEFAULT 0 CHECK (lag_days BETWEEN -60 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (predecessor_id <> successor_id),
  UNIQUE (predecessor_id, successor_id)
);
CREATE INDEX IF NOT EXISTS idx_phase_deps_project ON install_phase_dependencies(project_id);
CREATE INDEX IF NOT EXISTS idx_phase_deps_successor ON install_phase_dependencies(successor_id);

CREATE TABLE IF NOT EXISTS install_phase_crews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid NOT NULL REFERENCES install_project_phases(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phase_id, technician_id)
);
CREATE INDEX IF NOT EXISTS idx_phase_crews_project ON install_phase_crews(project_id);
CREATE INDEX IF NOT EXISTS idx_phase_crews_tech ON install_phase_crews(technician_id);

CREATE TABLE IF NOT EXISTS install_project_shares (
  project_id uuid PRIMARY KEY REFERENCES install_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  show_dates boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_install_project_shares_token ON install_project_shares(token);

-- =============================================================
-- TRIGGERS (reuse the Install Projects owner / validation / stamp functions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.install_phase_dependency_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.predecessor_id = NEW.successor_id THEN RAISE EXCEPTION 'dependency_self'; END IF;
  IF TG_OP = 'INSERT' OR NEW.predecessor_id <> OLD.predecessor_id OR NEW.successor_id <> OLD.successor_id THEN
    IF (SELECT count(*) FROM install_project_phases
         WHERE id IN (NEW.predecessor_id, NEW.successor_id) AND project_id = NEW.project_id) <> 2 THEN
      RAISE EXCEPTION 'dependency_invalid';
    END IF;
    -- Serialize link edits per project so two concurrent links can never jointly close a loop.
    PERFORM 1 FROM install_projects WHERE id = NEW.project_id FOR UPDATE;
    IF EXISTS (
      WITH RECURSIVE reach(id) AS (
        SELECT NEW.successor_id
        UNION
        SELECT d.successor_id FROM install_phase_dependencies d JOIN reach r ON d.predecessor_id = r.id
         WHERE d.project_id = NEW.project_id AND d.id <> NEW.id
      )
      SELECT 1 FROM reach WHERE id = NEW.predecessor_id
    ) THEN
      RAISE EXCEPTION 'dependency_cycle';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_phase_crew_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = NEW.technician_id AND account_owner_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_technician';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_phase_dependencies;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_phase_dependencies FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_phase_dependencies;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_phase_dependencies FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_phase_dependencies;
CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_phase_dependencies FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();
DROP TRIGGER IF EXISTS trg_ip_04_dep_guard ON install_phase_dependencies;
CREATE TRIGGER trg_ip_04_dep_guard BEFORE INSERT OR UPDATE ON install_phase_dependencies FOR EACH ROW EXECUTE FUNCTION public.install_phase_dependency_guard();

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_phase_crews;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_phase_crews FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_phase_crews;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_phase_crews FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_04_crew_guard ON install_phase_crews;
CREATE TRIGGER trg_ip_04_crew_guard BEFORE INSERT ON install_phase_crews FOR EACH ROW EXECUTE FUNCTION public.install_phase_crew_guard();

DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_project_shares;
CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_project_shares FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_project_shares;
CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_project_shares FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_project_shares;
CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_project_shares FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();

-- =============================================================
-- ROW LEVEL SECURITY — account-scoped + billing permission
-- =============================================================
ALTER TABLE install_phase_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_phase_crews ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_project_shares ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  scope text := 'user_id = public.get_account_owner_id() AND public.can_manage_install_projects()';
BEGIN
  FOREACH t IN ARRAY ARRAY['install_phase_dependencies', 'install_phase_crews', 'install_project_shares'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (%s)', t || '_select', t, scope);
    IF t <> 'install_project_shares' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (%s)', t || '_insert', t, scope);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (%s)', t || '_delete', t, scope);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS install_phase_dependencies_update ON install_phase_dependencies;
CREATE POLICY install_phase_dependencies_update ON install_phase_dependencies FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_install_projects())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_install_projects());
-- install_project_shares has no client write policy: writes only via set_project_sharing().

-- =============================================================
-- RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.reschedule_install_phases(p_project_id uuid, p_changes jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p install_projects%ROWTYPE;
  ph install_project_phases%ROWTYPE;
  c record;
  n integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 OR jsonb_array_length(p_changes) > 200 THEN
    RAISE EXCEPTION 'invalid_range';
  END IF;

  SELECT * INTO p FROM install_projects WHERE id = p_project_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sharing_not_found'; END IF;
  IF p.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'project_closed'; END IF;

  FOR c IN
    SELECT * FROM jsonb_to_recordset(p_changes) AS x(id uuid, planned_start date, planned_end date, expected_updated_at timestamptz)
  LOOP
    IF (c.planned_start IS NULL) <> (c.planned_end IS NULL)
       OR (c.planned_start IS NOT NULL AND (c.planned_end < c.planned_start OR c.planned_end - c.planned_start > 3650)) THEN
      RAISE EXCEPTION 'invalid_range';
    END IF;
    SELECT * INTO ph FROM install_project_phases WHERE id = c.id AND project_id = p.id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_phase'; END IF;
    IF c.expected_updated_at IS NOT NULL AND ph.updated_at <> c.expected_updated_at THEN RAISE EXCEPTION 'stale_schedule'; END IF;
    IF ph.planned_start IS NOT DISTINCT FROM c.planned_start AND ph.planned_end IS NOT DISTINCT FROM c.planned_end THEN CONTINUE; END IF;
    IF ph.status = 'completed' THEN RAISE EXCEPTION 'phase_completed'; END IF;
    IF ph.locked THEN RAISE EXCEPTION 'phase_locked'; END IF;
    UPDATE install_project_phases SET planned_start = c.planned_start, planned_end = c.planned_end WHERE id = ph.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.set_project_baseline(p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = p_project_id AND user_id = v_owner) THEN RAISE EXCEPTION 'sharing_not_found'; END IF;
  UPDATE install_project_phases
     SET baseline_start = planned_start, baseline_end = planned_end
   WHERE project_id = p_project_id AND user_id = v_owner AND planned_start IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.set_project_sharing(
  p_project_id uuid, p_enabled boolean DEFAULT NULL, p_rotate boolean DEFAULT false, p_show_dates boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_token uuid;
  v_enabled boolean;
  v_show boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = p_project_id AND user_id = v_owner) THEN RAISE EXCEPTION 'sharing_not_found'; END IF;

  INSERT INTO install_project_shares (project_id, user_id, enabled, show_dates)
  VALUES (p_project_id, v_owner, COALESCE(p_enabled, false), COALESCE(p_show_dates, true))
  ON CONFLICT (project_id) DO UPDATE SET
    enabled = COALESCE(p_enabled, install_project_shares.enabled),
    show_dates = COALESCE(p_show_dates, install_project_shares.show_dates),
    token = CASE WHEN p_rotate THEN gen_random_uuid() ELSE install_project_shares.token END
  RETURNING token, enabled, show_dates INTO v_token, v_enabled, v_show;

  RETURN jsonb_build_object('token', v_token, 'enabled', v_enabled, 'show_dates', v_show);
END $$;

-- Public, token-gated. Never returns money, notes, crew, addresses or customer data.
CREATE OR REPLACE FUNCTION public.get_project_progress(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s install_project_shares%ROWTYPE;
  p install_projects%ROWTYPE;
  v_company text;
  v_phases jsonb;
  v_ms jsonb;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM install_project_shares WHERE token = p_token AND enabled;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM install_projects WHERE id = s.project_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT company_name INTO v_company FROM profiles WHERE id = p.user_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', ph.id, 'name', ph.name, 'sort_order', ph.sort_order, 'weight', ph.weight, 'status', ph.status,
      'planned_start', CASE WHEN s.show_dates THEN ph.planned_start END,
      'planned_end', CASE WHEN s.show_dates THEN ph.planned_end END,
      'actual_start', CASE WHEN s.show_dates THEN ph.actual_start END,
      'actual_end', CASE WHEN s.show_dates THEN ph.actual_end END
    ) ORDER BY ph.sort_order, ph.created_at), '[]'::jsonb)
    INTO v_phases FROM install_project_phases ph WHERE ph.project_id = p.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', m.id, 'phase_id', m.phase_id, 'title', m.title, 'kind', m.kind, 'status', m.status,
      'due_date', CASE WHEN s.show_dates THEN m.due_date END, 'sort_order', m.sort_order
    ) ORDER BY m.sort_order, m.created_at), '[]'::jsonb)
    INTO v_ms FROM install_project_milestones m WHERE m.project_id = p.id;

  RETURN jsonb_build_object(
    'business_name', v_company,
    'show_dates', s.show_dates,
    'project', jsonb_build_object(
      'name', p.name, 'project_type', p.project_type, 'status', p.status,
      'start_date', CASE WHEN s.show_dates THEN p.start_date END,
      'target_end_date', CASE WHEN s.show_dates THEN p.target_end_date END),
    'phases', v_phases,
    'milestones', v_ms);
END $$;

REVOKE ALL ON FUNCTION public.reschedule_install_phases(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_project_baseline(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_project_sharing(uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_install_phases(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_project_baseline(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_project_sharing(uuid, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_progress(uuid) TO anon, authenticated;
