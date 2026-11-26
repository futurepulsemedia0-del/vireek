/*
  # OSHA recordkeeping (Forms 300 / 300A / 301)  — roadmap item 109

  Employer-side injury and illness log for the account owner's establishment. Built on top of the
  existing incident ledger (safety_incidents, migration 20281201000000): a recordable injury can be
  *promoted* from an incident, but the OSHA case is a self-contained legal record, so it survives
  safety_purge_expired() deleting the incident (FK is ON DELETE SET NULL).

  ## Tables
  osha_settings            establishment identity + retention config (years)
  osha_cases               one row per recordable case (Form 300 line + Form 301 detail)
  osha_case_counters       per-owner, per-year case number sequence (no client access)
  osha_annual_summaries    Form 300A inputs (employees, hours) + certification snapshot
  osha_audit_events        who created / changed / exported / certified (field NAMES only, never values)

  ## Security
  - RLS on every table. Reads are limited to the account owner's managers (safety_can_manage()).
    Technicians and other staff cannot read any of it. `TODO(counsel)`: employee / representative
    access rights to the log and to their own Form 301 need a defined request workflow.
  - Clients cannot INSERT / UPDATE / DELETE. Every write is a SECURITY DEFINER RPC that re-checks the
    caller and the tenant (get_account_owner_id()).
  - Privacy cases: exports replace the employee name with "Privacy Case" on the server.
  - Audit events store the NAMES of changed fields, not their values (no health data in the log).

  ## Retention (config, not law)
  retain_until = Dec 31 of the case year + osha_settings.retention_years (default 5, minimum 5).
  Nothing here deletes a case automatically. osha_cases_past_retention() only lists candidates.
  `TODO(counsel)`: confirm the period and how it interacts with account erasure (erase_user_rows()).

  ## Rollback (manual, destructive, never run automatically)
  See the commented block at the bottom.
*/

-- =============================================================
-- 0) Internal guard: authenticated manager of the current tenant
-- =============================================================

CREATE OR REPLACE FUNCTION public._osha_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.safety_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage OSHA records' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public._osha_owner() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 1) Settings
-- =============================================================

CREATE TABLE IF NOT EXISTS osha_settings (
  user_id uuid PRIMARY KEY,
  establishment_name text CHECK (establishment_name IS NULL OR char_length(establishment_name) BETWEEN 1 AND 200),
  street text CHECK (street IS NULL OR char_length(street) <= 200),
  city text CHECK (city IS NULL OR char_length(city) <= 100),
  state text CHECK (state IS NULL OR char_length(state) BETWEEN 2 AND 50),
  zip text CHECK (zip IS NULL OR char_length(zip) BETWEEN 3 AND 12),
  industry_description text CHECK (industry_description IS NULL OR char_length(industry_description) <= 200),
  naics_code text CHECK (naics_code IS NULL OR naics_code ~ '^[0-9]{2,6}$'),
  retention_years integer NOT NULL DEFAULT 5 CHECK (retention_years BETWEEN 5 AND 30),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 2) Cases (Form 300 line + Form 301 detail)
-- =============================================================

