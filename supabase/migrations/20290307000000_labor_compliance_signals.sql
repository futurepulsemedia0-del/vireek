/*
  # Labor-compliance SIGNALS (worker-classification flag + overtime / prevailing-wage rule config + review log)

  [COUNSEL] [VERIFY] — read this before changing anything.

  ## What this is
  A way to FLAG time-clock records that deserve a human look. It never concludes that a law was or was not
  followed. All rule numbers are editable data, start as "needs counsel review", and carry a "verified on"
  date that stays empty until a person compares the numbers with the source.

  ## What already exists (NOT duplicated here)
  - time_shifts / time_shift_breaks / time_shift_jobs / timesheets   (20271009000000_tech_time_clock.sql)
  - meal & rest break rules + violation reviews                      (20271210000000, 20271215000000)
  - prevailing-wage tables, rule sets, per-job worker classification (20271102000000_prevailing_wage_engine.sql)
  Break signals are re-used read-only from the break engine; prevailing-wage data is only READ.

  ## What this adds (additive only — no existing table, column, policy or function signature changes)
  1. labor_worker_classifications  business-recorded classification flag per employee
  2. labor_rule_configs            jurisdiction rule config per account (topics: overtime, prevailing_wage)
  3. labor_signal_reviews          acknowledgement / counsel-escalation of one signal (stable signal_key)
  4. labor_audit_log               who changed a classification / rule config / review, old + new
  5. RPCs: labor_signals_overview, set_worker_classification, save_labor_rule_config,
           record_labor_rule_review, review_labor_signal

  ## Security
  - Tenant: every row carries user_id = get_account_owner_id(); every RPC re-derives it from auth.uid().
  - View needs can_view_billing (owner always); edit needs owner OR (can_view_billing AND can_edit_business_profile)
    — the same gates as the prevailing-wage engine (pw_can_view / pw_can_edit). Enforced in the database.
  - Tables are read-only from the client (SELECT policy for managers); all writes go through RPCs.
  - Technicians cannot read any of this, including their own classification record.

  ## Rollback (manual; do not run on a live account without counsel sign-off — it deletes the audit trail) [COUNSEL]
    DROP FUNCTION IF EXISTS public.review_labor_signal(text, text, text);
    DROP FUNCTION IF EXISTS public.record_labor_rule_review(text, text, date, text);
    DROP FUNCTION IF EXISTS public.save_labor_rule_config(text, text, boolean, jsonb, text, text);
    DROP FUNCTION IF EXISTS public.set_worker_classification(uuid, text, text);
    DROP FUNCTION IF EXISTS public.labor_signals_overview(date, date);
    DROP FUNCTION IF EXISTS public.labor_validate_params(text, jsonb);
    DROP TABLE IF EXISTS labor_audit_log, labor_signal_reviews, labor_rule_configs, labor_worker_classifications;
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS labor_worker_classifications (
  employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What THE BUSINESS has recorded. Vireek does not decide or verify classification.
  classification text NOT NULL DEFAULT 'unreviewed'
    CHECK (classification IN ('unreviewed', 'hourly_recorded', 'apprentice_recorded', 'exempt_recorded', 'contractor_recorded')),
  basis_note text CHECK (basis_note IS NULL OR char_length(basis_note) <= 500),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labor_class_user ON labor_worker_classifications(user_id);

CREATE TABLE IF NOT EXISTS labor_rule_configs (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic text NOT NULL CHECK (topic IN ('overtime', 'prevailing_wage')),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2,12}$'),
  enabled boolean NOT NULL DEFAULT true,
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  citation text CHECK (citation IS NULL OR char_length(citation) <= 300),
  source_url text CHECK (source_url IS NULL OR (char_length(source_url) <= 500 AND source_url ~ '^https?://')),
  -- [COUNSEL] stays open until a person records who at counsel reviewed it
  counsel_status text NOT NULL DEFAULT 'needs_counsel' CHECK (counsel_status IN ('needs_counsel', 'counsel_reviewed')),
  counsel_reviewed_by text CHECK (counsel_reviewed_by IS NULL OR char_length(counsel_reviewed_by) <= 160),
  counsel_reviewed_at timestamptz,
  counsel_note text CHECK (counsel_note IS NULL OR char_length(counsel_note) <= 500),
  -- [VERIFY] stays open until a person records the date the numbers were compared with the source
  verified_on date,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic),
  CONSTRAINT labor_rule_counsel_chk CHECK (
    counsel_status <> 'counsel_reviewed'
    OR (counsel_reviewed_by IS NOT NULL AND btrim(counsel_reviewed_by) <> '' AND counsel_reviewed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS labor_signal_reviews (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_key text NOT NULL CHECK (char_length(signal_key) <= 100),
  anchor_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('acknowledged', 'no_action_needed', 'sent_to_counsel')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewer_name text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_labor_reviews_user_anchor ON labor_signal_reviews(user_id, anchor_date DESC);

CREATE TABLE IF NOT EXISTS labor_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('classification_set', 'rule_saved', 'rule_review_recorded', 'signal_reviewed')),
  subject text NOT NULL CHECK (char_length(subject) <= 120),
  old_data jsonb,
  new_data jsonb,
  actor uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labor_audit_user_time ON labor_audit_log(user_id, created_at DESC);

-- =============================================================
-- ROW LEVEL SECURITY — managers read, nobody writes directly
-- =============================================================

ALTER TABLE labor_worker_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_rule_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_signal_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS labor_class_select ON labor_worker_classifications;
CREATE POLICY labor_class_select ON labor_worker_classifications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

DROP POLICY IF EXISTS labor_rules_select ON labor_rule_configs;
CREATE POLICY labor_rules_select ON labor_rule_configs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

DROP POLICY IF EXISTS labor_reviews_select ON labor_signal_reviews;
CREATE POLICY labor_reviews_select ON labor_signal_reviews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

DROP POLICY IF EXISTS labor_audit_select ON labor_audit_log;
CREATE POLICY labor_audit_select ON labor_audit_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

REVOKE ALL ON labor_worker_classifications, labor_rule_configs, labor_signal_reviews, labor_audit_log FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON labor_worker_classifications, labor_rule_configs, labor_signal_reviews, labor_audit_log FROM authenticated;
GRANT SELECT ON labor_worker_classifications, labor_rule_configs, labor_signal_reviews, labor_audit_log TO authenticated;

-- =============================================================
-- PARAMETER VALIDATION (mirrors src/lib/laborSignals/rules.ts)
-- Returns a NORMALISED object containing only known keys. Raises on anything else.
-- =============================================================

CREATE OR REPLACE FUNCTION public.labor_validate_params(p_topic text, p_params jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_dow numeric; v_weekly numeric; v_dot numeric; v_ddt numeric; v_open numeric; v_tol numeric;
  v_seventh boolean; v_a boolean; v_b boolean;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RAISE EXCEPTION 'Invalid rule parameters' USING ERRCODE = '22023';
  END IF;

  IF p_topic = 'overtime' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k NOT IN
      ('workweek_start_dow','weekly_threshold_hours','daily_ot_after_hours','daily_dt_after_hours','seventh_day_signal','open_shift_alert_hours','payroll_gap_tolerance_hours')) THEN
      RAISE EXCEPTION 'Unknown rule parameter' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_params->'workweek_start_dow') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_params->'open_shift_alert_hours') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_params->'payroll_gap_tolerance_hours') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_params->'seventh_day_signal') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid rule parameters' USING ERRCODE = '22023';
    END IF;
    IF (p_params->'weekly_threshold_hours') IS NOT NULL AND jsonb_typeof(p_params->'weekly_threshold_hours') NOT IN ('number','null')
       OR (p_params->'daily_ot_after_hours') IS NOT NULL AND jsonb_typeof(p_params->'daily_ot_after_hours') NOT IN ('number','null')
       OR (p_params->'daily_dt_after_hours') IS NOT NULL AND jsonb_typeof(p_params->'daily_dt_after_hours') NOT IN ('number','null') THEN
      RAISE EXCEPTION 'Invalid rule parameters' USING ERRCODE = '22023';
    END IF;
    v_dow := (p_params->>'workweek_start_dow')::numeric;
    v_weekly := NULLIF(p_params->>'weekly_threshold_hours', '')::numeric;
    v_dot := NULLIF(p_params->>'daily_ot_after_hours', '')::numeric;
    v_ddt := NULLIF(p_params->>'daily_dt_after_hours', '')::numeric;
    v_open := (p_params->>'open_shift_alert_hours')::numeric;
    v_tol := (p_params->>'payroll_gap_tolerance_hours')::numeric;
    v_seventh := (p_params->>'seventh_day_signal')::boolean;
    IF v_dow < 0 OR v_dow > 6 OR v_dow <> trunc(v_dow) THEN RAISE EXCEPTION 'Invalid workweek start' USING ERRCODE = '22023'; END IF;
    IF v_weekly IS NOT NULL AND (v_weekly < 1 OR v_weekly > 168) THEN RAISE EXCEPTION 'Invalid weekly threshold' USING ERRCODE = '22023'; END IF;
    IF v_dot IS NOT NULL AND (v_dot < 1 OR v_dot > 24) THEN RAISE EXCEPTION 'Invalid daily threshold' USING ERRCODE = '22023'; END IF;
    IF v_ddt IS NOT NULL AND (v_ddt < 1 OR v_ddt > 24) THEN RAISE EXCEPTION 'Invalid second daily threshold' USING ERRCODE = '22023'; END IF;
    IF v_ddt IS NOT NULL AND (v_dot IS NULL OR v_ddt <= v_dot) THEN RAISE EXCEPTION 'Second daily threshold must be higher than the first' USING ERRCODE = '22023'; END IF;
    IF v_open < 4 OR v_open > 48 THEN RAISE EXCEPTION 'Invalid open-shift alert hours' USING ERRCODE = '22023'; END IF;
    IF v_tol < 0 OR v_tol > 8 THEN RAISE EXCEPTION 'Invalid tolerance' USING ERRCODE = '22023'; END IF;
    IF v_weekly IS NULL AND v_dot IS NULL AND NOT v_seventh THEN RAISE EXCEPTION 'Set at least one threshold' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object(
      'workweek_start_dow', v_dow::int,
      'weekly_threshold_hours', v_weekly,
      'daily_ot_after_hours', v_dot,
      'daily_dt_after_hours', v_ddt,
      'seventh_day_signal', v_seventh,
      'open_shift_alert_hours', v_open,
      'payroll_gap_tolerance_hours', v_tol
    );

  ELSIF p_topic = 'prevailing_wage' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k NOT IN ('check_missing_classification','check_rate_below_table')) THEN
      RAISE EXCEPTION 'Unknown rule parameter' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_params->'check_missing_classification') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(p_params->'check_rate_below_table') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid rule parameters' USING ERRCODE = '22023';
    END IF;
    v_a := (p_params->>'check_missing_classification')::boolean;
    v_b := (p_params->>'check_rate_below_table')::boolean;
    IF NOT v_a AND NOT v_b THEN RAISE EXCEPTION 'Turn on at least one check' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('check_missing_classification', v_a, 'check_rate_below_table', v_b);
  END IF;

  RAISE EXCEPTION 'Unknown rule topic' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.labor_validate_params(text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- READ: one call returns everything the page evaluates (manager only, one account)
-- =============================================================

CREATE OR REPLACE FUNCTION public.labor_signals_overview(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_shift_count integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.pw_can_view() THEN
    RAISE EXCEPTION 'You do not have permission to view labor signals' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 120 THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_shift_count FROM time_shifts s WHERE s.user_id = v_owner AND s.work_date BETWEEN p_from AND p_to;

  RETURN jsonb_build_object(
    'can_edit', public.pw_can_edit(),
    'shifts_truncated', v_shift_count > 5000,

    'employees', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'team_member_id', e.team_member_id, 'name', e.full_name,
        'employment_type', e.employment_type, 'pay_type', e.pay_type,
        'classification', COALESCE(c.classification, 'unreviewed'),
        'basis_note', c.basis_note, 'recorded_at', c.recorded_at) ORDER BY e.full_name)
      FROM employees e
      LEFT JOIN labor_worker_classifications c ON c.employee_id = e.id AND c.user_id = v_owner
      WHERE e.user_id = v_owner AND e.active), '[]'::jsonb),

    'shifts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'employee_id', t.employee_id, 'team_member_id', t.team_member_id, 'work_date', t.work_date,
        'clock_in_at', t.clock_in_at, 'clock_out_at', t.clock_out_at,
        'breaks', COALESCE((SELECT jsonb_agg(jsonb_build_object('started_at', b.started_at, 'ended_at', b.ended_at) ORDER BY b.started_at)
                              FROM time_shift_breaks b WHERE b.shift_id = t.id), '[]'::jsonb)))
      FROM (SELECT s.* FROM time_shifts s WHERE s.user_id = v_owner AND s.work_date BETWEEN p_from AND p_to
             ORDER BY s.clock_in_at DESC LIMIT 5000) t), '[]'::jsonb),

    'payroll', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'work_date', x.work_date, 'overtime_hours', x.ot))
      FROM (SELECT ts.employee_id, ts.work_date, SUM(ts.overtime_hours) AS ot
              FROM timesheets ts
             WHERE ts.user_id = v_owner AND ts.work_date BETWEEN p_from AND p_to AND ts.status <> 'rejected'
             GROUP BY ts.employee_id, ts.work_date LIMIT 20000) x), '[]'::jsonb),

    'pw_segments', COALESCE((
      WITH seg AS (
        SELECT s.employee_id, j.job_id, s.work_date, a.determination_id,
               SUM(EXTRACT(EPOCH FROM (j.ended_at - j.started_at)) / 60.0) AS minutes
          FROM time_shifts s
          JOIN time_shift_jobs j ON j.shift_id = s.id AND j.ended_at IS NOT NULL AND j.job_id IS NOT NULL
          JOIN pw_job_assignments a ON a.job_id = j.job_id AND a.user_id = v_owner
         WHERE s.user_id = v_owner AND s.work_date BETWEEN p_from AND p_to
         GROUP BY s.employee_id, j.job_id, s.work_date, a.determination_id
         LIMIT 5000
      ), cls AS (
        SELECT seg.*, (SELECT w.classification FROM pw_job_workers w
                        WHERE w.user_id = v_owner AND w.job_id = seg.job_id AND w.employee_id = seg.employee_id
                          AND w.effective_from <= seg.work_date
                        ORDER BY w.effective_from DESC LIMIT 1) AS classification
          FROM seg
      )
      SELECT jsonb_agg(jsonb_build_object(
        'employee_id', c.employee_id, 'job_id', c.job_id, 'work_date', c.work_date,
        'minutes', round(c.minutes)::int, 'classification', c.classification,
        'paid_cents', CASE WHEN e.hourly_rate_cents IS NULL THEN NULL ELSE e.hourly_rate_cents + COALESCE(wp.fringe_plan_cents_per_hour, 0) END,
        'table_cents', (SELECT r.base_rate_cents + r.fringe_cents FROM pw_wage_rates r
                         WHERE r.user_id = v_owner AND r.determination_id = c.determination_id AND c.classification IS NOT NULL
                           AND lower(btrim(r.classification)) = lower(btrim(c.classification))
                           AND r.effective_from <= c.work_date AND (r.effective_to IS NULL OR r.effective_to >= c.work_date)
                         ORDER BY r.effective_from DESC LIMIT 1)))
        FROM cls c
        JOIN employees e ON e.id = c.employee_id AND e.user_id = v_owner
        LEFT JOIN pw_worker_profiles wp ON wp.employee_id = e.id AND wp.user_id = v_owner), '[]'::jsonb),

    'rules', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'topic', r.topic, 'jurisdiction', r.jurisdiction, 'enabled', r.enabled, 'params', r.params,
        'citation', r.citation, 'source_url', r.source_url, 'counsel_status', r.counsel_status,
        'counsel_reviewed_by', r.counsel_reviewed_by, 'counsel_reviewed_at', r.counsel_reviewed_at,
        'verified_on', r.verified_on))
      FROM labor_rule_configs r WHERE r.user_id = v_owner), '[]'::jsonb),

    'break_settings', public.break_comp_settings_json(v_owner),
    'break_reviews', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('shift_id', br.shift_id, 'code', br.code, 'status', br.status, 'note', br.note))
      FROM break_violation_reviews br
      JOIN time_shifts s ON s.id = br.shift_id AND s.user_id = v_owner AND s.work_date BETWEEN p_from AND p_to
      WHERE br.user_id = v_owner), '[]'::jsonb),

    'reviews', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('signal_key', lr.signal_key, 'status', lr.status, 'note', lr.note))
      FROM labor_signal_reviews lr
      WHERE lr.user_id = v_owner AND lr.anchor_date BETWEEN p_from - 31 AND p_to), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- WRITE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_worker_classification(p_employee_id uuid, p_classification text, p_basis_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_old jsonb;
  v_note text := NULLIF(left(btrim(COALESCE(p_basis_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  IF NOT public.pw_can_edit() THEN RAISE EXCEPTION 'You do not have permission to edit worker classification records' USING ERRCODE = '42501'; END IF;
  IF p_classification IS NULL OR p_classification NOT IN ('unreviewed', 'hourly_recorded', 'apprentice_recorded', 'exempt_recorded', 'contractor_recorded') THEN
    RAISE EXCEPTION 'Unknown classification' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = p_employee_id AND e.user_id = v_owner) THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_build_object('classification', c.classification, 'basis_note', c.basis_note)
    INTO v_old FROM labor_worker_classifications c WHERE c.employee_id = p_employee_id AND c.user_id = v_owner;

  INSERT INTO labor_worker_classifications AS c (employee_id, user_id, classification, basis_note, recorded_by, recorded_at)
  VALUES (p_employee_id, v_owner, p_classification, v_note, auth.uid(), now())
  ON CONFLICT (employee_id) DO UPDATE
    SET classification = EXCLUDED.classification, basis_note = EXCLUDED.basis_note,
        recorded_by = EXCLUDED.recorded_by, recorded_at = now()
    WHERE c.user_id = v_owner;

  INSERT INTO labor_audit_log (user_id, action, subject, old_data, new_data, actor)
  VALUES (v_owner, 'classification_set', 'employee:' || p_employee_id::text, v_old,
          jsonb_build_object('classification', p_classification, 'basis_note', v_note), auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.save_labor_rule_config(
  p_topic text, p_jurisdiction text, p_enabled boolean, p_params jsonb, p_citation text DEFAULT NULL, p_source_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_norm jsonb;
  v_old labor_rule_configs%ROWTYPE;
  v_cit text := NULLIF(left(btrim(COALESCE(p_citation, '')), 300), '');
  v_url text := NULLIF(left(btrim(COALESCE(p_source_url, '')), 500), '');
  v_changed boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  IF NOT public.pw_can_edit() THEN RAISE EXCEPTION 'You do not have permission to edit labor rule settings' USING ERRCODE = '42501'; END IF;
  IF p_topic IS NULL OR p_topic NOT IN ('overtime', 'prevailing_wage') THEN RAISE EXCEPTION 'Unknown rule topic' USING ERRCODE = '22023'; END IF;
  IF p_jurisdiction IS NULL OR p_jurisdiction !~ '^[A-Z]{2,12}$' THEN RAISE EXCEPTION 'Invalid jurisdiction code' USING ERRCODE = '22023'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Invalid rule parameters' USING ERRCODE = '22023'; END IF;
  IF v_url IS NOT NULL AND v_url !~ '^https?://' THEN RAISE EXCEPTION 'Source link must start with http:// or https://' USING ERRCODE = '22023'; END IF;
  v_norm := public.labor_validate_params(p_topic, p_params);

  SELECT * INTO v_old FROM labor_rule_configs WHERE user_id = v_owner AND topic = p_topic FOR UPDATE;
  -- Changing the numbers or the jurisdiction invalidates any earlier review: it covered different values.
  v_changed := NOT FOUND OR v_old.jurisdiction <> p_jurisdiction OR v_old.params <> v_norm;

  INSERT INTO labor_rule_configs AS r (user_id, topic, jurisdiction, enabled, params, citation, source_url, updated_by, updated_at)
  VALUES (v_owner, p_topic, p_jurisdiction, p_enabled, v_norm, v_cit, v_url, auth.uid(), now())
  ON CONFLICT (user_id, topic) DO UPDATE
    SET jurisdiction = EXCLUDED.jurisdiction, enabled = EXCLUDED.enabled, params = EXCLUDED.params,
        citation = EXCLUDED.citation, source_url = EXCLUDED.source_url, updated_by = EXCLUDED.updated_by, updated_at = now(),
        counsel_status = CASE WHEN v_changed THEN 'needs_counsel' ELSE r.counsel_status END,
        counsel_reviewed_by = CASE WHEN v_changed THEN NULL ELSE r.counsel_reviewed_by END,
        counsel_reviewed_at = CASE WHEN v_changed THEN NULL ELSE r.counsel_reviewed_at END,
        counsel_note = CASE WHEN v_changed THEN NULL ELSE r.counsel_note END,
        verified_on = CASE WHEN v_changed THEN NULL ELSE r.verified_on END;

  INSERT INTO labor_audit_log (user_id, action, subject, old_data, new_data, actor)
  VALUES (v_owner, 'rule_saved', 'rule:' || p_topic,
          CASE WHEN v_old.topic IS NULL THEN NULL ELSE jsonb_build_object('jurisdiction', v_old.jurisdiction, 'enabled', v_old.enabled, 'params', v_old.params) END,
          jsonb_build_object('jurisdiction', p_jurisdiction, 'enabled', p_enabled, 'params', v_norm, 'review_reset', v_changed), auth.uid());
END;
$$;

-- Records what a PERSON did (counsel reviewed it / someone compared it with the source). Vireek verifies nothing itself.
CREATE OR REPLACE FUNCTION public.record_labor_rule_review(
  p_topic text, p_counsel_reviewer text DEFAULT NULL, p_verified_on date DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_who text := NULLIF(left(btrim(COALESCE(p_counsel_reviewer, '')), 160), '');
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  IF NOT public.pw_can_edit() THEN RAISE EXCEPTION 'You do not have permission to edit labor rule settings' USING ERRCODE = '42501'; END IF;
  IF p_topic IS NULL OR p_topic NOT IN ('overtime', 'prevailing_wage') THEN RAISE EXCEPTION 'Unknown rule topic' USING ERRCODE = '22023'; END IF;
  IF v_who IS NULL AND p_verified_on IS NULL THEN RAISE EXCEPTION 'Nothing to record' USING ERRCODE = '22023'; END IF;
  IF p_verified_on IS NOT NULL AND (p_verified_on > current_date OR p_verified_on < DATE '2000-01-01') THEN
    RAISE EXCEPTION 'Verification date is not valid' USING ERRCODE = '22023';
  END IF;

  UPDATE labor_rule_configs r
     SET counsel_status = CASE WHEN v_who IS NOT NULL THEN 'counsel_reviewed' ELSE r.counsel_status END,
         counsel_reviewed_by = CASE WHEN v_who IS NOT NULL THEN v_who ELSE r.counsel_reviewed_by END,
         counsel_reviewed_at = CASE WHEN v_who IS NOT NULL THEN now() ELSE r.counsel_reviewed_at END,
         counsel_note = CASE WHEN v_who IS NOT NULL THEN v_note ELSE r.counsel_note END,
         verified_on = COALESCE(p_verified_on, r.verified_on),
         updated_by = auth.uid(), updated_at = now()
   WHERE r.user_id = v_owner AND r.topic = p_topic;
  IF NOT FOUND THEN RAISE EXCEPTION 'Save the rule settings first' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO labor_audit_log (user_id, action, subject, new_data, actor)
  VALUES (v_owner, 'rule_review_recorded', 'rule:' || p_topic,
          jsonb_build_object('counsel_reviewer', v_who, 'verified_on', p_verified_on, 'note', v_note), auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.review_labor_signal(p_signal_key text, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_parts text[];
  v_anchor date;
  v_subject uuid;
  v_name text;
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501'; END IF;
  IF NOT public.pw_can_view() THEN RAISE EXCEPTION 'You do not have permission to review labor signals' USING ERRCODE = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('open', 'acknowledged', 'no_action_needed', 'sent_to_counsel') THEN
    RAISE EXCEPTION 'Unknown review status' USING ERRCODE = '22023';
  END IF;
  IF p_signal_key IS NULL OR p_signal_key !~ '^[a-z_]{3,40}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid signal' USING ERRCODE = '22023';
  END IF;
  v_parts := string_to_array(p_signal_key, ':');
  IF v_parts[1] NOT IN ('daily_hours_above_threshold', 'weekly_hours_above_threshold', 'payroll_overtime_below_clock', 'seventh_day_clocked',
                        'open_shift_long', 'classification_with_clock_use', 'pw_classification_missing', 'pw_pay_below_table') THEN
    RAISE EXCEPTION 'Invalid signal' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_anchor := v_parts[3]::date;
    v_subject := v_parts[2]::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid signal' USING ERRCODE = '22023';
  END;
  -- The subject must be an employee of THIS account: a key can never be used to touch another tenant.
  IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = v_subject AND e.user_id = v_owner) THEN
    RAISE EXCEPTION 'Signal not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_status = 'open' THEN
    DELETE FROM labor_signal_reviews r WHERE r.user_id = v_owner AND r.signal_key = p_signal_key;
  ELSE
    v_name := COALESCE(
      (SELECT NULLIF(btrim(tm.member_name), '') FROM team_members tm WHERE tm.user_id = auth.uid() LIMIT 1),
      (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()));
    INSERT INTO labor_signal_reviews AS r (user_id, signal_key, anchor_date, status, note, reviewed_by, reviewer_name, reviewed_at)
    VALUES (v_owner, p_signal_key, v_anchor, p_status, v_note, auth.uid(), v_name, now())
    ON CONFLICT (user_id, signal_key) DO UPDATE
      SET status = EXCLUDED.status, note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by,
          reviewer_name = EXCLUDED.reviewer_name, reviewed_at = now();
  END IF;

  INSERT INTO labor_audit_log (user_id, action, subject, new_data, actor)
  VALUES (v_owner, 'signal_reviewed', p_signal_key, jsonb_build_object('status', p_status, 'note', v_note), auth.uid());
END;
$$;

-- =============================================================
-- GRANTS — authenticated only
-- =============================================================

REVOKE ALL ON FUNCTION public.labor_signals_overview(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_worker_classification(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_labor_rule_config(text, text, boolean, jsonb, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_labor_rule_review(text, text, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_labor_signal(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.labor_signals_overview(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_worker_classification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_labor_rule_config(text, text, boolean, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_labor_rule_review(text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_labor_signal(text, text, text) TO authenticated;

COMMENT ON TABLE labor_rule_configs IS
  '[COUNSEL][VERIFY] Rule numbers used only to FLAG records for human review. Not legal advice; resets to needs_counsel whenever the numbers change.';
COMMENT ON TABLE labor_worker_classifications IS
  'What the business has recorded about a worker (exempt / contractor / hourly …). Vireek does not determine or verify classification.';
