/*
  # Prevailing-wage + overtime rules engine (commercial and government jobs)

  ## Why
  Government and commercial contracts (Davis-Bacon, state prevailing wage,
  service contracts, project labor agreements) require paying a classification
  wage table, handling fringe benefits, applying the right overtime rules and
  filing certified payroll. This migration adds the DATA layer: every rate and
  rule is a row that can be edited, nothing is hard-coded.

  ## LEGAL REVIEW REQUIRED
  This is a calculation aid, not legal advice. Wage tables and rule sets carry
  a legal_review_status. Certifying a payroll is blocked unless BOTH the wage
  table and the overtime rule set used are 'approved'. Any later change to a
  reviewed table/rule set automatically resets it to 'unreviewed'.

  ## What this adds
  1. pw_wage_determinations  - a wage table header (program, jurisdiction, dates).
  2. pw_wage_rates           - classification rates, effective-dated, base + fringe.
  3. pw_overtime_rule_sets   - daily/weekly/7th-day/weekend/holiday rules + fringe mode.
  4. pw_worker_profiles      - per employee: default classification, fringe plan, ID last-4.
  5. pw_job_assignments      - which wage table + rule set a job uses (+ contract info).
  6. pw_job_workers          - effective-dated classification of a worker on a job.
  7. pw_certified_reports    - weekly certified payroll, immutable snapshot once certified.
  8. pw_audit_log            - who changed which rate/rule, with old and new values.

  ## Security
  - Everything is scoped by get_account_owner_id(). Viewing needs can_view_billing;
    editing needs owner OR (can_view_billing AND can_edit_business_profile).
    Enforced in the database (RLS + RPCs), not just the UI.
  - Rule tables are edited directly (RLS-guarded). Reports are written ONLY by RPCs.
  - A wage table used by a certified payroll is locked (rates cannot change or
    be deleted; add a new effective-dated rate instead).
  - Only the last four digits of a worker ID are stored. Never store a full SSN.
*/