CREATE TABLE IF NOT EXISTS osha_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_year integer NOT NULL CHECK (case_year BETWEEN 2000 AND 2200),
  case_seq integer NOT NULL CHECK (case_seq >= 1),
  case_no text NOT NULL,
  incident_id uuid REFERENCES safety_incidents(id) ON DELETE SET NULL,

  employee_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  employee_name text NOT NULL CHECK (char_length(btrim(employee_name)) BETWEEN 1 AND 120),
  employee_address text CHECK (employee_address IS NULL OR char_length(employee_address) <= 300),
  employee_dob date,
  date_hired date,
  employee_sex text CHECK (employee_sex IS NULL OR employee_sex IN ('male', 'female')),
  job_title text NOT NULL CHECK (char_length(btrim(job_title)) BETWEEN 1 AND 120),

  privacy_case boolean NOT NULL DEFAULT false,
  privacy_reason text CHECK (privacy_reason IS NULL OR privacy_reason IN
    ('intimate_body_part', 'sexual_assault', 'mental_illness', 'infectious_disease', 'needlestick_sharps', 'employee_request')),

  date_of_injury date NOT NULL,
  time_began_work time,
  time_of_event time,
  location_where text CHECK (location_where IS NULL OR char_length(location_where) <= 200),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 3 AND 2000),
  activity_before text CHECK (activity_before IS NULL OR char_length(activity_before) <= 1000),
  how_occurred text CHECK (how_occurred IS NULL OR char_length(how_occurred) <= 2000),
  injury_nature text CHECK (injury_nature IS NULL OR char_length(injury_nature) <= 500),
  object_substance text CHECK (object_substance IS NULL OR char_length(object_substance) <= 300),

  classification text NOT NULL CHECK (classification IN ('death', 'days_away', 'job_transfer_restriction', 'other_recordable')),
  -- `TODO(counsel)`: confirm the 180-day cap on counted days.
  days_away integer NOT NULL DEFAULT 0 CHECK (days_away BETWEEN 0 AND 180),
  days_restricted integer NOT NULL DEFAULT 0 CHECK (days_restricted BETWEEN 0 AND 180),
  illness_type text NOT NULL CHECK (illness_type IN ('injury', 'skin_disorder', 'respiratory', 'poisoning', 'hearing_loss', 'other_illness')),
  died_on date,

  treated_in_er boolean,
  hospitalized_overnight boolean,
  treatment_facility text CHECK (treatment_facility IS NULL OR char_length(treatment_facility) <= 200),
  physician_name text CHECK (physician_name IS NULL OR char_length(physician_name) <= 120),

  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 5 AND 500),
  retain_until date NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_osha_case_number UNIQUE (user_id, case_year, case_seq),
  CONSTRAINT chk_osha_death_has_date CHECK (classification <> 'death' OR died_on IS NOT NULL),
  CONSTRAINT chk_osha_died_after_injury CHECK (died_on IS NULL OR died_on >= date_of_injury),
  CONSTRAINT chk_osha_privacy_reason CHECK (privacy_case OR privacy_reason IS NULL),
  CONSTRAINT chk_osha_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT chk_osha_year_matches_date CHECK (case_year = EXTRACT(year FROM date_of_injury)::integer)
);
CREATE INDEX IF NOT EXISTS idx_osha_cases_year ON osha_cases(user_id, case_year, case_seq);
CREATE INDEX IF NOT EXISTS idx_osha_cases_retention ON osha_cases(user_id, retain_until);
-- One OSHA case per incident: makes "promote this incident" idempotent under double-clicks and retries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_osha_cases_incident ON osha_cases(user_id, incident_id) WHERE incident_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS osha_case_counters (
  user_id uuid NOT NULL,
  case_year integer NOT NULL,
  last_seq integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, case_year)
);

-- =============================================================
-- 3) Annual summary (Form 300A)
-- =============================================================

CREATE TABLE IF NOT EXISTS osha_annual_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  summary_year integer NOT NULL CHECK (summary_year BETWEEN 2000 AND 2200),
  avg_employees integer CHECK (avg_employees IS NULL OR avg_employees BETWEEN 0 AND 10000000),
  total_hours bigint CHECK (total_hours IS NULL OR total_hours BETWEEN 0 AND 100000000000),
  certified_by_name text CHECK (certified_by_name IS NULL OR char_length(btrim(certified_by_name)) BETWEEN 1 AND 120),
  certified_by_title text CHECK (certified_by_title IS NULL OR char_length(btrim(certified_by_title)) BETWEEN 1 AND 120),
  certified_phone text CHECK (certified_phone IS NULL OR char_length(certified_phone) BETWEEN 5 AND 40),
  certified_by uuid,
  certified_at timestamptz,
  certified_totals jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_osha_summary_year UNIQUE (user_id, summary_year),
  CONSTRAINT chk_osha_certification_complete CHECK (
    certified_at IS NULL
    OR (certified_by_name IS NOT NULL AND certified_by_title IS NOT NULL AND certified_totals IS NOT NULL
        AND avg_employees IS NOT NULL AND total_hours IS NOT NULL)
  )
);

