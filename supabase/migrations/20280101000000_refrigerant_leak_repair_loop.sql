/*
  # Refrigerant Leak-Repair Loop

  ## Goal
  No regulated appliance (>= 15 lb of a refrigerant with GWP > 53) ever has an
  open leak case without a dated next action. Every case moves through a fixed
  lifecycle and every step has a due date:

    open -> initial_verified -> verified -> followup_scheduled -> closed
       \________________\______________\___________\--> failed -> (retrofit/retire plan) -> closed
    any non-terminal state -> voided (owner only, reason required)

  ## Regulatory basis (NOT LEGAL ADVICE — confirm against the current CFR text)
  EPA 40 CFR Part 84 Subpart C (AIM Act HFC management) and, for ozone-depleting
  refrigerants, 40 CFR 82.157, as commonly summarised. Every figure lives in
  `leak_rules()` / `leak_threshold_pct()` below and in the matching constants
  in src/lib/refrigerantCompliance.ts, so a rule change is a one-place edit.
    1. Leak rate over the category threshold (10% comfort, 20% commercial
       refrigeration, 30% industrial process) -> a leak case opens with a
       30-day repair deadline (counted from the addition that exceeded it).
    2. Two verification tests, each signed by a technician whose EPA 608
       certification is valid on the test date: an initial test inside the
       repair window, and a follow-up test within 10 days of the initial test
       (or of return to normal operation after a shutdown, whichever is later).
    3. Follow-up inspections: quarterly (4 inspections) for >= 500 lb, annual
       (1 inspection) for 15-499 lb — waived only when the unit's calibrated
       ALD flag is set (flag only; ALD hardware is out of scope).
    4. Failed repair -> retrofit/retire plan draft due in 30 days; the retrofit
       or retirement must complete within 1 year.
    5. Leak > 125% of full charge in a calendar year -> chronic-leak export
       prepared for EPA's HAWK system. PREPARE ONLY: Vireek never files.
    6. Records are retained 3 years (no delete path before `retain_until`).
  Out of scope: ALD hardware, state regimes (NY/WA/NJ/CA), filing with EPA.

  ## Design (extends, never duplicates)
  - Leak-rate maths is `computeLeakRate` (TS) mirrored 1:1 by
    `leak_evaluate_equipment()` (SQL); shared test vectors guard against drift.
  - Certification check is ONE SQL helper `find_valid_epa608_credential()`; the
    existing refrigerant_log guard is re-pointed at it (behaviour unchanged).
  - Audit: every state change calls the existing `log_audit_event()` AND writes
    an append-only row to `leak_case_events` (the case timeline / PDF source).
  - Follow-up inspections become real `jobs` (idempotent, double-booking aware,
    same approach as `generate_recurring_jobs`), created by `leak_loop_tick()`
    which the existing `recurring-jobs-cron` edge function calls hourly.
  - Tables are append-only / RPC-only: clients can SELECT within their account
    (RLS: user_id = get_account_owner_id()); every write goes through a
    SECURITY DEFINER RPC that re-checks tenant, role and certification.
  - The case-opening trigger can never block the compliance ledger: a failure
    there only raises a WARNING, and `leak_loop_tick()` self-heals by
    re-evaluating recently logged additions.

  ## Rollback
  Additive only (new tables/functions/columns). To roll back: drop the
  trg_refrigerant_log_leak trigger, then the new tables/functions; the old
  guard body is the one in 20271011000000_refrigerant_compliance.sql.
*/

-- =============================================================
-- 1. EQUIPMENT: calibrated-ALD flag (flag only; RPC-only writes)
-- =============================================================

ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS ald_calibrated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ald_calibrated_on date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_ald_has_date') THEN
    ALTER TABLE equipment
      ADD CONSTRAINT equipment_ald_has_date
      CHECK (NOT ald_calibrated OR ald_calibrated_on IS NOT NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.equipment_ald_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- The ALD flag waives follow-up inspections, so it must be set through the
  -- audited RPC set_equipment_ald_flag(), never by a plain UPDATE.
  IF coalesce(current_setting('vireek.ald_rpc', true), '') <> 'on' THEN
    IF TG_OP = 'INSERT' AND (NEW.ald_calibrated OR NEW.ald_calibrated_on IS NOT NULL) THEN
      RAISE EXCEPTION 'ald_flag_rpc_only: use set_equipment_ald_flag()' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.ald_calibrated, NEW.ald_calibrated_on) IS DISTINCT FROM (OLD.ald_calibrated, OLD.ald_calibrated_on) THEN
      RAISE EXCEPTION 'ald_flag_rpc_only: use set_equipment_ald_flag()' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_equipment_ald_guard ON equipment;
CREATE TRIGGER trg_equipment_ald_guard
  BEFORE INSERT OR UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION public.equipment_ald_guard();

-- =============================================================
-- 2. RULES (single source of truth in SQL; mirrored in refrigerantCompliance.ts)
-- =============================================================

CREATE OR REPLACE FUNCTION public.leak_rules()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'min_charge_lbs', 15,              -- appliances holding >= this are covered
    'gwp_exclusive_min', 53,           -- covered refrigerants have GWP > this
    'repair_days', 30,                 -- repair deadline after the exceeding addition
    'followup_test_days', 10,          -- 2nd verification test window
    'retrofit_plan_days', 30,          -- retrofit/retire plan draft due
    'retrofit_complete_years', 1,      -- retrofit/retirement must finish within
    'chronic_pct', 125,                -- chronic leaker, % of full charge / calendar year
    'quarterly_min_lbs', 500,          -- >= 500 lb: quarterly follow-up inspections
    'quarterly_count', 4,
    'annual_count', 1,
    'ald_max_age_days', 365,           -- ALD calibration must be this recent
    'retention_years', 3,
    'followup_job_lead_days', 30,      -- create the inspection job this early
    'due_soon_days', 7,
    'type_i_max_lbs', 5
  );
$$;

