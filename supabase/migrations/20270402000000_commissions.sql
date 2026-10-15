/*
  # Commissions — rules with tiers, per-job overrides, statements, approval, payroll export

  ## Why
  20261204000000_payroll.sql gave Vireek a flat per-record commission
  (`commission_records`: basis x rate). It had no rules, no tiers, no way to
  deviate for one job, no review step before money is owed, and no way to
  hand the result to an outside payroll provider. This migration builds that
  layer on top of the existing table — nothing is dropped or renamed.

  ## Rule precedence (first match wins)
  1. Per-job override (employee-specific, then job-wide):
     rate_percent | flat_cents | excluded
  2. The employee's assigned plan (employees.commission_plan_id)
  3. The account's default plan
  4. The employee's legacy flat employees.commission_rate_percent
  No match -> the job earns nothing and is reported as `no_rule`.

  ## Plans and tiers
  A plan is a ladder of (threshold, rate) tiers evaluated on the employee's
  cumulative commissionable volume inside a monthly / quarterly / yearly
  period.
    marginal      each dollar earns the rate of the tier it lands in
                  (tax-bracket style; one job can straddle two tiers)
    tier_reached  the whole job earns the rate of the tier the employee's
                  period volume reaches after that job (no retroactive
                  true-up of earlier jobs)
  Editing a plan only affects commissions generated afterwards; every stored
  record keeps `plan_id` + `calc_detail` (tier segments) as its audit trail.

  ## Where commissions come from
  A completed job with an assigned technician who is linked to an active
  employee (employees.team_member_id). Basis = paid ar_invoices.subtotal_cents
  for the job (pre-tax); if the job has no paid ar_invoice, the paid
  jobs.invoice_amount. Commission is therefore earned on collected money.
  Jobs that already have an earned record for that employee (generated OR
  manual) are never duplicated.

  ## Statements and approval
  records (pending) -> statement (draft) -> pending_approval -> approved
  -> paid, with `return` (back to draft, note required) and `void`.
  Approving flips the statement's records to `approved`, which is exactly what
  the existing create_pay_run() pulls into a pay run. The preparer cannot
  approve their own statement unless they are the account owner. Approved
  records are locked against edits. A statement with a negative net (more
  clawbacks than earnings) is not created; its records carry forward.

  ## Payroll export
  Approved statements can be exported to CSV and marked exported, then either:
    a) paid through a Vireek pay run (records flow in automatically; the
       trigger below marks records/statements paid when the pay run is paid,
       and reverts them if the pay run is voided), or
    b) marked paid after an external payroll provider ran them
       (mark_commission_statements_paid).
  Honest limitation: path (b) does NOT post to the general ledger — Vireek
  cannot know what the external provider withheld. Only pay runs post
  Dr Commission Expense / Cr Cash + Payroll Tax Payable.

  ## Security
  Everything here (and, now, commission_records) is readable/writable only by
  the account owner or a team member with `can_view_billing` (directly or via
  a custom role). All writes to plans, tiers, overrides and statements go
  through SECURITY DEFINER RPCs that re-check access and write audit_log rows.
*/

-- =============================================================
-- ACCESS HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_commissions()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_commissions() TO authenticated;

CREATE OR REPLACE FUNCTION public._require_commission_access()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_commissions() THEN
    RAISE EXCEPTION 'Not authorized to manage commissions' USING ERRCODE = '42501';
  END IF;
  RETURN public.get_account_owner_id();
END;
$$;

REVOKE ALL ON FUNCTION public._require_commission_access() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._commission_cycle_start(p_date date, p_period text)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc(CASE p_period WHEN 'quarterly' THEN 'quarter' WHEN 'yearly' THEN 'year' ELSE 'month' END, p_date::timestamp)::date;
$$;

-- =============================================================
-- PLANS + TIERS
-- =============================================================