-- =============================================================
-- 4) Audit trail (field names only)
-- =============================================================

CREATE TABLE IF NOT EXISTS osha_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('settings_updated', 'case_created', 'case_updated', 'case_voided',
                                     'log_exported', 'summary_saved', 'summary_exported', 'summary_certified')),
  case_id uuid REFERENCES osha_cases(id) ON DELETE SET NULL,
  report_year integer,
  changed_fields text[],
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osha_audit_user_time ON osha_audit_events(user_id, created_at DESC);

-- =============================================================
-- 5) RLS: managers of the tenant read; nobody writes directly
-- =============================================================

ALTER TABLE osha_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE osha_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE osha_case_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE osha_annual_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE osha_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "osha_settings_select" ON osha_settings;
CREATE POLICY "osha_settings_select" ON osha_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.safety_can_manage()));

DROP POLICY IF EXISTS "osha_cases_select" ON osha_cases;
CREATE POLICY "osha_cases_select" ON osha_cases FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.safety_can_manage()));

DROP POLICY IF EXISTS "osha_annual_summaries_select" ON osha_annual_summaries;
CREATE POLICY "osha_annual_summaries_select" ON osha_annual_summaries FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.safety_can_manage()));

DROP POLICY IF EXISTS "osha_audit_events_select" ON osha_audit_events;
CREATE POLICY "osha_audit_events_select" ON osha_audit_events FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.safety_can_manage()));

-- osha_case_counters: RLS on, no policy => no client access at all.
REVOKE ALL ON osha_case_counters FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON osha_settings, osha_cases, osha_annual_summaries, osha_audit_events FROM anon, authenticated;
REVOKE ALL ON osha_settings, osha_cases, osha_annual_summaries, osha_audit_events FROM anon;
GRANT SELECT ON osha_settings, osha_cases, osha_annual_summaries, osha_audit_events TO authenticated;