CREATE OR REPLACE FUNCTION public.leak_rule_int(p_key text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT (public.leak_rules() ->> p_key)::integer; $$;

CREATE OR REPLACE FUNCTION public.leak_threshold_pct(p_category text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_category
    WHEN 'comfort_cooling' THEN 10
    WHEN 'commercial_refrigeration' THEN 20
    WHEN 'industrial_process' THEN 30
    ELSE 10
  END;
$$;

-- GWP table: mirrors REFRIGERANTS in refrigerantCompliance.ts (a vitest asserts equality).
CREATE TABLE IF NOT EXISTS refrigerant_gwp (
  code text PRIMARY KEY,
  gwp integer NOT NULL CHECK (gwp >= 0)
);

ALTER TABLE refrigerant_gwp ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_refrigerant_gwp" ON refrigerant_gwp;
CREATE POLICY "read_refrigerant_gwp" ON refrigerant_gwp FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON refrigerant_gwp FROM authenticated, anon;

INSERT INTO refrigerant_gwp (code, gwp) VALUES
  ('R-22', 1810), ('R-134a', 1430), ('R-404A', 3922), ('R-407C', 1774), ('R-410A', 2088),
  ('R-32', 675), ('R-454B', 466), ('R-452B', 698), ('R-507A', 3985), ('R-448A', 1387),
  ('R-449A', 1397), ('R-290', 3), ('R-600a', 3), ('R-717', 0), ('R-744', 1)
ON CONFLICT (code) DO UPDATE SET gwp = EXCLUDED.gwp;

/** GWP for "r410a" / "R 410A" / "R-410A"; NULL when the refrigerant is not in the table. */
CREATE OR REPLACE FUNCTION public.refrigerant_gwp_for(p_refrigerant text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT g.gwp FROM refrigerant_gwp g
  WHERE upper(regexp_replace(g.code, '[\s_-]', '', 'g')) = upper(regexp_replace(coalesce(p_refrigerant, ''), '[\s_-]', '', 'g'))
  LIMIT 1;
$$;

/** Covered by the leak-rate rules: >= 15 lb AND (GWP > 53 OR refrigerant unknown — conservative). */
CREATE OR REPLACE FUNCTION public.is_regulated_appliance(p_charge_lbs numeric, p_refrigerant text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(p_charge_lbs, 0) >= public.leak_rule_int('min_charge_lbs')
     AND coalesce(public.refrigerant_gwp_for(p_refrigerant) > public.leak_rule_int('gwp_exclusive_min'), true);
$$;

-- ---- date math (mirrored by leakRepair.ts; all dates are UTC days) ----

CREATE OR REPLACE FUNCTION public.leak_followup_test_due_on(p_initial_on date, p_normal_operation_on date DEFAULT NULL)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT greatest(p_initial_on, coalesce(p_normal_operation_on, p_initial_on)) + public.leak_rule_int('followup_test_days');
$$;

/** n-th follow-up inspection date, anchored on the verification date (never "previous + interval", so Jan 31 + 1 month = Feb 28 without drifting). */
CREATE OR REPLACE FUNCTION public.leak_inspection_due_on(p_verified_on date, p_cadence text, p_n integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (p_verified_on + make_interval(months => p_n * CASE p_cadence WHEN 'quarterly' THEN 3 ELSE 12 END))::date;
$$;

CREATE OR REPLACE FUNCTION public.leak_plan_due_on(p_failed_on date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$ SELECT p_failed_on + public.leak_rule_int('retrofit_plan_days'); $$;

CREATE OR REPLACE FUNCTION public.leak_plan_complete_by(p_failed_on date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$ SELECT (p_failed_on + make_interval(years => public.leak_rule_int('retrofit_complete_years')))::date; $$;

-- =============================================================
-- 3. PERMISSION HELPER + CERTIFICATION HELPER
-- =============================================================

/** Owner, or an active team admin. Gate for waivers, retrofit approval and scans. */
CREATE OR REPLACE FUNCTION public.can_manage_leak_cases()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status = 'active'
        AND tm.role = 'admin'
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_leak_cases() TO authenticated;

/**
  The one place that decides "does this technician hold a valid EPA 608
  certification on this date" (active, not expired on the date, Type I only for
  small appliances). Callers must already have proven the technician belongs to
  their account, so this is NOT exposed to clients.
*/
CREATE OR REPLACE FUNCTION public.find_valid_epa608_credential(
  p_technician_id uuid,
  p_on_date date,
  p_charge_lbs numeric
)
RETURNS TABLE (id uuid, credential_type text, credential_number text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tc.id, tc.credential_type, tc.credential_number
  FROM technician_credentials tc
  WHERE tc.technician_id = p_technician_id
    AND tc.credential_type IN ('epa_608', 'epa_608_type_i', 'epa_608_type_ii', 'epa_608_type_iii', 'epa_608_universal')
    AND tc.status = 'active'
    AND (tc.expires_at IS NULL OR tc.expires_at >= p_on_date)
    AND (tc.credential_type <> 'epa_608_type_i' OR p_charge_lbs IS NULL OR p_charge_lbs <= public.leak_rule_int('type_i_max_lbs'))
  ORDER BY CASE tc.credential_type
    WHEN 'epa_608_universal' THEN 0 WHEN 'epa_608_type_ii' THEN 1 WHEN 'epa_608_type_iii' THEN 1
    WHEN 'epa_608' THEN 2 ELSE 3 END, tc.expires_at DESC NULLS FIRST
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_valid_epa608_credential(uuid, date, numeric) FROM PUBLIC, anon, authenticated;

-- Re-point the existing ledger guard at the shared helper. Body is identical to
-- 20271011000000_refrigerant_compliance.sql except the certification lookup.
CREATE OR REPLACE FUNCTION public.refrigerant_log_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job record;
  v_eq record;
  v_tech record;
  v_cred record;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: not authenticated' USING ERRCODE = '42501';
  END IF;
  NEW.user_id := v_owner;

  IF NEW.job_id IS NULL OR NEW.equipment_id IS NULL OR NEW.technician_id IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: job, unit and technician are required' USING ERRCODE = '23502';
  END IF;

  IF NEW.performed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'refrigerant_log: performed_at cannot be in the future' USING ERRCODE = '22007';
  END IF;

  SELECT j.id, j.address INTO v_job FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: job not found' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.equipment_type, e.make, e.model, e.serial_number, e.refrigerant_charge_lbs
    INTO v_eq FROM equipment e WHERE e.id = NEW.equipment_id AND e.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: unit not found' USING ERRCODE = '42501';
  END IF;

  SELECT tm.id, tm.member_name INTO v_tech
  FROM team_members tm WHERE tm.id = NEW.technician_id AND tm.account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: technician not found' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.credential_type, c.credential_number INTO v_cred
  FROM public.find_valid_epa608_credential(
    NEW.technician_id, (NEW.performed_at AT TIME ZONE 'UTC')::date, v_eq.refrigerant_charge_lbs
  ) c;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_cert_required: % has no valid EPA 608 certification on file for this work',
      COALESCE(v_tech.member_name, 'technician') USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type = 'recovered' AND NEW.disposition IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: recovered refrigerant needs a disposition' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'added' THEN
    NEW.disposition := NULL;
  END IF;

  NEW.refrigerant_type := btrim(NEW.refrigerant_type);
  NEW.cert_credential_id := v_cred.id;
  NEW.cert_type := v_cred.credential_type;
  NEW.cert_number := v_cred.credential_number;
  NEW.technician_name := v_tech.member_name;
  NEW.site_address := v_job.address;
  NEW.equipment_serial := v_eq.serial_number;
  NEW.equipment_label := NULLIF(btrim(concat_ws(' ', v_eq.make, v_eq.model, v_eq.equipment_type)), '');
  NEW.voided_at := NULL;
  NEW.voided_by := NULL;
  NEW.void_reason := NULL;
  RETURN NEW;
END;
$$;

-- =============================================================
-- 4. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS leak_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  trigger_entry_id uuid REFERENCES refrigerant_log(id) ON DELETE SET NULL,
  -- Snapshots: the record stays complete even if the unit / customer is deleted.
  equipment_label text,
  equipment_serial text,
  site_address text,
  customer_name text,
  refrigerant_type text,
  charge_lbs numeric(8,2) NOT NULL CHECK (charge_lbs > 0),
  appliance_category text NOT NULL
    CHECK (appliance_category IN ('comfort_cooling', 'commercial_refrigeration', 'industrial_process', 'other')),
  threshold_pct integer NOT NULL CHECK (threshold_pct > 0),
  rate_pct numeric(7,1) NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'initial_verified', 'verified', 'followup_scheduled', 'failed', 'closed', 'voided')),
  detected_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  repair_due_at timestamptz NOT NULL,
  initial_verified_at timestamptz,
  normal_operation_on date,
  followup_test_due_on date,
  verified_at timestamptz,
  baseline_reset_at timestamptz,
  followup_cadence text CHECK (followup_cadence IS NULL OR followup_cadence IN ('quarterly', 'annual')),
  failed_at timestamptz,
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 300),
  closed_at timestamptz,
  close_reason text
    CHECK (close_reason IS NULL OR close_reason IN ('follow_up_passed', 'ald_waiver', 'retrofitted', 'retired')),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  chronic_flagged_at timestamptz,
  next_action text
    CHECK (next_action IS NULL OR next_action IN
      ('initial_verification', 'followup_verification', 'schedule_followup', 'followup_inspection',
       'submit_retrofit_plan', 'complete_retrofit')),
  next_action_due_at date,
  overdue_notified_at timestamptz,
  due_soon_notified_at timestamptz,
  retain_until date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- THE invariant: a live case always has a dated next action.
  CONSTRAINT leak_cases_next_action_required CHECK (
    status IN ('closed', 'voided') OR (next_action IS NOT NULL AND next_action_due_at IS NOT NULL)
  ),
  CONSTRAINT leak_cases_closed_consistent CHECK (
    (status = 'closed') = (closed_at IS NOT NULL AND close_reason IS NOT NULL)
  ),
  CONSTRAINT leak_cases_voided_consistent CHECK (
    (status = 'voided') = (voided_at IS NOT NULL AND char_length(btrim(coalesce(void_reason, ''))) >= 5)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_leak_cases_one_active_per_equipment
  ON leak_cases(equipment_id) WHERE equipment_id IS NOT NULL AND status NOT IN ('closed', 'voided');
CREATE INDEX IF NOT EXISTS idx_leak_cases_user_status ON leak_cases(user_id, status, next_action_due_at);
CREATE INDEX IF NOT EXISTS idx_leak_cases_equipment ON leak_cases(equipment_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS leak_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES leak_cases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leak_case_events_case ON leak_case_events(case_id, created_at);

CREATE TABLE IF NOT EXISTS leak_verification_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES leak_cases(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial', 'followup')),
  result text NOT NULL CHECK (result IN ('pass', 'fail')),
  performed_at timestamptz NOT NULL,
  on_time boolean NOT NULL,
  method text NOT NULL
    CHECK (method IN ('electronic_leak_detector', 'bubble_solution', 'pressure_decay', 'ultrasonic', 'other')),
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text,
  cert_credential_id uuid REFERENCES technician_credentials(id) ON DELETE SET NULL,
  cert_type text NOT NULL,
  cert_number text,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  signed_by uuid,
  signed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leak_verification_one_per_kind UNIQUE (case_id, kind)
);

CREATE TABLE IF NOT EXISTS leak_followup_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES leak_cases(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  period_index integer NOT NULL CHECK (period_index BETWEEN 1 AND 4),
  cadence text NOT NULL CHECK (cadence IN ('quarterly', 'annual')),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'failed', 'waived', 'cancelled')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  completed_at timestamptz,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text,
  result text CHECK (result IS NULL OR result IN ('pass', 'fail')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  waived_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leak_inspection_period_unique UNIQUE (case_id, period_index)
);
CREATE INDEX IF NOT EXISTS idx_leak_inspections_due ON leak_followup_inspections(user_id, status, due_date);

CREATE TABLE IF NOT EXISTS leak_retrofit_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL UNIQUE REFERENCES leak_cases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'completed', 'cancelled')),
  plan_due_on date NOT NULL,
  complete_by date NOT NULL,
  option text CHECK (option IS NULL OR option IN ('retrofit', 'retire')),
  proposed_refrigerant text CHECK (proposed_refrigerant IS NULL OR char_length(proposed_refrigerant) <= 40),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  approved_at timestamptz,
  approved_by uuid,
  completed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- RLS: read within the account; all writes via SECURITY DEFINER RPCs ----

ALTER TABLE leak_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE leak_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE leak_verification_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leak_followup_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE leak_retrofit_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_leak_cases" ON leak_cases;
CREATE POLICY "select_own_leak_cases" ON leak_cases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_leak_case_events" ON leak_case_events;
CREATE POLICY "select_own_leak_case_events" ON leak_case_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_leak_verification_tests" ON leak_verification_tests;
CREATE POLICY "select_own_leak_verification_tests" ON leak_verification_tests FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_leak_followup_inspections" ON leak_followup_inspections;
CREATE POLICY "select_own_leak_followup_inspections" ON leak_followup_inspections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_leak_retrofit_plans" ON leak_retrofit_plans;
CREATE POLICY "select_own_leak_retrofit_plans" ON leak_retrofit_plans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Intentionally NO insert / update / delete policies, and no table privileges either.
REVOKE INSERT, UPDATE, DELETE ON leak_cases, leak_case_events, leak_verification_tests,
  leak_followup_inspections, leak_retrofit_plans FROM authenticated, anon;
REVOKE ALL ON leak_cases, leak_case_events, leak_verification_tests,
  leak_followup_inspections, leak_retrofit_plans FROM anon;

-- =============================================================
-- 5. GUARDS (append-only tables, case state machine, retention)
-- =============================================================

CREATE OR REPLACE FUNCTION public.leak_cases_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retain_until > (now() AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'leak_cases are retained until % (3-year record retention)', OLD.retain_until
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW.id, NEW.user_id, NEW.charge_lbs, NEW.appliance_category, NEW.threshold_pct, NEW.rate_pct,
      NEW.detected_at, NEW.opened_at, NEW.repair_due_at, NEW.created_at,
      NEW.equipment_label, NEW.equipment_serial, NEW.site_address, NEW.customer_name, NEW.refrigerant_type)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.charge_lbs, OLD.appliance_category, OLD.threshold_pct, OLD.rate_pct,
      OLD.detected_at, OLD.opened_at, OLD.repair_due_at, OLD.created_at,
      OLD.equipment_label, OLD.equipment_serial, OLD.site_address, OLD.customer_name, OLD.refrigerant_type)
  THEN
    RAISE EXCEPTION 'leak case snapshot fields are immutable' USING ERRCODE = '42501';
  END IF;

  -- FKs may only be detached (ON DELETE SET NULL), never re-pointed.
  IF (NEW.equipment_id IS NOT NULL AND NEW.equipment_id IS DISTINCT FROM OLD.equipment_id)
     OR (NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     OR (NEW.trigger_entry_id IS NOT NULL AND NEW.trigger_entry_id IS DISTINCT FROM OLD.trigger_entry_id)
  THEN
    RAISE EXCEPTION 'leak case links cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'open' THEN NEW.status IN ('initial_verified', 'failed', 'voided')
      WHEN 'initial_verified' THEN NEW.status IN ('verified', 'failed', 'voided')
      WHEN 'verified' THEN NEW.status IN ('followup_scheduled', 'closed', 'failed', 'voided')
      WHEN 'followup_scheduled' THEN NEW.status IN ('closed', 'failed', 'voided')
      WHEN 'failed' THEN NEW.status IN ('closed', 'voided')
      ELSE false
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'leak case cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A new next action re-arms the reminder notifications.
  IF (NEW.next_action IS DISTINCT FROM OLD.next_action OR NEW.next_action_due_at IS DISTINCT FROM OLD.next_action_due_at)
     AND NEW.overdue_notified_at IS NOT DISTINCT FROM OLD.overdue_notified_at
     AND NEW.due_soon_notified_at IS NOT DISTINCT FROM OLD.due_soon_notified_at THEN
    NEW.overdue_notified_at := NULL;
    NEW.due_soon_notified_at := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leak_cases_guard ON leak_cases;
CREATE TRIGGER trg_leak_cases_guard
  BEFORE UPDATE OR DELETE ON leak_cases
  FOR EACH ROW EXECUTE FUNCTION public.leak_cases_guard();

/** Events and signed tests are append-only. FK columns may be detached (ON DELETE SET NULL). */
CREATE OR REPLACE FUNCTION public.leak_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only reachable via ON DELETE CASCADE from a retention-expired case.
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'leak_verification_tests' THEN
    IF (to_jsonb(NEW) - 'technician_id' - 'cert_credential_id')
       IS DISTINCT FROM (to_jsonb(OLD) - 'technician_id' - 'cert_credential_id')
       OR (NEW.technician_id IS NOT NULL AND NEW.technician_id IS DISTINCT FROM OLD.technician_id)
       OR (NEW.cert_credential_id IS NOT NULL AND NEW.cert_credential_id IS DISTINCT FROM OLD.cert_credential_id) THEN
      RAISE EXCEPTION 'signed verification tests are immutable' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'leak case events are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leak_tests_append_only ON leak_verification_tests;
CREATE TRIGGER trg_leak_tests_append_only
  BEFORE UPDATE OR DELETE ON leak_verification_tests
  FOR EACH ROW EXECUTE FUNCTION public.leak_append_only_guard();

DROP TRIGGER IF EXISTS trg_leak_events_append_only ON leak_case_events;
CREATE TRIGGER trg_leak_events_append_only
  BEFORE UPDATE ON leak_case_events
  FOR EACH ROW EXECUTE FUNCTION public.leak_append_only_guard();

-- =============================================================
-- 6. LEAK-RATE EVALUATION (SQL mirror of computeLeakRate)
-- =============================================================

/**
  Mirrors computeLeakRate() in refrigerantCompliance.ts (same maths, same
  rounding): rolling 365-day pounds added / full charge, and the annualised
  rate at the latest addition; the higher of the two decides. Additions at or
  before the unit's latest verified repair (baseline_reset_at) are excluded, so
  a verified repair "resets" the books and does not re-open the case forever.
*/
CREATE OR REPLACE FUNCTION public.leak_evaluate_equipment(
  p_equipment_id uuid,
  p_as_of timestamptz DEFAULT now(),
  p_refrigerant text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e record;
  v_charge double precision;
  v_threshold integer;
  v_refrigerant text;
  v_gwp integer;
  v_baseline timestamptz;
  v_last_at timestamptz;
  v_last_lbs double precision;
  v_prev_at timestamptz;
  v_sum365 double precision := 0;
  v_days integer;
  v_rolling double precision;
  v_annual double precision;
  v_rate double precision;
  v_covered boolean;
  v_exceeds boolean;
BEGIN
  SELECT eq.refrigerant_charge_lbs AS charge, eq.appliance_category AS cat,
         eq.refrigerant_type AS rtype, eq.install_date AS installed
    INTO e FROM equipment eq WHERE eq.id = p_equipment_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_charge := CASE WHEN e.charge IS NOT NULL AND e.charge > 0 THEN e.charge::double precision END;
  v_threshold := public.leak_threshold_pct(e.cat);
  v_refrigerant := COALESCE(NULLIF(btrim(p_refrigerant), ''), e.rtype);
  v_gwp := public.refrigerant_gwp_for(v_refrigerant);

  SELECT max(c.baseline_reset_at) INTO v_baseline
  FROM leak_cases c WHERE c.equipment_id = p_equipment_id AND c.status <> 'voided';

  SELECT COALESCE(sum(l.pounds) FILTER (WHERE l.performed_at > p_as_of - make_interval(secs => 365 * 86400)), 0)::double precision
    INTO v_sum365
  FROM refrigerant_log l
  WHERE l.equipment_id = p_equipment_id AND l.event_type = 'added' AND l.voided_at IS NULL
    AND l.performed_at <= p_as_of AND (v_baseline IS NULL OR l.performed_at > v_baseline);

  SELECT t.performed_at, t.pounds, t.prev_at INTO v_last_at, v_last_lbs, v_prev_at
  FROM (
    SELECT l.performed_at, l.pounds::double precision AS pounds,
           lag(l.performed_at) OVER (ORDER BY l.performed_at, l.created_at) AS prev_at
    FROM refrigerant_log l
    WHERE l.equipment_id = p_equipment_id AND l.event_type = 'added' AND l.voided_at IS NULL
      AND l.performed_at <= p_as_of AND (v_baseline IS NULL OR l.performed_at > v_baseline)
  ) t
  ORDER BY t.performed_at DESC
  LIMIT 1;

  -- First addition: compare against the last verified repair, else the install date.
  v_prev_at := COALESCE(v_prev_at, v_baseline, (e.installed::timestamp AT TIME ZONE 'UTC'));

  IF v_last_at IS NOT NULL AND v_prev_at IS NOT NULL THEN
    v_days := GREATEST(1, floor(extract(epoch FROM (v_last_at - v_prev_at)) / 86400.0 + 0.5)::integer);
  END IF;

  IF v_charge IS NOT NULL THEN
    v_rolling := (v_sum365 / v_charge) * 100;
    IF v_last_at IS NOT NULL AND v_days IS NOT NULL THEN
      v_annual := (v_last_lbs / v_charge) * (365.0 / v_days) * 100;
    END IF;
  END IF;

  v_rate := CASE
    WHEN v_rolling IS NOT NULL AND v_annual IS NOT NULL THEN GREATEST(v_rolling, v_annual)
    ELSE COALESCE(v_rolling, v_annual)
  END;
  v_exceeds := v_rate IS NOT NULL AND v_rate > v_threshold;
  v_covered := v_charge IS NOT NULL
    AND v_charge >= public.leak_rule_int('min_charge_lbs')
    AND COALESCE(v_gwp > public.leak_rule_int('gwp_exclusive_min'), true);

  RETURN jsonb_build_object(
    'covered', v_covered,
    'charge_lbs', v_charge,
    'category', COALESCE(e.cat, 'other'),
    'threshold_pct', v_threshold,
    'refrigerant', v_refrigerant,
    'gwp', v_gwp,
    'rate_pct', CASE WHEN v_rate IS NULL THEN NULL ELSE floor(v_rate * 10 + 0.5) / 10 END,
    'rolling_pct', CASE WHEN v_rolling IS NULL THEN NULL ELSE floor(v_rolling * 10 + 0.5) / 10 END,
    'annualized_pct', CASE WHEN v_annual IS NULL THEN NULL ELSE floor(v_annual * 10 + 0.5) / 10 END,
    'exceeds', v_exceeds,
    'last_addition_at', v_last_at,
    'repair_due_at', CASE WHEN v_exceeds AND v_last_at IS NOT NULL
      THEN v_last_at + make_interval(secs => public.leak_rule_int('repair_days') * 86400) END,
    'pounds_added_365', floor(v_sum365 * 100 + 0.5) / 100,
    'baseline_at', v_baseline
  );
END;
$$;

REVOKE ALL ON FUNCTION public.leak_evaluate_equipment(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 7. INTERNAL HELPERS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.leak_case_log(
  p_user uuid, p_case uuid, p_event text, p_from text, p_to text, p_detail text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO leak_case_events (user_id, case_id, event_type, from_status, to_status, actor_id, detail)
  VALUES (p_user, p_case, p_event, p_from, p_to, auth.uid(), left(p_detail, 1000));
  PERFORM public.log_audit_event(p_user, 'leak_case.' || p_event, 'leak_cases', p_case::text);
END;
$$;

REVOKE ALL ON FUNCTION public.leak_case_log(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

/** Failed repair: case -> failed, retrofit/retire plan draft due in 30 days, completion within 1 year. */
CREATE OR REPLACE FUNCTION public.leak_fail_case(p_case uuid, p_reason text, p_failed_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c leak_cases;
  v_failed_on date := (p_failed_at AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO c FROM leak_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND OR c.status IN ('failed', 'closed', 'voided') THEN
    RETURN;
  END IF;

  UPDATE leak_followup_inspections SET status = 'cancelled', updated_at = now()
  WHERE case_id = p_case AND status = 'scheduled';

  UPDATE leak_cases SET
    status = 'failed', failed_at = p_failed_at, failure_reason = left(p_reason, 300),
    next_action = 'submit_retrofit_plan', next_action_due_at = public.leak_plan_due_on(v_failed_on)
  WHERE id = p_case;

  INSERT INTO leak_retrofit_plans (user_id, case_id, plan_due_on, complete_by)
  VALUES (c.user_id, p_case, public.leak_plan_due_on(v_failed_on), public.leak_plan_complete_by(v_failed_on))
  ON CONFLICT (case_id) DO NOTHING;

  PERFORM public.leak_case_log(c.user_id, p_case, 'failed', c.status, 'failed', p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.leak_fail_case(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;

/** Creates the inspection job for one scheduled inspection (idempotent; double-booking aware). */
CREATE OR REPLACE FUNCTION public.leak_create_followup_job(p_inspection_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i leak_followup_inspections;
  c leak_cases;
  cust record;
  v_off integer;
  v_step integer;
  v_base timestamptz;
  v_try timestamptz;
  v_job uuid;
BEGIN
  SELECT * INTO i FROM leak_followup_inspections
  WHERE id = p_inspection_id AND status = 'scheduled' AND job_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM leak_cases WHERE id = i.case_id;

  SELECT cu.id, cu.name, cu.phone, cu.address INTO cust
  FROM equipment e JOIN customers cu ON cu.id = e.customer_id
  WHERE e.id = i.equipment_id AND cu.user_id = i.user_id;
  IF NOT FOUND THEN
    RETURN NULL; -- unit or customer no longer exists: nothing to dispatch to
  END IF;

  FOR v_off IN 0..6 LOOP
    v_base := (((GREATEST(i.due_date, (now() AT TIME ZONE 'UTC')::date) + v_off)) + time '14:00') AT TIME ZONE 'UTC';
    FOR v_step IN 0..15 LOOP
      v_try := v_base + (v_step * interval '30 minutes');
      BEGIN
        INSERT INTO jobs (user_id, customer_id, customer_name, customer_phone, service_type, address,
                          scheduled_datetime, duration_minutes, job_status, dispatch_note)
        VALUES (i.user_id, cust.id, cust.name, cust.phone, 'Refrigerant leak follow-up inspection',
                COALESCE(c.site_address, cust.address), v_try, 60, 'scheduled',
                'Leak follow-up inspection ' || i.period_index || ' (' || i.cadence || ') for '
                  || COALESCE(c.equipment_label, 'unit') || ' — due ' || i.due_date)
        RETURNING id INTO v_job;

        UPDATE leak_followup_inspections SET job_id = v_job, updated_at = now() WHERE id = i.id;
        PERFORM public.leak_case_log(i.user_id, i.case_id, 'job_created', c.status, c.status,
          'Inspection ' || i.period_index || ' job created for ' || i.due_date);
        RETURN v_job;
      EXCEPTION WHEN exclusion_violation THEN
        NULL; -- slot taken; try the next 30-minute step
      END;
    END LOOP;
  END LOOP;
  RETURN NULL; -- no free slot in a week; the next tick retries
END;
$$;

REVOKE ALL ON FUNCTION public.leak_create_followup_job(uuid) FROM PUBLIC, anon, authenticated;

/** After the 2nd verification passes: waive (calibrated ALD) or schedule the follow-up inspection series. */
CREATE OR REPLACE FUNCTION public.leak_schedule_followups(p_case uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c leak_cases;
  eq record;
  v_verified_on date;
  v_cadence text;
  v_count integer;
  n integer;
  v_first date;
  v_insp uuid;
BEGIN
  SELECT * INTO c FROM leak_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND OR c.status <> 'verified' THEN
    RETURN;
  END IF;
  v_verified_on := (c.verified_at AT TIME ZONE 'UTC')::date;
  v_cadence := CASE WHEN c.charge_lbs >= public.leak_rule_int('quarterly_min_lbs') THEN 'quarterly' ELSE 'annual' END;
  v_count := CASE v_cadence WHEN 'quarterly' THEN public.leak_rule_int('quarterly_count') ELSE public.leak_rule_int('annual_count') END;

  SELECT e.ald_calibrated, e.ald_calibrated_on INTO eq FROM equipment e WHERE e.id = c.equipment_id;

  IF FOUND AND eq.ald_calibrated AND eq.ald_calibrated_on IS NOT NULL
     AND eq.ald_calibrated_on >= v_verified_on - public.leak_rule_int('ald_max_age_days') THEN
    INSERT INTO leak_followup_inspections (user_id, case_id, equipment_id, period_index, cadence, due_date, status, waived_reason)
    VALUES (c.user_id, p_case, c.equipment_id, 1, v_cadence, v_verified_on, 'waived',
            'Calibrated ALD on file (calibrated ' || eq.ald_calibrated_on || ')')
    ON CONFLICT (case_id, period_index) DO NOTHING;

    UPDATE leak_cases SET status = 'closed', closed_at = now(), close_reason = 'ald_waiver',
      followup_cadence = v_cadence, next_action = NULL, next_action_due_at = NULL,
      retain_until = ((now() AT TIME ZONE 'UTC')::date + make_interval(years => public.leak_rule_int('retention_years')))::date
    WHERE id = p_case;
    PERFORM public.leak_case_log(c.user_id, p_case, 'followup_waived', 'verified', 'closed',
      'Follow-up inspections waived: calibrated ALD on file');
    RETURN;
  END IF;

  FOR n IN 1..v_count LOOP
    INSERT INTO leak_followup_inspections (user_id, case_id, equipment_id, period_index, cadence, due_date)
    VALUES (c.user_id, p_case, c.equipment_id, n, v_cadence, public.leak_inspection_due_on(v_verified_on, v_cadence, n))
    ON CONFLICT (case_id, period_index) DO NOTHING;
  END LOOP;
  v_first := public.leak_inspection_due_on(v_verified_on, v_cadence, 1);

  UPDATE leak_cases SET status = 'followup_scheduled', followup_cadence = v_cadence,
    next_action = 'followup_inspection', next_action_due_at = v_first
  WHERE id = p_case;
  PERFORM public.leak_case_log(c.user_id, p_case, 'followup_scheduled', 'verified', 'followup_scheduled',
    v_count || ' ' || v_cadence || ' inspection(s); first due ' || v_first);

  -- Inspections that fall inside the lead window get their job right away.
  FOR v_insp IN
    SELECT id FROM leak_followup_inspections
    WHERE case_id = p_case AND status = 'scheduled' AND job_id IS NULL
      AND due_date <= (now() AT TIME ZONE 'UTC')::date + public.leak_rule_int('followup_job_lead_days')
  LOOP
    PERFORM public.leak_create_followup_job(v_insp);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.leak_schedule_followups(uuid) FROM PUBLIC, anon, authenticated;

/** Flags the unit's live case when the calendar-year leak exceeds 125% of full charge. */
CREATE OR REPLACE FUNCTION public.leak_flag_chronic(p_equipment_id uuid, p_year integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c leak_cases;
  v_charge numeric;
  v_added numeric;
BEGIN
  SELECT e.refrigerant_charge_lbs INTO v_charge FROM equipment e WHERE e.id = p_equipment_id;
  IF v_charge IS NULL OR v_charge <= 0 THEN RETURN; END IF;
  SELECT COALESCE(sum(l.pounds), 0) INTO v_added FROM refrigerant_log l
  WHERE l.equipment_id = p_equipment_id AND l.event_type = 'added' AND l.voided_at IS NULL
    AND l.performed_at >= make_timestamptz(p_year, 1, 1, 0, 0, 0, 'UTC')
    AND l.performed_at < make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC');
  IF (v_added / v_charge) * 100 <= public.leak_rule_int('chronic_pct') THEN RETURN; END IF;

  SELECT * INTO c FROM leak_cases
  WHERE equipment_id = p_equipment_id AND status NOT IN ('closed', 'voided') AND chronic_flagged_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    UPDATE leak_cases SET chronic_flagged_at = now() WHERE id = c.id;
    PERFORM public.leak_case_log(c.user_id, c.id, 'chronic_flagged', c.status, c.status,
      'Chronic leaker: ' || round((v_added / v_charge) * 100, 1) || '% of full charge added in ' || p_year
      || ' (limit ' || public.leak_rule_int('chronic_pct') || '%). HAWK export data is ready; nothing is filed.');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leak_flag_chronic(uuid, integer) FROM PUBLIC, anon, authenticated;

/**
  Opens a leak case for the unit behind a logged addition when it is a regulated
  appliance over its threshold. Idempotent and serialised per unit. A new
  exceedance while a repaired case is in follow-up means the repair did not
  hold -> that case fails (retrofit/retire plan).
*/
CREATE OR REPLACE FUNCTION public.leak_open_case_if_needed(p_entry_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l refrigerant_log;
  v_eval jsonb;
  v_active leak_cases;
  v_eq record;
  v_case uuid;
  v_due timestamptz;
BEGIN
  SELECT * INTO l FROM refrigerant_log WHERE id = p_entry_id;
  IF NOT FOUND OR l.event_type <> 'added' OR l.voided_at IS NOT NULL OR l.equipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('leak_case:' || l.equipment_id::text, 0));

  v_eval := public.leak_evaluate_equipment(l.equipment_id, l.performed_at, l.refrigerant_type);
  IF v_eval IS NULL OR NOT (v_eval ->> 'covered')::boolean THEN
    RETURN NULL;
  END IF;

  PERFORM public.leak_flag_chronic(l.equipment_id, extract(year FROM l.performed_at AT TIME ZONE 'UTC')::integer);

  IF NOT (v_eval ->> 'exceeds')::boolean THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_active FROM leak_cases
  WHERE equipment_id = l.equipment_id AND status NOT IN ('closed', 'voided') FOR UPDATE;
  IF FOUND THEN
    IF v_active.status = 'followup_scheduled' THEN
      PERFORM public.leak_fail_case(v_active.id,
        'Leak rate exceeded the threshold again after the verified repair (' || (v_eval ->> 'rate_pct') || '%)',
        l.performed_at);
    END IF;
    RETURN v_active.id;
  END IF;

  SELECT e.customer_id, e.install_date, cu.name AS customer_name INTO v_eq
  FROM equipment e LEFT JOIN customers cu ON cu.id = e.customer_id WHERE e.id = l.equipment_id;

  v_due := (v_eval ->> 'repair_due_at')::timestamptz;
  INSERT INTO leak_cases (
    user_id, equipment_id, customer_id, trigger_entry_id, equipment_label, equipment_serial, site_address,
    customer_name, refrigerant_type, charge_lbs, appliance_category, threshold_pct, rate_pct,
    detected_at, repair_due_at, next_action, next_action_due_at, retain_until
  ) VALUES (
    l.user_id, l.equipment_id, v_eq.customer_id, l.id, l.equipment_label, l.equipment_serial, l.site_address,
    v_eq.customer_name, v_eval ->> 'refrigerant', (v_eval ->> 'charge_lbs')::numeric, v_eval ->> 'category',
    (v_eval ->> 'threshold_pct')::integer, (v_eval ->> 'rate_pct')::numeric,
    l.performed_at, v_due, 'initial_verification', (v_due AT TIME ZONE 'UTC')::date,
    ((now() AT TIME ZONE 'UTC')::date + make_interval(years => public.leak_rule_int('retention_years')))::date
  ) RETURNING id INTO v_case;

  PERFORM public.leak_case_log(l.user_id, v_case, 'opened', NULL, 'open',
    'Leak rate ' || (v_eval ->> 'rate_pct') || '% exceeds the ' || (v_eval ->> 'threshold_pct')
    || '% limit; repair due ' || (v_due AT TIME ZONE 'UTC')::date);
  RETURN v_case;
END;
$$;

REVOKE ALL ON FUNCTION public.leak_open_case_if_needed(uuid) FROM PUBLIC, anon, authenticated;

-- Trigger on the ledger. It must never block compliance logging: on any error it
-- warns, and leak_loop_tick() re-evaluates recent additions to self-heal.
CREATE OR REPLACE FUNCTION public.refrigerant_log_leak_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_type = 'added' AND NEW.equipment_id IS NOT NULL THEN
    BEGIN
      PERFORM public.leak_open_case_if_needed(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'leak case evaluation failed for refrigerant_log %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refrigerant_log_leak ON refrigerant_log;
CREATE TRIGGER trg_refrigerant_log_leak
  AFTER INSERT ON refrigerant_log
  FOR EACH ROW EXECUTE FUNCTION public.refrigerant_log_leak_trigger();

-- =============================================================
-- 8. CLIENT RPCs
-- =============================================================

/** Signs a verification test. The technician must hold a valid EPA 608 certification on the test date. */
CREATE OR REPLACE FUNCTION public.record_leak_verification_test(
  p_case_id uuid,
  p_kind text,
  p_result text,
  p_performed_at timestamptz,
  p_technician_id uuid,
  p_method text,
  p_notes text DEFAULT NULL,
  p_normal_operation_on date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_at timestamptz := COALESCE(p_performed_at, now());
  c leak_cases;
  v_tech record;
  v_caller record;
  v_cred record;
  v_initial leak_verification_tests;
  v_due_on date;
  v_on_time boolean;
  v_test uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'leak case: not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('initial', 'followup') OR p_result NOT IN ('pass', 'fail') THEN
    RAISE EXCEPTION 'leak test: invalid kind or result' USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('electronic_leak_detector', 'bubble_solution', 'pressure_decay', 'ultrasonic', 'other') THEN
    RAISE EXCEPTION 'leak test: choose the test method' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'leak test: notes are too long' USING ERRCODE = '22001';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'leak test: test date cannot be in the future' USING ERRCODE = '22007';
  END IF;

  SELECT * INTO c FROM leak_cases WHERE id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leak case not found' USING ERRCODE = 'P0002';
  END IF;
  IF (p_kind = 'initial' AND c.status <> 'open') OR (p_kind = 'followup' AND c.status <> 'initial_verified') THEN
    RAISE EXCEPTION 'leak_case_invalid_state: a % test cannot be recorded while the case is %', p_kind, c.status
      USING ERRCODE = '23514';
  END IF;
  IF v_at < c.detected_at THEN
    RAISE EXCEPTION 'leak test: test date is before the leak was detected' USING ERRCODE = '22007';
  END IF;

  SELECT tm.id, tm.member_name INTO v_tech
  FROM team_members tm WHERE tm.id = p_technician_id AND tm.account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leak test: technician not found' USING ERRCODE = '42501';
  END IF;

  -- A technician can only sign for themselves.
  SELECT tm.id, tm.role INTO v_caller
  FROM team_members tm
  WHERE tm.account_owner_id = v_owner AND tm.invite_status = 'active'
    AND tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
  LIMIT 1;
  IF FOUND AND v_caller.role = 'technician' AND v_caller.id <> p_technician_id THEN
    RAISE EXCEPTION 'leak_signer_mismatch: technicians can only sign their own tests' USING ERRCODE = '42501';
  END IF;

  SELECT cr.id, cr.credential_type, cr.credential_number INTO v_cred
  FROM public.find_valid_epa608_credential(p_technician_id, (v_at AT TIME ZONE 'UTC')::date, c.charge_lbs) cr;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leak_cert_required: % has no valid EPA 608 certification on the test date',
      COALESCE(v_tech.member_name, 'technician') USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'initial' THEN
    v_on_time := v_at <= c.repair_due_at;
  ELSE
    SELECT * INTO v_initial FROM leak_verification_tests WHERE case_id = c.id AND kind = 'initial';
    IF v_at < v_initial.performed_at THEN
      RAISE EXCEPTION 'leak test: follow-up test cannot be before the initial test' USING ERRCODE = '22007';
    END IF;
    v_on_time := (v_at AT TIME ZONE 'UTC')::date <= c.followup_test_due_on;
  END IF;

  INSERT INTO leak_verification_tests (
    user_id, case_id, kind, result, performed_at, on_time, method, technician_id, technician_name,
    cert_credential_id, cert_type, cert_number, notes, signed_by
  ) VALUES (
    v_owner, c.id, p_kind, p_result, v_at, v_on_time, p_method, p_technician_id, v_tech.member_name,
    v_cred.id, v_cred.credential_type, v_cred.credential_number, NULLIF(btrim(COALESCE(p_notes, '')), ''), auth.uid()
  ) RETURNING id INTO v_test;

  IF p_result = 'fail' THEN
    PERFORM public.leak_fail_case(c.id, initcap(p_kind) || ' verification test failed', v_at);
    RETURN v_test;
  END IF;

  IF p_kind = 'initial' THEN
    v_due_on := public.leak_followup_test_due_on((v_at AT TIME ZONE 'UTC')::date, p_normal_operation_on);
    UPDATE leak_cases SET status = 'initial_verified', initial_verified_at = v_at,
      normal_operation_on = p_normal_operation_on, followup_test_due_on = v_due_on,
      next_action = 'followup_verification', next_action_due_at = v_due_on
    WHERE id = c.id;
    PERFORM public.leak_case_log(v_owner, c.id, 'initial_verified', 'open', 'initial_verified',
      'Initial verification passed' || CASE WHEN v_on_time THEN '' ELSE ' (after the repair deadline)' END
      || '; follow-up test due ' || v_due_on);
  ELSE
    UPDATE leak_cases SET status = 'verified', verified_at = v_at, baseline_reset_at = v_at,
      next_action = 'schedule_followup', next_action_due_at = (v_at AT TIME ZONE 'UTC')::date
    WHERE id = c.id;
    PERFORM public.leak_case_log(v_owner, c.id, 'verified', 'initial_verified', 'verified',
      'Follow-up verification passed' || CASE WHEN v_on_time THEN '' ELSE ' (after the 10-day window)' END);
    PERFORM public.leak_schedule_followups(c.id);
  END IF;
  RETURN v_test;
END;
$$;

/** Completes (or fails) a follow-up inspection; closes the case when the series is done. */
CREATE OR REPLACE FUNCTION public.complete_leak_inspection(
  p_inspection_id uuid,
  p_result text,
  p_technician_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  i leak_followup_inspections;
  c leak_cases;
  v_tech record;
  v_next date;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'leak case: not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_result NOT IN ('pass', 'fail') THEN
    RAISE EXCEPTION 'leak inspection: invalid result' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'leak inspection: notes are too long' USING ERRCODE = '22001';
  END IF;

  SELECT * INTO i FROM leak_followup_inspections WHERE id = p_inspection_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leak inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF i.status <> 'scheduled' THEN
    RAISE EXCEPTION 'leak_case_invalid_state: inspection is already %', i.status USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM leak_cases WHERE id = i.case_id FOR UPDATE;
  IF c.status <> 'followup_scheduled' THEN
    RAISE EXCEPTION 'leak_case_invalid_state: case is %', c.status USING ERRCODE = '23514';
  END IF;

  IF p_technician_id IS NOT NULL THEN
    SELECT tm.id, tm.member_name INTO v_tech
    FROM team_members tm WHERE tm.id = p_technician_id AND tm.account_owner_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'leak inspection: technician not found' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE leak_followup_inspections SET
    status = CASE p_result WHEN 'pass' THEN 'completed' ELSE 'failed' END,
    result = p_result, completed_at = now(), technician_id = p_technician_id,
    technician_name = v_tech.member_name, notes = NULLIF(btrim(COALESCE(p_notes, '')), ''), updated_at = now()
  WHERE id = i.id;

  IF p_result = 'fail' THEN
    PERFORM public.leak_case_log(v_owner, c.id, 'inspection_failed', c.status, c.status,
      'Follow-up inspection ' || i.period_index || ' found a leak');
    PERFORM public.leak_fail_case(c.id, 'Follow-up inspection ' || i.period_index || ' found a leak', now());
    RETURN;
  END IF;

  PERFORM public.leak_case_log(v_owner, c.id, 'inspection_completed', c.status, c.status,
    'Follow-up inspection ' || i.period_index || ' passed');

  SELECT min(due_date) INTO v_next FROM leak_followup_inspections WHERE case_id = c.id AND status = 'scheduled';
  IF v_next IS NULL THEN
    UPDATE leak_cases SET status = 'closed', closed_at = now(), close_reason = 'follow_up_passed',
      next_action = NULL, next_action_due_at = NULL,
      retain_until = ((now() AT TIME ZONE 'UTC')::date + make_interval(years => public.leak_rule_int('retention_years')))::date
    WHERE id = c.id;
    PERFORM public.leak_case_log(v_owner, c.id, 'closed', 'followup_scheduled', 'closed',
      'All follow-up inspections passed');
  ELSE
    UPDATE leak_cases SET next_action_due_at = v_next WHERE id = c.id;
  END IF;
END;
$$;

/** Edit the retrofit/retire plan draft (owner / admin). */
CREATE OR REPLACE FUNCTION public.save_leak_retrofit_plan(
  p_case_id uuid, p_option text, p_proposed_refrigerant text DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p leak_retrofit_plans;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_leak_cases() THEN
    RAISE EXCEPTION 'Only the owner or an admin can edit retrofit plans' USING ERRCODE = '42501';
  END IF;
  IF p_option IS NOT NULL AND p_option NOT IN ('retrofit', 'retire') THEN
    RAISE EXCEPTION 'retrofit plan: option must be retrofit or retire' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM leak_retrofit_plans WHERE case_id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retrofit plan not found' USING ERRCODE = 'P0002';
  END IF;
  IF p.status <> 'draft' THEN
    RAISE EXCEPTION 'leak_case_invalid_state: only a draft plan can be edited' USING ERRCODE = '23514';
  END IF;
  UPDATE leak_retrofit_plans SET option = p_option,
    proposed_refrigerant = NULLIF(btrim(COALESCE(p_proposed_refrigerant, '')), ''),
    notes = NULLIF(btrim(COALESCE(p_notes, '')), ''), updated_at = now()
  WHERE id = p.id;
  PERFORM public.leak_case_log(v_owner, p_case_id, 'retrofit_plan_saved', 'failed', 'failed',
    'Retrofit/retire plan draft updated');
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_leak_retrofit_plan(p_case_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p leak_retrofit_plans;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_leak_cases() THEN
    RAISE EXCEPTION 'Only the owner or an admin can approve retrofit plans' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM leak_retrofit_plans WHERE case_id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retrofit plan not found' USING ERRCODE = 'P0002';
  END IF;
  IF p.status <> 'draft' OR p.option IS NULL THEN
    RAISE EXCEPTION 'leak_case_invalid_state: choose retrofit or retire on the draft first' USING ERRCODE = '23514';
  END IF;
  UPDATE leak_retrofit_plans SET status = 'approved', approved_at = now(), approved_by = auth.uid(), updated_at = now()
  WHERE id = p.id;
  UPDATE leak_cases SET next_action = 'complete_retrofit', next_action_due_at = p.complete_by
  WHERE id = p_case_id AND status = 'failed';
  PERFORM public.leak_case_log(v_owner, p_case_id, 'retrofit_approved', 'failed', 'failed',
    'Plan approved: ' || p.option || '; complete by ' || p.complete_by);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_leak_retrofit_plan(
  p_case_id uuid, p_completed_on date DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_on date := COALESCE(p_completed_on, (now() AT TIME ZONE 'UTC')::date);
  p leak_retrofit_plans;
  c leak_cases;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_leak_cases() THEN
    RAISE EXCEPTION 'Only the owner or an admin can complete retrofit plans' USING ERRCODE = '42501';
  END IF;
  IF v_on > (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'retrofit plan: completion date cannot be in the future' USING ERRCODE = '22007';
  END IF;
  SELECT * INTO p FROM leak_retrofit_plans WHERE case_id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retrofit plan not found' USING ERRCODE = 'P0002';
  END IF;
  IF p.status <> 'approved' THEN
    RAISE EXCEPTION 'leak_case_invalid_state: approve the plan before completing it' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM leak_cases WHERE id = p_case_id FOR UPDATE;

  UPDATE leak_retrofit_plans SET status = 'completed', completed_on = v_on,
    notes = COALESCE(NULLIF(btrim(COALESCE(p_notes, '')), ''), notes), updated_at = now()
  WHERE id = p.id;

  UPDATE leak_cases SET status = 'closed', closed_at = now(),
    close_reason = CASE p.option WHEN 'retire' THEN 'retired' ELSE 'retrofitted' END,
    baseline_reset_at = (v_on::timestamp AT TIME ZONE 'UTC'),
    next_action = NULL, next_action_due_at = NULL,
    retain_until = ((now() AT TIME ZONE 'UTC')::date + make_interval(years => public.leak_rule_int('retention_years')))::date
  WHERE id = p_case_id;

  IF c.equipment_id IS NOT NULL THEN
    IF p.option = 'retire' THEN
      UPDATE equipment SET status = 'removed' WHERE id = c.equipment_id AND user_id = v_owner;
    ELSIF p.proposed_refrigerant IS NOT NULL THEN
      UPDATE equipment SET refrigerant_type = p.proposed_refrigerant WHERE id = c.equipment_id AND user_id = v_owner;
    END IF;
  END IF;

  PERFORM public.leak_case_log(v_owner, p_case_id, 'closed', 'failed', 'closed',
    CASE p.option WHEN 'retire' THEN 'Appliance retired' ELSE 'Appliance retrofitted' END || ' on ' || v_on);
END;
$$;

/** Owner-only: void a case opened from bad data. The case stays in the record. */
CREATE OR REPLACE FUNCTION public.void_leak_case(p_case_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := btrim(COALESCE(p_reason, ''));
  c leak_cases;
BEGIN
  IF v_owner IS NULL OR NOT public.is_account_owner() THEN
    RAISE EXCEPTION 'Only the account owner can void leak cases' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM leak_cases WHERE id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR c.status IN ('closed', 'voided') THEN
    RAISE EXCEPTION 'Case not found or already finished' USING ERRCODE = 'P0002';
  END IF;

  UPDATE leak_followup_inspections SET status = 'cancelled', updated_at = now()
  WHERE case_id = p_case_id AND status = 'scheduled';
  UPDATE leak_retrofit_plans SET status = 'cancelled', updated_at = now()
  WHERE case_id = p_case_id AND status IN ('draft', 'approved');
  UPDATE leak_cases SET status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
    next_action = NULL, next_action_due_at = NULL
  WHERE id = p_case_id;
  PERFORM public.leak_case_log(v_owner, p_case_id, 'voided', c.status, 'voided', v_reason);
END;
$$;

/** Owner / admin: set or clear the calibrated-ALD flag that can waive follow-up inspections. */
CREATE OR REPLACE FUNCTION public.set_equipment_ald_flag(
  p_equipment_id uuid, p_calibrated boolean, p_calibrated_on date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_leak_cases() THEN
    RAISE EXCEPTION 'Only the owner or an admin can set the ALD flag' USING ERRCODE = '42501';
  END IF;
  IF p_calibrated AND (p_calibrated_on IS NULL OR p_calibrated_on > (now() AT TIME ZONE 'UTC')::date) THEN
    RAISE EXCEPTION 'ALD flag: give the calibration date (not in the future)' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.ald_rpc', 'on', true);
  UPDATE equipment SET ald_calibrated = p_calibrated, ald_calibrated_on = CASE WHEN p_calibrated THEN p_calibrated_on END
  WHERE id = p_equipment_id AND user_id = v_owner;
  PERFORM set_config('vireek.ald_rpc', 'off', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unit not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner,
    CASE WHEN p_calibrated THEN 'equipment.ald_flag_set' ELSE 'equipment.ald_flag_cleared' END,
    'equipment', p_equipment_id::text);
END;
$$;

/** Owner / admin: evaluate existing ledger data once and open cases that are missing. Idempotent. */
CREATE OR REPLACE FUNCTION public.scan_leak_cases()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r record;
  v_before integer;
  v_after integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_leak_cases() THEN
    RAISE EXCEPTION 'Only the owner or an admin can scan for leak cases' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_before FROM leak_cases WHERE user_id = v_owner;
  FOR r IN
    SELECT DISTINCT ON (l.equipment_id) l.id
    FROM refrigerant_log l
    WHERE l.user_id = v_owner AND l.event_type = 'added' AND l.voided_at IS NULL AND l.equipment_id IS NOT NULL
      AND l.performed_at > now() - make_interval(secs => 366 * 86400)
    ORDER BY l.equipment_id, l.performed_at DESC
  LOOP
    PERFORM public.leak_open_case_if_needed(r.id);
  END LOOP;
  SELECT count(*) INTO v_after FROM leak_cases WHERE user_id = v_owner;
  RETURN v_after - v_before;
END;
$$;

-- =============================================================
-- 9. READ HELPERS (SECURITY INVOKER: RLS applies) + EXPORT
-- =============================================================

CREATE OR REPLACE FUNCTION public.leak_case_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'active',   count(*) FILTER (WHERE status NOT IN ('closed', 'voided')),
    'overdue',  count(*) FILTER (WHERE status NOT IN ('closed', 'voided') AND next_action_due_at < (now() AT TIME ZONE 'UTC')::date),
    'due_soon', count(*) FILTER (WHERE status NOT IN ('closed', 'voided')
                  AND next_action_due_at BETWEEN (now() AT TIME ZONE 'UTC')::date
                      AND (now() AT TIME ZONE 'UTC')::date + public.leak_rule_int('due_soon_days')),
    'failed',   count(*) FILTER (WHERE status = 'failed'),
    'chronic',  count(*) FILTER (WHERE status NOT IN ('closed', 'voided') AND chronic_flagged_at IS NOT NULL)
  ) FROM leak_cases;
$$;

/** Units over 125% of full charge added in a calendar year (data prepared for EPA's HAWK system; never filed). */
CREATE OR REPLACE FUNCTION public.leak_chronic_candidates(p_year integer DEFAULT NULL)
RETURNS TABLE (
  equipment_id uuid, customer_name text, site_address text, equipment_label text, equipment_serial text,
  refrigerant_type text, appliance_category text, charge_lbs numeric, pounds_added numeric, leak_rate_pct numeric,
  additions integer, first_addition_at timestamptz, last_addition_at timestamptz,
  case_count integer, latest_case_status text, year integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH y AS (SELECT COALESCE(p_year, extract(year FROM now() AT TIME ZONE 'UTC')::integer) AS yr),
  agg AS (
    SELECT l.equipment_id, sum(l.pounds) AS added, count(*)::integer AS n,
           min(l.performed_at) AS first_at, max(l.performed_at) AS last_at,
           (array_agg(l.site_address ORDER BY l.performed_at DESC))[1] AS site
    FROM refrigerant_log l, y
    WHERE l.event_type = 'added' AND l.voided_at IS NULL AND l.equipment_id IS NOT NULL
      AND l.performed_at >= make_timestamptz(y.yr, 1, 1, 0, 0, 0, 'UTC')
      AND l.performed_at < make_timestamptz(y.yr + 1, 1, 1, 0, 0, 0, 'UTC')
    GROUP BY l.equipment_id
  )
  SELECT e.id, cu.name, COALESCE(a.site, cu.address),
         NULLIF(btrim(concat_ws(' ', e.make, e.model, e.equipment_type)), ''), e.serial_number,
         e.refrigerant_type, COALESCE(e.appliance_category, 'other'), e.refrigerant_charge_lbs, a.added,
         round((a.added / e.refrigerant_charge_lbs) * 100, 1), a.n, a.first_at, a.last_at,
         (SELECT count(*)::integer FROM leak_cases c WHERE c.equipment_id = e.id AND c.status <> 'voided'),
         (SELECT c.status FROM leak_cases c WHERE c.equipment_id = e.id AND c.status <> 'voided' ORDER BY c.opened_at DESC LIMIT 1),
         y.yr
  FROM agg a
  JOIN y ON true
  JOIN equipment e ON e.id = a.equipment_id
  LEFT JOIN customers cu ON cu.id = e.customer_id
  WHERE e.refrigerant_charge_lbs IS NOT NULL AND e.refrigerant_charge_lbs > 0
    AND public.is_regulated_appliance(e.refrigerant_charge_lbs, e.refrigerant_type)
    AND (a.added / e.refrigerant_charge_lbs) * 100 > public.leak_rule_int('chronic_pct')
  ORDER BY (a.added / e.refrigerant_charge_lbs) DESC;
$$;

-- =============================================================
-- 10. HOURLY TICK (called by the recurring-jobs-cron edge function)
-- =============================================================

CREATE OR REPLACE FUNCTION public.leak_loop_tick(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_scanned integer := 0;
  v_jobs integer := 0;
  v_overdue integer := 0;
  v_soon integer := 0;
  v_today date := (p_now AT TIME ZONE 'UTC')::date;
  v_job uuid;
BEGIN
  -- 1. Self-heal: re-evaluate additions logged in the last 48h (the ledger trigger never blocks).
  FOR r IN
    SELECT DISTINCT ON (l.equipment_id) l.id
    FROM refrigerant_log l
    WHERE l.event_type = 'added' AND l.voided_at IS NULL AND l.equipment_id IS NOT NULL
      AND l.created_at > p_now - interval '48 hours'
    ORDER BY l.equipment_id, l.performed_at DESC
  LOOP
    BEGIN
      PERFORM public.leak_open_case_if_needed(r.id);
      v_scanned := v_scanned + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'leak_loop_tick: evaluation failed for %: %', r.id, SQLERRM;
    END;
  END LOOP;

  -- 2. Follow-up inspection jobs inside the lead window.
  FOR r IN
    SELECT id FROM leak_followup_inspections
    WHERE status = 'scheduled' AND job_id IS NULL
      AND due_date <= v_today + public.leak_rule_int('followup_job_lead_days')
    ORDER BY due_date
    LIMIT 200
  LOOP
    BEGIN
      v_job := public.leak_create_followup_job(r.id);
      IF v_job IS NOT NULL THEN v_jobs := v_jobs + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'leak_loop_tick: job creation failed for %: %', r.id, SQLERRM;
    END;
  END LOOP;

  -- 3. Notifications: once when a next action becomes due soon, once when it is overdue.
  FOR r IN
    SELECT c.id, c.user_id, c.next_action, c.next_action_due_at, c.equipment_label
    FROM leak_cases c
    WHERE c.status NOT IN ('closed', 'voided') AND c.next_action_due_at < v_today AND c.overdue_notified_at IS NULL
    LIMIT 500
  LOOP
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (r.user_id, 'leak_case_overdue', 'Refrigerant leak case overdue',
      COALESCE(r.equipment_label, 'A regulated unit') || ': ' || replace(r.next_action, '_', ' ')
        || ' was due ' || r.next_action_due_at || '.', '/dashboard/refrigerant-leaks');
    UPDATE leak_cases SET overdue_notified_at = p_now WHERE id = r.id;
    v_overdue := v_overdue + 1;
  END LOOP;

  FOR r IN
    SELECT c.id, c.user_id, c.next_action, c.next_action_due_at, c.equipment_label
    FROM leak_cases c
    WHERE c.status NOT IN ('closed', 'voided') AND c.due_soon_notified_at IS NULL
      AND c.next_action_due_at BETWEEN v_today AND v_today + public.leak_rule_int('due_soon_days')
    LIMIT 500
  LOOP
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (r.user_id, 'leak_case_due_soon', 'Refrigerant leak action due soon',
      COALESCE(r.equipment_label, 'A regulated unit') || ': ' || replace(r.next_action, '_', ' ')
        || ' is due ' || r.next_action_due_at || '.', '/dashboard/refrigerant-leaks');
    UPDATE leak_cases SET due_soon_notified_at = p_now WHERE id = r.id;
    v_soon := v_soon + 1;
  END LOOP;

  RETURN jsonb_build_object('evaluated', v_scanned, 'jobs_created', v_jobs,
    'overdue_notified', v_overdue, 'due_soon_notified', v_soon);
END;
$$;

REVOKE ALL ON FUNCTION public.leak_loop_tick(timestamptz) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 11. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.record_leak_verification_test(uuid, text, text, timestamptz, uuid, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_leak_inspection(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_leak_retrofit_plan(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_leak_retrofit_plan(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_leak_retrofit_plan(uuid, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_leak_case(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_equipment_ald_flag(uuid, boolean, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scan_leak_cases() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leak_case_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leak_chronic_candidates(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leak_evaluate_equipment(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_leak_verification_test(uuid, text, text, timestamptz, uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_leak_inspection(uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_leak_retrofit_plan(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leak_retrofit_plan(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_leak_retrofit_plan(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_leak_case(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_equipment_ald_flag(uuid, boolean, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scan_leak_cases() TO authenticated;
GRANT EXECUTE ON FUNCTION public.leak_case_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.leak_chronic_candidates(integer) TO authenticated;
GRANT SELECT ON leak_cases, leak_case_events, leak_verification_tests, leak_followup_inspections, leak_retrofit_plans TO authenticated;
