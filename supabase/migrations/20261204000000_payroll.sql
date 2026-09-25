/*
  # Payroll — Employees, Timesheets, Overtime, Commission, Pay Runs

  ## Why
  Vireek tracks technicians as team_members but has no compensation
  layer: no hourly/salary/commission setup, no timesheets, no payroll
  runs, and no link from "a job got done" to "someone got paid for
  it". This migration adds that layer and posts every approved pay
  run straight into the general ledger from
  20261203000001_accounting_general_ledger.sql (Dr Payroll Expense +
  Commission Expense / Cr Payroll Tax Payable + Cash), so payroll and
  the books never drift apart.

  ## Scope and an honest limitation
  Tax withholding here is a single flat percentage per employee
  (default_tax_withholding_percent) used to estimate a withholding
  amount and post it to a Payroll Tax Payable liability account. This
  is NOT a real payroll-tax engine (no federal/state tax tables, no
  FICA/FUTA/SUTA employer-side calculation, no e-filing or deposit
  scheduling). Treat the numbers here as an internal estimate for the
  books, not a substitute for a licensed payroll provider — remitting
  actual withheld taxes still has to happen outside this system.

  ## What this adds
  1. `employees` — pay type (hourly/salary/commission_only/
     salary_plus_commission), rates, overtime multiplier, pay schedule.
     Optionally linked to an existing team_members row.
  2. `timesheets` — daily hours per employee, optionally tied to a job,
     with an approval flag.
  3. `commission_records` — per-job/invoice commission, rate x basis
     computed automatically by a trigger.
  4. `pay_runs` / `pay_run_items` — a payroll run pulls in every
     approved-and-unassigned timesheet + commission record in the
     period, computes gross/withholding/net per employee, and posts
     one balanced journal entry for the whole run on approval.

  RLS: employees/timesheets/commission_records are owner-managed
  master/operational data (FOR ALL, like vendors/customers elsewhere
  in this codebase). pay_runs/pay_run_items are SELECT-only — every
  write goes through the RPCs below, same audit-safe pattern as
  20261121000000_ai_agent_governance.sql and the AR/AP tables.
*/

