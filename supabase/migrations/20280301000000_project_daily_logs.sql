/*
  # Project Daily Logs

  One log per install project per day: weather, crew + hours, work performed,
  photos, delays, visitors, and an optional AI summary (always editable, labelled draft).
  A log is locked once submitted; corrections after that are append-only amendments.

  - New tables only. Purely additive; reuses install_projects, employees, timesheets,
    install_project_jobs and job_photos (photos stay in the Gallery).
  - Owner is FORCED by trigger (get_account_owner_id()); a client can never write into another account.
  - Same access rule as Install Projects: owner, or team members with can_view_billing
    (can_manage_install_projects(), created in 20271008000000_install_projects.sql).
  - Writes to the log, crew, delays and visitors go through save_project_daily_log() (one atomic call).
    Locking goes through submit_project_daily_log(). Triggers enforce the lock even against direct writes.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS project_daily_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  log_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  weather_code text CHECK (weather_code IS NULL OR weather_code IN
    ('clear', 'partly_cloudy', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'wind', 'heat', 'cold')),
  temp_high_f integer CHECK (temp_high_f IS NULL OR temp_high_f BETWEEN -60 AND 150),
  temp_low_f integer CHECK (temp_low_f IS NULL OR temp_low_f BETWEEN -60 AND 150),
  wind_mph integer CHECK (wind_mph IS NULL OR wind_mph BETWEEN 0 AND 250),
  weather_notes text CHECK (weather_notes IS NULL OR char_length(weather_notes) <= 500),
  work_performed text CHECK (work_performed IS NULL OR char_length(work_performed) <= 5000),
  ai_summary text CHECK (ai_summary IS NULL OR char_length(ai_summary) <= 2000),
  ai_generated_at timestamptz,
  ai_edited boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  submitted_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, log_date),
  CHECK (temp_high_f IS NULL OR temp_low_f IS NULL OR temp_high_f >= temp_low_f),
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_pdl_owner_date ON project_daily_logs(user_id, log_date DESC);

CREATE TABLE IF NOT EXISTS project_daily_log_crew (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES project_daily_logs(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  role text CHECK (role IS NULL OR char_length(role) <= 80),
  hours numeric(4,2) NOT NULL DEFAULT 0 CHECK (hours >= 0 AND hours <= 24),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('timesheet', 'manual')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdl_crew_log ON project_daily_log_crew(log_id, sort_order);

CREATE TABLE IF NOT EXISTS project_daily_log_delays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES project_daily_logs(id) ON DELETE CASCADE,
  cause text NOT NULL CHECK (cause IN ('weather', 'material', 'inspection', 'permit', 'customer', 'crew', 'equipment', 'other')),
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdl_delays_log ON project_daily_log_delays(log_id, sort_order);

CREATE TABLE IF NOT EXISTS project_daily_log_visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES project_daily_logs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  company text CHECK (company IS NULL OR char_length(company) <= 120),
  purpose text CHECK (purpose IS NULL OR char_length(purpose) <= 300),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdl_visitors_log ON project_daily_log_visitors(log_id, sort_order);

-- Photos are links to the existing Gallery (job_photos); removing a link never deletes the photo.
CREATE TABLE IF NOT EXISTS project_daily_log_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES project_daily_logs(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES job_photos(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (log_id, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_pdl_photos_log ON project_daily_log_photos(log_id, sort_order);

-- Append-only corrections to a submitted log.
CREATE TABLE IF NOT EXISTS project_daily_log_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES project_daily_logs(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdl_amend_log ON project_daily_log_amendments(log_id, created_at);

-- =============================================================
-- TRIGGERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.pdl_force_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.user_id := public.get_account_owner_id();
  IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF TG_TABLE_NAME = 'project_daily_logs' THEN
    NEW.created_by := auth.uid();
    NEW.status := 'draft';
    NEW.submitted_at := NULL;
    NEW.submitted_by := NULL;
  ELSIF TG_TABLE_NAME = 'project_daily_log_amendments' THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;

-- pg_trigger_depth() > 1 means the change is a cascade from another trigger
-- (deleting a draft log, or deleting the whole project), which must never be blocked.
CREATE OR REPLACE FUNCTION public.pdl_validate_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'submitted' AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'log_locked'; END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_project';
    END IF;
    IF NEW.log_date > current_date + 1 THEN RAISE EXCEPTION 'future_date'; END IF;
  ELSE
    IF OLD.status = 'submitted' THEN RAISE EXCEPTION 'log_locked'; END IF;
    IF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id OR NEW.log_date <> OLD.log_date THEN
      RAISE EXCEPTION 'immutable_link';
    END IF;
    IF NEW.status = 'submitted' AND COALESCE(current_setting('app.pdl_submit', true), '') <> '1' THEN
      RAISE EXCEPTION 'use_submit';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.pdl_validate_child()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_status text;
  v jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_status FROM project_daily_logs WHERE id = OLD.log_id;
    IF FOUND AND v_status = 'submitted' AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'log_locked'; END IF;
    RETURN OLD;
  END IF;

  SELECT user_id, status INTO v_user, v_status FROM project_daily_logs WHERE id = NEW.log_id;
  IF NOT FOUND OR v_user <> NEW.user_id THEN RAISE EXCEPTION 'invalid_log'; END IF;
  IF v_status = 'submitted' THEN RAISE EXCEPTION 'log_locked'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.log_id <> OLD.log_id OR NEW.user_id <> OLD.user_id) THEN RAISE EXCEPTION 'immutable_link'; END IF;

  v := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'project_daily_log_crew' AND v->>'employee_id' IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = (v->>'employee_id')::uuid AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_employee';
    END IF;
  ELSIF TG_TABLE_NAME = 'project_daily_log_photos' THEN
    IF NOT EXISTS (SELECT 1 FROM job_photos WHERE id = (v->>'photo_id')::uuid AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_photo';
    END IF;
    IF TG_OP = 'INSERT' AND (SELECT count(*) FROM project_daily_log_photos WHERE log_id = NEW.log_id) >= 30 THEN
      RAISE EXCEPTION 'too_many_photos';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.pdl_validate_amendment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF pg_trigger_depth() > 1 THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'amendments_immutable';
  END IF;
  SELECT user_id, status INTO v_user, v_status FROM project_daily_logs WHERE id = NEW.log_id;
  IF NOT FOUND OR v_user <> NEW.user_id THEN RAISE EXCEPTION 'invalid_log'; END IF;
  IF v_status <> 'submitted' THEN RAISE EXCEPTION 'log_not_submitted'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_daily_logs', 'project_daily_log_crew', 'project_daily_log_delays',
    'project_daily_log_visitors', 'project_daily_log_photos', 'project_daily_log_amendments'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_pdl_01_owner ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_pdl_01_owner BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.pdl_force_owner()', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'project_daily_log_crew', 'project_daily_log_delays', 'project_daily_log_visitors', 'project_daily_log_photos'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_pdl_02_validate ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_pdl_02_validate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.pdl_validate_child()', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_pdl_02_validate ON project_daily_logs;
CREATE TRIGGER trg_pdl_02_validate BEFORE INSERT OR UPDATE OR DELETE ON project_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.pdl_validate_log();

DROP TRIGGER IF EXISTS trg_pdl_02_validate ON project_daily_log_amendments;
CREATE TRIGGER trg_pdl_02_validate BEFORE INSERT OR UPDATE OR DELETE ON project_daily_log_amendments
  FOR EACH ROW EXECUTE FUNCTION public.pdl_validate_amendment();

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

DO $$
DECLARE
  t text;
  scope text := 'user_id = public.get_account_owner_id() AND public.can_manage_install_projects()';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_daily_logs', 'project_daily_log_crew', 'project_daily_log_delays',
    'project_daily_log_visitors', 'project_daily_log_photos', 'project_daily_log_amendments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (%s)', t || '_select', t, scope);
  END LOOP;

  -- Photo links: attach / detach directly (the trigger blocks it once the log is submitted).
  DROP POLICY IF EXISTS project_daily_log_photos_insert ON project_daily_log_photos;
  EXECUTE format('CREATE POLICY project_daily_log_photos_insert ON project_daily_log_photos FOR INSERT TO authenticated WITH CHECK (%s)', scope);
  DROP POLICY IF EXISTS project_daily_log_photos_delete ON project_daily_log_photos;
  EXECUTE format('CREATE POLICY project_daily_log_photos_delete ON project_daily_log_photos FOR DELETE TO authenticated USING (%s)', scope);

  -- Amendments: add only (no update / delete policy exists).
  DROP POLICY IF EXISTS project_daily_log_amendments_insert ON project_daily_log_amendments;
  EXECUTE format('CREATE POLICY project_daily_log_amendments_insert ON project_daily_log_amendments FOR INSERT TO authenticated WITH CHECK (%s)', scope);

  -- Only DRAFT logs can be discarded.
  DROP POLICY IF EXISTS project_daily_logs_delete ON project_daily_logs;
  EXECUTE format('CREATE POLICY project_daily_logs_delete ON project_daily_logs FOR DELETE TO authenticated USING (%s AND status = ''draft'')', scope);
END $$;

-- =============================================================
-- RPC: save (atomic upsert of log + crew + delays + visitors)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_project_daily_log(p_project_id uuid, p_log_date date, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_status text;
  v_summary text;
  v_ai_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_log_date IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = p_project_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'invalid_project';
  END IF;
  IF jsonb_array_length(COALESCE(p_payload->'crew', '[]'::jsonb)) > 60
     OR jsonb_array_length(COALESCE(p_payload->'delays', '[]'::jsonb)) > 30
     OR jsonb_array_length(COALESCE(p_payload->'visitors', '[]'::jsonb)) > 30 THEN
    RAISE EXCEPTION 'too_many_rows';
  END IF;

  -- Serialize concurrent saves of the same project/day.
  PERFORM pg_advisory_xact_lock(hashtextextended('pdl:' || p_project_id::text || ':' || p_log_date::text, 0));

  SELECT id, status INTO v_id, v_status
    FROM project_daily_logs WHERE project_id = p_project_id AND log_date = p_log_date;
  IF v_status = 'submitted' THEN RAISE EXCEPTION 'log_locked'; END IF;

  v_summary := NULLIF(btrim(p_payload->>'ai_summary'), '');
  v_ai_at := CASE WHEN v_summary IS NULL THEN NULL ELSE NULLIF(p_payload->>'ai_generated_at', '')::timestamptz END;

  IF v_id IS NULL THEN
    INSERT INTO project_daily_logs (
      user_id, project_id, log_date, weather_code, temp_high_f, temp_low_f, wind_mph,
      weather_notes, work_performed, ai_summary, ai_generated_at, ai_edited
    ) VALUES (
      v_owner, p_project_id, p_log_date,
      NULLIF(p_payload->>'weather_code', ''),
      NULLIF(p_payload->>'temp_high_f', '')::integer,
      NULLIF(p_payload->>'temp_low_f', '')::integer,
      NULLIF(p_payload->>'wind_mph', '')::integer,
      NULLIF(btrim(p_payload->>'weather_notes'), ''),
      NULLIF(btrim(p_payload->>'work_performed'), ''),
      v_summary, v_ai_at,
      CASE WHEN v_summary IS NULL THEN false ELSE COALESCE((p_payload->>'ai_edited')::boolean, false) END
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE project_daily_logs SET
      weather_code = NULLIF(p_payload->>'weather_code', ''),
      temp_high_f = NULLIF(p_payload->>'temp_high_f', '')::integer,
      temp_low_f = NULLIF(p_payload->>'temp_low_f', '')::integer,
      wind_mph = NULLIF(p_payload->>'wind_mph', '')::integer,
      weather_notes = NULLIF(btrim(p_payload->>'weather_notes'), ''),
      work_performed = NULLIF(btrim(p_payload->>'work_performed'), ''),
      ai_summary = v_summary,
      ai_generated_at = v_ai_at,
      ai_edited = CASE WHEN v_summary IS NULL THEN false ELSE COALESCE((p_payload->>'ai_edited')::boolean, false) END
    WHERE id = v_id;
  END IF;

  DELETE FROM project_daily_log_crew WHERE log_id = v_id;
  INSERT INTO project_daily_log_crew (user_id, log_id, employee_id, name, role, hours, source, sort_order)
  SELECT v_owner, v_id, x.employee_id, btrim(x.name), NULLIF(btrim(x.role), ''),
         COALESCE(x.hours, 0), COALESCE(NULLIF(x.source, ''), 'manual'), COALESCE(x.sort_order, 0)
    FROM jsonb_to_recordset(COALESCE(p_payload->'crew', '[]'::jsonb))
         AS x(employee_id uuid, name text, role text, hours numeric, source text, sort_order integer);

  DELETE FROM project_daily_log_delays WHERE log_id = v_id;
  INSERT INTO project_daily_log_delays (user_id, log_id, cause, minutes, description, sort_order)
  SELECT v_owner, v_id, x.cause, x.minutes, NULLIF(btrim(x.description), ''), COALESCE(x.sort_order, 0)
    FROM jsonb_to_recordset(COALESCE(p_payload->'delays', '[]'::jsonb))
         AS x(cause text, minutes integer, description text, sort_order integer);

  DELETE FROM project_daily_log_visitors WHERE log_id = v_id;
  INSERT INTO project_daily_log_visitors (user_id, log_id, name, company, purpose, sort_order)
  SELECT v_owner, v_id, btrim(x.name), NULLIF(btrim(x.company), ''), NULLIF(btrim(x.purpose), ''), COALESCE(x.sort_order, 0)
    FROM jsonb_to_recordset(COALESCE(p_payload->'visitors', '[]'::jsonb))
         AS x(name text, company text, purpose text, sort_order integer);

  RETURN v_id;
END $$;

-- =============================================================
-- RPC: submit (locks the log)
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_project_daily_log(p_log_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  l project_daily_logs%ROWTYPE;
  v_at timestamptz := now();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO l FROM project_daily_logs WHERE id = p_log_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'log_not_found'; END IF;
  IF l.status = 'submitted' THEN RAISE EXCEPTION 'already_submitted'; END IF;
  IF l.weather_code IS NULL THEN RAISE EXCEPTION 'weather_required'; END IF;
  IF l.work_performed IS NULL OR char_length(btrim(l.work_performed)) = 0 THEN RAISE EXCEPTION 'work_required'; END IF;

  PERFORM set_config('app.pdl_submit', '1', true);
  UPDATE project_daily_logs
     SET status = 'submitted', submitted_at = v_at, submitted_by = auth.uid()
   WHERE id = p_log_id;
  PERFORM set_config('app.pdl_submit', '', true);
  RETURN v_at;
END $$;

-- =============================================================
-- RPC: hours already logged in timesheets for jobs linked to the project on that day
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_project_daily_log_timesheet_hours(p_project_id uuid, p_log_date date)
RETURNS TABLE (employee_id uuid, full_name text, hours numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM install_projects ip WHERE ip.id = p_project_id AND ip.user_id = v_owner) THEN
    RAISE EXCEPTION 'invalid_project';
  END IF;

  RETURN QUERY
  SELECT e.id, e.full_name::text, LEAST(24, ROUND(SUM(t.regular_hours + t.overtime_hours), 2))::numeric
    FROM timesheets t
    JOIN employees e ON e.id = t.employee_id AND e.user_id = v_owner
   WHERE t.user_id = v_owner
     AND t.work_date = p_log_date
     AND t.status <> 'rejected'
     AND t.job_id IN (SELECT pj.job_id FROM install_project_jobs pj WHERE pj.project_id = p_project_id AND pj.user_id = v_owner)
   GROUP BY e.id, e.full_name
   ORDER BY e.full_name;
END $$;

REVOKE ALL ON FUNCTION public.save_project_daily_log(uuid, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_project_daily_log(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_project_daily_log_timesheet_hours(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_project_daily_log(uuid, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_project_daily_log(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_daily_log_timesheet_hours(uuid, date) TO authenticated;