-- =============================================================
-- PERMISSION HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.pw_has_permission(p_flag text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.get_account_owner_id() = auth.uid()
    OR COALESCE((
      SELECT CASE
        WHEN (cr.permissions ->> p_flag) IS NOT NULL THEN (cr.permissions ->> p_flag) = 'true'
        ELSE (tm.permissions ->> p_flag) = 'true'
      END
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false);
$$;

CREATE OR REPLACE FUNCTION public.pw_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND public.pw_has_permission('can_view_billing');
$$;

CREATE OR REPLACE FUNCTION public.pw_can_edit()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      public.get_account_owner_id() = auth.uid()
      OR (public.pw_has_permission('can_view_billing') AND public.pw_has_permission('can_edit_business_profile'))
    );
$$;

REVOKE ALL ON FUNCTION public.pw_has_permission(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pw_can_view() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pw_can_edit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pw_has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pw_can_view() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pw_can_edit() TO authenticated;

-- =============================================================
-- WAGE DETERMINATIONS (wage table header)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_wage_determinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  program text NOT NULL DEFAULT 'davis_bacon'
    CHECK (program IN ('davis_bacon', 'service_contract_act', 'state_prevailing', 'municipal', 'project_labor_agreement', 'custom')),
  determination_number text CHECK (determination_number IS NULL OR char_length(determination_number) <= 80),
  revision text CHECK (revision IS NULL OR char_length(revision) <= 80),
  country text NOT NULL DEFAULT 'US' CHECK (char_length(country) BETWEEN 2 AND 3),
  state text CHECK (state IS NULL OR char_length(state) BETWEEN 2 AND 3),
  county text CHECK (county IS NULL OR char_length(county) <= 120),
  locality text CHECK (locality IS NULL OR char_length(locality) <= 120),
  construction_type text NOT NULL DEFAULT 'building'
    CHECK (construction_type IN ('building', 'heavy', 'highway', 'residential', 'service', 'other')),
  effective_from date NOT NULL,
  effective_to date,
  source_url text CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  source_notes text CHECK (source_notes IS NULL OR char_length(source_notes) <= 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  legal_review_status text NOT NULL DEFAULT 'unreviewed' CHECK (legal_review_status IN ('unreviewed', 'in_review', 'approved')),
  legal_reviewed_by text CHECK (legal_reviewed_by IS NULL OR char_length(legal_reviewed_by) <= 160),
  legal_reviewed_at timestamptz,
  locked_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pw_wd_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT pw_wd_review_chk CHECK (
    legal_review_status <> 'approved'
    OR (legal_reviewed_by IS NOT NULL AND btrim(legal_reviewed_by) <> '' AND legal_reviewed_at IS NOT NULL)
  ),
  CONSTRAINT pw_wd_id_user_uq UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pw_wd_user ON pw_wage_determinations(user_id, status);

-- =============================================================
-- WAGE RATES (classification x effective date)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_wage_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  determination_id uuid NOT NULL,
  classification text NOT NULL CHECK (char_length(btrim(classification)) BETWEEN 1 AND 200),
  trade_code text CHECK (trade_code IS NULL OR char_length(trade_code) <= 40),
  effective_from date NOT NULL,
  effective_to date,
  base_rate_cents integer NOT NULL CHECK (base_rate_cents BETWEEN 0 AND 100000),
  fringe_cents integer NOT NULL DEFAULT 0 CHECK (fringe_cents BETWEEN 0 AND 100000),
  is_apprentice boolean NOT NULL DEFAULT false,
  ot_multiplier_override numeric(4,2) CHECK (ot_multiplier_override IS NULL OR (ot_multiplier_override >= 1 AND ot_multiplier_override <= 5)),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pw_rates_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT pw_rates_det_fk FOREIGN KEY (determination_id, user_id)
    REFERENCES pw_wage_determinations(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pw_rates_class_date
  ON pw_wage_rates(determination_id, lower(btrim(classification)), effective_from);
CREATE INDEX IF NOT EXISTS idx_pw_rates_det ON pw_wage_rates(determination_id);

-- =============================================================
-- OVERTIME RULE SETS
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_overtime_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  workweek_start_dow smallint NOT NULL DEFAULT 0 CHECK (workweek_start_dow BETWEEN 0 AND 6),
  daily_ot_after numeric(5,2) CHECK (daily_ot_after IS NULL OR (daily_ot_after > 0 AND daily_ot_after <= 24)),
  daily_dt_after numeric(5,2) CHECK (daily_dt_after IS NULL OR (daily_dt_after > 0 AND daily_dt_after <= 24)),
  weekly_ot_after numeric(5,2) NOT NULL DEFAULT 40 CHECK (weekly_ot_after > 0 AND weekly_ot_after <= 168),
  seventh_day_rule text NOT NULL DEFAULT 'none' CHECK (seventh_day_rule IN ('none', 'ot_first_dt_after')),
  seventh_day_ot_hours numeric(4,2) NOT NULL DEFAULT 8 CHECK (seventh_day_ot_hours > 0 AND seventh_day_ot_hours <= 24),
  ot_multiplier numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 1 AND ot_multiplier <= 5),
  dt_multiplier numeric(4,2) NOT NULL DEFAULT 2.0 CHECK (dt_multiplier >= 1 AND dt_multiplier <= 5),
  saturday_multiplier numeric(4,2) CHECK (saturday_multiplier IS NULL OR (saturday_multiplier >= 1 AND saturday_multiplier <= 5)),
  sunday_multiplier numeric(4,2) CHECK (sunday_multiplier IS NULL OR (sunday_multiplier >= 1 AND sunday_multiplier <= 5)),
  holiday_multiplier numeric(4,2) CHECK (holiday_multiplier IS NULL OR (holiday_multiplier >= 1 AND holiday_multiplier <= 5)),
  holidays date[] NOT NULL DEFAULT '{}',
  fringe_overtime_mode text NOT NULL DEFAULT 'straight' CHECK (fringe_overtime_mode IN ('straight', 'multiplied')),
  active boolean NOT NULL DEFAULT true,
  legal_review_status text NOT NULL DEFAULT 'unreviewed' CHECK (legal_review_status IN ('unreviewed', 'in_review', 'approved')),
  legal_reviewed_by text CHECK (legal_reviewed_by IS NULL OR char_length(legal_reviewed_by) <= 160),
  legal_reviewed_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pw_rs_dt_chk CHECK (daily_dt_after IS NULL OR daily_ot_after IS NULL OR daily_dt_after > daily_ot_after),
  CONSTRAINT pw_rs_mult_chk CHECK (dt_multiplier >= ot_multiplier),
  CONSTRAINT pw_rs_review_chk CHECK (
    legal_review_status <> 'approved'
    OR (legal_reviewed_by IS NOT NULL AND btrim(legal_reviewed_by) <> '' AND legal_reviewed_at IS NOT NULL)
  ),
  CONSTRAINT pw_rs_id_user_uq UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pw_rs_user ON pw_overtime_rule_sets(user_id, active);

-- =============================================================
-- WORKER PROFILES (prevailing-wage attributes of an employee)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_worker_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  default_classification text CHECK (default_classification IS NULL OR char_length(default_classification) <= 200),
  worker_id_last4 text CHECK (worker_id_last4 IS NULL OR worker_id_last4 ~ '^[0-9]{4}$'),
  address text CHECK (address IS NULL OR char_length(address) <= 300),
  fringe_plan_cents_per_hour integer NOT NULL DEFAULT 0 CHECK (fringe_plan_cents_per_hour BETWEEN 0 AND 100000),
  fringe_plan_description text CHECK (fringe_plan_description IS NULL OR char_length(fringe_plan_description) <= 300),
  apprentice_registration text CHECK (apprentice_registration IS NULL OR char_length(apprentice_registration) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pw_worker_employee UNIQUE (employee_id)
);

CREATE INDEX IF NOT EXISTS idx_pw_worker_user ON pw_worker_profiles(user_id);

-- =============================================================
-- JOB ASSIGNMENTS (which wage table + rule set a job uses)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  determination_id uuid NOT NULL,
  rule_set_id uuid NOT NULL,
  project_name text CHECK (project_name IS NULL OR char_length(project_name) <= 200),
  contract_number text CHECK (contract_number IS NULL OR char_length(contract_number) <= 120),
  awarding_agency text CHECK (awarding_agency IS NULL OR char_length(awarding_agency) <= 200),
  prime_contractor text CHECK (prime_contractor IS NULL OR char_length(prime_contractor) <= 200),
  project_location text CHECK (project_location IS NULL OR char_length(project_location) <= 300),
  contractor_name text CHECK (contractor_name IS NULL OR char_length(contractor_name) <= 200),
  contractor_address text CHECK (contractor_address IS NULL OR char_length(contractor_address) <= 300),
  is_certified_payroll boolean NOT NULL DEFAULT true,
  rate_lock_date date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pw_assignment_job UNIQUE (job_id),
  CONSTRAINT pw_assign_det_fk FOREIGN KEY (determination_id, user_id)
    REFERENCES pw_wage_determinations(id, user_id),
  CONSTRAINT pw_assign_rs_fk FOREIGN KEY (rule_set_id, user_id)
    REFERENCES pw_overtime_rule_sets(id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pw_assign_user ON pw_job_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_pw_assign_det ON pw_job_assignments(determination_id);
CREATE INDEX IF NOT EXISTS idx_pw_assign_rs ON pw_job_assignments(rule_set_id);

-- =============================================================
-- JOB WORKERS (classification of a worker on a job, effective-dated)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_job_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (char_length(btrim(classification)) BETWEEN 1 AND 200),
  effective_from date NOT NULL DEFAULT DATE '2000-01-01',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pw_job_worker UNIQUE (job_id, employee_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pw_job_workers_job ON pw_job_workers(job_id);
CREATE INDEX IF NOT EXISTS idx_pw_job_workers_user ON pw_job_workers(user_id);

-- =============================================================
-- CERTIFIED PAYROLL REPORTS (written only through RPCs)
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_certified_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  determination_id uuid NOT NULL,
  rule_set_id uuid NOT NULL,
  payroll_number integer NOT NULL CHECK (payroll_number > 0),
  week_ending date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'certified', 'void')),
  is_final boolean NOT NULL DEFAULT false,
  no_work boolean NOT NULL DEFAULT false,
  total_hours numeric(10,2) NOT NULL DEFAULT 0,
  total_gross_cents bigint NOT NULL DEFAULT 0,
  total_fringe_plan_cents bigint NOT NULL DEFAULT 0,
  worker_count integer NOT NULL DEFAULT 0,
  engine_version text,
  snapshot jsonb NOT NULL,
  certified_by_name text CHECK (certified_by_name IS NULL OR char_length(certified_by_name) <= 160),
  certified_by_title text CHECK (certified_by_title IS NULL OR char_length(certified_by_title) <= 160),
  certified_at timestamptz,
  certified_by uuid,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pw_report_number UNIQUE (job_id, payroll_number),
  CONSTRAINT pw_report_cert_chk CHECK (status <> 'certified' OR (certified_by_name IS NOT NULL AND certified_at IS NOT NULL)),
  CONSTRAINT pw_report_void_chk CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL)),
  CONSTRAINT pw_report_det_fk FOREIGN KEY (determination_id, user_id)
    REFERENCES pw_wage_determinations(id, user_id),
  CONSTRAINT pw_report_rs_fk FOREIGN KEY (rule_set_id, user_id)
    REFERENCES pw_overtime_rule_sets(id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pw_report_job_week_live
  ON pw_certified_reports(job_id, week_ending) WHERE status IN ('draft', 'certified');
CREATE INDEX IF NOT EXISTS idx_pw_reports_user ON pw_certified_reports(user_id, week_ending DESC);
CREATE INDEX IF NOT EXISTS idx_pw_reports_det ON pw_certified_reports(determination_id);
CREATE INDEX IF NOT EXISTS idx_pw_reports_rs ON pw_certified_reports(rule_set_id);

-- =============================================================
-- AUDIT LOG
-- =============================================================
CREATE TABLE IF NOT EXISTS pw_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pw_audit_user_time ON pw_audit_log(user_id, created_at DESC);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
ALTER TABLE pw_wage_determinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_wage_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_overtime_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_worker_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_job_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_job_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_certified_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE pw_audit_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pw_wage_determinations', 'pw_wage_rates', 'pw_overtime_rule_sets',
    'pw_worker_profiles', 'pw_job_assignments', 'pw_job_workers'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS pw_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS pw_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS pw_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS pw_delete ON public.%I', t);
    EXECUTE format('CREATE POLICY pw_select ON public.%I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.pw_can_view())', t);
    EXECUTE format('CREATE POLICY pw_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.pw_can_edit())', t);
    EXECUTE format('CREATE POLICY pw_update ON public.%I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id() AND public.pw_can_edit()) WITH CHECK (user_id = public.get_account_owner_id() AND public.pw_can_edit())', t);
    EXECUTE format('CREATE POLICY pw_delete ON public.%I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id() AND public.pw_can_edit())', t);
  END LOOP;
END $$;

-- Reports and the audit log are read-only for clients (writes go through RPCs / triggers).
DROP POLICY IF EXISTS pw_select ON pw_certified_reports;
CREATE POLICY pw_select ON pw_certified_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

DROP POLICY IF EXISTS pw_select ON pw_audit_log;
CREATE POLICY pw_select ON pw_audit_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pw_can_view());

-- =============================================================
-- TRIGGER FUNCTIONS
-- =============================================================

-- Verify job / employee references belong to the same account.
CREATE OR REPLACE FUNCTION public.pw_check_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb := to_jsonb(NEW);
  v_job uuid := NULLIF(v ->> 'job_id', '')::uuid;
  v_emp uuid := NULLIF(v ->> 'employee_id', '')::uuid;
BEGIN
  IF v_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = v_job AND j.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Job does not belong to this account' USING ERRCODE = '42501';
  END IF;
  IF v_emp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = v_emp AND e.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Employee does not belong to this account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Stamp who created / last changed a row.
CREATE OR REPLACE FUNCTION public.pw_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  END IF;
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

-- Wage table guard: locking, review reset, delete protection.
CREATE OR REPLACE FUNCTION public.pw_determination_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_skip text[] := ARRAY['legal_review_status', 'legal_reviewed_by', 'legal_reviewed_at', 'updated_at', 'updated_by', 'locked_at', 'status', 'source_notes'];
  v_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'This wage table was used in a certified payroll and cannot be deleted. Archive it instead.' USING ERRCODE = '23001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.legal_review_status := 'unreviewed';
    NEW.legal_reviewed_by := NULL;
    NEW.legal_reviewed_at := NULL;
    NEW.locked_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.locked_at IS DISTINCT FROM OLD.locked_at AND COALESCE(current_setting('pw.internal', true), '') <> '1' THEN
    NEW.locked_at := OLD.locked_at;
  END IF;

  v_changed := (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip);

  IF OLD.locked_at IS NOT NULL AND v_changed THEN
    RAISE EXCEPTION 'This wage table is locked by a certified payroll. Add a new effective-dated rate or create a new wage table instead.' USING ERRCODE = '23001';
  END IF;

  IF v_changed AND NEW.legal_review_status = OLD.legal_review_status AND OLD.legal_review_status <> 'unreviewed' THEN
    NEW.legal_review_status := 'unreviewed';
    NEW.legal_reviewed_by := NULL;
    NEW.legal_reviewed_at := NULL;
  END IF;

  IF NEW.legal_review_status = 'approved' AND NEW.legal_reviewed_at IS NULL THEN
    NEW.legal_reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Rate guard: locked tables are immutable; any rate change resets the review.
CREATE OR REPLACE FUNCTION public.pw_rate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_det uuid;
  v_locked timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_det := NEW.determination_id;
  ELSE
    v_det := OLD.determination_id;
  END IF;
  SELECT locked_at INTO v_locked FROM pw_wage_determinations WHERE id = v_det;
  IF TG_OP IN ('UPDATE', 'DELETE') AND v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'This wage table is locked by a certified payroll. Add a new effective-dated rate instead of changing or deleting one.' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.pw_rate_review_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_det uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_det := OLD.determination_id;
  ELSE
    v_det := NEW.determination_id;
  END IF;
  UPDATE pw_wage_determinations
     SET legal_review_status = 'unreviewed', legal_reviewed_by = NULL, legal_reviewed_at = NULL
   WHERE id = v_det AND legal_review_status <> 'unreviewed';
  RETURN NULL;
END;
$$;

-- Rule set guard: any substantive change resets the legal review.
CREATE OR REPLACE FUNCTION public.pw_ruleset_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_skip text[] := ARRAY['legal_review_status', 'legal_reviewed_by', 'legal_reviewed_at', 'updated_at', 'updated_by', 'active', 'description'];
  v_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.legal_review_status := 'unreviewed';
    NEW.legal_reviewed_by := NULL;
    NEW.legal_reviewed_at := NULL;
    RETURN NEW;
  END IF;

  v_changed := (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip);
  IF v_changed AND NEW.legal_review_status = OLD.legal_review_status AND OLD.legal_review_status <> 'unreviewed' THEN
    NEW.legal_review_status := 'unreviewed';
    NEW.legal_reviewed_by := NULL;
    NEW.legal_reviewed_at := NULL;
  END IF;
  IF NEW.legal_review_status = 'approved' AND NEW.legal_reviewed_at IS NULL THEN
    NEW.legal_reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Job assignment guard: wage table / rule set cannot change once a payroll is certified.
CREATE OR REPLACE FUNCTION public.pw_assignment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pw_certified_reports r WHERE r.job_id = OLD.job_id AND r.status = 'certified') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'This job has a certified payroll; its prevailing-wage setup cannot be removed.' USING ERRCODE = '23001';
    END IF;
    IF NEW.determination_id IS DISTINCT FROM OLD.determination_id OR NEW.rule_set_id IS DISTINCT FROM OLD.rule_set_id THEN
      RAISE EXCEPTION 'This job has a certified payroll; its wage table and overtime rule set cannot be changed.' USING ERRCODE = '23001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Reports: certified snapshots are immutable, void is terminal.