-- =============================================================
-- EMPLOYEES
-- =============================================================

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  employment_type text NOT NULL DEFAULT 'w2' CHECK (employment_type IN ('w2', '1099')),
  pay_type text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'salary', 'commission_only', 'salary_plus_commission')),
  hourly_rate_cents integer CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
  annual_salary_cents integer CHECK (annual_salary_cents IS NULL OR annual_salary_cents >= 0),
  commission_rate_percent numeric(5,2) DEFAULT 0 CHECK (commission_rate_percent >= 0),
  overtime_multiplier numeric(3,2) NOT NULL DEFAULT 1.50 CHECK (overtime_multiplier >= 1),
  standard_hours_per_week numeric NOT NULL DEFAULT 40,
  pay_schedule text NOT NULL DEFAULT 'biweekly' CHECK (pay_schedule IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  default_tax_withholding_percent numeric(5,2) NOT NULL DEFAULT 20 CHECK (default_tax_withholding_percent BETWEEN 0 AND 60),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_team_member
  ON employees(user_id, team_member_id) WHERE team_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_user_active ON employees(user_id, active);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_employees" ON employees;
CREATE POLICY "manage_own_employees" ON employees FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_employees_updated_at ON employees;
CREATE TRIGGER trigger_employees_updated_at
  BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- TIMESHEETS
-- =============================================================

CREATE TABLE IF NOT EXISTS timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  regular_hours numeric NOT NULL DEFAULT 0 CHECK (regular_hours >= 0),
  overtime_hours numeric NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by uuid,
  approved_at timestamptz,
  pay_run_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timesheets_employee_date ON timesheets(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_timesheets_user_status ON timesheets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_timesheets_unassigned ON timesheets(employee_id, status) WHERE pay_run_item_id IS NULL;

ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_timesheets" ON timesheets;
CREATE POLICY "manage_own_timesheets" ON timesheets FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- COMMISSION_RECORDS — commission_cents auto-computed by trigger
-- =============================================================

CREATE TABLE IF NOT EXISTS commission_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  ar_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  basis_amount_cents integer NOT NULL CHECK (basis_amount_cents >= 0),
  commission_rate_percent numeric(5,2) NOT NULL CHECK (commission_rate_percent >= 0),
  commission_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'paid')),
  pay_run_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_records_employee ON commission_records(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_commission_records_unassigned ON commission_records(employee_id, status) WHERE pay_run_item_id IS NULL;

ALTER TABLE commission_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_commission_records" ON commission_records;
CREATE POLICY "manage_own_commission_records" ON commission_records FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public._commission_calc()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.commission_cents := round(NEW.basis_amount_cents * NEW.commission_rate_percent / 100.0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_calc ON commission_records;
CREATE TRIGGER trg_commission_calc
  BEFORE INSERT OR UPDATE ON commission_records FOR EACH ROW EXECUTE FUNCTION public._commission_calc();

-- =============================================================
-- PAY_RUNS / PAY_RUN_ITEMS
-- =============================================================

CREATE TABLE IF NOT EXISTS pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  pay_period_start date NOT NULL,
  pay_period_end date NOT NULL,
  pay_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  total_gross_cents integer NOT NULL DEFAULT 0,
  total_tax_cents integer NOT NULL DEFAULT 0,
  total_net_cents integer NOT NULL DEFAULT 0,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pay_runs_user_date ON pay_runs(user_id, pay_date DESC);

ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pay_runs" ON pay_runs;
CREATE POLICY "select_own_pay_runs" ON pay_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS pay_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_run_id uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  regular_hours numeric NOT NULL DEFAULT 0,
  overtime_hours numeric NOT NULL DEFAULT 0,
  regular_pay_cents integer NOT NULL DEFAULT 0,
  overtime_pay_cents integer NOT NULL DEFAULT 0,
  salary_pay_cents integer NOT NULL DEFAULT 0,
  commission_cents integer NOT NULL DEFAULT 0,
  bonus_cents integer NOT NULL DEFAULT 0,
  gross_pay_cents integer GENERATED ALWAYS AS (regular_pay_cents + overtime_pay_cents + salary_pay_cents + commission_cents + bonus_cents) STORED,
  tax_withholding_cents integer NOT NULL DEFAULT 0,
  other_deductions_cents integer NOT NULL DEFAULT 0,
  net_pay_cents integer NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'direct_deposit' CHECK (payment_method IN ('direct_deposit', 'check', 'cash')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pay_run_items_run ON pay_run_items(pay_run_id);
CREATE INDEX IF NOT EXISTS idx_pay_run_items_employee ON pay_run_items(employee_id);

ALTER TABLE pay_run_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pay_run_items" ON pay_run_items;
CREATE POLICY "select_own_pay_run_items" ON pay_run_items FOR SELECT TO authenticated
  USING (pay_run_id IN (SELECT id FROM pay_runs WHERE user_id = public.get_account_owner_id()));

-- Now that pay_run_items exists, link timesheets/commission_records to it.
ALTER TABLE timesheets ADD CONSTRAINT fk_timesheets_pay_run_item
  FOREIGN KEY (pay_run_item_id) REFERENCES pay_run_items(id) ON DELETE SET NULL;
ALTER TABLE commission_records ADD CONSTRAINT fk_commission_records_pay_run_item
  FOREIGN KEY (pay_run_item_id) REFERENCES pay_run_items(id) ON DELETE SET NULL;

-- =============================================================
-- RPC: ensure_payroll_chart_of_accounts — extends the chart from
-- 20261203000001_accounting_general_ledger.sql with payroll-specific
-- accounts (idempotent, additive).
-- =============================================================

CREATE OR REPLACE FUNCTION public.ensure_payroll_chart_of_accounts()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public.ensure_default_chart_of_accounts();

  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system) VALUES
    (v_user_id, '2300', 'Payroll Tax Payable', 'liability', 'credit', true),
    (v_user_id, '6050', 'Commission Expense', 'expense', 'debit', true)
  ON CONFLICT (user_id, code) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_payroll_chart_of_accounts() TO authenticated;

-- =============================================================
-- RPC: create_pay_run — pulls in every approved, unassigned
-- timesheet + commission record in the period and computes pay
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_pay_run(p_period_start date, p_period_end date, p_pay_date date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_run_id uuid;
  emp RECORD;
  v_reg_hours numeric;
  v_ot_hours numeric;
  v_commission_cents integer;
  v_reg_pay integer;
  v_ot_pay integer;
  v_salary_pay integer;
  v_periods_per_year integer;
  v_gross integer;
  v_tax integer;
  v_item_id uuid;
  v_total_gross integer := 0;
  v_total_tax integer := 0;
  v_total_net integer := 0;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public.ensure_payroll_chart_of_accounts();

  INSERT INTO pay_runs (user_id, pay_period_start, pay_period_end, pay_date)
  VALUES (v_user_id, p_period_start, p_period_end, p_pay_date)
  RETURNING id INTO v_run_id;

  FOR emp IN SELECT * FROM employees WHERE user_id = v_user_id AND active LOOP
    SELECT coalesce(sum(regular_hours), 0), coalesce(sum(overtime_hours), 0)
      INTO v_reg_hours, v_ot_hours
      FROM timesheets
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND work_date BETWEEN p_period_start AND p_period_end;

    SELECT coalesce(sum(commission_cents), 0) INTO v_commission_cents
      FROM commission_records
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND created_at::date <= p_period_end;

    v_reg_pay := 0; v_ot_pay := 0; v_salary_pay := 0;

    IF emp.pay_type IN ('hourly') THEN
      v_reg_pay := round(coalesce(emp.hourly_rate_cents, 0) * v_reg_hours);
      v_ot_pay := round(coalesce(emp.hourly_rate_cents, 0) * emp.overtime_multiplier * v_ot_hours);
    END IF;

    IF emp.pay_type IN ('salary', 'salary_plus_commission') THEN
      v_periods_per_year := CASE emp.pay_schedule
        WHEN 'weekly' THEN 52 WHEN 'biweekly' THEN 26 WHEN 'semimonthly' THEN 24 ELSE 12 END;
      v_salary_pay := round(coalesce(emp.annual_salary_cents, 0)::numeric / v_periods_per_year);
    END IF;

    IF emp.pay_type = 'commission_only' AND v_commission_cents = 0 AND v_reg_hours = 0 AND v_ot_hours = 0 THEN
      CONTINUE; -- nothing earned this period, skip the row entirely
    END IF;
    IF emp.pay_type != 'commission_only' AND v_reg_pay = 0 AND v_ot_pay = 0 AND v_salary_pay = 0 AND v_commission_cents = 0 THEN
      CONTINUE;
    END IF;

    v_gross := v_reg_pay + v_ot_pay + v_salary_pay + v_commission_cents;
    v_tax := round(v_gross * emp.default_tax_withholding_percent / 100.0);

    INSERT INTO pay_run_items (
      pay_run_id, employee_id, regular_hours, overtime_hours, regular_pay_cents, overtime_pay_cents,
      salary_pay_cents, commission_cents, tax_withholding_cents, net_pay_cents
    ) VALUES (
      v_run_id, emp.id, v_reg_hours, v_ot_hours, v_reg_pay, v_ot_pay, v_salary_pay, v_commission_cents, v_tax, v_gross - v_tax
    ) RETURNING id INTO v_item_id;

    UPDATE timesheets SET pay_run_item_id = v_item_id
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND work_date BETWEEN p_period_start AND p_period_end;

    UPDATE commission_records SET pay_run_item_id = v_item_id
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND created_at::date <= p_period_end;

    v_total_gross := v_total_gross + v_gross;
    v_total_tax := v_total_tax + v_tax;
    v_total_net := v_total_net + (v_gross - v_tax);
  END LOOP;

  UPDATE pay_runs SET total_gross_cents = v_total_gross, total_tax_cents = v_total_tax, total_net_cents = v_total_net, updated_at = now()
  WHERE id = v_run_id;

  RETURN v_run_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pay_run(date, date, date) TO authenticated;

-- =============================================================
-- RPC: approve_and_post_pay_run — posts one balanced JE for the run
-- Dr Payroll Expense + Commission Expense / Cr Payroll Tax Payable + Cash
-- =============================================================

CREATE OR REPLACE FUNCTION public.approve_and_post_pay_run(p_pay_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_run pay_runs%ROWTYPE;
  v_wages_cents integer;
  v_commission_cents integer;
  v_je_id uuid;
  v_payroll_expense uuid;
  v_commission_expense uuid;
  v_tax_payable uuid;
  v_cash uuid;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT * INTO v_run FROM pay_runs WHERE id = p_pay_run_id AND user_id = v_user_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'Pay run not found'; END IF;
  IF v_run.status != 'draft' THEN RAISE EXCEPTION 'Pay run is not in draft status'; END IF;

  SELECT coalesce(sum(regular_pay_cents + overtime_pay_cents + salary_pay_cents + bonus_cents), 0),
         coalesce(sum(commission_cents), 0)
    INTO v_wages_cents, v_commission_cents
    FROM pay_run_items WHERE pay_run_id = p_pay_run_id;

  SELECT id INTO v_payroll_expense FROM chart_of_accounts WHERE user_id = v_user_id AND code = '6000';
  SELECT id INTO v_commission_expense FROM chart_of_accounts WHERE user_id = v_user_id AND code = '6050';
  SELECT id INTO v_tax_payable FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2300';
  SELECT id INTO v_cash FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1000';

  v_je_id := public.post_journal_entry(
    v_run.pay_date, 'Pay run ' || to_char(v_run.pay_period_start, 'YYYY-MM-DD') || ' to ' || to_char(v_run.pay_period_end, 'YYYY-MM-DD'),
    'manual', p_pay_run_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_payroll_expense, 'debit_cents', v_wages_cents, 'credit_cents', 0, 'description', 'Wages and salaries'),
      jsonb_build_object('account_id', v_commission_expense, 'debit_cents', v_commission_cents, 'credit_cents', 0, 'description', 'Commission'),
      jsonb_build_object('account_id', v_tax_payable, 'debit_cents', 0, 'credit_cents', v_run.total_tax_cents, 'description', 'Withheld payroll tax'),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_run.total_net_cents, 'description', 'Net pay disbursed')
    )
  );

  UPDATE pay_runs SET status = 'approved', journal_entry_id = v_je_id, updated_at = now() WHERE id = p_pay_run_id;

  RETURN v_je_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_and_post_pay_run(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_pay_run_paid(p_pay_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  UPDATE pay_runs SET status = 'paid', updated_at = now() WHERE id = p_pay_run_id AND user_id = v_user_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Pay run must be approved before it can be marked paid'; END IF;
  UPDATE pay_run_items SET paid_at = now() WHERE pay_run_id = p_pay_run_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_pay_run_paid(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_pay_run(p_pay_run_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_je_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT journal_entry_id INTO v_je_id FROM pay_runs WHERE id = p_pay_run_id AND user_id = v_user_id AND status IN ('approved', 'paid');
  IF v_je_id IS NOT NULL THEN
    PERFORM public.void_journal_entry(v_je_id, coalesce(p_reason, 'Pay run voided'));
  END IF;

  UPDATE timesheets SET pay_run_item_id = NULL
    WHERE pay_run_item_id IN (SELECT id FROM pay_run_items WHERE pay_run_id = p_pay_run_id);
  UPDATE commission_records SET pay_run_item_id = NULL
    WHERE pay_run_item_id IN (SELECT id FROM pay_run_items WHERE pay_run_id = p_pay_run_id);

  UPDATE pay_runs SET status = 'void', updated_at = now() WHERE id = p_pay_run_id AND user_id = v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_pay_run(uuid, text) TO authenticated;

-- =============================================================
-- REPORT: get_ytd_payroll — per-employee year-to-date totals
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ytd_payroll(p_year integer)
RETURNS TABLE (employee_id uuid, full_name text, gross_cents bigint, tax_cents bigint, net_cents bigint, commission_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT e.id, e.full_name,
    coalesce(sum(i.gross_pay_cents), 0)::bigint, coalesce(sum(i.tax_withholding_cents), 0)::bigint,
    coalesce(sum(i.net_pay_cents), 0)::bigint, coalesce(sum(i.commission_cents), 0)::bigint
  FROM employees e
  LEFT JOIN pay_runs r ON r.user_id = v_user_id AND r.status IN ('approved', 'paid') AND extract(year FROM r.pay_date) = p_year
  LEFT JOIN pay_run_items i ON i.pay_run_id = r.id AND i.employee_id = e.id
  WHERE e.user_id = v_user_id
  GROUP BY e.id, e.full_name
  ORDER BY e.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_ytd_payroll(integer) TO authenticated;