-- =============================================================
-- 6) RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public._osha_audit(p_owner uuid, p_kind text, p_case uuid, p_year integer, p_fields text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO osha_audit_events (user_id, kind, case_id, report_year, changed_fields, actor_id)
  VALUES (p_owner, p_kind, p_case, p_year, p_fields, auth.uid());
$$;
REVOKE ALL ON FUNCTION public._osha_audit(uuid, text, uuid, integer, text[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._osha_retain_until(p_owner uuid, p_year integer)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (make_date(p_year, 12, 31)
          + make_interval(years => coalesce((SELECT retention_years FROM osha_settings WHERE user_id = p_owner), 5)))::date;
$$;
REVOKE ALL ON FUNCTION public._osha_retain_until(uuid, integer) FROM PUBLIC, anon, authenticated;

-- Settings ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.osha_upsert_settings(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_row osha_settings%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023'; END IF;
  INSERT INTO osha_settings (user_id, establishment_name, street, city, state, zip, industry_description, naics_code, retention_years, updated_by)
  VALUES (v_owner,
          nullif(btrim(p ->> 'establishment_name'), ''), nullif(btrim(p ->> 'street'), ''), nullif(btrim(p ->> 'city'), ''),
          nullif(btrim(p ->> 'state'), ''), nullif(btrim(p ->> 'zip'), ''), nullif(btrim(p ->> 'industry_description'), ''),
          nullif(btrim(p ->> 'naics_code'), ''), coalesce(nullif(p ->> 'retention_years', '')::integer, 5), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    establishment_name = EXCLUDED.establishment_name, street = EXCLUDED.street, city = EXCLUDED.city,
    state = EXCLUDED.state, zip = EXCLUDED.zip, industry_description = EXCLUDED.industry_description,
    naics_code = EXCLUDED.naics_code, retention_years = EXCLUDED.retention_years,
    updated_by = auth.uid(), updated_at = now()
  RETURNING * INTO v_row;
  PERFORM public._osha_audit(v_owner, 'settings_updated', NULL, NULL, NULL);
  RETURN jsonb_build_object('success', true, 'retention_years', v_row.retention_years);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_upsert_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_upsert_settings(jsonb) TO authenticated;

-- Create case (optionally promoted from a safety incident; idempotent per incident) ----------

CREATE OR REPLACE FUNCTION public.osha_create_case(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_inc uuid := nullif(p ->> 'incident_id', '')::uuid;
  v_member uuid := nullif(p ->> 'employee_member_id', '')::uuid;
  v_doi date := nullif(p ->> 'date_of_injury', '')::date;
  v_name text := nullif(btrim(p ->> 'employee_name'), '');
  v_existing osha_cases%ROWTYPE;
  v_incident safety_incidents%ROWTYPE;
  v_member_name text;
  v_year integer;
  v_seq integer;
  v_row osha_cases%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid case' USING ERRCODE = '22023'; END IF;

  IF v_inc IS NOT NULL THEN
    SELECT * INTO v_existing FROM osha_cases WHERE user_id = v_owner AND incident_id = v_inc;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'existing', true, 'id', v_existing.id, 'case_no', v_existing.case_no);
    END IF;
    SELECT * INTO v_incident FROM safety_incidents WHERE id = v_inc AND user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002'; END IF;
    IF v_incident.category <> 'injury' THEN RAISE EXCEPTION 'Only injury incidents can be promoted to an OSHA case' USING ERRCODE = '22023'; END IF;
    v_doi := coalesce(v_doi, v_incident.occurred_at::date);
  END IF;

  IF v_member IS NOT NULL THEN
    SELECT member_name INTO v_member_name FROM team_members WHERE id = v_member AND account_owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
    v_name := coalesce(v_name, nullif(btrim(v_member_name), ''));
  END IF;

  IF v_doi IS NULL THEN RAISE EXCEPTION 'Date of injury is required' USING ERRCODE = '22023'; END IF;
  IF v_doi > current_date THEN RAISE EXCEPTION 'The date of injury cannot be in the future' USING ERRCODE = '22023'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Employee name is required' USING ERRCODE = '22023'; END IF;

  v_year := EXTRACT(year FROM v_doi)::integer;

  -- A unique violation on the incident index (concurrent double submit) rolls the counter bump back.
  BEGIN
    INSERT INTO osha_case_counters (user_id, case_year, last_seq) VALUES (v_owner, v_year, 1)
    ON CONFLICT (user_id, case_year) DO UPDATE SET last_seq = osha_case_counters.last_seq + 1
    RETURNING last_seq INTO v_seq;

    INSERT INTO osha_cases (
      user_id, case_year, case_seq, case_no, incident_id, employee_member_id, employee_name, employee_address, employee_dob,
      date_hired, employee_sex, job_title, privacy_case, privacy_reason, date_of_injury, time_began_work, time_of_event,
      location_where, description, activity_before, how_occurred, injury_nature, object_substance, classification,
      days_away, days_restricted, illness_type, died_on, treated_in_er, hospitalized_overnight, treatment_facility,
      physician_name, retain_until, created_by)
    VALUES (
      v_owner, v_year, v_seq, v_year::text || '-' || lpad(v_seq::text, 3, '0'), v_inc, v_member, v_name,
      nullif(btrim(p ->> 'employee_address'), ''), nullif(p ->> 'employee_dob', '')::date,
      nullif(p ->> 'date_hired', '')::date, nullif(p ->> 'employee_sex', ''), btrim(p ->> 'job_title'),
      coalesce((p ->> 'privacy_case')::boolean, false), nullif(p ->> 'privacy_reason', ''), v_doi,
      nullif(p ->> 'time_began_work', '')::time, nullif(p ->> 'time_of_event', '')::time,
      nullif(btrim(p ->> 'location_where'), ''), btrim(coalesce(p ->> 'description', v_incident.description)),
      nullif(btrim(p ->> 'activity_before'), ''), nullif(btrim(p ->> 'how_occurred'), ''),
      nullif(btrim(p ->> 'injury_nature'), ''), nullif(btrim(p ->> 'object_substance'), ''),
      p ->> 'classification', coalesce(nullif(p ->> 'days_away', '')::integer, 0),
      coalesce(nullif(p ->> 'days_restricted', '')::integer, 0), coalesce(nullif(p ->> 'illness_type', ''), 'injury'),
      nullif(p ->> 'died_on', '')::date, (p ->> 'treated_in_er')::boolean, (p ->> 'hospitalized_overnight')::boolean,
      nullif(btrim(p ->> 'treatment_facility'), ''), nullif(btrim(p ->> 'physician_name'), ''),
      public._osha_retain_until(v_owner, v_year), auth.uid())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    IF v_inc IS NOT NULL THEN
      SELECT * INTO v_existing FROM osha_cases WHERE user_id = v_owner AND incident_id = v_inc;
      IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'existing', true, 'id', v_existing.id, 'case_no', v_existing.case_no);
      END IF;
    END IF;
    RAISE;
  END;

  PERFORM public._osha_audit(v_owner, 'case_created', v_row.id, v_year, NULL);
  RETURN jsonb_build_object('success', true, 'existing', false, 'id', v_row.id, 'case_no', v_row.case_no, 'retain_until', v_row.retain_until);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_create_case(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_create_case(jsonb) TO authenticated;

-- Update case (whitelisted fields; date of injury is fixed because it decides the case number) ----

CREATE OR REPLACE FUNCTION public.osha_update_case(p_id uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_old osha_cases%ROWTYPE;
  v_new osha_cases%ROWTYPE;
  v_fields text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid update' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_old FROM osha_cases WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.voided_at IS NOT NULL THEN RAISE EXCEPTION 'A voided case cannot be changed' USING ERRCODE = '22023'; END IF;

  UPDATE osha_cases SET
    employee_name = CASE WHEN p ? 'employee_name' THEN btrim(p ->> 'employee_name') ELSE employee_name END,
    employee_address = CASE WHEN p ? 'employee_address' THEN nullif(btrim(p ->> 'employee_address'), '') ELSE employee_address END,
    employee_dob = CASE WHEN p ? 'employee_dob' THEN nullif(p ->> 'employee_dob', '')::date ELSE employee_dob END,
    date_hired = CASE WHEN p ? 'date_hired' THEN nullif(p ->> 'date_hired', '')::date ELSE date_hired END,
    employee_sex = CASE WHEN p ? 'employee_sex' THEN nullif(p ->> 'employee_sex', '') ELSE employee_sex END,
    job_title = CASE WHEN p ? 'job_title' THEN btrim(p ->> 'job_title') ELSE job_title END,
    privacy_case = CASE WHEN p ? 'privacy_case' THEN (p ->> 'privacy_case')::boolean ELSE privacy_case END,
    privacy_reason = CASE WHEN p ? 'privacy_reason' THEN nullif(p ->> 'privacy_reason', '') ELSE privacy_reason END,
    time_began_work = CASE WHEN p ? 'time_began_work' THEN nullif(p ->> 'time_began_work', '')::time ELSE time_began_work END,
    time_of_event = CASE WHEN p ? 'time_of_event' THEN nullif(p ->> 'time_of_event', '')::time ELSE time_of_event END,
    location_where = CASE WHEN p ? 'location_where' THEN nullif(btrim(p ->> 'location_where'), '') ELSE location_where END,
    description = CASE WHEN p ? 'description' THEN btrim(p ->> 'description') ELSE description END,
    activity_before = CASE WHEN p ? 'activity_before' THEN nullif(btrim(p ->> 'activity_before'), '') ELSE activity_before END,
    how_occurred = CASE WHEN p ? 'how_occurred' THEN nullif(btrim(p ->> 'how_occurred'), '') ELSE how_occurred END,
    injury_nature = CASE WHEN p ? 'injury_nature' THEN nullif(btrim(p ->> 'injury_nature'), '') ELSE injury_nature END,
    object_substance = CASE WHEN p ? 'object_substance' THEN nullif(btrim(p ->> 'object_substance'), '') ELSE object_substance END,
    classification = CASE WHEN p ? 'classification' THEN p ->> 'classification' ELSE classification END,
    days_away = CASE WHEN p ? 'days_away' THEN coalesce(nullif(p ->> 'days_away', '')::integer, 0) ELSE days_away END,
    days_restricted = CASE WHEN p ? 'days_restricted' THEN coalesce(nullif(p ->> 'days_restricted', '')::integer, 0) ELSE days_restricted END,
    illness_type = CASE WHEN p ? 'illness_type' THEN p ->> 'illness_type' ELSE illness_type END,
    died_on = CASE WHEN p ? 'died_on' THEN nullif(p ->> 'died_on', '')::date ELSE died_on END,
    treated_in_er = CASE WHEN p ? 'treated_in_er' THEN (p ->> 'treated_in_er')::boolean ELSE treated_in_er END,
    hospitalized_overnight = CASE WHEN p ? 'hospitalized_overnight' THEN (p ->> 'hospitalized_overnight')::boolean ELSE hospitalized_overnight END,
    treatment_facility = CASE WHEN p ? 'treatment_facility' THEN nullif(btrim(p ->> 'treatment_facility'), '') ELSE treatment_facility END,
    physician_name = CASE WHEN p ? 'physician_name' THEN nullif(btrim(p ->> 'physician_name'), '') ELSE physician_name END,
    updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_new;

  SELECT coalesce(array_agg(n.key ORDER BY n.key), ARRAY[]::text[]) INTO v_fields
  FROM jsonb_each(to_jsonb(v_new)) AS n(key, value)
  JOIN jsonb_each(to_jsonb(v_old)) AS o(key, value) ON o.key = n.key
  WHERE n.value IS DISTINCT FROM o.value AND n.key <> 'updated_at';

  IF coalesce(array_length(v_fields, 1), 0) > 0 THEN
    PERFORM public._osha_audit(v_owner, 'case_updated', p_id, v_new.case_year, v_fields);
  END IF;
  RETURN jsonb_build_object('success', true, 'changed_fields', to_jsonb(v_fields));
END;
$$;
REVOKE ALL ON FUNCTION public.osha_update_case(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_update_case(uuid, jsonb) TO authenticated;

-- Void: the row stays (retention), it just stops counting ----------------------------

CREATE OR REPLACE FUNCTION public.osha_void_case(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_row osha_cases%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Give a reason of at least 5 characters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM osha_cases WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.voided_at IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'already_voided', true); END IF;
  IF EXISTS (SELECT 1 FROM osha_annual_summaries WHERE user_id = v_owner AND summary_year = v_row.case_year AND certified_at IS NOT NULL) THEN
    -- `TODO(counsel)`: define the amendment procedure for a certified year.
    RAISE EXCEPTION 'The % summary is already certified; amend it through the documented procedure first', v_row.case_year USING ERRCODE = '22023';
  END IF;
  UPDATE osha_cases SET voided_at = now(), void_reason = left(btrim(p_reason), 500), updated_at = now() WHERE id = p_id;
  PERFORM public._osha_audit(v_owner, 'case_voided', p_id, v_row.case_year, NULL);
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_void_case(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_void_case(uuid, text) TO authenticated;

-- Totals (shared by export and certification) -----------------------------------------

CREATE OR REPLACE FUNCTION public._osha_totals(p_owner uuid, p_year integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'deaths',                   count(*) FILTER (WHERE classification = 'death'),
    'days_away_cases',          count(*) FILTER (WHERE classification = 'days_away'),
    'job_transfer_cases',       count(*) FILTER (WHERE classification = 'job_transfer_restriction'),
    'other_recordable_cases',   count(*) FILTER (WHERE classification = 'other_recordable'),
    'total_days_away',          coalesce(sum(days_away), 0),
    'total_days_restricted',    coalesce(sum(days_restricted), 0),
    'injuries',                 count(*) FILTER (WHERE illness_type = 'injury'),
    'skin_disorders',           count(*) FILTER (WHERE illness_type = 'skin_disorder'),
    'respiratory_conditions',   count(*) FILTER (WHERE illness_type = 'respiratory'),
    'poisonings',               count(*) FILTER (WHERE illness_type = 'poisoning'),
    'hearing_loss',             count(*) FILTER (WHERE illness_type = 'hearing_loss'),
    'other_illnesses',          count(*) FILTER (WHERE illness_type = 'other_illness'),
    'total_cases',              count(*)
  )
  FROM osha_cases WHERE user_id = p_owner AND case_year = p_year AND voided_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public._osha_totals(uuid, integer) FROM PUBLIC, anon, authenticated;

-- Form 300 export (privacy cases masked on the server) --------------------------------

CREATE OR REPLACE FUNCTION public.osha_export_log(p_year integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_rows jsonb;
BEGIN
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'Invalid year' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'case_no', c.case_no,
      'employee_name', CASE WHEN c.privacy_case THEN 'Privacy Case' ELSE c.employee_name END,
      'job_title', c.job_title,
      'date_of_injury', c.date_of_injury,
      'location_where', c.location_where,
      'description', c.description,
      'classification', c.classification,
      'days_away', c.days_away,
      'days_restricted', c.days_restricted,
      'illness_type', c.illness_type,
      'privacy_case', c.privacy_case
    ) ORDER BY c.case_seq), '[]'::jsonb)
  INTO v_rows
  FROM osha_cases c WHERE c.user_id = v_owner AND c.case_year = p_year AND c.voided_at IS NULL;
  PERFORM public._osha_audit(v_owner, 'log_exported', NULL, p_year, NULL);
  RETURN jsonb_build_object(
    'year', p_year,
    'establishment', (SELECT to_jsonb(s) - 'user_id' - 'updated_by' FROM osha_settings s WHERE s.user_id = v_owner),
    'rows', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_export_log(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_export_log(integer) TO authenticated;

-- Form 300A inputs, export, certification ---------------------------------------------

CREATE OR REPLACE FUNCTION public.osha_save_summary_inputs(p_year integer, p_avg_employees integer, p_total_hours bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_cert timestamptz;
BEGIN
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'Invalid year' USING ERRCODE = '22023'; END IF;
  SELECT certified_at INTO v_cert FROM osha_annual_summaries WHERE user_id = v_owner AND summary_year = p_year FOR UPDATE;
  IF v_cert IS NOT NULL THEN RAISE EXCEPTION 'This summary is already certified' USING ERRCODE = '22023'; END IF;
  INSERT INTO osha_annual_summaries (user_id, summary_year, avg_employees, total_hours)
  VALUES (v_owner, p_year, p_avg_employees, p_total_hours)
  ON CONFLICT (user_id, summary_year) DO UPDATE SET avg_employees = EXCLUDED.avg_employees, total_hours = EXCLUDED.total_hours, updated_at = now();
  PERFORM public._osha_audit(v_owner, 'summary_saved', NULL, p_year, ARRAY['avg_employees', 'total_hours']);
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_save_summary_inputs(integer, integer, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_save_summary_inputs(integer, integer, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.osha_export_summary(p_year integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_s osha_annual_summaries%ROWTYPE;
  v_cfg osha_settings%ROWTYPE;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'Invalid year' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_s FROM osha_annual_summaries WHERE user_id = v_owner AND summary_year = p_year;
  SELECT * INTO v_cfg FROM osha_settings WHERE user_id = v_owner;
  IF v_cfg.establishment_name IS NULL THEN v_missing := v_missing || 'establishment_name'; END IF;
  IF v_cfg.street IS NULL OR v_cfg.city IS NULL OR v_cfg.state IS NULL OR v_cfg.zip IS NULL THEN v_missing := v_missing || 'establishment_address'; END IF;
  IF v_s.avg_employees IS NULL THEN v_missing := v_missing || 'avg_employees'; END IF;
  IF v_s.total_hours IS NULL THEN v_missing := v_missing || 'total_hours'; END IF;
  PERFORM public._osha_audit(v_owner, 'summary_exported', NULL, p_year, NULL);
  RETURN jsonb_build_object(
    'year', p_year,
    'establishment', (SELECT to_jsonb(s) - 'user_id' - 'updated_by' FROM osha_settings s WHERE s.user_id = v_owner),
    'avg_employees', v_s.avg_employees,
    'total_hours', v_s.total_hours,
    -- After certification the frozen snapshot is returned, so later edits cannot silently change a certified form.
    'totals', coalesce(v_s.certified_totals, public._osha_totals(v_owner, p_year)),
    'certification', CASE WHEN v_s.certified_at IS NULL THEN NULL ELSE jsonb_build_object(
      'name', v_s.certified_by_name, 'title', v_s.certified_by_title, 'phone', v_s.certified_phone, 'at', v_s.certified_at) END,
    'missing', to_jsonb(v_missing));
END;
$$;
REVOKE ALL ON FUNCTION public.osha_export_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_export_summary(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.osha_certify_summary(p_year integer, p_name text, p_title text, p_phone text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
  v_s osha_annual_summaries%ROWTYPE;
BEGIN
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'Invalid year' USING ERRCODE = '22023'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' OR p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'Name and title of the certifying person are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_s FROM osha_annual_summaries WHERE user_id = v_owner AND summary_year = p_year FOR UPDATE;
  IF NOT FOUND OR v_s.avg_employees IS NULL OR v_s.total_hours IS NULL THEN
    RAISE EXCEPTION 'Enter average employees and total hours worked first' USING ERRCODE = '22023';
  END IF;
  IF v_s.certified_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_certified', true, 'certified_at', v_s.certified_at);
  END IF;
  -- `TODO(counsel)`: who qualifies as the certifying company executive is a legal question; the app only records who attested.
  UPDATE osha_annual_summaries SET
    certified_by_name = left(btrim(p_name), 120), certified_by_title = left(btrim(p_title), 120),
    certified_phone = nullif(left(btrim(p_phone), 40), ''), certified_by = auth.uid(), certified_at = now(),
    certified_totals = public._osha_totals(v_owner, p_year), updated_at = now()
  WHERE id = v_s.id;
  PERFORM public._osha_audit(v_owner, 'summary_certified', NULL, p_year, NULL);
  RETURN jsonb_build_object('success', true, 'already_certified', false);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_certify_summary(integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_certify_summary(integer, text, text, text) TO authenticated;

-- Retention: report only, never deletes -------------------------------------------------

CREATE OR REPLACE FUNCTION public.osha_cases_past_retention()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._osha_owner();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'case_no', case_no, 'retain_until', retain_until) ORDER BY retain_until)
                   FROM osha_cases WHERE user_id = v_owner AND retain_until < current_date), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.osha_cases_past_retention() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osha_cases_past_retention() TO authenticated;

/*
## Rollback (manual; destroys legal records — export first)
-- drop function if exists public.osha_cases_past_retention(), public.osha_certify_summary(integer, text, text, text),
--   public.osha_export_summary(integer), public.osha_save_summary_inputs(integer, integer, bigint),
--   public.osha_export_log(integer), public._osha_totals(uuid, integer), public.osha_void_case(uuid, text),
--   public.osha_update_case(uuid, jsonb), public.osha_create_case(jsonb), public.osha_upsert_settings(jsonb),
--   public._osha_retain_until(uuid, integer), public._osha_audit(uuid, text, uuid, integer, text[]), public._osha_owner();
-- drop table if exists osha_audit_events, osha_annual_summaries, osha_case_counters, osha_cases, osha_settings;
*/