CREATE OR REPLACE FUNCTION public.pw_report_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'Voided payrolls are read-only' USING ERRCODE = '23001';
  END IF;
  IF OLD.status = 'certified' AND (
       NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.week_ending IS DISTINCT FROM OLD.week_ending
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.determination_id IS DISTINCT FROM OLD.determination_id
    OR NEW.rule_set_id IS DISTINCT FROM OLD.rule_set_id
    OR NEW.payroll_number IS DISTINCT FROM OLD.payroll_number
    OR NEW.total_gross_cents IS DISTINCT FROM OLD.total_gross_cents
  ) THEN
    RAISE EXCEPTION 'A certified payroll cannot be edited. Void it and issue a corrected one.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$;

-- Audit trail for rates, rules and setup.
CREATE OR REPLACE FUNCTION public.pw_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new jsonb;
  v_old jsonb;
  v_user uuid;
  v_row uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_old := NULL;
  ELSIF TG_OP = 'DELETE' THEN
    v_new := NULL;
    v_old := to_jsonb(OLD);
  ELSE
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    IF (v_new - 'updated_at') = (v_old - 'updated_at') THEN
      RETURN NULL;
    END IF;
  END IF;
  v_user := COALESCE((v_new ->> 'user_id')::uuid, (v_old ->> 'user_id')::uuid);
  v_row := COALESCE((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid);
  INSERT INTO pw_audit_log (user_id, table_name, row_id, action, actor, old_data, new_data)
  VALUES (v_user, TG_TABLE_NAME, v_row, TG_OP, auth.uid(), v_old, v_new);
  RETURN NULL;
END;
$$;

-- =============================================================
-- TRIGGERS
-- =============================================================
DROP TRIGGER IF EXISTS trg_pw_wd_guard ON pw_wage_determinations;
CREATE TRIGGER trg_pw_wd_guard BEFORE INSERT OR UPDATE OR DELETE ON pw_wage_determinations
  FOR EACH ROW EXECUTE FUNCTION public.pw_determination_guard();
DROP TRIGGER IF EXISTS trg_pw_wd_stamp ON pw_wage_determinations;
CREATE TRIGGER trg_pw_wd_stamp BEFORE INSERT OR UPDATE ON pw_wage_determinations
  FOR EACH ROW EXECUTE FUNCTION public.pw_stamp();
DROP TRIGGER IF EXISTS trg_pw_wd_updated ON pw_wage_determinations;
CREATE TRIGGER trg_pw_wd_updated BEFORE UPDATE ON pw_wage_determinations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_rates_guard ON pw_wage_rates;
CREATE TRIGGER trg_pw_rates_guard BEFORE INSERT OR UPDATE OR DELETE ON pw_wage_rates
  FOR EACH ROW EXECUTE FUNCTION public.pw_rate_guard();
DROP TRIGGER IF EXISTS trg_pw_rates_updated ON pw_wage_rates;
CREATE TRIGGER trg_pw_rates_updated BEFORE UPDATE ON pw_wage_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_pw_rates_reset ON pw_wage_rates;
CREATE TRIGGER trg_pw_rates_reset AFTER INSERT OR UPDATE OR DELETE ON pw_wage_rates
  FOR EACH ROW EXECUTE FUNCTION public.pw_rate_review_reset();

DROP TRIGGER IF EXISTS trg_pw_rs_guard ON pw_overtime_rule_sets;
CREATE TRIGGER trg_pw_rs_guard BEFORE INSERT OR UPDATE ON pw_overtime_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.pw_ruleset_guard();
DROP TRIGGER IF EXISTS trg_pw_rs_stamp ON pw_overtime_rule_sets;
CREATE TRIGGER trg_pw_rs_stamp BEFORE INSERT OR UPDATE ON pw_overtime_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.pw_stamp();
DROP TRIGGER IF EXISTS trg_pw_rs_updated ON pw_overtime_rule_sets;
CREATE TRIGGER trg_pw_rs_updated BEFORE UPDATE ON pw_overtime_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_worker_refs ON pw_worker_profiles;
CREATE TRIGGER trg_pw_worker_refs BEFORE INSERT OR UPDATE ON pw_worker_profiles
  FOR EACH ROW EXECUTE FUNCTION public.pw_check_refs();
DROP TRIGGER IF EXISTS trg_pw_worker_updated ON pw_worker_profiles;
CREATE TRIGGER trg_pw_worker_updated BEFORE UPDATE ON pw_worker_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_assign_refs ON pw_job_assignments;
CREATE TRIGGER trg_pw_assign_refs BEFORE INSERT OR UPDATE ON pw_job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.pw_check_refs();
DROP TRIGGER IF EXISTS trg_pw_assign_guard ON pw_job_assignments;
CREATE TRIGGER trg_pw_assign_guard BEFORE UPDATE OR DELETE ON pw_job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.pw_assignment_guard();
DROP TRIGGER IF EXISTS trg_pw_assign_stamp ON pw_job_assignments;
CREATE TRIGGER trg_pw_assign_stamp BEFORE INSERT OR UPDATE ON pw_job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.pw_stamp();
DROP TRIGGER IF EXISTS trg_pw_assign_updated ON pw_job_assignments;
CREATE TRIGGER trg_pw_assign_updated BEFORE UPDATE ON pw_job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_jw_refs ON pw_job_workers;
CREATE TRIGGER trg_pw_jw_refs BEFORE INSERT OR UPDATE ON pw_job_workers
  FOR EACH ROW EXECUTE FUNCTION public.pw_check_refs();
DROP TRIGGER IF EXISTS trg_pw_jw_updated ON pw_job_workers;
CREATE TRIGGER trg_pw_jw_updated BEFORE UPDATE ON pw_job_workers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_report_refs ON pw_certified_reports;
CREATE TRIGGER trg_pw_report_refs BEFORE INSERT ON pw_certified_reports
  FOR EACH ROW EXECUTE FUNCTION public.pw_check_refs();
DROP TRIGGER IF EXISTS trg_pw_report_immutable ON pw_certified_reports;
CREATE TRIGGER trg_pw_report_immutable BEFORE UPDATE ON pw_certified_reports
  FOR EACH ROW EXECUTE FUNCTION public.pw_report_immutable();
DROP TRIGGER IF EXISTS trg_pw_report_updated ON pw_certified_reports;
CREATE TRIGGER trg_pw_report_updated BEFORE UPDATE ON pw_certified_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pw_wd_audit ON pw_wage_determinations;
CREATE TRIGGER trg_pw_wd_audit AFTER INSERT OR UPDATE OR DELETE ON pw_wage_determinations
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();
DROP TRIGGER IF EXISTS trg_pw_rates_audit ON pw_wage_rates;
CREATE TRIGGER trg_pw_rates_audit AFTER INSERT OR UPDATE OR DELETE ON pw_wage_rates
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();
DROP TRIGGER IF EXISTS trg_pw_rs_audit ON pw_overtime_rule_sets;
CREATE TRIGGER trg_pw_rs_audit AFTER INSERT OR UPDATE OR DELETE ON pw_overtime_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();
DROP TRIGGER IF EXISTS trg_pw_worker_audit ON pw_worker_profiles;
CREATE TRIGGER trg_pw_worker_audit AFTER INSERT OR UPDATE OR DELETE ON pw_worker_profiles
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();
DROP TRIGGER IF EXISTS trg_pw_assign_audit ON pw_job_assignments;
CREATE TRIGGER trg_pw_assign_audit AFTER INSERT OR UPDATE OR DELETE ON pw_job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();
DROP TRIGGER IF EXISTS trg_pw_jw_audit ON pw_job_workers;
CREATE TRIGGER trg_pw_jw_audit AFTER INSERT OR UPDATE OR DELETE ON pw_job_workers
  FOR EACH ROW EXECUTE FUNCTION public.pw_audit_trigger();

-- =============================================================
-- RPC HELPERS (internal)
-- =============================================================
CREATE OR REPLACE FUNCTION public._pw_owner(p_edit boolean DEFAULT false)
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
  IF NOT public.pw_can_view() THEN
    RAISE EXCEPTION 'You do not have permission to view prevailing wage data' USING ERRCODE = '42501';
  END IF;
  IF p_edit AND NOT public.pw_can_edit() THEN
    RAISE EXCEPTION 'You do not have permission to edit prevailing wage data' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public._pw_owner(boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPC: pw_save_report  (create or replace the DRAFT for a job + week)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pw_save_report(
  p_job_id uuid,
  p_week_ending date,
  p_snapshot jsonb,
  p_is_final boolean DEFAULT false,
  p_no_work boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pw_owner(true);
  v_assign pw_job_assignments%ROWTYPE;
  v_lines jsonb;
  v_id uuid;
  v_num integer;
  v_hours numeric;
  v_gross bigint;
  v_plan bigint;
  v_workers integer;
BEGIN
  SELECT * INTO v_assign FROM pw_job_assignments WHERE job_id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Set up prevailing wage for this job first' USING ERRCODE = 'P0002';
  END IF;
  IF p_week_ending IS NULL THEN
    RAISE EXCEPTION 'Week ending date is required' USING ERRCODE = '22023';
  END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' OR jsonb_typeof(p_snapshot -> 'lines') <> 'array' THEN
    RAISE EXCEPTION 'Report snapshot is malformed' USING ERRCODE = '22023';
  END IF;
  v_lines := p_snapshot -> 'lines';
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_lines) l
    WHERE jsonb_typeof(l) <> 'object'
       OR COALESCE(l ->> 'grossCashCents', '') !~ '^[0-9]{1,12}$'
       OR COALESCE(l ->> 'fringePlanCents', '') !~ '^[0-9]{1,12}$'
       OR COALESCE(l ->> 'hours', '') !~ '^[0-9]{1,5}(\.[0-9]+)?$'
       OR COALESCE(l ->> 'employeeId', '') = ''
  ) THEN
    RAISE EXCEPTION 'Report lines are malformed' USING ERRCODE = '22023';
  END IF;
  IF p_no_work AND jsonb_array_length(v_lines) > 0 THEN
    RAISE EXCEPTION 'A no-work payroll cannot contain pay lines' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pw_report:' || p_job_id::text));

  IF EXISTS (SELECT 1 FROM pw_certified_reports WHERE job_id = p_job_id AND week_ending = p_week_ending AND status = 'certified') THEN
    RAISE EXCEPTION 'A certified payroll already exists for this week. Void it first to issue a corrected one.' USING ERRCODE = '23505';
  END IF;

  SELECT COALESCE(SUM((l ->> 'hours')::numeric), 0),
         COALESCE(SUM((l ->> 'grossCashCents')::bigint), 0),
         COALESCE(SUM((l ->> 'fringePlanCents')::bigint), 0),
         COUNT(DISTINCT l ->> 'employeeId')
    INTO v_hours, v_gross, v_plan, v_workers
    FROM jsonb_array_elements(v_lines) l;

  SELECT id, payroll_number INTO v_id, v_num
    FROM pw_certified_reports
   WHERE job_id = p_job_id AND week_ending = p_week_ending AND status = 'draft';

  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(payroll_number), 0) + 1 INTO v_num FROM pw_certified_reports WHERE job_id = p_job_id;
    INSERT INTO pw_certified_reports (
      user_id, job_id, determination_id, rule_set_id, payroll_number, week_ending, status,
      is_final, no_work, total_hours, total_gross_cents, total_fringe_plan_cents, worker_count,
      engine_version, snapshot, created_by
    ) VALUES (
      v_owner, p_job_id, v_assign.determination_id, v_assign.rule_set_id, v_num, p_week_ending, 'draft',
      COALESCE(p_is_final, false), COALESCE(p_no_work, false), v_hours, v_gross, v_plan, v_workers,
      p_snapshot ->> 'engineVersion', p_snapshot, auth.uid()
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE pw_certified_reports
       SET determination_id = v_assign.determination_id,
           rule_set_id = v_assign.rule_set_id,
           is_final = COALESCE(p_is_final, false),
           no_work = COALESCE(p_no_work, false),
           total_hours = v_hours,
           total_gross_cents = v_gross,
           total_fringe_plan_cents = v_plan,
           worker_count = v_workers,
           engine_version = p_snapshot ->> 'engineVersion',
           snapshot = p_snapshot
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- =============================================================
-- RPC: pw_certify_report
-- =============================================================
CREATE OR REPLACE FUNCTION public.pw_certify_report(
  p_report_id uuid,
  p_name text,
  p_title text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pw_owner(true);
  v_rep pw_certified_reports%ROWTYPE;
  v_wd text;
  v_rs text;
BEGIN
  SELECT * INTO v_rep FROM pw_certified_reports WHERE id = p_report_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rep.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft payroll can be certified' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) < 2 OR char_length(p_name) > 160 THEN
    RAISE EXCEPTION 'Enter the full name of the person certifying this payroll' USING ERRCODE = '22023';
  END IF;
  IF p_title IS NOT NULL AND char_length(p_title) > 160 THEN
    RAISE EXCEPTION 'Title is too long' USING ERRCODE = '22023';
  END IF;

  SELECT legal_review_status INTO v_wd FROM pw_wage_determinations WHERE id = v_rep.determination_id AND user_id = v_owner;
  SELECT legal_review_status INTO v_rs FROM pw_overtime_rule_sets WHERE id = v_rep.rule_set_id AND user_id = v_owner;
  IF COALESCE(v_wd, '') <> 'approved' OR COALESCE(v_rs, '') <> 'approved' THEN
    RAISE EXCEPTION 'Both the wage table and the overtime rule set must be marked legally reviewed before certifying' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_rep.snapshot -> 'warnings', '[]'::jsonb)) w
    WHERE w ->> 'severity' = 'error'
  ) THEN
    RAISE EXCEPTION 'Resolve all errors on this payroll before certifying' USING ERRCODE = '22023';
  END IF;
  IF NOT v_rep.no_work AND jsonb_array_length(COALESCE(v_rep.snapshot -> 'lines', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'There is nothing to certify. Mark the week as no work performed instead.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('pw.internal', '1', true);
  UPDATE pw_wage_determinations SET locked_at = COALESCE(locked_at, now()) WHERE id = v_rep.determination_id AND user_id = v_owner;
  PERFORM set_config('pw.internal', '', true);

  UPDATE pw_certified_reports
     SET status = 'certified',
         certified_by_name = btrim(p_name),
         certified_by_title = NULLIF(btrim(COALESCE(p_title, '')), ''),
         certified_at = now(),
         certified_by = auth.uid()
   WHERE id = p_report_id;
END;
$$;

-- =============================================================
-- RPC: pw_void_report
-- =============================================================
CREATE OR REPLACE FUNCTION public.pw_void_report(p_report_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pw_owner(true);
  v_status text;
BEGIN
  SELECT status INTO v_status FROM pw_certified_reports WHERE id = p_report_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'certified' THEN
    RAISE EXCEPTION 'Only a certified payroll can be voided. Discard drafts instead.' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Enter a reason (5 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  UPDATE pw_certified_reports
     SET status = 'void', voided_at = now(), void_reason = btrim(p_reason)
   WHERE id = p_report_id;
END;
$$;

-- =============================================================
-- RPC: pw_discard_draft
-- =============================================================
CREATE OR REPLACE FUNCTION public.pw_discard_draft(p_report_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pw_owner(true);
BEGIN
  DELETE FROM pw_certified_reports WHERE id = p_report_id AND user_id = v_owner AND status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found (only drafts can be discarded)' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pw_save_report(uuid, date, jsonb, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pw_certify_report(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pw_void_report(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pw_discard_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pw_save_report(uuid, date, jsonb, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pw_certify_report(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pw_void_report(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pw_discard_draft(uuid) TO authenticated;

COMMENT ON TABLE pw_wage_determinations IS 'Prevailing-wage table header. Legal review required before certified payroll.';
COMMENT ON TABLE pw_certified_reports IS 'Weekly certified payroll. Certified rows are immutable; void and reissue to correct.';