CREATE TABLE IF NOT EXISTS commission_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  tier_mode text NOT NULL DEFAULT 'marginal' CHECK (tier_mode IN ('marginal', 'tier_reached')),
  tier_period text NOT NULL DEFAULT 'monthly' CHECK (tier_period IN ('monthly', 'quarterly', 'yearly')),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_default OR active)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_plans_name ON commission_plans(user_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_plans_default ON commission_plans(user_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS commission_plan_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
  min_cents bigint NOT NULL CHECK (min_cents >= 0),
  rate_percent numeric(5,2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  UNIQUE (plan_id, min_cents)
);

CREATE INDEX IF NOT EXISTS idx_commission_plan_tiers_plan ON commission_plan_tiers(plan_id, min_cents);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS commission_plan_id uuid REFERENCES commission_plans(id) ON DELETE SET NULL;

-- =============================================================
-- PER-JOB OVERRIDES
-- =============================================================

CREATE TABLE IF NOT EXISTS commission_job_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  override_type text NOT NULL CHECK (override_type IN ('rate_percent', 'flat_cents', 'excluded')),
  rate_percent numeric(5,2) CHECK (rate_percent IS NULL OR (rate_percent >= 0 AND rate_percent <= 100)),
  flat_cents integer CHECK (flat_cents IS NULL OR flat_cents >= 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 3 AND char_length(reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (override_type = 'rate_percent' AND rate_percent IS NOT NULL AND flat_cents IS NULL)
    OR (override_type = 'flat_cents' AND flat_cents IS NOT NULL AND rate_percent IS NULL)
    OR (override_type = 'excluded' AND rate_percent IS NULL AND flat_cents IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_job_overrides_target
  ON commission_job_overrides(job_id, COALESCE(employee_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_commission_job_overrides_user ON commission_job_overrides(user_id, created_at DESC);

-- =============================================================
-- STATEMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS commission_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid', 'void')),
  record_count integer NOT NULL DEFAULT 0,
  earned_cents bigint NOT NULL DEFAULT 0,
  adjustment_cents bigint NOT NULL DEFAULT 0,
  net_cents bigint NOT NULL DEFAULT 0,
  prepared_by uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  review_note text,
  void_reason text,
  exported_at timestamptz,
  paid_at timestamptz,
  payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_commission_statements_user_status ON commission_statements(user_id, status, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_commission_statements_employee ON commission_statements(employee_id, period_end DESC);

-- =============================================================
-- EXTEND commission_records (additive; legacy rows keep working)
-- =============================================================

ALTER TABLE commission_records
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'earned' CHECK (kind IN ('earned', 'adjustment', 'clawback')),
  ADD COLUMN IF NOT EXISTS calc_source text NOT NULL DEFAULT 'manual' CHECK (calc_source IN ('manual', 'plan', 'override_rate', 'override_flat', 'employee_rate')),
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES commission_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS calc_detail jsonb,
  ADD COLUMN IF NOT EXISTS memo text,
  ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES commission_statements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS earned_date date;

UPDATE commission_records SET earned_date = created_at::date WHERE earned_date IS NULL;
ALTER TABLE commission_records ALTER COLUMN earned_date SET DEFAULT current_date;
ALTER TABLE commission_records ALTER COLUMN earned_date SET NOT NULL;

ALTER TABLE commission_records DROP CONSTRAINT IF EXISTS chk_commission_kind_sign;
ALTER TABLE commission_records ADD CONSTRAINT chk_commission_kind_sign CHECK (
  (kind = 'earned' AND commission_cents >= 0)
  OR (kind = 'clawback' AND commission_cents <= 0)
  OR kind = 'adjustment'
);

CREATE INDEX IF NOT EXISTS idx_commission_records_user_date ON commission_records(user_id, earned_date DESC);
CREATE INDEX IF NOT EXISTS idx_commission_records_statement ON commission_records(statement_id) WHERE statement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commission_records_pending ON commission_records(employee_id, earned_date) WHERE status = 'pending' AND statement_id IS NULL;
-- A job can earn a generated commission only once per employee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_records_generated_job
  ON commission_records(employee_id, job_id)
  WHERE kind = 'earned' AND job_id IS NOT NULL AND calc_source <> 'manual';

-- commission_cents is derived from basis x rate ONLY for manual/flat-rate
-- records (unchanged legacy behaviour). Plan (tiered) and flat-amount
-- override records carry an exact engine-computed amount that must not be
-- recomputed from a rounded effective rate; adjustments are entered as-is.
CREATE OR REPLACE FUNCTION public._commission_calc()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'earned' AND NEW.calc_source IN ('manual', 'override_rate', 'employee_rate') THEN
    NEW.commission_cents := round(NEW.basis_amount_cents * NEW.commission_rate_percent / 100.0);
  END IF;
  RETURN NEW;
END;
$$;

-- Approved/paid records that belong to a statement are immutable.
CREATE OR REPLACE FUNCTION public._commission_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.statement_id IS NOT NULL AND OLD.status IN ('approved', 'paid') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Commission record is locked by an approved statement';
    END IF;
    IF (NEW.employee_id, NEW.job_id, NEW.kind, NEW.basis_amount_cents, NEW.commission_rate_percent, NEW.commission_cents)
       IS DISTINCT FROM
       (OLD.employee_id, OLD.job_id, OLD.kind, OLD.basis_amount_cents, OLD.commission_rate_percent, OLD.commission_cents) THEN
      RAISE EXCEPTION 'Commission record is locked by an approved statement';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_guard ON commission_records;
CREATE TRIGGER trg_commission_guard
  BEFORE UPDATE OR DELETE ON commission_records FOR EACH ROW EXECUTE FUNCTION public._commission_guard();

-- Pay run voided after payment: put records/statement back to "approved".
CREATE OR REPLACE FUNCTION public._commission_pay_revert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.pay_run_item_id IS NOT NULL AND NEW.pay_run_item_id IS NULL AND OLD.status = 'paid' THEN
    NEW.status := 'approved';
    IF NEW.statement_id IS NOT NULL THEN
      UPDATE commission_statements SET status = 'approved', paid_at = NULL, updated_at = now()
      WHERE id = NEW.statement_id AND status = 'paid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_pay_revert ON commission_records;
CREATE TRIGGER trg_commission_pay_revert
  BEFORE UPDATE OF pay_run_item_id ON commission_records FOR EACH ROW EXECUTE FUNCTION public._commission_pay_revert();

-- Pay run marked paid: mark its commission records / statements paid.
CREATE OR REPLACE FUNCTION public._commission_sync_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
    UPDATE commission_records SET status = 'paid'
    WHERE pay_run_item_id = NEW.id AND status = 'approved';

    UPDATE commission_statements s
    SET status = 'paid', paid_at = now(), updated_at = now()
    WHERE s.status = 'approved'
      AND EXISTS (SELECT 1 FROM commission_records r WHERE r.statement_id = s.id AND r.pay_run_item_id = NEW.id)
      AND NOT EXISTS (SELECT 1 FROM commission_records r WHERE r.statement_id = s.id AND r.status <> 'paid');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_sync_paid ON pay_run_items;
CREATE TRIGGER trg_commission_sync_paid
  AFTER UPDATE OF paid_at ON pay_run_items FOR EACH ROW EXECUTE FUNCTION public._commission_sync_paid();

DROP TRIGGER IF EXISTS trigger_commission_plans_updated_at ON commission_plans;
CREATE TRIGGER trigger_commission_plans_updated_at
  BEFORE UPDATE ON commission_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_commission_statements_updated_at ON commission_statements;
CREATE TRIGGER trigger_commission_statements_updated_at
  BEFORE UPDATE ON commission_statements FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- RLS — owner or billing-permission members only; writes via RPC
-- =============================================================

ALTER TABLE commission_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_plan_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_job_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_commission_plans" ON commission_plans;
CREATE POLICY "select_commission_plans" ON commission_plans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS "select_commission_plan_tiers" ON commission_plan_tiers;
CREATE POLICY "select_commission_plan_tiers" ON commission_plan_tiers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS "select_commission_job_overrides" ON commission_job_overrides;
CREATE POLICY "select_commission_job_overrides" ON commission_job_overrides FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS "select_commission_statements" ON commission_statements;
CREATE POLICY "select_commission_statements" ON commission_statements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

-- Tighten the legacy owner-managed policy: any team member could read every
-- commission. Now it requires the billing permission like everything above.
DROP POLICY IF EXISTS "manage_own_commission_records" ON commission_records;
CREATE POLICY "manage_own_commission_records" ON commission_records FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

-- =============================================================
-- RPC: save_commission_plan (create/update + replace tiers atomically)
-- p_tiers: [{"min_cents": 0, "rate_percent": 5}, ...]
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_commission_plan(
  p_plan_id uuid,
  p_name text,
  p_description text,
  p_tier_mode text,
  p_tier_period text,
  p_is_default boolean,
  p_active boolean,
  p_tiers jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_id uuid := p_plan_id;
  v_count integer;
  v_first bigint;
  v_prev bigint := -1;
  t jsonb;
  v_min bigint;
  v_rate numeric;
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) = 0 THEN RAISE EXCEPTION 'Plan name is required'; END IF;
  IF p_tier_mode NOT IN ('marginal', 'tier_reached') THEN RAISE EXCEPTION 'Invalid tier mode'; END IF;
  IF p_tier_period NOT IN ('monthly', 'quarterly', 'yearly') THEN RAISE EXCEPTION 'Invalid tier period'; END IF;
  IF p_is_default AND NOT p_active THEN RAISE EXCEPTION 'The default plan must be active'; END IF;
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' THEN RAISE EXCEPTION 'Tiers must be an array'; END IF;

  v_count := jsonb_array_length(p_tiers);
  IF v_count < 1 OR v_count > 12 THEN RAISE EXCEPTION 'A plan needs between 1 and 12 tiers'; END IF;

  -- Validate in ascending threshold order.
  FOR t IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'min_cents')::bigint LOOP
    v_min := (t ->> 'min_cents')::bigint;
    v_rate := (t ->> 'rate_percent')::numeric;
    IF v_min IS NULL OR v_min < 0 THEN RAISE EXCEPTION 'Tier thresholds must be 0 or more'; END IF;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 100 OR v_rate <> round(v_rate, 2) THEN
      RAISE EXCEPTION 'Tier rates must be 0-100 with at most 2 decimals';
    END IF;
    IF v_first IS NULL THEN v_first := v_min; END IF;
    IF v_min <= v_prev THEN RAISE EXCEPTION 'Tier thresholds must be strictly increasing'; END IF;
    v_prev := v_min;
  END LOOP;
  IF v_first <> 0 THEN RAISE EXCEPTION 'The first tier must start at 0'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission:' || v_owner::text));

  IF p_is_default THEN
    UPDATE commission_plans SET is_default = false WHERE user_id = v_owner AND is_default AND id IS DISTINCT FROM v_id;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO commission_plans (user_id, name, description, tier_mode, tier_period, is_default, active, created_by)
    VALUES (v_owner, btrim(p_name), NULLIF(btrim(p_description), ''), p_tier_mode, p_tier_period, p_is_default, p_active, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE commission_plans
    SET name = btrim(p_name), description = NULLIF(btrim(p_description), ''), tier_mode = p_tier_mode,
        tier_period = p_tier_period, is_default = p_is_default, active = p_active
    WHERE id = v_id AND user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Commission plan not found'; END IF;
    DELETE FROM commission_plan_tiers WHERE plan_id = v_id;
  END IF;

  INSERT INTO commission_plan_tiers (user_id, plan_id, min_cents, rate_percent)
  SELECT v_owner, v_id, (value ->> 'min_cents')::bigint, (value ->> 'rate_percent')::numeric
  FROM jsonb_array_elements(p_tiers);

  PERFORM public.log_audit_event(v_owner, 'commission_plan_saved', 'commission_plans', v_id::text);
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A commission plan with that name already exists';
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_commission_plan(uuid, text, text, text, text, boolean, boolean, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_employee_commission_plan(p_employee_id uuid, p_plan_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._require_commission_access();
BEGIN
  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM commission_plans WHERE id = p_plan_id AND user_id = v_owner AND active
  ) THEN
    RAISE EXCEPTION 'Commission plan not found or inactive';
  END IF;
  UPDATE employees SET commission_plan_id = p_plan_id WHERE id = p_employee_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  PERFORM public.log_audit_event(v_owner, 'commission_plan_assigned', 'employees', p_employee_id::text);
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_employee_commission_plan(uuid, uuid) TO authenticated;

-- =============================================================
-- INTERNAL: generate the earned record for one job
-- Returns: created | exists | not_eligible | no_employee | no_rule | excluded
-- =============================================================

CREATE OR REPLACE FUNCTION public._commission_generate_for_job(p_owner uuid, p_job_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs%ROWTYPE;
  emp employees%ROWTYPE;
  ov commission_job_overrides%ROWTYPE;
  pl commission_plans%ROWTYPE;
  t RECORD;
  v_inv_count integer;
  v_inv_id uuid;
  v_basis bigint;
  v_date date;
  v_cum bigint;
  v_after bigint;
  v_overlap bigint;
  v_numer numeric := 0;
  v_commission bigint;
  v_rate numeric;
  v_source text;
  v_plan_id uuid;
  v_detail jsonb;
  v_segments jsonb := '[]'::jsonb;
  v_p_start date;
  v_p_end date;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = p_owner;
  IF NOT FOUND OR j.job_status <> 'completed' OR j.assigned_technician_id IS NULL THEN RETURN 'not_eligible'; END IF;

  SELECT * INTO emp FROM employees
  WHERE user_id = p_owner AND team_member_id = j.assigned_technician_id AND active
  LIMIT 1;
  IF NOT FOUND THEN RETURN 'no_employee'; END IF;

  IF EXISTS (SELECT 1 FROM commission_records WHERE employee_id = emp.id AND job_id = j.id AND kind = 'earned') THEN
    RETURN 'exists';
  END IF;

  -- Basis: collected, pre-tax money.
  SELECT count(*), COALESCE(sum(subtotal_cents), 0), (array_agg(id ORDER BY created_at))[1]
    INTO v_inv_count, v_basis, v_inv_id
  FROM ar_invoices WHERE user_id = p_owner AND job_id = j.id AND status = 'paid';

  IF v_inv_count = 0 THEN
    IF j.invoice_status = 'paid' AND j.invoice_amount IS NOT NULL AND j.invoice_amount > 0 THEN
      v_basis := round(j.invoice_amount * 100);
    ELSE
      RETURN 'not_eligible';
    END IF;
  END IF;
  IF v_basis <= 0 THEN RETURN 'not_eligible'; END IF;

  v_date := COALESCE(j.completed_at::date, j.created_at::date);

  SELECT * INTO ov FROM commission_job_overrides
  WHERE user_id = p_owner AND job_id = j.id AND (employee_id = emp.id OR employee_id IS NULL)
  ORDER BY (employee_id IS NULL)
  LIMIT 1;

  IF FOUND THEN
    IF ov.override_type = 'excluded' THEN RETURN 'excluded'; END IF;
    IF ov.override_type = 'rate_percent' THEN
      v_rate := ov.rate_percent;
      v_commission := round(v_basis * v_rate / 100.0);
      v_source := 'override_rate';
    ELSE
      v_commission := ov.flat_cents;
      v_rate := least(999.99, round(v_commission * 100.0 / v_basis, 2));
      v_source := 'override_flat';
    END IF;
    v_detail := jsonb_build_object('override_id', ov.id, 'type', ov.override_type, 'reason', ov.reason);
  ELSE
    IF emp.commission_plan_id IS NOT NULL THEN
      SELECT * INTO pl FROM commission_plans WHERE id = emp.commission_plan_id AND user_id = p_owner AND active;
    END IF;
    IF pl.id IS NULL THEN
      SELECT * INTO pl FROM commission_plans WHERE user_id = p_owner AND is_default AND active LIMIT 1;
    END IF;

    IF pl.id IS NOT NULL AND EXISTS (SELECT 1 FROM commission_plan_tiers WHERE plan_id = pl.id) THEN
      v_p_start := public._commission_cycle_start(v_date, pl.tier_period);
      v_p_end := (v_p_start + CASE pl.tier_period WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END)::date;

      SELECT COALESCE(sum(basis_amount_cents), 0) INTO v_cum
      FROM commission_records
      WHERE employee_id = emp.id AND kind = 'earned' AND earned_date >= v_p_start AND earned_date < v_p_end;
      v_after := v_cum + v_basis;

      IF pl.tier_mode = 'tier_reached' THEN
        SELECT min_cents, rate_percent INTO t FROM commission_plan_tiers
        WHERE plan_id = pl.id AND min_cents <= v_after ORDER BY min_cents DESC LIMIT 1;
        v_commission := round(v_basis * t.rate_percent / 100.0);
        v_rate := t.rate_percent;
        v_segments := jsonb_build_array(jsonb_build_object(
          'min_cents', t.min_cents, 'rate_percent', t.rate_percent, 'amount_cents', v_basis, 'commission_cents', v_commission));
      ELSE
        FOR t IN
          SELECT min_cents, rate_percent, lead(min_cents) OVER (ORDER BY min_cents) AS next_min
          FROM commission_plan_tiers WHERE plan_id = pl.id ORDER BY min_cents
        LOOP
          v_overlap := greatest(0, least(v_after, COALESCE(t.next_min, 9223372036854775807)) - greatest(v_cum, t.min_cents));
          IF v_overlap > 0 THEN
            v_numer := v_numer + v_overlap * t.rate_percent;
            v_segments := v_segments || jsonb_build_object(
              'min_cents', t.min_cents, 'rate_percent', t.rate_percent, 'amount_cents', v_overlap,
              'commission_cents', round(v_overlap * t.rate_percent / 100.0));
          END IF;
        END LOOP;
        v_commission := round(v_numer / 100.0);
        v_rate := least(999.99, round(v_commission * 100.0 / v_basis, 2));
      END IF;

      v_source := 'plan';
      v_plan_id := pl.id;
      v_detail := jsonb_build_object(
        'mode', pl.tier_mode, 'period', pl.tier_period, 'period_start', v_p_start,
        'cumulative_before_cents', v_cum, 'segments', v_segments);
    ELSIF COALESCE(emp.commission_rate_percent, 0) > 0 THEN
      v_rate := emp.commission_rate_percent;
      v_commission := round(v_basis * v_rate / 100.0);
      v_source := 'employee_rate';
      v_detail := jsonb_build_object('flat_rate_percent', v_rate);
    ELSE
      RETURN 'no_rule';
    END IF;
  END IF;

  BEGIN
    INSERT INTO commission_records (
      user_id, employee_id, job_id, ar_invoice_id, basis_amount_cents, commission_rate_percent, commission_cents,
      status, kind, calc_source, plan_id, earned_date, calc_detail
    ) VALUES (
      p_owner, emp.id, j.id, CASE WHEN v_inv_count = 1 THEN v_inv_id END, v_basis, v_rate, v_commission,
      'pending', 'earned', v_source, v_plan_id, v_date, v_detail
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN 'exists';
  END;

  RETURN 'created';
END;
$$;

REVOKE ALL ON FUNCTION public._commission_generate_for_job(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPC: generate_commission_records — scan completed+paid jobs in a range
-- Returns counts keyed by outcome, e.g. {"created": 12, "no_rule": 2}
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_commission_records(p_period_start date, p_period_end date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  j RECORD;
  v_res text;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Choose a valid date range';
  END IF;
  IF p_period_end - p_period_start > 366 THEN RAISE EXCEPTION 'Date range cannot exceed one year'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission:' || v_owner::text));

  FOR j IN
    SELECT id FROM jobs
    WHERE user_id = v_owner AND job_status = 'completed' AND assigned_technician_id IS NOT NULL
      AND COALESCE(completed_at::date, created_at::date) BETWEEN p_period_start AND p_period_end
    ORDER BY COALESCE(completed_at, created_at), id
  LOOP
    v_res := public._commission_generate_for_job(v_owner, j.id);
    v_counts := jsonb_set(v_counts, ARRAY[v_res], to_jsonb(COALESCE((v_counts ->> v_res)::integer, 0) + 1));
  END LOOP;

  PERFORM public.log_audit_event(v_owner, 'commission_records_generated', 'commission_records', NULL);
  RETURN v_counts;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_commission_records(date, date) TO authenticated;

-- =============================================================
-- RPC: per-job overrides (re-calculates a not-yet-statemented record)
-- =============================================================

CREATE OR REPLACE FUNCTION public._commission_release_job(p_owner uuid, p_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commission_records
    WHERE user_id = p_owner AND job_id = p_job_id AND kind = 'earned' AND calc_source <> 'manual'
      AND (statement_id IS NOT NULL OR status <> 'pending')
  ) THEN
    RAISE EXCEPTION 'This job is already on a statement. Void the statement or add an adjustment instead.';
  END IF;
  DELETE FROM commission_records
  WHERE user_id = p_owner AND job_id = p_job_id AND kind = 'earned' AND calc_source <> 'manual'
    AND statement_id IS NULL AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public._commission_release_job(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_commission_job_override(
  p_job_id uuid,
  p_employee_id uuid,
  p_type text,
  p_rate_percent numeric,
  p_flat_cents integer,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_id uuid;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_type NOT IN ('rate_percent', 'flat_cents', 'excluded') THEN RAISE EXCEPTION 'Invalid override type'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Job not found'; END IF;
  IF p_employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission:' || v_owner::text));
  PERFORM public._commission_release_job(v_owner, p_job_id);

  DELETE FROM commission_job_overrides
  WHERE user_id = v_owner AND job_id = p_job_id AND employee_id IS NOT DISTINCT FROM p_employee_id;

  INSERT INTO commission_job_overrides (user_id, job_id, employee_id, override_type, rate_percent, flat_cents, reason, created_by)
  VALUES (
    v_owner, p_job_id, p_employee_id, p_type,
    CASE WHEN p_type = 'rate_percent' THEN p_rate_percent END,
    CASE WHEN p_type = 'flat_cents' THEN p_flat_cents END,
    btrim(p_reason), auth.uid()
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'commission_override_set', 'commission_job_overrides', v_id::text);
  RETURN public._commission_generate_for_job(v_owner, p_job_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_commission_job_override(uuid, uuid, text, numeric, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_commission_job_override(p_override_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_job uuid;
BEGIN
  SELECT job_id INTO v_job FROM commission_job_overrides WHERE id = p_override_id AND user_id = v_owner;
  IF v_job IS NULL THEN RAISE EXCEPTION 'Override not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission:' || v_owner::text));
  PERFORM public._commission_release_job(v_owner, v_job);
  DELETE FROM commission_job_overrides WHERE id = p_override_id;

  PERFORM public.log_audit_event(v_owner, 'commission_override_removed', 'commission_job_overrides', p_override_id::text);
  RETURN public._commission_generate_for_job(v_owner, v_job);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_commission_job_override(uuid) TO authenticated;

-- =============================================================
-- RPC: manual adjustment / clawback (always lands as a pending record)
-- =============================================================

CREATE OR REPLACE FUNCTION public.add_commission_adjustment(
  p_employee_id uuid,
  p_kind text,
  p_amount_cents integer,
  p_job_id uuid,
  p_memo text,
  p_earned_date date
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_id uuid;
  v_cents integer;
BEGIN
  IF p_kind NOT IN ('adjustment', 'clawback') THEN RAISE EXCEPTION 'Invalid adjustment kind'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents = 0 THEN RAISE EXCEPTION 'Amount must not be zero'; END IF;
  IF p_memo IS NULL OR char_length(btrim(p_memo)) < 3 THEN RAISE EXCEPTION 'A memo is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Employee not found'; END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Job not found'; END IF;

  v_cents := CASE WHEN p_kind = 'clawback' THEN -abs(p_amount_cents) ELSE p_amount_cents END;

  INSERT INTO commission_records (
    user_id, employee_id, job_id, basis_amount_cents, commission_rate_percent, commission_cents,
    status, kind, calc_source, earned_date, memo
  ) VALUES (
    v_owner, p_employee_id, p_job_id, 0, 0, v_cents,
    'pending', p_kind, 'manual', COALESCE(p_earned_date, current_date), btrim(p_memo)
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'commission_adjustment_added', 'commission_records', v_id::text);
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_commission_adjustment(uuid, text, integer, uuid, text, date) TO authenticated;

-- =============================================================
-- STATEMENTS
-- =============================================================

CREATE OR REPLACE FUNCTION public._commission_refresh_statement(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE commission_statements s SET
    record_count = x.cnt, earned_cents = x.earned, adjustment_cents = x.adj, net_cents = x.earned + x.adj, updated_at = now()
  FROM (
    SELECT count(*)::integer AS cnt,
           COALESCE(sum(commission_cents) FILTER (WHERE kind = 'earned'), 0) AS earned,
           COALESCE(sum(commission_cents) FILTER (WHERE kind <> 'earned'), 0) AS adj
    FROM commission_records WHERE statement_id = p_id
  ) x
  WHERE s.id = p_id;
$$;

REVOKE ALL ON FUNCTION public._commission_refresh_statement(uuid) FROM PUBLIC, anon, authenticated;

-- Groups every pending, un-statemented record in the range into one draft
-- statement per employee. Negative nets are skipped and carry forward.
CREATE OR REPLACE FUNCTION public.build_commission_statements(p_period_start date, p_period_end date, p_employee_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  r RECORD;
  v_id uuid;
  v_created integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Choose a valid date range';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission:' || v_owner::text));

  FOR r IN
    SELECT employee_id, sum(commission_cents) AS total
    FROM commission_records
    WHERE user_id = v_owner AND status = 'pending' AND statement_id IS NULL
      AND earned_date BETWEEN p_period_start AND p_period_end
      AND (p_employee_id IS NULL OR employee_id = p_employee_id)
    GROUP BY employee_id
  LOOP
    IF r.total < 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    INSERT INTO commission_statements (user_id, employee_id, period_start, period_end, prepared_by)
    VALUES (v_owner, r.employee_id, p_period_start, p_period_end, auth.uid())
    RETURNING id INTO v_id;

    UPDATE commission_records SET statement_id = v_id
    WHERE user_id = v_owner AND employee_id = r.employee_id AND status = 'pending' AND statement_id IS NULL
      AND earned_date BETWEEN p_period_start AND p_period_end;

    PERFORM public._commission_refresh_statement(v_id);
    PERFORM public.log_audit_event(v_owner, 'commission_statement_created', 'commission_statements', v_id::text);
    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'skipped_negative', v_skipped);
END;
$$;

GRANT EXECUTE ON FUNCTION public.build_commission_statements(date, date, uuid) TO authenticated;

-- Lifecycle: submit | approve | return | void
CREATE OR REPLACE FUNCTION public.transition_commission_statement(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_uid uuid := auth.uid();
  s commission_statements%ROWTYPE;
  v_is_owner boolean;
BEGIN
  SELECT * INTO s FROM commission_statements WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;

  IF p_action = 'submit' THEN
    IF s.status <> 'draft' THEN RAISE EXCEPTION 'Only draft statements can be submitted'; END IF;
    PERFORM public._commission_refresh_statement(p_id);
    SELECT * INTO s FROM commission_statements WHERE id = p_id;
    IF s.record_count = 0 THEN RAISE EXCEPTION 'Statement has no commission lines'; END IF;
    IF s.net_cents < 0 THEN RAISE EXCEPTION 'Net commission is negative and cannot be submitted'; END IF;
    UPDATE commission_statements SET status = 'pending_approval', submitted_by = v_uid, submitted_at = now(), review_note = NULL WHERE id = p_id;

  ELSIF p_action = 'approve' THEN
    IF s.status <> 'pending_approval' THEN RAISE EXCEPTION 'Only submitted statements can be approved'; END IF;
    SELECT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid AND role = 'owner') INTO v_is_owner;
    IF s.submitted_by IS NOT DISTINCT FROM v_uid AND NOT v_is_owner THEN
      RAISE EXCEPTION 'A different person must approve a statement you submitted';
    END IF;
    UPDATE commission_records SET status = 'approved' WHERE statement_id = p_id AND status = 'pending';
    UPDATE commission_statements SET status = 'approved', approved_by = v_uid, approved_at = now() WHERE id = p_id;

  ELSIF p_action = 'return' THEN
    IF s.status <> 'pending_approval' THEN RAISE EXCEPTION 'Only submitted statements can be returned'; END IF;
    IF p_note IS NULL OR char_length(btrim(p_note)) < 3 THEN RAISE EXCEPTION 'A note explaining the return is required'; END IF;
    UPDATE commission_statements SET status = 'draft', review_note = btrim(p_note), submitted_by = NULL, submitted_at = NULL WHERE id = p_id;

  ELSIF p_action = 'void' THEN
    IF s.status NOT IN ('draft', 'pending_approval', 'approved') THEN RAISE EXCEPTION 'This statement can no longer be voided'; END IF;
    IF p_note IS NULL OR char_length(btrim(p_note)) < 3 THEN RAISE EXCEPTION 'A reason is required to void a statement'; END IF;
    IF EXISTS (SELECT 1 FROM commission_records WHERE statement_id = p_id AND pay_run_item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'This statement is already in a pay run. Void the pay run first.';
    END IF;
    UPDATE commission_records SET statement_id = NULL, status = 'pending' WHERE statement_id = p_id;
    UPDATE commission_statements SET status = 'void', void_reason = btrim(p_note) WHERE id = p_id;

  ELSE
    RAISE EXCEPTION 'Unknown statement action';
  END IF;

  PERFORM public.log_audit_event(v_owner, 'commission_statement_' || p_action, 'commission_statements', p_id::text);
END;
$$;

GRANT EXECUTE ON FUNCTION public.transition_commission_statement(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_commission_statements_exported(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_n integer;
BEGIN
  UPDATE commission_statements SET exported_at = now()
  WHERE user_id = v_owner AND id = ANY(p_ids) AND status IN ('approved', 'paid');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN PERFORM public.log_audit_event(v_owner, 'commission_statements_exported', 'commission_statements', array_to_string(p_ids, ',')); END IF;
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_commission_statements_exported(uuid[]) TO authenticated;

-- For statements paid OUTSIDE Vireek by an external payroll provider.
CREATE OR REPLACE FUNCTION public.mark_commission_statements_paid(p_ids uuid[], p_reference text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._require_commission_access();
  v_n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM commission_records r JOIN commission_statements s ON s.id = r.statement_id
    WHERE s.user_id = v_owner AND s.id = ANY(p_ids) AND r.pay_run_item_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A selected statement is in a Vireek pay run; it is marked paid when that pay run is paid.';
  END IF;

  UPDATE commission_records SET status = 'paid'
  WHERE statement_id IN (SELECT id FROM commission_statements WHERE user_id = v_owner AND id = ANY(p_ids) AND status = 'approved')
    AND status = 'approved';

  UPDATE commission_statements
  SET status = 'paid', paid_at = now(), payment_reference = NULLIF(btrim(p_reference), '')
  WHERE user_id = v_owner AND id = ANY(p_ids) AND status = 'approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN PERFORM public.log_audit_event(v_owner, 'commission_statements_paid', 'commission_statements', array_to_string(p_ids, ',')); END IF;
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_commission_statements_paid(uuid[], text) TO authenticated;

-- =============================================================
-- REPORT: per-employee overview for a date range
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_commission_overview(p_start date, p_end date)
RETURNS TABLE (
  employee_id uuid, full_name text, jobs_count bigint,
  earned_cents bigint, adjustment_cents bigint, pending_cents bigint, approved_cents bigint, paid_cents bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._require_commission_access();
BEGIN
  RETURN QUERY
  SELECT e.id, e.full_name,
    count(*) FILTER (WHERE r.kind = 'earned'),
    COALESCE(sum(r.commission_cents) FILTER (WHERE r.kind = 'earned'), 0)::bigint,
    COALESCE(sum(r.commission_cents) FILTER (WHERE r.kind <> 'earned'), 0)::bigint,
    COALESCE(sum(r.commission_cents) FILTER (WHERE r.status = 'pending'), 0)::bigint,
    COALESCE(sum(r.commission_cents) FILTER (WHERE r.status = 'approved'), 0)::bigint,
    COALESCE(sum(r.commission_cents) FILTER (WHERE r.status = 'paid'), 0)::bigint
  FROM employees e
  JOIN commission_records r ON r.employee_id = e.id AND r.user_id = v_owner AND r.earned_date BETWEEN p_start AND p_end
  WHERE e.user_id = v_owner
  GROUP BY e.id, e.full_name
  ORDER BY 4 DESC, e.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_commission_overview(date, date) TO authenticated;
